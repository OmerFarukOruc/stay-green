"""Contracts of the stored sign-in that need no Microsoft account: the command that `login HOST` runs on HOST, and the
lock that it shares with `run`. The store tests send that command through a real SSH server on this computer, named
by STAY_GREEN_TEST_SSH_HOST (CI sets it to localhost), and the lock tests hold the lock with the real flock(1)."""
import fcntl
import os
import shlex
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

from harness import MADE_UP_REFRESH_TOKEN, mode_of, sg, stay_green

HOST = os.environ.get("STAY_GREEN_TEST_SSH_HOST")
NEW_TOKEN = "new-refresh-token-" + "x" * 1400  # Microsoft's refresh tokens are about 1.4 KB
OLD_TOKEN = "old-refresh-token\n"
HOLD = 4  # seconds that a test holds the lock


class StateCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.state = self.home / "stay-green"
        self.state.mkdir(mode=0o700)

    def files(self):
        return sorted(p.name for p in self.state.iterdir())


class StoreTest(StateCase):
    """The state folder on HOST is this test's folder, because HOST is this computer."""

    def setUp(self):
        if not HOST:
            if os.environ.get("CI"):
                self.fail("STAY_GREEN_TEST_SSH_HOST is not set")
            self.skipTest("set STAY_GREEN_TEST_SSH_HOST to an SSH host that is this computer, such as localhost")
        super().setUp()
        # An old sign-in in a folder and a file that others can read, as an older version left them.
        self.state.chmod(0o755)
        (self.state / "refresh-token").write_text(OLD_TOKEN)
        (self.state / "refresh-token").chmod(0o644)
        (self.state / "access-token").write_text("{}")
        (self.state / "renewal-failed").write_text("400 invalid_grant\n")

    def store(self, data):
        # The command that login HOST sends, with XDG_STATE_HOME set to this test's folder.
        command = f"XDG_STATE_HOME={shlex.quote(str(self.home))} sh -c {shlex.quote(sg.STORE_ON_HOST)}"
        return subprocess.run(["ssh", "-o", "BatchMode=yes", "--", HOST, command], input=data, text=True,
                              capture_output=True, timeout=60)

    def test_a_whole_token_replaces_the_old_sign_in_in_a_private_file_and_folder(self):
        result = self.store(NEW_TOKEN + "\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.state / "refresh-token").read_text(), NEW_TOKEN + "\n")
        self.assertEqual(mode_of(self.state / "refresh-token"), 0o600)
        self.assertEqual(mode_of(self.state), 0o700)
        self.assertEqual(self.files(), ["lock", "refresh-token"])

    def test_input_that_ends_before_the_line_break_keeps_the_old_sign_in(self):
        # The connection drops in the middle of the token, or right after it, before the line break that ends it.
        for cut in (30, len(NEW_TOKEN)):
            with self.subTest(cut=cut):
                result = self.store(NEW_TOKEN[:cut])
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((self.state / "refresh-token").read_text(), OLD_TOKEN)
                self.assertNotIn(".refresh-token.", " ".join(self.files()))

    def test_the_store_waits_while_stay_green_holds_the_lock(self):
        held = threading.Event()

        def hold():
            with sg.locked(self.state):
                held.set()
                time.sleep(HOLD)

        holder = threading.Thread(target=hold)
        holder.start()
        self.addCleanup(holder.join)
        self.assertTrue(held.wait(10))
        start = time.monotonic()
        result = self.store(NEW_TOKEN + "\n")
        waited = time.monotonic() - start
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreater(waited, HOLD - 1)
        self.assertEqual((self.state / "refresh-token").read_text(), NEW_TOKEN + "\n")


class RunLockTest(StateCase):
    def test_a_run_waits_for_the_lock_before_it_renews(self):
        (self.state / "refresh-token").write_text(MADE_UP_REFRESH_TOKEN)
        lock = self.state / "lock"
        holder = subprocess.Popen(["flock", str(lock), "sleep", str(HOLD)])
        self.addCleanup(holder.wait)
        wait_until_locked(lock)
        start = time.monotonic()
        result = stay_green(self.home, "run")
        waited = time.monotonic() - start
        self.assertGreater(waited, HOLD - 1)
        # After the wait, the run renews, and Microsoft refuses the made-up token.
        self.assertIn("400 invalid_grant", result.stderr)
        self.assertTrue((self.state / "renewal-failed").exists())


def wait_until_locked(path):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if path.exists():
            with open(path, "a") as file:
                try:
                    fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return
                fcntl.flock(file, fcntl.LOCK_UN)
        time.sleep(0.05)
    raise AssertionError(f"flock never took {path}")


if __name__ == "__main__":
    unittest.main()
