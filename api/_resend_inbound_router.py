from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from email.utils import getaddresses
from typing import Any


INBOUND_DOMAIN = "foliolens.in"
HUMAN_ALIASES = {"hello", "support", "privacy", "security"}
TOKEN_ALPHABET_RE = r"[A-HJKMNP-Z2-9]{8}"
DEV_CAS_RE = re.compile(rf"^cas-dev-({TOKEN_ALPHABET_RE})@foliolens\.in$", re.IGNORECASE)
PROD_CAS_RE = re.compile(rf"^cas-({TOKEN_ALPHABET_RE})@foliolens\.in$", re.IGNORECASE)
SVIX_TOLERANCE_SECONDS = 5 * 60
RESEND_API_BASE_URL = os.environ.get("RESEND_API_BASE_URL", "https://api.resend.com")


class RouterError(Exception):
    status: int = 500


class MissingConfigError(RouterError):
    status = 500


class SignatureError(RouterError):
    status = 401


class UpstreamError(RouterError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Route:
    kind: str
    recipient: str | None = None
    token: str | None = None
    alias: str | None = None


def _header(headers: dict[str, str], name: str) -> str | None:
    lower = name.lower()
    for key, value in headers.items():
        if key.lower() == lower:
            return value
    return None


def _json_loads(raw_body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UpstreamError(400, "Invalid JSON") from exc
    if not isinstance(payload, dict):
        raise UpstreamError(400, "Invalid payload")
    return payload


def verify_svix_signature(raw_body: bytes, headers: dict[str, str], secret: str) -> None:
    if not secret:
        raise MissingConfigError("RESEND_INBOUND_ROUTER_SECRET is not set")

    svix_id = _header(headers, "svix-id")
    svix_timestamp = _header(headers, "svix-timestamp")
    svix_signature = _header(headers, "svix-signature")
    if not svix_id or not svix_timestamp or not svix_signature:
        raise SignatureError("Missing Svix signature headers")

    try:
        timestamp = int(svix_timestamp)
    except ValueError as exc:
        raise SignatureError("Invalid Svix timestamp") from exc
    if abs(time.time() - timestamp) > SVIX_TOLERANCE_SECONDS:
        raise SignatureError("Svix timestamp outside tolerance")

    secret_value = secret.removeprefix("whsec_")
    try:
        key = base64.b64decode(secret_value)
    except ValueError:
        key = secret_value.encode("utf-8")

    signed_content = b".".join(
        [svix_id.encode("utf-8"), svix_timestamp.encode("utf-8"), raw_body]
    )
    expected = base64.b64encode(
        hmac.new(key, signed_content, hashlib.sha256).digest()
    ).decode("ascii")

    valid = False
    for entry in svix_signature.split(" "):
        version, _, value = entry.strip().partition(",")
        if version == "v1" and hmac.compare_digest(value, expected):
            valid = True
            break
    if not valid:
        raise SignatureError("Invalid Svix signature")


def _recipient_values(data: dict[str, Any]) -> list[str]:
    values: list[str] = []
    for key in ("to", "cc", "bcc"):
        raw_value = data.get(key)
        if isinstance(raw_value, str):
            values.append(raw_value)
        elif isinstance(raw_value, list):
            for item in raw_value:
                if isinstance(item, str):
                    values.append(item)
                elif isinstance(item, dict) and isinstance(item.get("email"), str):
                    name = item.get("name")
                    if isinstance(name, str) and name:
                        values.append(f"{name} <{item['email']}>")
                    else:
                        values.append(item["email"])
    return values


def extract_recipients(event: dict[str, Any]) -> list[str]:
    data = event.get("data")
    if not isinstance(data, dict):
        return []
    recipients = []
    for _, address in getaddresses(_recipient_values(data)):
        if address:
            recipients.append(address.lower())
    return recipients


def choose_route(event: dict[str, Any]) -> Route:
    recipients = extract_recipients(event)

    for recipient in recipients:
        dev_match = DEV_CAS_RE.match(recipient)
        if dev_match:
            return Route(kind="cas_dev", recipient=recipient, token=dev_match.group(1).upper())
        prod_match = PROD_CAS_RE.match(recipient)
        if prod_match:
            return Route(kind="cas_prod", recipient=recipient, token=prod_match.group(1).upper())

    for recipient in recipients:
        local, _, domain = recipient.partition("@")
        if domain == INBOUND_DOMAIN and local in HUMAN_ALIASES:
            return Route(kind="human_forward", recipient=recipient, alias=local)

    return Route(kind="drop")


def _resend_api_key() -> str:
    api_key = os.environ.get("RESEND_API_KEY", "")
    if not api_key:
        raise MissingConfigError("RESEND_API_KEY is not set")
    return api_key


def _request_json(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {_resend_api_key()}",
        "Content-Type": "application/json",
    }
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key

    request = urllib.request.Request(
        f"{RESEND_API_BASE_URL}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read()
            if not raw:
                return {}
            parsed = json.loads(raw.decode("utf-8"))
            return parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise UpstreamError(exc.code, f"Resend API failed: {detail}") from exc
    except urllib.error.URLError as exc:
        raise UpstreamError(502, f"Resend API unavailable: {exc.reason}") from exc


def get_received_email(email_id: str) -> dict[str, Any]:
    return _request_json("GET", f"/emails/receiving/{email_id}")


def list_received_attachments(email_id: str) -> list[dict[str, Any]]:
    response = _request_json("GET", f"/emails/receiving/{email_id}/attachments")
    data = response.get("data")
    return data if isinstance(data, list) else []


def _attachment_payloads(email_id: str) -> list[dict[str, str]]:
    payloads: list[dict[str, str]] = []
    for attachment in list_received_attachments(email_id):
        if not isinstance(attachment, dict):
            continue
        download_url = attachment.get("download_url")
        filename = attachment.get("filename")
        if not download_url or not filename:
            continue
        payload: dict[str, str] = {"path": str(download_url), "filename": str(filename)}
        content_type = attachment.get("content_type")
        if content_type:
            payload["content_type"] = str(content_type)
        content_id = attachment.get("content_id")
        if content_id:
            payload["content_id"] = str(content_id)
        payloads.append(payload)
    return payloads


def _forward_recipients() -> list[str]:
    raw_value = os.environ.get("MAIL_FORWARD_TO", "")
    recipients = [item.strip() for item in raw_value.split(",") if item.strip()]
    if not recipients:
        raise MissingConfigError("MAIL_FORWARD_TO is not set")
    return recipients


def _original_from(email: dict[str, Any], event: dict[str, Any]) -> str:
    value = email.get("from")
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict) and isinstance(value.get("email"), str):
        name = value.get("name")
        if isinstance(name, str) and name:
            return f"{name} <{value['email']}>"
        return value["email"]
    data = event.get("data")
    if isinstance(data, dict) and isinstance(data.get("from"), str):
        return data["from"]
    if isinstance(data, dict) and isinstance(data.get("from"), dict):
        from_value = data["from"]
        if isinstance(from_value.get("email"), str):
            name = from_value.get("name")
            if isinstance(name, str) and name:
                return f"{name} <{from_value['email']}>"
            return from_value["email"]
    return ""


def forward_human_email(event: dict[str, Any], route: Route, svix_id: str | None) -> dict[str, Any]:
    data = event.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("email_id"), str):
        raise UpstreamError(400, "email.received payload missing data.email_id")

    email_id = data["email_id"]
    email = get_received_email(email_id)
    original_from = _original_from(email, event)

    send_body: dict[str, Any] = {
        "from": os.environ.get("MAIL_FORWARD_FROM", "FolioLens Mail <noreply@foliolens.in>"),
        "to": _forward_recipients(),
        "subject": email.get("subject") or data.get("subject") or "(no subject)",
        "headers": {
            "X-FolioLens-Inbound-Alias": route.alias or "",
            "X-FolioLens-Original-Recipient": route.recipient or "",
        },
    }
    if original_from:
        send_body["reply_to"] = original_from

    html = email.get("html")
    text = email.get("text")
    if isinstance(html, str) and html:
        send_body["html"] = html
    if isinstance(text, str) and text:
        send_body["text"] = text
    if "html" not in send_body and "text" not in send_body:
        send_body["text"] = (
            "Forwarded by FolioLens inbound mail router.\n\n"
            f"From: {original_from or '(unknown)'}\n"
            f"To: {route.recipient or '(unknown)'}\n"
        )

    attachments = _attachment_payloads(email_id)
    if attachments:
        send_body["attachments"] = attachments

    return _request_json(
        "POST",
        "/emails",
        send_body,
        idempotency_key=f"forward-{svix_id}" if svix_id else None,
    )


def _supabase_url(route: Route) -> str:
    if route.kind == "cas_dev":
        env_key = "SUPABASE_DEV_FUNCTION_URL"
    elif route.kind == "cas_prod":
        env_key = "SUPABASE_PROD_FUNCTION_URL"
    else:
        raise ValueError(f"Unsupported Supabase route: {route.kind}")
    value = os.environ.get(env_key, "")
    if not value:
        raise MissingConfigError(f"{env_key} is not set")
    return value


# ── FolioLens-owned HMAC for router ↔ Supabase ──────────────────────────────
#
# Issue #107: Resend secrets stay on the router; Supabase only knows about
# this FolioLens-owned shared secret. Every CAS handoff (router → Supabase
# webhook) and every notification callback (Supabase → router) carries an
# `x-foliolens-signature: v1,<base64sig>` header signed with HMAC-SHA256
# over the raw body using `FOLIOLENS_INBOUND_ROUTER_SECRET`.
NORMALIZED_PAYLOAD_VERSION = 1
ROUTER_SIGNATURE_HEADER = "x-foliolens-signature"
ROUTER_SIGNATURE_TOLERANCE_SECONDS = 5 * 60


def _foliolens_secret() -> bytes:
    secret = os.environ.get("FOLIOLENS_INBOUND_ROUTER_SECRET", "")
    if not secret:
        raise MissingConfigError("FOLIOLENS_INBOUND_ROUTER_SECRET is not set")
    return secret.encode("utf-8")


def sign_router_payload(body: bytes, timestamp: int | None = None) -> tuple[str, int]:
    """Sign a body with FOLIOLENS_INBOUND_ROUTER_SECRET. Returns (header, ts)."""
    ts = timestamp if timestamp is not None else int(time.time())
    signed = b".".join([str(ts).encode("ascii"), body])
    sig = base64.b64encode(
        hmac.new(_foliolens_secret(), signed, hashlib.sha256).digest()
    ).decode("ascii")
    return f"v1,{sig}", ts


def verify_router_signature(body: bytes, signature_header: str | None, timestamp_header: str | None) -> None:
    """Inverse of sign_router_payload — used by the notify endpoint."""
    if not signature_header or not timestamp_header:
        raise SignatureError("Missing FolioLens signature headers")
    try:
        ts = int(timestamp_header)
    except ValueError as exc:
        raise SignatureError("Invalid FolioLens timestamp") from exc
    if abs(time.time() - ts) > ROUTER_SIGNATURE_TOLERANCE_SECONDS:
        raise SignatureError("FolioLens timestamp outside tolerance")

    expected, _ = sign_router_payload(body, timestamp=ts)
    if not hmac.compare_digest(signature_header, expected):
        raise SignatureError("Invalid FolioLens signature")


def _normalized_attachments(email_id: str) -> list[dict[str, str]]:
    """List Resend-hosted attachments. download_url is a presigned URL the
    Supabase function can fetch directly without a Resend API key."""
    payloads: list[dict[str, str]] = []
    for attachment in list_received_attachments(email_id):
        if not isinstance(attachment, dict):
            continue
        download_url = attachment.get("download_url")
        filename = attachment.get("filename")
        if not download_url:
            continue
        item: dict[str, str] = {
            "filename": str(filename or "attachment"),
            "download_url": str(download_url),
        }
        content_type = attachment.get("content_type") or attachment.get("contentType")
        if content_type:
            item["content_type"] = str(content_type)
        attachment_id = attachment.get("id")
        if attachment_id:
            item["id"] = str(attachment_id)
        payloads.append(item)
    return payloads


def _build_normalized_cas_payload(route: Route, event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("email_id"), str):
        raise UpstreamError(400, "email.received payload missing data.email_id")

    email_id = data["email_id"]
    email = get_received_email(email_id)
    merged: dict[str, Any] = {**data, **email}

    return {
        "v": NORMALIZED_PAYLOAD_VERSION,
        "route": route.kind,
        "token": route.token,
        "recipient": route.recipient,
        "email_id": email_id,
        "from": _original_from(email, event),
        "subject": merged.get("subject"),
        "text": merged.get("text"),
        "html": merged.get("html"),
        "headers": merged.get("headers") if isinstance(merged.get("headers"), dict) else {},
        "attachments": _normalized_attachments(email_id),
    }


def forward_cas_to_supabase(route: Route, event: dict[str, Any]) -> dict[str, Any]:
    """Build a normalized, FolioLens-signed payload and POST to Supabase.

    The router is the only component that talks to Resend; Supabase verifies
    the FolioLens HMAC and processes the normalized shape — no Resend Svix
    verification, no Resend Receiving API calls on the Supabase side.
    """
    payload = _build_normalized_cas_payload(route, event)
    body = json.dumps(payload).encode("utf-8")
    signature, timestamp = sign_router_payload(body)
    forwarded_headers = {
        "Content-Type": "application/json",
        ROUTER_SIGNATURE_HEADER: signature,
        "x-foliolens-timestamp": str(timestamp),
        "x-foliolens-router": "resend-inbound-router",
    }
    request = urllib.request.Request(
        _supabase_url(route),
        data=body,
        headers=forwarded_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            return {"status": response.status, "body": response_body}
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        raise UpstreamError(exc.code, f"Supabase CAS webhook failed: {response_body}") from exc
    except urllib.error.URLError as exc:
        raise UpstreamError(502, f"Supabase CAS webhook unavailable: {exc.reason}") from exc


def _notification_from_address(environment: str) -> str:
    """Per-env Resend Notification From address. Mirrors the value the
    Supabase function used to read directly via RESEND_NOTIFICATION_FROM."""
    if environment == "dev":
        return os.environ.get(
            "RESEND_NOTIFICATION_FROM_DEV",
            "FolioLens Dev <noreply-dev@foliolens.in>",
        )
    return os.environ.get(
        "RESEND_NOTIFICATION_FROM_PROD",
        "FolioLens <noreply@foliolens.in>",
    )


def _notification_template_id(environment: str) -> str:
    env_key = (
        "RESEND_IMPORT_NOTIFICATION_TEMPLATE_ID_DEV"
        if environment == "dev"
        else "RESEND_IMPORT_NOTIFICATION_TEMPLATE_ID_PROD"
    )
    value = os.environ.get(env_key, "")
    if not value:
        raise MissingConfigError(f"{env_key} is not set")
    return value


def _escape_template_value(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _safe_template_value(value: str) -> str:
    truncated = value[:1897] + "..." if len(value) > 1900 else value
    return _escape_template_value(truncated)


def _notification_variables(payload: dict[str, Any]) -> dict[str, str]:
    """Render the same import-status-email variables the Supabase function
    used to render. Numbers are stringified — the Resend template renderer
    rejects numeric values with `validation_error` even though the API docs
    claim numbers are accepted."""
    status = payload.get("status")
    success = status == "success"
    funds = int(payload.get("funds_updated") or 0)
    transactions = int(payload.get("transactions_added") or 0)
    errors = payload.get("errors") or []
    if not isinstance(errors, list):
        errors = []
    problem = errors[0] if errors else "No importable transactions were found."
    title = "Your CAS import is ready" if success else "Your CAS could not be imported"
    intro = (
        "We processed the CAS PDF from your FolioLens import inbox. "
        "Open the app to review the updated portfolio."
        if success
        else "We received your CAS email, but the PDF could not be imported into your portfolio."
    )
    detail_text = (
        "Your portfolio was updated from the CAS PDF received in your private import inbox."
        if success
        else str(problem)
    )
    next_step = (
        "Open FolioLens to review your portfolio."
        if success
        else (
            "Forward or upload a Detailed CAS PDF that includes transaction history "
            "for your full investment date range. Holdings-only summaries cannot build "
            "Money Trail or XIRR."
        )
    )
    app_url = (
        os.environ.get("APP_URL_PROD", "https://app.foliolens.in")
        if payload.get("environment") == "prod"
        else os.environ.get("APP_URL_DEV", "https://foliolens-dev.vercel.app")
    )
    return {
        "STATUS_LABEL": "Imported" if success else "Needs attention",
        "STATUS_BG": "#E7FAF2" if success else "#FEEDEE",
        "STATUS_TEXT_COLOR": "#0EA372" if success else "#B91C1C",
        "TITLE": _safe_template_value(title),
        "INTRO": _safe_template_value(intro),
        "FUNDS_UPDATED": str(funds),
        "TRANSACTIONS_IMPORTED": str(transactions),
        "DETAIL_LABEL": "What changed" if success else "Reason",
        "DETAIL_TEXT": _safe_template_value(detail_text),
        "NEXT_STEP_LABEL": "Next step" if success else "What to do next",
        "NEXT_STEP_TEXT": _safe_template_value(next_step),
        "APP_URL": _safe_template_value(app_url),
        "CTA_LABEL": "Open FolioLens",
        "FOOTER_TEXT": "Sent because your private FolioLens import inbox received a CAS PDF.",
    }


def send_import_notification(payload: dict[str, Any]) -> dict[str, Any]:
    """Send the CAS import status email via Resend Templates. Called from
    the cas-import-notify endpoint after Supabase POSTs a signed body."""
    to_address = payload.get("to")
    if not isinstance(to_address, str) or not to_address:
        raise UpstreamError(400, "Missing recipient address")
    status = payload.get("status")
    if status not in ("success", "failed"):
        raise UpstreamError(400, "Invalid import status")
    environment = payload.get("environment") or "prod"
    if environment not in ("dev", "prod"):
        environment = "prod"
    import_id = payload.get("import_id") or "unknown"

    success = status == "success"
    subject = (
        "FolioLens imported your CAS"
        if success
        else "FolioLens could not import your CAS"
    )
    body = {
        "from": _notification_from_address(environment),
        "to": [to_address],
        "subject": subject,
        "template": {
            "id": _notification_template_id(environment),
            "variables": _notification_variables(payload),
        },
        "tags": [
            {"name": "category", "value": "cas_import"},
            {"name": "status", "value": status},
        ],
    }
    return _request_json(
        "POST",
        "/emails",
        body,
        idempotency_key=f"cas-import-notification/{import_id}/{status}",
    )


def route_event(raw_body: bytes, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
    verify_svix_signature(
        raw_body,
        headers,
        os.environ.get("RESEND_INBOUND_ROUTER_SECRET", ""),
    )

    event = _json_loads(raw_body)
    event_type = event.get("type")
    if event_type != "email.received":
        return 200, {"ok": True, "route": "ignored", "event_type": event_type}

    route = choose_route(event)
    if route.kind == "drop":
        return 200, {"ok": True, "route": "drop"}
    if route.kind == "human_forward":
        result = forward_human_email(event, route, _header(headers, "svix-id"))
        return 200, {"ok": True, "route": "human_forward", "resend": result}
    if route.kind in {"cas_dev", "cas_prod"}:
        result = forward_cas_to_supabase(route, event)
        return 200, {"ok": True, "route": route.kind, "upstream": result}

    raise UpstreamError(500, f"Unhandled route kind: {route.kind}")
