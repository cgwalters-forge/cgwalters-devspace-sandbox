# A Responses upstream well-formed enough for opencode (@ai-sdk/openai),
# in place of praxis' mock-upstream.py in the test pod; same port and
# endpoints (/jwks, /counters, /reset). Each response reports 100 tokens.
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json

USAGE = {"input_tokens": 70, "input_tokens_details": {"cached_tokens": 30},
         "output_tokens": 30, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 100}

def ev(kind, **data):
    data["type"] = kind
    return f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode()

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        self.server.calls += 1
        self.server.observed.append([self.headers.get("authorization") == "Bearer synthetic-agent-token",
                                     self.headers.get("chatgpt-account-id") == "synthetic-account"])
        model = body.get("model", "synthetic")
        resp = {"id": f"resp_{self.server.calls}", "object": "response", "created_at": 0, "model": model,
                "status": "in_progress", "output": []}
        msg = {"type": "message", "id": f"msg_{self.server.calls}", "role": "assistant", "status": "completed",
               "content": [{"type": "output_text", "text": "PRAXIS-E2E-OK", "annotations": []}]}
        if body.get("stream"):
            out = (ev("response.created", response=resp, sequence_number=0)
                   + ev("response.output_item.added", output_index=0, sequence_number=1,
                        item={**msg, "status": "in_progress", "content": []})
                   + ev("response.content_part.added", item_id=msg["id"], output_index=0, content_index=0,
                        sequence_number=2, part={"type": "output_text", "text": "", "annotations": []})
                   + ev("response.output_text.delta", item_id=msg["id"], output_index=0, content_index=0,
                        sequence_number=3, delta="PRAXIS-E2E-OK", logprobs=[])
                   + ev("response.output_text.done", item_id=msg["id"], output_index=0, content_index=0,
                        sequence_number=4, text="PRAXIS-E2E-OK", logprobs=[])
                   + ev("response.output_item.done", output_index=0, sequence_number=5, item=msg)
                   + ev("response.completed", sequence_number=6,
                        response={**resp, "status": "completed", "output": [msg], "usage": USAGE}))
            ctype = "text/event-stream"
        else:
            out = json.dumps({**resp, "status": "completed", "output": [msg], "usage": USAGE}).encode()
            ctype = "application/json"
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
    def do_GET(self):
        if self.path == "/reset":
            self.server.calls = 0
            self.server.observed.clear()
            body = b""
        elif self.path == "/counters":
            body = json.dumps({"calls": self.server.calls, "observed": self.server.observed}).encode()
        elif self.path == "/jwks":
            body = open("/jwks.json", "rb").read()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_):
        pass

server = ThreadingHTTPServer(("0.0.0.0", 18081), Handler)
server.observed = []
server.calls = 0
server.serve_forever()
