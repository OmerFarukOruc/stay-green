"""Shared helpers for the Python tests. The tests run the real script against the real Microsoft endpoints, a real
SSH server, and real file locks. They never sign in: the tokens they store are made up, so Microsoft refuses them,
and the tests check what the script does with Microsoft's real answers."""
import importlib.machinery
import importlib.util
import os
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Microsoft cannot read either one, so it answers with its real refusal: invalid_grant from the sign-in service and
# 401 InvalidAuthenticationToken from Graph.
MADE_UP_REFRESH_TOKEN = "made-up-refresh-token-for-the-stay-green-tests"
MADE_UP_ACCESS_TOKEN = "made-up-access-token-for-the-stay-green-tests"
ALWAYS = "Mon-Sun 00:00-24:00"


def load_script():
    loader = importlib.machinery.SourceFileLoader("stay_green", str(ROOT / "stay-green"))
    spec = importlib.util.spec_from_loader("stay_green", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


sg = load_script()


def stay_green(state_home, *args, schedule=ALWAYS, env=None, umask=0o077):
    """Runs the script as a command, the way the timer does, with its state in state_home/stay-green."""
    full = {k: v for k, v in os.environ.items() if not k.startswith("STAY_GREEN_")}
    full.update({"XDG_STATE_HOME": str(state_home), "STAY_GREEN_SCHEDULE": schedule, "STAY_GREEN_TIME_ZONE": "UTC"})
    full.update(env or {})
    return subprocess.run([sys.executable, str(ROOT / "stay-green"), *args], env=full, umask=umask,
                          capture_output=True, text=True, timeout=60)


def closed_port():
    """A local TCP port that nothing listens on, so a connection to it is refused."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class StateCase(unittest.TestCase):
    """A test with an empty state folder of mode 700 at self.state, inside the XDG_STATE_HOME at self.home."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.state = self.home / "stay-green"
        self.state.mkdir(mode=0o700)

    def files(self):
        return sorted(p.name for p in self.state.iterdir())


def fixed_datetime(instant):
    """A datetime class whose now(tz) returns the ISO instant, so the script's schedule check runs at that instant."""
    timestamp = datetime.fromisoformat(instant.replace("Z", "+00:00")).timestamp()

    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            # fromtimestamp converts the way datetime.now does, for a zone and for the computer's own zone.
            return datetime.fromtimestamp(timestamp, tz)

    return FixedDateTime


def mode_of(path):
    return stat.S_IMODE(os.stat(path).st_mode)
