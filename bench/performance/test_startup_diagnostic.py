"""Regression for the startup diagnostic's observed OSC over-consumption."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("startup", Path(__file__).with_name("startup-diagnostic.py"))
assert spec is not None and spec.loader is not None
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)


class StartupMatcherTest(unittest.TestCase):
    def test_first_frame_between_st_and_bel_terminated_osc_is_preserved(self):
        stream = b"\x1b]99;query\x1b\\\x1b[2;1Hstartup_probe_7Q\x1b]12;#ffffff\x07"
        self.assertTrue(startup.visible_marker(stream, "startup_probe_7Q"))

    def test_control_string_payloads_cannot_become_visible_content(self):
        for stream in (b"\x1b]0;startup_probe_7Q\x07", b"\x1b]0;startup_probe_7Q\x1b\\",
                       b"\x1bPstartup_probe_7Q\x1b\\", b"\x1b_startup_probe_7Q\x1b\\"):
            self.assertFalse(startup.visible_marker(stream, "startup_probe_7Q"))


if __name__ == "__main__":
    unittest.main()
