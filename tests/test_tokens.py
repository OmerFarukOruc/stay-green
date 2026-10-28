"""Contracts of `stay-green run` that the real Microsoft endpoints show without a sign-in: when the script contacts
Microsoft, and how it keeps, renews, and drops the tokens it stores. Each test runs the script as a command against
the real sign-in service and Graph, which refuse the made-up tokens it holds."""
import json
import tempfile
import time
import unittest
from pathlib import Path

from harness import MADE_UP_ACCESS_TOKEN, MADE_UP_REFRESH_TOKEN, closed_port, mode_of, stay_green

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


class TokenCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.state = self.home / "stay-green"
        self.state.mkdir(mode=0o700)
        self.write("refresh-token", MADE_UP_REFRESH_TOKEN)

    def write(self, name, text):
        (self.state / name).write_text(text)

    def read(self, name):
        return (self.state / name).read_text()

    def exists(self, name):
        return (self.state / name).exists()

    def cache(self, seconds_left):
        self.write("access-token", json.dumps({"token": MADE_UP_ACCESS_TOKEN, "expires": time.time() + seconds_left}))

    def run_command(self, **options):
        return stay_green(self.home, "run", **options)


class RefusalTest(TokenCase):
    def test_a_refresh_token_that_microsoft_refuses_is_marked_and_not_sent_again(self):
        first = self.run_command()
        self.assertEqual(first.returncode, 1)
        self.assertIn("400 invalid_grant: AADSTS", first.stderr)
        mark = self.read("renewal-failed")
        self.assertIn("invalid_grant", mark)
        self.assertEqual(mode_of(self.state / "renewal-failed"), 0o600)

        second = self.run_command()
        self.assertEqual(second.returncode, 1)
        self.assertIn("the sign-in was rejected earlier (400 invalid_grant", second.stderr)
        # Each answer from Microsoft carries a new trace ID, so a second request would have changed the mark.
        self.assertEqual(self.read("renewal-failed"), mark)

    def test_a_network_failure_fails_only_that_run_and_the_next_run_tries_again(self):
        # Every request goes to a proxy port that refuses the connection, the way an offline computer fails.
        proxy = f"http://127.0.0.1:{closed_port()}"
        offline = self.run_command(env={"https_proxy": proxy, "HTTPS_PROXY": proxy, "no_proxy": "", "NO_PROXY": ""})
        self.assertEqual(offline.returncode, 1)
        self.assertIn("unreachable", offline.stderr)
        self.assertFalse(self.exists("renewal-failed"))

        online = self.run_command()
        self.assertIn("400 invalid_grant", online.stderr)
        self.assertTrue(self.exists("renewal-failed"))


class CacheTest(TokenCase):
    def test_a_cached_access_token_is_used_until_5_minutes_before_it_expires(self):
        # Graph refuses the made-up access token with 401, and the sign-in service refuses the refresh token, so the
        # answer shows which of the two the run sent.
        for seconds_left, renews in ((400, False), (200, True)):
            with self.subTest(seconds_left=seconds_left):
                (self.state / "renewal-failed").unlink(missing_ok=True)
                self.cache(seconds_left)
                result = self.run_command()
                self.assertEqual(result.returncode, 1)
                if renews:
                    self.assertIn("400 invalid_grant", result.stderr)
                    self.assertTrue(self.exists("renewal-failed"))
                else:
                    self.assertIn("401 InvalidAuthenticationToken", result.stderr)
                    self.assertFalse(self.exists("renewal-failed"))

    def test_graph_refusing_the_cached_access_token_drops_it_so_the_next_run_renews(self):
        self.cache(3600)
        refused = self.run_command()
        self.assertIn("401 InvalidAuthenticationToken", refused.stderr)
        self.assertFalse(self.exists("access-token"))

        renewed = self.run_command()
        self.assertIn("400 invalid_grant", renewed.stderr)
        self.assertTrue(self.exists("renewal-failed"))

    def test_a_damaged_cached_access_token_leads_to_a_renewal(self):
        for text in ("", "{not json", "[]", '{"token": "x"}', '{"token": "x", "expires": "soon"}'):
            with self.subTest(text=text):
                (self.state / "renewal-failed").unlink(missing_ok=True)
                self.write("access-token", text)
                result = self.run_command()
                self.assertNotIn("Traceback", result.stderr)
                self.assertIn("400 invalid_grant", result.stderr)
                self.assertTrue(self.exists("renewal-failed"))


class ScheduleRunTest(TokenCase):
    def test_outside_the_schedule_the_run_contacts_nobody(self):
        # A day three days away is outside the schedule for the whole test, even across midnight.
        other_day = DAYS[(time.gmtime().tm_wday + 3) % 7]
        result = self.run_command(schedule=f"{other_day} 00:00-24:00")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        # A request would have left the refusal mark or taken the lock.
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), ["refresh-token"])


class CommandTest(unittest.TestCase):
    def test_the_command_creates_its_files_private_under_an_open_umask(self):
        # docs/reference.md (Files): each file has mode 600, whatever umask the timer or the shell starts it with.
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "stay-green"
            state.mkdir(mode=0o700)
            # No sign-in is stored, so the run stops after it takes the lock and before any request.
            result = stay_green(tmp, "run", umask=0o022)
            self.assertEqual(result.returncode, 1)
            self.assertIn("no sign-in", result.stderr)
            self.assertEqual(mode_of(state / "lock"), 0o600)


if __name__ == "__main__":
    unittest.main()
