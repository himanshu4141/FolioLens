import base64
import hashlib
import hmac
import json
import os
import time
import unittest
from unittest import mock

from api._resend_inbound_router import (
    MissingConfigError,
    SignatureError,
    choose_route,
    extract_recipients,
    sign_router_payload,
    verify_router_signature,
    verify_svix_signature,
)


class ResendInboundRouterTest(unittest.TestCase):
    def test_extract_recipients_handles_display_names_and_arrays(self):
        event = {
            "data": {
                "to": [
                    "FolioLens <hello@foliolens.in>",
                    "cas-A2B3C4D5@foliolens.in",
                    {"email": "privacy@foliolens.in", "name": "Privacy"},
                ],
                "cc": "Support <support@foliolens.in>",
            }
        }

        self.assertEqual(
            extract_recipients(event),
            [
                "hello@foliolens.in",
                "cas-a2b3c4d5@foliolens.in",
                "privacy@foliolens.in",
                "support@foliolens.in",
            ],
        )

    def test_choose_route_sends_prod_cas_to_prod(self):
        route = choose_route({"data": {"to": ["cas-A2B3C4D5@foliolens.in"]}})

        self.assertEqual(route.kind, "cas_prod")
        self.assertEqual(route.token, "A2B3C4D5")

    def test_choose_route_sends_dev_cas_to_dev(self):
        route = choose_route({"data": {"to": ["cas-dev-A2B3C4D5@foliolens.in"]}})

        self.assertEqual(route.kind, "cas_dev")
        self.assertEqual(route.token, "A2B3C4D5")

    def test_choose_route_forwards_human_aliases(self):
        route = choose_route({"data": {"to": ["Support <support@foliolens.in>"]}})

        self.assertEqual(route.kind, "human_forward")
        self.assertEqual(route.alias, "support")

    def test_choose_route_prefers_cas_when_multiple_recipients(self):
        route = choose_route(
            {"data": {"to": ["support@foliolens.in", "cas-dev-A2B3C4D5@foliolens.in"]}}
        )

        self.assertEqual(route.kind, "cas_dev")

    def test_choose_route_drops_unknown_addresses(self):
        route = choose_route({"data": {"to": ["random@foliolens.in"]}})

        self.assertEqual(route.kind, "drop")

    # ── Auto-forwarded mail: data.to keeps the original recipient (the user's
    #    personal address). The actual delivery destination only shows up in
    #    forwarding-marker headers. We must still route correctly. ──

    def test_choose_route_finds_cas_token_in_delivered_to_header(self):
        """Gmail-style auto-forward: data.to is the original inbox, the cas-dev
        address is in `Delivered-To`."""
        event = {
            "data": {
                "to": ["himanshu4141@gmail.com"],
                "from": "donotreply@camsonline.com",
                "headers": [
                    {"name": "Delivered-To", "value": "cas-dev-3ZQNUTF7@foliolens.in"},
                ],
            }
        }
        route = choose_route(event)
        self.assertEqual(route.kind, "cas_dev")
        self.assertEqual(route.token, "3ZQNUTF7")

    def test_choose_route_finds_cas_token_in_x_forwarded_to(self):
        """Some Outlook configurations stamp `X-Forwarded-To` instead of
        Delivered-To."""
        event = {
            "data": {
                "to": ["user@outlook.com"],
                "headers": [
                    {"name": "X-Forwarded-To", "value": "cas-A2B3C4D5@foliolens.in"},
                ],
            }
        }
        route = choose_route(event)
        self.assertEqual(route.kind, "cas_prod")
        self.assertEqual(route.token, "A2B3C4D5")

    def test_choose_route_finds_cas_token_in_x_original_to(self):
        """Postfix-style `X-Original-To` header."""
        event = {
            "data": {
                "to": ["user@example.com"],
                "headers": [
                    {"name": "X-Original-To", "value": "cas-dev-ABCDEF23@foliolens.in"},
                ],
            }
        }
        route = choose_route(event)
        self.assertEqual(route.kind, "cas_dev")
        self.assertEqual(route.token, "ABCDEF23")

    def test_choose_route_finds_cas_token_in_envelope_to(self):
        """Exim-style `Envelope-To` header."""
        event = {
            "data": {
                "to": ["user@example.com"],
                "headers": [
                    {"name": "Envelope-To", "value": "cas-XYZ23456@foliolens.in"},
                ],
            }
        }
        route = choose_route(event)
        self.assertEqual(route.kind, "cas_prod")
        self.assertEqual(route.token, "XYZ23456")

    def test_choose_route_handles_dict_shaped_headers(self):
        """Some Resend payloads expose headers as a flat dict instead of a list
        of {name,value} pairs."""
        event = {
            "data": {
                "to": ["user@example.com"],
                "headers": {
                    "Delivered-To": "cas-dev-ABCDEF23@foliolens.in",
                },
            }
        }
        route = choose_route(event)
        self.assertEqual(route.kind, "cas_dev")
        self.assertEqual(route.token, "ABCDEF23")

    def test_choose_route_mines_cas_token_from_received_chain(self):
        """Last-resort: parse `for <cas-XXX@foliolens.in>` out of the Received
        header chain. Many MTAs stamp the SMTP envelope's RCPT TO there."""
        event = {
            "data": {
                "to": ["user@example.com"],
                "headers": [
                    {
                        "name": "Received",
                        "value": "by mx.google.com with SMTPS id abc "
                                 "for <cas-dev-3ZQNUTF7@foliolens.in> "
                                 "(Google Transport Security); ",
                    },
                ],
            }
        }
        route = choose_route(event)
        self.assertEqual(route.kind, "cas_dev")
        self.assertEqual(route.token, "3ZQNUTF7")

    def test_choose_route_falls_back_to_envelope_to_singular_field(self):
        """Some webhook payload shapes expose a singular `envelope_to` /
        `recipient` / `rcpt_to` instead of headers."""
        for key in ("envelope_to", "recipient", "rcpt_to"):
            with self.subTest(key=key):
                event = {
                    "data": {
                        "to": ["user@example.com"],
                        key: "cas-A2B3C4D5@foliolens.in",
                    }
                }
                route = choose_route(event)
                self.assertEqual(route.kind, "cas_prod")
                self.assertEqual(route.token, "A2B3C4D5")

    def test_choose_route_prefers_header_to_over_delivered_to_for_manual_forward(self):
        """A manual forward — user typed cas-dev-XXX@ themselves, so it lands
        in data.to. Delivered-To might still show their own inbox from the
        ingress hop, but we should match the user-typed address first."""
        event = {
            "data": {
                "to": ["cas-dev-A2B3C4D5@foliolens.in"],
                "headers": [
                    {"name": "Delivered-To", "value": "ingress@example.com"},
                ],
            }
        }
        route = choose_route(event)
        self.assertEqual(route.kind, "cas_dev")
        self.assertEqual(route.recipient, "cas-dev-a2b3c4d5@foliolens.in")
        self.assertEqual(route.token, "A2B3C4D5")

    def test_choose_route_still_drops_when_no_source_has_a_cas_address(self):
        event = {
            "data": {
                "to": ["random@example.com"],
                "headers": [
                    {"name": "Delivered-To", "value": "another@example.com"},
                ],
            }
        }
        route = choose_route(event)
        self.assertEqual(route.kind, "drop")

    def test_extract_recipients_deduplicates_across_sources(self):
        """The same address appearing in both data.to and Delivered-To should
        appear once in the output."""
        event = {
            "data": {
                "to": ["cas-dev-A2B3C4D5@foliolens.in"],
                "headers": [
                    {"name": "Delivered-To", "value": "cas-dev-A2B3C4D5@foliolens.in"},
                ],
            }
        }
        recipients = extract_recipients(event)
        self.assertEqual(recipients.count("cas-dev-a2b3c4d5@foliolens.in"), 1)

    def _signed_headers(self, raw_body: bytes, secret: str) -> dict[str, str]:
        svix_id = "msg_test"
        svix_timestamp = str(int(time.time()))
        secret_value = secret.removeprefix("whsec_")
        key = base64.b64decode(secret_value)
        signed_content = b".".join([svix_id.encode(), svix_timestamp.encode(), raw_body])
        signature = base64.b64encode(
            hmac.new(key, signed_content, hashlib.sha256).digest()
        ).decode("ascii")
        return {
            "svix-id": svix_id,
            "svix-timestamp": svix_timestamp,
            "svix-signature": f"v1,{signature}",
        }

    def test_verify_svix_signature_accepts_valid_payload(self):
        raw_body = json.dumps({"type": "email.received"}).encode()
        secret = "whsec_" + base64.b64encode(b"secret-key").decode("ascii")

        verify_svix_signature(raw_body, self._signed_headers(raw_body, secret), secret)

    def test_verify_svix_signature_rejects_tampered_payload(self):
        raw_body = json.dumps({"type": "email.received"}).encode()
        secret = "whsec_" + base64.b64encode(b"secret-key").decode("ascii")
        headers = self._signed_headers(raw_body, secret)

        with self.assertRaises(SignatureError):
            verify_svix_signature(b'{"type":"other"}', headers, secret)


class FoliolensRouterSignatureTest(unittest.TestCase):
    """Issue #107 — HMAC handshake between the router and Supabase / between
    Supabase and the cas-import-notify endpoint. The same secret signs both
    directions; tests verify sign-then-verify roundtrip + tampering rejection."""

    SECRET = "test-foliolens-secret"

    def test_sign_and_verify_roundtrip(self):
        body = b'{"v":1,"token":"ABC23456"}'
        with mock.patch.dict(os.environ, {"FOLIOLENS_INBOUND_ROUTER_SECRET": self.SECRET}):
            signature, ts = sign_router_payload(body)
            verify_router_signature(body, signature, str(ts))

    def test_verify_rejects_tampered_body(self):
        with mock.patch.dict(os.environ, {"FOLIOLENS_INBOUND_ROUTER_SECRET": self.SECRET}):
            signature, ts = sign_router_payload(b'{"v":1,"token":"ABC23456"}')
            with self.assertRaises(SignatureError):
                verify_router_signature(b'{"v":1,"token":"OTHER"}', signature, str(ts))

    def test_verify_rejects_stale_timestamp(self):
        with mock.patch.dict(os.environ, {"FOLIOLENS_INBOUND_ROUTER_SECRET": self.SECRET}):
            stale_ts = int(time.time()) - 6 * 60  # 6 minutes ago
            signature, _ = sign_router_payload(b"x", timestamp=stale_ts)
            with self.assertRaises(SignatureError):
                verify_router_signature(b"x", signature, str(stale_ts))

    def test_verify_rejects_missing_headers(self):
        with mock.patch.dict(os.environ, {"FOLIOLENS_INBOUND_ROUTER_SECRET": self.SECRET}):
            with self.assertRaises(SignatureError):
                verify_router_signature(b"x", None, str(int(time.time())))
            with self.assertRaises(SignatureError):
                verify_router_signature(b"x", "v1,whatever", None)

    def test_sign_requires_secret(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(MissingConfigError):
                sign_router_payload(b"x")


if __name__ == "__main__":
    unittest.main()
