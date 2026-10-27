"""Contracts of `stay-green run`: when it calls setPresence, and how it keeps and renews the tokens. The real script
runs against a local fake of Microsoft's endpoints, so every Graph and token request crosses real HTTP."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from harness import (DROP, ROOT, SET_PRESENCE_BODY, SHAPES, CLIENT_ID, Reply, ScriptCase, graph_error, html, mode_of,
                     presence, token_error, token_ok)

PRESENCE_ID = SHAPES["presence"]["id"]
SET_PRESENCE_PATH = f"/v1.0/users/{PRESENCE_ID}/presence/setPresence"
# The five refusal codes of docs/reference.md (Files).
REFUSALS = ["invalid_grant", "interaction_required", "consent_required", "invalid_client", "unauthorized_client"]


class RunTest(ScriptCase):
    schedule = "Mon-Fri 09:00-18:00"

    def setUp(self):
        super().setUp()
        self.write("refresh-token", "RT-OLD")
        self.write("access-token", self.cache_for("AT-OLD"))

    def test_inside_the_schedule_run_sets_presence_once_with_the_documented_body(self):
        self.fake.presence = lambda request: presence(availability="Busy")
        code, _ = self.cli("run")
        self.assertIsNone(code)
        calls = self.fake.set_presence_requests
        self.assertEqual(len(calls), 1)
        self.assertEqual((calls[0]["method"], calls[0]["path"]), ("POST", SET_PRESENCE_PATH))
        self.assertEqual(calls[0]["json"], SET_PRESENCE_BODY)
        self.assertEqual(calls[0]["auth"], "Bearer AT-OLD")
        self.assertEqual([r["path"] for r in self.fake.requests], ["/v1.0/me/presence", SET_PRESENCE_PATH])

    def test_out_of_office_makes_no_set_presence_call_and_other_answers_do(self):
        no_settings = presence()
        del no_settings.body["outOfOfficeSettings"]
        for label, reply, calls in (("out of office", presence(out_of_office=True), 0),
                                    ("not out of office", presence(out_of_office=False), 1),
                                    ("no outOfOfficeSettings in the answer", no_settings, 1)):
            with self.subTest(label):
                self.fake.requests.clear()
                self.fake.presence = lambda request, reply=reply: reply
                code, _ = self.cli("run")
                self.assertIsNone(code)
                self.assertEqual(len(self.fake.set_presence_requests), calls)

    def test_a_schedule_that_ends_while_the_run_waits_on_microsoft_makes_no_set_presence_call(self):
        self.clock.set("2026-10-26T17:59:30Z")

        def slow_presence(request):
            self.clock.set("2026-10-26T18:00:30Z")  # Graph answers after the schedule ended
            return presence()

        self.fake.presence = slow_presence
        code, out = self.cli("run")
        self.assertIsNone(code)
        self.assertEqual(self.fake.set_presence_requests, [])
        self.assertIn("the schedule ended during this run", out)

    def test_outside_the_schedule_run_contacts_nobody(self):
        self.clock.set("2026-10-26T18:00:00Z")
        code, out = self.cli("run")
        self.assertIsNone(code)
        self.assertEqual(self.fake.requests, [])
        self.assertEqual(out, "")

    def test_a_failed_set_presence_fails_the_run_without_a_success_line(self):
        self.fake.set_presence = lambda request: graph_error(403, "Authorization_RequestDenied")
        code, out = self.cli("run")
        self.assertTrue(str(code).startswith("stay-green: 403"), code)
        self.assertNotIn("marked Available", out)


class TokenTest(ScriptCase):
    def setUp(self):
        super().setUp()
        self.write("refresh-token", "RT-OLD")

    def run_once(self):
        self.fake.requests.clear()
        return self.cli("run")

    def test_a_cache_that_stays_valid_for_5_minutes_is_used_without_a_renewal(self):
        for expires_in, renewals in ((3600, 0), (400, 0), (200, 1), (-10, 1)):
            with self.subTest(expires_in=expires_in):
                self.write("refresh-token", "RT-OLD")
                self.write("access-token", self.cache_for("AT-OLD", expires_in))
                code, _ = self.run_once()
                self.assertIsNone(code)
                self.assertEqual(len(self.fake.token_requests), renewals)
                self.assertEqual(self.fake.requests[-1]["auth"], "Bearer AT-NEW" if renewals else "Bearer AT-OLD")

    def test_an_expired_or_damaged_cache_renews_and_replaces_both_stored_tokens(self):
        damaged = {"not json": "{broken", "empty file": "", "a list": "[]", "no keys": "{}",
                   "no expiry": json.dumps({"token": "AT-OLD"}), "expiry is text": json.dumps({"token": "AT-OLD", "expires": "soon"}),
                   "expired": self.cache_for("AT-OLD", -10)}
        for label, content in damaged.items():
            with self.subTest(label):
                self.write("refresh-token", "RT-OLD")
                self.write("access-token", content)
                code, _ = self.run_once()
                self.assertIsNone(code)
                self.assertEqual(len(self.fake.token_requests), 1)
                renewal = self.fake.token_requests[0]
                self.assertEqual({k: renewal["form"][k] for k in ("grant_type", "refresh_token", "client_id")},
                                 {"grant_type": "refresh_token", "refresh_token": "RT-OLD", "client_id": CLIENT_ID})
                self.assertEqual(self.read("refresh-token"), "RT-NEW")
                cache = json.loads(self.read("access-token"))
                self.assertEqual(cache["token"], "AT-NEW")
                self.assertAlmostEqual(cache["expires"], time.time() + 3599, delta=30)
                self.assertEqual(mode_of(self.state / "refresh-token"), 0o600)
                self.assertEqual(mode_of(self.state / "access-token"), 0o600)
                self.assertEqual(self.fake.requests[-2]["auth"], "Bearer AT-NEW")  # presence read, then setPresence

    def test_a_graph_401_drops_the_cached_token_so_the_next_run_renews(self):
        self.write("access-token", self.cache_for("AT-OLD"))
        self.fake.presence = lambda request: graph_error(401)
        code, _ = self.run_once()
        self.assertTrue(str(code).startswith("stay-green: 401 InvalidAuthenticationToken"), code)
        self.assertEqual(self.files(), ["refresh-token"])
        self.assertEqual(self.read("refresh-token"), "RT-OLD")
        self.fake.presence = lambda request: presence()
        code, _ = self.run_once()
        self.assertIsNone(code)
        self.assertEqual(len(self.fake.token_requests), 1)
        self.assertEqual(self.fake.set_presence_requests[0]["auth"], "Bearer AT-NEW")

    def test_each_refused_renewal_is_marked_and_the_next_run_does_not_contact_microsoft(self):
        for code in REFUSALS:
            with self.subTest(code):
                self.write("refresh-token", "RT-OLD")
                for name in ("renewal-failed", "access-token"):
                    (self.state / name).unlink(missing_ok=True)
                self.fake.token = lambda request, code=code: token_error(code)
                first, _ = self.run_once()
                self.assertTrue(str(first).startswith(f"stay-green: 400 {code}: "), first)
                self.assertTrue((self.state / "renewal-failed").exists())
                self.assertEqual(self.read("refresh-token"), "RT-OLD")
                second, _ = self.run_once()
                self.assertIn("the sign-in was rejected earlier", str(second))
                self.assertEqual(self.fake.requests, [])

    def test_a_failure_that_may_pass_fails_that_run_and_marks_nothing(self):
        transient = {
            "connection dropped": DROP,
            "429": token_error("temporarily_unavailable", 429),
            "500": token_error("server_error", 500),
            "503": token_error("temporarily_unavailable", 503),
            "400 with a code outside the five": token_error("invalid_request"),
            "400 invalid_scope": token_error("invalid_scope"),
            "403 page of a proxy": html(403),
            "408 page": html(408),
            "502 page": html(502),
            "200 page": html(200),
            "200 null": Reply(200, None),
            "200 list": Reply(200, []),
            "200 string": Reply(200, "token"),
            "400 object without error": Reply(400, {"error_description": "something"}),
            "400 with a list as error": Reply(400, {"error": ["invalid_grant"]}),
            "400 null": Reply(400, None),
            "502 page cut short": Reply(502, b"<html>bad", declared_length=200),
        }
        for label, reply in transient.items():
            with self.subTest(label):
                self.write("refresh-token", "RT-OLD")
                (self.state / "access-token").unlink(missing_ok=True)
                self.fake.token = lambda request, reply=reply: reply
                code, _ = self.run_once()
                self.assertTrue(str(code).startswith("stay-green:"), code)
                self.assertEqual(self.files(), ["refresh-token"])
                self.assertEqual(self.read("refresh-token"), "RT-OLD")
                self.fake.token = lambda request: token_ok()
                code, _ = self.run_once()
                self.assertIsNone(code)
                self.assertEqual(len(self.fake.token_requests), 1)

    def test_graph_errors_other_than_401_keep_the_cache_and_mark_nothing(self):
        for status, code in ((403, "Authorization_RequestDenied"), (404, "ResourceNotFound"), (500, "generalException")):
            with self.subTest(status):
                self.write("access-token", self.cache_for("AT-OLD"))
                self.fake.presence = lambda request, status=status, code=code: graph_error(status, code)
                result, _ = self.run_once()
                self.assertTrue(str(result).startswith(f"stay-green: {status} {code}"), result)
                self.assertEqual(self.files(), ["access-token", "refresh-token"])
                self.assertEqual(self.fake.token_requests, [])


class CommandTest(unittest.TestCase):
    # The other tests call main() in the test process. This one starts the script as a command, so its __main__ block
    # runs, and an open umask such as 022 must still leave the files it creates private (docs/reference.md, Files).
    def test_the_command_creates_its_files_private_under_an_open_umask(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "stay-green"
            state.mkdir(mode=0o700)
            env = {**os.environ, "XDG_STATE_HOME": tmp, "STAY_GREEN_SCHEDULE": "Mon-Sun 00:00-24:00"}
            env.pop("STAY_GREEN_TIME_ZONE", None)
            # No sign-in is stored, so the run stops after it takes the lock and before any request.
            result = subprocess.run([sys.executable, str(ROOT / "stay-green"), "run"], env=env, umask=0o022,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertIn("no sign-in", result.stderr)
            self.assertEqual(mode_of(state / "lock"), 0o600)


if __name__ == "__main__":
    unittest.main()
