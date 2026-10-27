"""Contract: the schedule format of docs/reference.md. tests/schedule-cases.json is read by the Worker tests too."""
import json
import os
import time
import unittest
from unittest import mock

from harness import ROOT, Clock, fixed_datetime, sg

with open(ROOT / "tests" / "schedule-cases.json", encoding="utf-8") as file:
    CASES = json.load(file)

ERROR_TEXT = {  # docs/reference.md, Errors
    "day": "unknown day in STAY_GREEN_SCHEDULE",
    "time": "bad time range in STAY_GREEN_SCHEDULE",
    "zone": "unknown time zone in STAY_GREEN_TIME_ZONE",
}


def decide(schedule, zone, instant):
    """What the script's scheduled() says at the instant, with the real zone lookup and the real parser."""
    clock = Clock(instant)
    env = {"STAY_GREEN_SCHEDULE": schedule}
    if zone is not None:
        env["STAY_GREEN_TIME_ZONE"] = zone
    with mock.patch.dict(os.environ, env), mock.patch.object(sg, "datetime", fixed_datetime(clock)):
        if zone is None:
            os.environ.pop("STAY_GREEN_TIME_ZONE", None)
        return sg.scheduled()


class ScheduleTest(unittest.TestCase):
    def test_valid_schedules_decide_each_instant(self):
        for case in CASES["valid"]:
            for instant, expected in case["at"]:
                with self.subTest(case["name"], instant=instant):
                    self.assertIs(decide(case["schedule"], case["zone"], instant), expected)

    def test_invalid_schedules_and_zones_are_refused_by_the_guard_that_owns_them(self):
        for case in CASES["invalid"]:
            with self.subTest(case["name"]):
                with self.assertRaises(SystemExit) as raised:
                    decide(case["schedule"], case.get("zone", "UTC"), "2026-10-26T10:00:00Z")
                self.assertIn(ERROR_TEXT[case["error"]], str(raised.exception))

    def test_without_a_time_zone_the_computers_zone_decides(self):
        # Mon 09:00 in New York is 14:00 UTC on 2026-03-02, so the same instant is inside only in that zone.
        old = os.environ.get("TZ")
        self.addCleanup(lambda: (os.environ.__setitem__("TZ", old) if old is not None else os.environ.pop("TZ", None),
                                 time.tzset()))
        os.environ["TZ"] = "America/New_York"
        time.tzset()
        self.assertTrue(decide("Mon 09:00-10:00", None, "2026-03-02T14:30:00Z"))
        self.assertFalse(decide("Mon 09:00-10:00", None, "2026-03-02T09:30:00Z"))


if __name__ == "__main__":
    unittest.main()
