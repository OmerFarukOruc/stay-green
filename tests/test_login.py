"""Contracts of `stay-green login`: the remote store of `login HOST`, and a sign-in that overlaps a renewal. The real
login runs with a fake browser that follows the redirects, a fake Microsoft on local HTTP, and, for HOST, a fake ssh
that runs the real remote command with the system sh (dash on GitHub's Ubuntu runners)."""
import contextlib
import io
import json
import os
import threading
import unittest
from unittest import mock

from harness import ScriptCase, install_fake_ssh, mode_of, open_url_like_a_browser, sg, token_ok

NEW_TOKEN = "RT-NEW-ACCOUNT-" + "x" * 80


class LoginCase(ScriptCase):
    def setUp(self):
        super().setUp()
        browser = mock.patch.object(sg.webbrowser, "open", open_url_like_a_browser)
        browser.start()
        self.addCleanup(browser.stop)


class RemoteStoreTest(LoginCase):
    def setUp(self):
        super().setUp()
        ssh = install_fake_ssh(self.tmp / "bin")
        ssh.start()
        self.addCleanup(ssh.stop)
        self.fake.token = lambda request: token_ok(access="AT-B", refresh=NEW_TOKEN)
        # The state folder of HOST. The fake ssh runs on this computer, so it reads XDG_STATE_HOME as HOST would.
        self.remote = self.tmp / "remote" / "stay-green"
        self.remote.mkdir(parents=True)
        self.remote.chmod(0o755)
        for name, text in (("refresh-token", "RT-OLD\n"), ("access-token", "{}"), ("renewal-failed", "x\n")):
            (self.remote / name).write_text(text)
        (self.remote / "refresh-token").chmod(0o644)
        env = mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(self.remote.parent)})
        env.start()
        self.addCleanup(env.stop)

    def login(self, cut=None):
        env = {"FAKE_SSH_CUT": str(cut)} if cut is not None else {}
        with mock.patch.dict(os.environ, env):
            return self.cli("login", "box")

    def test_a_connection_cut_before_the_line_break_keeps_the_old_token_and_fails_the_login(self):
        for label, cut in (("in the middle of the token", 30), ("after the last character, before the line break", len(NEW_TOKEN))):
            with self.subTest(label):
                code, _ = self.login(cut)
                self.assertEqual(code, "stay-green: could not store the sign-in on box")
                self.assertEqual((self.remote / "refresh-token").read_text(), "RT-OLD\n")

    def test_a_complete_store_leaves_a_private_file_in_a_private_folder_and_drops_the_old_state(self):
        code, out = self.login()
        self.assertIsNone(code)
        self.assertIn("Stored the sign-in on box.", out)
        self.assertEqual((self.remote / "refresh-token").read_text().strip(), NEW_TOKEN)
        self.assertEqual(mode_of(self.remote / "refresh-token"), 0o600)
        self.assertEqual(mode_of(self.remote), 0o700)
        self.assertEqual(sorted(p.name for p in self.remote.iterdir()), ["lock", "refresh-token"])


class LocalStoreTest(LoginCase):
    def test_a_local_sign_in_into_an_open_folder_leaves_a_private_folder_and_file(self):
        # docs/reference.md (Files): the folder has mode 700 and each file mode 600.
        self.state.chmod(0o755)
        self.fake.token = lambda request: token_ok(access="AT-B", refresh=NEW_TOKEN)
        code, _ = self.cli("login")
        self.assertIsNone(code)
        self.assertEqual(self.read("refresh-token"), NEW_TOKEN)
        self.assertEqual(mode_of(self.state), 0o700)
        self.assertEqual(mode_of(self.state / "refresh-token"), 0o600)


class LoginDuringRenewalTest(LoginCase):
    def test_a_sign_in_that_starts_while_a_run_renews_account_a_ends_with_account_b_stored(self):
        self.write("refresh-token", "RT-A1")
        renewing, release, exchanged = threading.Event(), threading.Event(), threading.Event()

        def token(request):
            form = request["form"]
            if form["grant_type"] == "authorization_code":
                exchanged.set()
                return token_ok(access="AT-B", refresh="RT-B")
            # Each account's refresh token gets that account's tokens, as Microsoft answers.
            if form["refresh_token"] == "RT-A1":
                renewing.set()
                release.wait(20)
                return token_ok(access="AT-A", refresh="RT-A2")
            return token_ok(access="AT-B2", refresh="RT-B2")

        self.fake.token = token
        failures = []

        def guarded(fn, *args):
            def target():
                try:
                    fn(*args)
                except BaseException as error:
                    failures.append(error)
            return threading.Thread(target=target, daemon=True)

        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            runner = guarded(sg.run)
            runner.start()
            self.assertTrue(renewing.wait(20), "the run never asked for a renewal")
            signer = guarded(sg.login, None)
            signer.start()
            self.assertTrue(exchanged.wait(20), "the sign-in never exchanged its code")
            # A login that does not wait for the renewal finishes here. One that waits for the lock is still blocked.
            signer.join(1.0)
            release.set()
            runner.join(20)
            signer.join(20)
        self.assertEqual(failures, [])
        self.assertFalse(runner.is_alive() or signer.is_alive())
        self.assertTrue(self.read("refresh-token").startswith("RT-B"), self.read("refresh-token"))
        if "access-token" in self.files():
            self.assertNotEqual(json.loads(self.read("access-token"))["token"], "AT-A")


if __name__ == "__main__":
    unittest.main()
