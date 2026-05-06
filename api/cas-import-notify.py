"""Outbound CAS import notification endpoint.

Supabase POSTs here after every CAS import (success or failure) with a
FolioLens-HMAC-signed body. This endpoint verifies the signature and sends
the status email through Resend, keeping `RESEND_API_KEY` isolated to
Vercel.

Issue #107 — moves the last Resend touchpoint out of the Supabase Edge
Function so Resend operational knowledge stays at the router boundary.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler

from api._resend_inbound_router import (
    RouterError,
    SignatureError,
    UpstreamError,
    send_import_notification,
    verify_router_signature,
)


def _json(handler: BaseHTTPRequestHandler, status: int, body: dict) -> None:
    payload = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


class handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        _json(self, 200, {"ok": True, "service": "cas-import-notify"})

    def do_POST(self) -> None:
        content_length = int(self.headers.get("content-length", "0"))
        raw_body = self.rfile.read(content_length)

        signature = self.headers.get("x-foliolens-signature")
        timestamp = self.headers.get("x-foliolens-timestamp")
        try:
            verify_router_signature(raw_body, signature, timestamp)
        except SignatureError as exc:
            _json(self, exc.status, {"ok": False, "error": str(exc)})
            return

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            _json(self, 400, {"ok": False, "error": "Invalid JSON"})
            return

        try:
            result = send_import_notification(payload)
        except UpstreamError as exc:
            _json(self, exc.status, {"ok": False, "error": str(exc)})
            return
        except RouterError as exc:
            _json(self, exc.status, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:
            _json(self, 500, {"ok": False, "error": str(exc)})
            return

        _json(self, 200, {"ok": True, "resend": result})
