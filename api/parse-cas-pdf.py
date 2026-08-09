from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

from api._cas_parser import parse_cas_pdf_bytes
from api._cas_preflight import (
    CASPreflightError,
    safe_failure_body,
    safe_parser_telemetry,
)
from api._cdsl_nsdl_parser import HoldingsOnlyError


PARSER_SECRET = os.environ.get("CAS_PARSER_SHARED_SECRET", "")

# PostHog config is shared with the Expo web bundle build that runs in the
# same Vercel project. The `EXPO_PUBLIC_*` prefix is an Expo build-time
# convention for inlining values into the client JS bundle; from a Vercel
# serverless runtime's perspective, an env var is an env var. Reading the
# same names here means a single Vercel project setting powers both the
# build-step inline AND this Python function's runtime read — no
# duplication. (Supabase Edge Functions still use `POSTHOG_PROJECT_KEY`
# without the prefix because that runtime has no Expo concept.)
POSTHOG_KEY = os.environ.get("EXPO_PUBLIC_POSTHOG_KEY", "")
POSTHOG_HOST = os.environ.get("EXPO_PUBLIC_POSTHOG_HOST", "https://us.i.posthog.com")
APP_ENVIRONMENT = os.environ.get("APP_ENVIRONMENT", "unknown")


def _track_event(event: str, properties: dict) -> None:
    """Fire-and-forget PostHog capture. Silently no-ops without a key.

    Uses urllib so we don't pull in a new dependency. Errors are swallowed
    — analytics must never break a user-visible parse response.
    """
    if not POSTHOG_KEY:
        return
    payload = json.dumps({
        "api_key": POSTHOG_KEY,
        "event": event,
        "distinct_id": "system:python-parser",
        "properties": {
            "$lib": "foliolens-vercel-python",
            "environment": APP_ENVIRONMENT,
            **properties,
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{POSTHOG_HOST}/capture/",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as _:
            pass
    except Exception:
        # Analytics failures are never fatal here.
        pass


def _json(handler: BaseHTTPRequestHandler, status: int, body: dict) -> None:
    payload = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if not PARSER_SECRET or self.headers.get("x-parser-secret") != PARSER_SECRET:
            _json(self, 401, {"error": "Unauthorized"})
            return

        password = self.headers.get("x-password", "").strip()
        if not password:
            _json(self, 400, {"error": "Missing PDF password"})
            return

        cdsl_password = self.headers.get("x-password-cdsl", "").strip() or None

        content_length = int(self.headers.get("content-length", "0"))
        pdf_bytes = self.rfile.read(content_length)
        if not pdf_bytes:
            _json(self, 400, {"error": "Empty file received"})
            return

        try:
            parsed = parse_cas_pdf_bytes(pdf_bytes, password, cdsl_password)
        except CASPreflightError as exc:
            _track_event(
                "cas_parser_python_outcome",
                safe_parser_telemetry(
                    "rejected",
                    summary=exc.summary,
                    reason=exc.reason,
                ),
            )
            _json(self, 422, safe_failure_body(exc))
            return
        except HoldingsOnlyError:
            _track_event(
                "cas_parser_python_outcome",
                safe_parser_telemetry("holdings_only"),
            )
            _json(
                self,
                422,
                {
                    "error": (
                        "This PDF has holdings but no transaction history. "
                        "Please upload a Detailed CAS covering your full investment date range."
                    ),
                    "reason": "holdings_only",
                },
            )
            return
        except Exception as exc:
            message = str(exc)
            lowered = message.lower()
            is_password_error = (
                "password" in lowered
                or "decrypt" in lowered
                or "encrypted" in lowered
                or "invalid key" in lowered
            )
            _track_event(
                "cas_parser_python_outcome",
                safe_parser_telemetry(
                    "wrong_password" if is_password_error else "exception"
                ),
            )
            _json(
                self,
                422 if is_password_error else 500,
                {
                    "error": (
                        "Wrong PDF password. Check the password saved in FolioLens."
                        if is_password_error
                        else "This PDF could not be parsed safely."
                    ),
                    "reason": "wrong_password" if is_password_error else "parser_error",
                },
            )
            return

        summary = parsed.get("preflight_summary")
        _track_event(
            "cas_parser_python_outcome",
            safe_parser_telemetry(
                "success",
                summary=summary if isinstance(summary, dict) else None,
            ),
        )
        _json(self, 200, parsed)
