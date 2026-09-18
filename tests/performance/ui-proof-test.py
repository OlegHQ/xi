"""Small regressions for the diagnostic's visible completion boundary."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('ui_proof', Path(__file__).resolve().parents[2] / 'bench/performance/ui-proof.py')
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class VisibleState(unittest.TestCase):
    def test_cells_not_hardware_cursor_or_unrelated_output(self):
        screen = proof.Screen(120, 40)
        stream = proof.pyte.ByteStream(screen)
        stream.feed(b'\x1b[?25l\x1b[2;34HROW00007\x1b[2;34H')
        self.assertIsNone(screen.editor_state())
        stream.feed(b'\x1b[48;2;20;32;46mR\x1b[0m')
        self.assertEqual(screen.editor_state(), (7, '', 'normal'))
        stream.feed(b'\x1b[3;34H\x1b[48;2;20;32;46mROW00008\x1b[0m')
        self.assertIsNone(screen.editor_state(), 'two painted cursors are ambiguous')

    def test_wide_cell_and_synchronized_frame(self):
        screen = proof.Screen(120, 40)
        stream = proof.pyte.ByteStream(screen)
        observed = []
        screen.on_frame = lambda: observed.append(screen.editor_state())
        stream.feed('\x1b[?2026h\x1b[2;34Haé漢'.encode())
        # Core may explicitly overwrite the wide glyph continuation with a space.
        stream.feed(b'\x1b[2;37H \x1b[4mROW00005\x1b[0m')
        self.assertEqual(observed, [])
        stream.feed(b'\x1b[?2026l')
        self.assertEqual(observed, [(5, 'aé漢', 'insert')])

    def test_oracle_cursor_and_orphan_wide_continuation(self):
        screen = proof.Screen(120, 40, oracle=True)
        stream = proof.pyte.ByteStream(screen)
        stream.feed(b'\x1b[2;1HROW00002\x1b[2;1H\x1b[?25h')
        self.assertEqual(screen.editor_state(), (2, '', 'normal'))
        stream.feed(b'\x1b[?25l')
        self.assertIsNone(screen.editor_state())
        screen.buffer[0][0] = screen.default_char._replace(data='')
        self.assertEqual(screen.display[0], ' ' * 120)


if __name__ == '__main__':
    unittest.main()
