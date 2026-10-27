"""Shared helpers for the Python tests: the real script, a fake of Microsoft's endpoints on local HTTP, a fixed clock,
a fake browser, and a fake ssh. Nothing here talks to a real Microsoft or SSH host."""
import contextlib
import copy
import http.server
import importlib.machinery
import importlib.util
import io
import json
import os
import socket
import stat
import sys
import tempfile
import threading
import unittest
import urllib.request
from datetime import datetime
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent


def load_script():
    loader = importlib.machinery.SourceFileLoader("stay_green", str(ROOT / "stay-green"))
    spec = importlib.util.spec_from_loader("stay_green", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


sg = load_script()


def _shapes():
    with open(ROOT / "tests" / "microsoft-shapes.json", encoding="utf-8") as file:
        raw = json.load(file)
    return {name: {k: v for k, v in body.items() if not k.startswith("_")} for name, body in raw.items()
            if not name.startswith("_")}


SHAPES = _shapes()
CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"  # docs/reference.md, Requests to Microsoft
SET_PRESENCE_BODY = {  # docs/reference.md, The setPresence request body is
    "sessionId": "14d82eec-204b-4c2f-b7e8-296a70dab67e",
    "availability": "Available",
    "activity": "Available",
    "expirationDuration": "PT15M",
}


def token_ok(access="AT-NEW", refresh="RT-NEW", expires_in=None):
    body = copy.deepcopy(SHAPES["tokenSuccess"])
    body.update(access_token=access, refresh_token=refresh)
    if expires_in is not None:
        body["expires_in"] = expires_in
    return Reply(200, body)


def token_error(code, status=400):
    body = copy.deepcopy(SHAPES["tokenError"])
    body["error"] = code
    return Reply(status, body)


def graph_error(status, code="InvalidAuthenticationToken"):
    body = copy.deepcopy(SHAPES["graphError"])
    body["error"]["code"] = code
    return Reply(status, body)


def presence(out_of_office=False, availability="Away", **extra):
    body = copy.deepcopy(SHAPES["presence"])
    body["availability"] = availability
    body["outOfOfficeSettings"]["isOutOfOffice"] = out_of_office
    body.update(extra)
    return Reply(200, body)


class Reply:
    """One scripted answer. body is a JSON value, or bytes for an answer that is not JSON."""

    def __init__(self, status, body=b"", content_type=None, declared_length=None, drop=False):
        self.status, self.body, self.drop = status, body, drop
        self.declared_length = declared_length
        if content_type is None:
            content_type = "application/json" if not isinstance(body, bytes) else "text/html"
        self.content_type = content_type


DROP = Reply(0, drop=True)  # the server closes the connection without an answer


def html(status):
    return Reply(status, b"<html><body>Gateway page</body></html>", "text/html")


class FakeMicrosoft:
    """A local HTTP server with the paths of login.microsoftonline.com and graph.microsoft.com. Each endpoint answers
    with the function in token / presence / set_presence, which gets the request record and returns a Reply."""

    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()
        self.token = lambda request: token_ok()
        self.presence = lambda request: presence()
        self.set_presence = lambda request: Reply(200, b"", "text/plain")
        self.code_for_authorize = "CODE-1"
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                outer.handle(self)

            def do_POST(self):
                outer.handle(self)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def handle(self, handler):
        length = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(length) if length else b""
        path = handler.path.split("?")[0]
        request = {"method": handler.command, "path": path, "query": handler.path.partition("?")[2],
                   "auth": handler.headers.get("Authorization"), "raw": raw}
        if handler.headers.get("Content-Type", "").startswith("application/x-www-form-urlencoded"):
            from urllib.parse import parse_qsl
            request["form"] = dict(parse_qsl(raw.decode()))
        elif raw:
            request["json"] = json.loads(raw)
        with self.lock:
            self.requests.append(request)
        if path == "/organizations/oauth2/v2.0/authorize":
            # The documented success redirect: the code and the state go back to redirect_uri.
            from urllib.parse import parse_qsl, urlencode
            query = dict(parse_qsl(request["query"]))
            handler.send_response(302)
            handler.send_header("Location", query["redirect_uri"] + "?" + urlencode(
                {"code": self.code_for_authorize, "state": query["state"]}))
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        if path == "/organizations/oauth2/v2.0/token":
            reply = self.token(request)
        elif path == "/v1.0/me/presence":
            reply = self.presence(request)
        elif path.endswith("/presence/setPresence") and path.startswith("/v1.0/users/"):
            reply = self.set_presence(request)
        else:
            reply = Reply(404, SHAPES["graphError"])
        if reply.drop:
            handler.connection.shutdown(socket.SHUT_RDWR)
            return
        body = reply.body if isinstance(reply.body, bytes) else json.dumps(reply.body).encode()
        handler.send_response(reply.status)
        handler.send_header("Content-Type", reply.content_type)
        handler.send_header("Content-Length", str(reply.declared_length or len(body)))
        handler.end_headers()
        handler.wfile.write(body)
        if reply.declared_length:  # an answer cut short: fewer bytes than declared, then the connection closes
            handler.wfile.flush()
            handler.connection.shutdown(socket.SHUT_RDWR)

    def to(self, path_end):
        return [r for r in self.requests if r["path"].endswith(path_end)]

    @property
    def token_requests(self):
        return self.to("/token")

    @property
    def set_presence_requests(self):
        return self.to("/setPresence")


class Clock:
    """The instant that the script's datetime.now(tz) returns. Move it with set()."""

    def __init__(self, iso):
        self.set(iso)

    def set(self, iso):
        self.timestamp = datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def fixed_datetime(clock):
    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            # fromtimestamp converts the way datetime.now does, for a zone and for the computer's own zone.
            return datetime.fromtimestamp(clock.timestamp, tz)

    return FixedDateTime


class ScriptCase(unittest.TestCase):
    """Real script, real local HTTP, a private state folder, a fixed clock."""

    schedule = "Mon-Sun 00:00-24:00"
    zone = "UTC"
    now = "2026-10-26T10:00:00Z"

    def setUp(self):
        self.fake = FakeMicrosoft()
        self.addCleanup(self.fake.close)
        self.clock = Clock(self.now)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.xdg = self.tmp / "xdg"
        self.state = self.xdg / "stay-green"
        self.state.mkdir(parents=True, mode=0o700)
        env = {"XDG_STATE_HOME": str(self.xdg), "STAY_GREEN_SCHEDULE": self.schedule, "no_proxy": "127.0.0.1",
               "NO_PROXY": "127.0.0.1"}
        if self.zone:
            env["STAY_GREEN_TIME_ZONE"] = self.zone
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        if not self.zone:
            os.environ.pop("STAY_GREEN_TIME_ZONE", None)
        for target, value in (("AUTHORITY", f"{self.fake.base}/organizations/oauth2/v2.0"),
                              ("GRAPH", f"{self.fake.base}/v1.0"),
                              ("datetime", fixed_datetime(self.clock))):
            patch = mock.patch.object(sg, target, value)
            patch.start()
            self.addCleanup(patch.stop)

    def write(self, name, text):
        (self.state / name).write_text(text)

    def read(self, name):
        return (self.state / name).read_text().strip()

    def files(self):
        return sorted(p.name for p in self.state.iterdir() if p.name != "lock")

    def cache_for(self, token="AT-OLD", expires_in=3600):
        import time
        return json.dumps({"token": token, "expires": time.time() + expires_in})

    def cli(self, *args):
        """Runs the script's main() like the command line does. Returns (exit, stdout)."""
        out = io.StringIO()
        with mock.patch.object(sys, "argv", ["stay-green", *args]), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(io.StringIO()):
            try:
                sg.main()
            except SystemExit as error:
                return error.code, out.getvalue()
        return None, out.getvalue()


def mode_of(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def open_url_like_a_browser(url):
    """Follows the redirects of the authorization URL, as a browser does after the user signs in."""
    def follow():
        with urllib.request.urlopen(url, timeout=10) as response:
            response.read()
    thread = threading.Thread(target=follow, daemon=True)
    thread.start()
    return True


FAKE_SSH = """#!/bin/sh
# ssh [--] HOST COMMAND: runs COMMAND through sh, the way ssh runs it through the login shell of HOST.
# FAKE_SSH_CUT=N passes only the first N bytes of the input on, which is what the remote side reads when the
# connection drops after N bytes.
[ "$1" = "--" ] && shift
shift
if [ -n "$FAKE_SSH_CUT" ]; then head -c "$FAKE_SSH_CUT" | sh -c "$1"; else sh -c "$1"; fi
"""


def install_fake_ssh(directory):
    """Puts a fake ssh first on PATH. STAY_GREEN_TEST_SH=/path/to/dash makes the sh that it runs that shell."""
    directory = Path(directory)
    directory.mkdir()
    (directory / "ssh").write_text(FAKE_SSH)
    (directory / "ssh").chmod(0o755)
    shell = os.environ.get("STAY_GREEN_TEST_SH")
    if shell:
        (directory / "sh").symlink_to(shell)
    return mock.patch.dict(os.environ, {"PATH": f"{directory}{os.pathsep}{os.environ['PATH']}"})
