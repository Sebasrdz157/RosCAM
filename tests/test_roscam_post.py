"""Machines and the Avid EX post: RosCAM writes files an Avid PRO4848 (Centroid) runs,
in the same format as the Vectric post that machine already uses (tests/fixtures/avid/)."""

import io
import os
import re
import tempfile
import unittest
import zipfile
from types import SimpleNamespace

import roscam
import roscam_post as rp
from tests.fixtures.make_roscam_plate import build as build_plate

HERE = os.path.dirname(os.path.abspath(__file__))
AVID = os.path.join(HERE, 'fixtures', 'avid')


def _sections(path):
    """The move lines after each tool change in a Vectric Avid EX file (N words dropped)."""
    with open(path, newline='') as fh:
        lines = [l.split(' ', 1)[1] for l in fh.read().split('\r\n') if l.strip()]
    sections, cur = [], None
    for line in lines:
        if re.match(r'T\d+ M6$', line):
            cur = 'tool change'
        elif cur == 'tool change' and line == 'G53 Z0':
            cur = []
            sections.append(cur)
        elif isinstance(cur, list):
            if line.startswith('; ----'):
                cur = None
            elif not line.startswith(';'):
                cur.append(line)
    return sections


def _words(line):
    return dict(re.findall(r'([XYZIJF])(\S+)', line))


class AvidFormatTests(unittest.TestCase):
    """The post writes moves exactly like the Vectric Avid EX post did in real files."""

    def test_moves_match_the_vectric_files(self):
        for name in ('cut1_2_two_tools.cnc', 'profile_2.cnc', 'bore.cnc'):
            with self.subTest(file=name):
                total = same = 0
                for section in _sections(os.path.join(AVID, name)):
                    ours = list(rp._moves(rp._motion('\n'.join(section))))
                    self.assertEqual(len(ours), len(section))
                    for theirs, mine in zip(section, ours):
                        total += 1
                        if theirs == mine:
                            same += 1
                            continue
                        # Vectric sometimes repeats an axis whose full-precision value differs
                        # but prints the same to 4 decimals; we leave it out. Same move either way.
                        self.assertEqual(theirs.split()[0], mine.split()[0], (theirs, mine))
                        a, b = _words(theirs), _words(mine)
                        self.assertTrue(set(b) <= set(a) and all(a[k] == v for k, v in b.items()), (theirs, mine))
                        for k in set(a) - set(b):
                            self.assertIn(k, 'XYZ', (theirs, mine))
                self.assertGreater(same / total, 0.98, name)

    def _program(self, gcode, number=5, name='1/4" end mill', rpm=16782, index=1, summary='outline'):
        tool = SimpleNamespace(tool_number=number, name=name, spindle_speed=rpm)
        return SimpleNamespace(gcode=gcode, tool=tool, index=index, feature_summary=summary)

    def test_file_structure(self):
        a = self._program('G0 Z0.5000  ; Safe height\nS16782 M3\n(===== OUTLINE =====)\nG0 X1 Y1\n'
                          'G0 Z0.2\nG1 Z0 F5\nG1 X2 F72.0\nG2 X3 Y2 I1 J0\nG0 Z0.2\n(===== FINISH =====)\n'
                          'G0 Z0.5\nM5\nG0 X0 Y0\nM30\n')
        b = self._program('G0 Z0.5\nG0 X1 Y1\nG1 Z-0.1 F7.5\nG0 Z0.2\n', number=2, name='1/8" (2F) end mill',
                          rpm=30000, index=2, summary='details')
        text = rp.avid_ex('job (1)', [a, b], (24, 48), 0.25, 0.5)
        self.assertTrue(text.endswith('M30\r\n'))
        self.assertNotIn('\n', text.replace('\r\n', ''))      # CRLF only
        lines = text.split('\r\n')[:-1]
        self.assertTrue(all(l.startswith(f'N{10 * (i + 1):04d} ') for i, l in enumerate(lines)))
        body = [l.split(' ', 1)[1] for l in lines]
        self.assertEqual(body[:2], ['; ---------------------------------------------', '; Filename: job 1'])
        self.assertIn(';X 24.000 Y 48.000 Z 0.250', body)
        self.assertIn(';2 = 1/8" 2F end mill', body)          # no parentheses in comments
        i = body.index('T5 M6')
        self.assertEqual(body[i - 4:i + 4], ['; ---------------------------------------------',
                                              '; Toolchange: T5 - Speed: S16782',
                                              '; ---------------------------------------------',
                                              '; Start Tool Change', 'T5 M6', '; Spindle on CW', 'M3  S16782',
                                              '; ---------------------------------------------'])
        self.assertEqual(body[i + 4:i + 13], ['G53 Z0', 'G0 Z0.5000', '; ===== OUTLINE =====', 'G0 X1.0000 Y1.0000',
                                               'G0 Z0.2000', 'G1 Z0.0000 F5', 'G1 X2.0000 F72',
                                               'G2 X3.0000 Y2.0000 I1.0000 J0.0000', 'G0 Z0.2000'])
        # the engine's finish block is not copied; the next bit starts from a safe height
        self.assertNotIn('G0 X0.0000 Y0.0000', body)
        j = body.index('T2 M6')
        self.assertEqual(body[j - 5], 'G0 Z0.5000')
        self.assertIn('G1 Z-0.1000 F7.5', body)
        self.assertEqual(body[-11:], ['G0 Z0.5000', '; ---------------------------------------------', 'G53 Z0',
                                      '; Spindle off', 'M5', '; Coolant Off', 'M9', '; Canned Cycle Cancel', 'G80',
                                      '; End-Custom M Code', 'M30'])

    def test_feed_after_every_rapid(self):
        p = self._program('G0 X0 Y0\nG0 Z0.2\nG1 Z0 F10\nG1 X1\nG0 Z0.2\nG0 X2\nG1 Z0 F10\n')
        moves = list(rp._moves(rp._motion(p.gcode)))
        self.assertEqual(moves, ['G0 X0.0000 Y0.0000', 'G0 Z0.2000', 'G1 Z0.0000 F10', 'G1 X1.0000',
                                 'G0 Z0.2000', 'G0 X2.0000', 'G1 Z0.0000 F10'])

    def test_needs_tool_numbers(self):
        with self.assertRaisesRegex(rp.PostError, 'tool number'):
            rp.avid_ex('j', [self._program('G0 Z1\n', number=None)], (1, 1), 0.25, 0.5)

    def test_refuses_codes_it_does_not_know(self):
        with self.assertRaisesRegex(rp.PostError, 'G4'):
            list(rp._moves(rp._motion('G0 Z1\nG4 P1\n')))


class MachineTests(unittest.TestCase):
    def test_both_machines(self):
        ids = [c.machine_id for c in roscam.machine_configs()]
        self.assertEqual(ids, ['shop', 'avid'])
        self.assertEqual(roscam.base_config().machine_id, 'shop')

    def test_avid_has_its_own_bits_and_the_shops_materials(self):
        shop, avid = roscam.base_config('shop'), roscam.base_config('avid')
        self.assertFalse(set(shop.tools) & set(avid.tools))
        self.assertEqual(avid.post, 'avid_ex')
        self.assertEqual(avid.tool_changes, 'in_file')
        self.assertTrue(all(t.tool_number for t in avid.tools.values()))
        self.assertEqual(set(shop.materials), set(avid.materials))
        for m in shop.materials:
            self.assertEqual([t.label for t in shop.materials[m].thicknesses],
                             [t.label for t in avid.materials[m].thicknesses])
        self.assertEqual(avid.stock_margin, shop.stock_margin)
        self.assertEqual(avid.materials['polycarbonate'].tool_overrides['endmill_1_8']['feed_rate'], 33)

    def test_library_rows_belong_to_one_machine(self):
        row = {'id': 'endmill_1_16', 'name': '1/16 em', 'type': 'endmill', 'diameter': 0.0625,
               'flute_length': 0.25, 'spindle_speed': 30000, 'feed_rate': 10, 'plunge_rate': 3,
               'ramp_feed_rate': 3, 'stepdown': 0.01, 'tool_number': 7}
        avid, _ = roscam.config_with_tools([dict(row, machine='avid')], roscam.base_config('avid'))
        self.assertEqual(avid.tools['endmill_1_16'].tool_number, 7)
        shop, _ = roscam.config_with_tools([dict(row, machine='avid')], roscam.base_config('shop'))
        self.assertNotIn('endmill_1_16', shop.tools)
        old, _ = roscam.config_with_tools([row], roscam.base_config('shop'))     # saved before machines
        self.assertIn('endmill_1_16', old.tools)

    def test_web_options_list_the_machines(self):
        opts = roscam.web_options(machine='avid')
        self.assertEqual(opts['machine']['id'], 'avid')
        self.assertEqual([m['id'] for m in opts['machines']], ['shop', 'avid'])
        self.assertEqual({t['tool_number'] for t in opts['tools']}, {2, 5})


class AvidJobTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.plate = build_plate(os.path.join(cls.tmp.name, 'plate.dxf'))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _job(self, machine):
        sheet = roscam.Sheet.from_dict({'id': 'AL-250-01', 'material': 'aluminum', 'thickness': '1/4',
                                        'width': 24, 'height': 48, 'status': 'active', 'sheet_regions': []})
        return roscam.generate_sheet_job([roscam.PartFile(self.plate, 'plate')], [{'part': 0, 'x': 1, 'y': 1}],
                                         'aluminum', '1/4', sheet, roscam.base_config(machine), {}, [])

    def test_one_file_with_every_bit(self):
        res = self._job('avid')
        self.assertTrue(res.success, res.errors)
        self.assertEqual(res.combined_name, 'plate.cnc')          # named after the job
        self.assertEqual(re.findall(r'N\d+ (T\d+) M6', res.combined_text), ['T2', 'T5'])
        self.assertIn('M3  S30000', res.combined_text)
        with zipfile.ZipFile(io.BytesIO(res.zip_bytes())) as zf:
            self.assertEqual(sorted(zf.namelist()), ['00_plate_SETUP.txt', 'plate.cnc'])
        self.assertIn('Run plate.cnc: one file for every bit.', res.setup_sheet)
        self.assertIn('T2 1/8" end mill', res.setup_sheet)
        self.assertNotIn('Convert each .nc', res.setup_sheet)
        self.assertEqual(res.to_dict()['combined']['name'], 'plate.cnc')
        # its 1/8" end mill takes the small holes the shop drills
        self.assertEqual([p.tool.id for p in res.programs], ['endmill_1_8', 'endmill_1_4_3f'])

    def test_shop_unchanged(self):
        res = self._job('shop')
        self.assertTrue(res.success, res.errors)
        self.assertEqual(res.combined_name, '')
        self.assertIsNone(res.to_dict()['combined'])
        self.assertTrue(all(p.filename.endswith('.nc') for p in res.programs))
        self.assertIn('Convert each .nc file', res.setup_sheet)

    def test_same_toolpath_as_the_engine_wrote(self):
        """The .cnc cutting moves are the engine's, reformatted: same points, same order, same feeds."""
        res = self._job('avid')

        def cuts(text):
            out, pos, feed = [], {}, None
            for line in text.splitlines():
                code = line.split(';')[0].strip()
                code = re.sub(r'^N\d+ ', '', code)
                m = re.match(r'(G[0123])\b', code)
                if not m or code.startswith('G53'):
                    continue
                for k, v in re.findall(r'([XYZF])([-\d.]+)', code):
                    if k == 'F':
                        feed = float(v)
                    else:
                        pos[k] = round(float(v), 4)
                if m.group(1) != 'G0':
                    out.append((m.group(1), pos.get('X'), pos.get('Y'), pos.get('Z'), feed))
            return out
        engine = []
        for p in res.programs:
            engine += cuts(p.gcode.split('(===== FINISH')[0])
        # The engine sometimes moves 0" (to where it already is) after a full circle; the post
        # leaves those out, as Vectric does. Arcs back to their start are full circles: kept.
        engine = [m for i, m in enumerate(engine)
                  if not (i and m[0] == 'G1' and m[1:4] == engine[i - 1][1:4])]
        self.assertEqual(cuts(res.combined_text), engine)

    def test_full_circle_given_by_centre_only(self):
        moves = list(rp._moves(rp._motion('G0 X1 Y1\nG1 Z-0.1 F10\nG3 I-0.5\n')))
        self.assertEqual(moves[-1], 'G3 X1.0000 Y1.0000 I-0.5000 J0.0000')

if __name__ == '__main__':
    unittest.main()
