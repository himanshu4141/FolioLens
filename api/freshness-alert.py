"""Outbound freshness-check alert endpoint.

Supabase POSTs here from the `freshness-check` edge function (daily and
monthly cron) with a FolioLens-HMAC signed body when one or more checks
fail. This endpoint verifies the signature and sends the founder alert
through Resend — same pattern as `feedback-notify` and `cas-import-notify`.

Before this handler existed, ROUTER_FRESHNESS_ALERT_URL pointed at a route
that didn't exist in this repo, so every freshness alert was a silent 404
and the founder never received it. See docs/plans/amfi-nav-format-change.md
M1.3.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler

from api._resend_inbound_router import (
    RouterError,
    SignatureError,
    UpstreamError,
    send_freshness_alert,
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
        _json(self, 200, {"ok": True, "service": "freshness-alert"})

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
            result = send_freshness_alert(payload)
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
