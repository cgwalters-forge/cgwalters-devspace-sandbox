#!/usr/bin/env python3
"""A mock Anthropic Messages API endpoint that replays a scripted conversation.

The agent CLI is pointed at it with ANTHROPIC_BASE_URL, so a workflow run
exercises the whole pipeline (unprivileged user, transcript capture,
redaction, summary) without credentials or inference cost.

The script is a JSON list of assistant turns, each a list of content
blocks as the Messages API returns them ({"type": "text", "text": ...} or
{"type": "tool_use", "name": ..., "input": {...}}). A request's turn is the
number of assistant messages it already carries, so the replay needs no
state and follows the agent through tool results; past the end, the model
says it's done. "{workdir}" in a tool input string becomes --workdir, since
file tools want absolute paths. The script uses Claude Code's tool names
and input keys (Bash, file_path); for an agent whose tools are named
differently (opencode: bash, filePath), a scripted call goes to the offered
tool of the same name up to case, with its keys in camelCase where that's
what the tool's schema has. Requests without tools (titles, summaries and other side
calls) get a short text answer. Every request is logged, one JSON line with
its token counts, to --usage-log.

    mock-model.py --script CONVERSATION.json --workdir DIR --port 8080 --usage-log usage.jsonl
"""

import argparse
import json
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Rough token estimate for the usage numbers: about 4 bytes per token.
BYTES_PER_TOKEN = 4
DONE_TEXT = "The scripted conversation is over; nothing left to do."
SIDE_CALL_TEXT = "Mock"


def tokens(obj):
    return max(1, len(json.dumps(obj)) // BYTES_PER_TOKEN)


def turn_of(request):
    return sum(1 for m in request.get("messages", []) if m.get("role") == "assistant")


def expand(value, workdir):
    if isinstance(value, str):
        return value.replace("{workdir}", workdir)
    if isinstance(value, dict):
        return {k: expand(v, workdir) for k, v in value.items()}
    if isinstance(value, list):
        return [expand(v, workdir) for v in value]
    return value


def camel(key):
    head, *rest = key.split("_")
    return head + "".join(word.title() for word in rest)


def adapt(block, tools):
    """Fits a scripted tool call to the agent's own tool of that name."""
    names = {t.get("name") for t in tools}
    if block["name"] in names:
        return block
    tool = next((t for t in tools if str(t.get("name", "")).lower() == block["name"].lower()), None)
    if tool is None:
        return block
    props = tool.get("input_schema", {}).get("properties", {})
    inputs = {(camel(k) if k not in props and camel(k) in props else k): v for k, v in block["input"].items()}
    return dict(block, name=tool["name"], input=inputs)


def prepare(blocks, workdir, tools):
    out = []
    for block in blocks:
        block = dict(block)
        if block.get("type") == "tool_use":
            block["input"] = expand(block["input"], workdir)
            block = adapt(block, tools)
            block.setdefault("id", "toolu_mock_" + uuid.uuid4().hex[:16])
        out.append(block)
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mock-model"

    def log_message(self, fmt, *args):
        sys.stderr.write("mock-model: " + (fmt % args) + "\n")

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_GET(self):
        self.send_json(200, {})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as e:
            self.send_json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": str(e)}})
            return
        path = self.path.split("?", 1)[0]
        if path.endswith("/messages/count_tokens"):
            self.send_json(200, {"input_tokens": tokens(request)})
            return
        if not path.endswith("/messages"):
            self.send_json(404, {"type": "error", "error": {"type": "not_found_error", "message": path}})
            return

        script = self.server.script
        turn = turn_of(request)
        if not request.get("tools"):
            blocks, stop = [{"type": "text", "text": SIDE_CALL_TEXT}], "end_turn"
        elif turn < len(script):
            blocks = prepare(script[turn], self.server.workdir, request["tools"])
            stop = "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"
        else:
            blocks, stop = [{"type": "text", "text": DONE_TEXT}], "end_turn"
        model = request.get("model", "mock")
        usage = {
            "input_tokens": tokens(request),
            "output_tokens": tokens(blocks),
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }
        with open(self.server.usage_log, "a") as f:
            record = {"ts": time.time(), "model": model, "turn": turn, "tools": bool(request.get("tools")), **usage}
            f.write(json.dumps(record) + "\n")
        message = {
            "id": "msg_mock_" + uuid.uuid4().hex[:16],
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": blocks,
            "stop_reason": stop,
            "stop_sequence": None,
            "usage": usage,
        }
        if request.get("stream"):
            self.stream(message)
        else:
            self.send_json(200, message)

    def stream(self, message):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()
        self.close_connection = True

        def event(kind, data):
            self.wfile.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())

        start = dict(message, content=[], stop_reason=None, usage=dict(message["usage"], output_tokens=1))
        event("message_start", {"type": "message_start", "message": start})
        for index, block in enumerate(message["content"]):
            if block["type"] == "tool_use":
                empty = dict(block, input={})
                delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
            else:
                empty = dict(block, text="")
                delta = {"type": "text_delta", "text": block["text"]}
            event("content_block_start", {"type": "content_block_start", "index": index, "content_block": empty})
            event("content_block_delta", {"type": "content_block_delta", "index": index, "delta": delta})
            event("content_block_stop", {"type": "content_block_stop", "index": index})
        event(
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": message["stop_reason"], "stop_sequence": None},
                "usage": {"output_tokens": message["usage"]["output_tokens"]},
            },
        )
        event("message_stop", {"type": "message_stop"})
        self.wfile.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--script", required=True, help="JSON list of assistant turns")
    parser.add_argument("--workdir", required=True, help="the agent's working directory")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--usage-log", required=True, help="appends one JSON line per request")
    args = parser.parse_args()
    with open(args.script) as f:
        script = json.load(f)
    if not isinstance(script, list) or not all(isinstance(turn, list) for turn in script):
        sys.exit(f"mock-model: {args.script} must be a JSON list of turns, each a list of content blocks")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.script = script
    server.usage_log = args.usage_log
    server.workdir = args.workdir
    server.serve_forever()


if __name__ == "__main__":
    main()
