#!/usr/bin/env python3
"""A scripted ACP agent for bot-harness's tests (tests/fake_agent.rs).

FAKE_MODE picks what it does in session/prompt:
- fs: sends fs/* and terminal/* requests (session-scoped and not) that the
  harness doesn't advertise, and expects each answered;
- flood: sends FAKE_UPDATES agent_message_chunk notifications;
- grace: makes three tool calls, then asks permission after the harness
  must have cancelled the session (run it with --max-tool-calls 2);
- slow-init: never answers initialize.
It ends the prompt turn with end_turn (or cancelled, after session/cancel).
"""
import json
import os
import select
import sys
import time

MODE = os.environ.get("FAKE_MODE", "fs")
SESSION = "s1"


def send(m):
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()


def recv(timeout=None):
    r, _, _ = select.select([sys.stdin], [], [], timeout)
    if not r:
        return None
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)


def wait_for(id_, timeout):
    """The response to request ID_; notifications in between are noted."""
    end = time.time() + timeout
    cancelled = False
    while time.time() < end:
        m = recv(end - time.time())
        if m is None:
            break
        if m.get("method") == "session/cancel":
            cancelled = True
        elif m.get("id") == id_ and "method" not in m:
            return m, cancelled
    sys.exit(f"fake-agent: no response to request {id_}")


def update(u):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": SESSION, "update": u}})


while True:
    m = recv()
    method = m.get("method")
    if method == "initialize":
        if MODE == "slow-init":
            continue
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": 1, "agentInfo": {"name": "fake", "version": "0"}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"sessionId": SESSION}})
    elif method == "session/prompt":
        stop = "end_turn"
        if MODE == "fs":
            for i, (req, params) in enumerate([
                ("fs/read_text_file", {"sessionId": SESSION, "path": "/etc/passwd"}),
                ("terminal/create", {"sessionId": SESSION, "command": "id"}),
                ("fs/read_text_file", {"path": "/etc/passwd"}),
            ]):
                send({"jsonrpc": "2.0", "id": 100 + i, "method": req, "params": params})
                wait_for(100 + i, 5)
        elif MODE == "flood":
            chunk = "x" * 1000
            for _ in range(int(os.environ["FAKE_UPDATES"])):
                update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": chunk}})
        elif MODE == "grace":
            for i in range(3):
                update({"sessionUpdate": "tool_call", "toolCallId": f"t{i}", "title": "Bash", "kind": "execute",
                        "status": "pending", "rawInput": {"command": "true"}})
            time.sleep(1)
            send({"jsonrpc": "2.0", "id": 300, "method": "session/request_permission", "params": {
                "sessionId": SESSION,
                "toolCall": {"toolCallId": "t2", "kind": "execute", "rawInput": {"command": "true"}},
                "options": [{"optionId": "ok", "name": "Allow", "kind": "allow_once"},
                            {"optionId": "no", "name": "Reject", "kind": "reject_once"}]}})
            _, cancelled = wait_for(300, 10)
            stop = "cancelled" if cancelled else stop
        send({"jsonrpc": "2.0", "id": m["id"], "result": {"stopReason": stop}})
