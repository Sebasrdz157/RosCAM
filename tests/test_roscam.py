"""Tests for RosCAM: tool library, hole-to-drill matching, per-tool programs,
stock-top Z zero, peck expansion, and preflight checks."""

import copy
import io
import math
import os
import tempfile
import unittest
import zipfile

import ezdxf
import yaml

import roscam
from tests.fixtures.make_roscam_plate import build as build_plate

HERE = os.path.dirname(os.path.abspath(__file__))
INCH_PER_MM = 1 / 25.4


def _dxf(tmpdir, holes, size=(4.0, 3.0), name='p.dxf', extra=None):
    doc = ezdxf.new(units=1)
    msp = doc.modelspace()
    w, h = size
    msp.add_lwpolyline([(0, 0), (w, 0), (w, h), (0, h)], close=True)
    for x, y, dia in holes:
        msp.add_circle((x, y), dia / 2)
    if extra:
        extra(msp)
    path = os.path.join(tmpdir, name)
    doc.saveas(path)
    return path


def _min_z(gcode):
    return roscam.analyze_motion(gcode).z_min


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.cfg = roscam.load_config()

    def test_shop_tools_loaded(self):
        em = self.cfg.profile_tool
        self.assertEqual(em.type, 'endmill')
        self.assertAlmostEqual(em.diameter, 0.25)
        self.assertAlmostEqual(em.flute_length, 0.75)
        self.assertEqual(em.spindle_speed, 17820)
        self.assertAlmostEqual(em.feed_rate, 144.0)
        self.assertAlmostEqual(em.plunge_rate, 10.0)
        self.assertAlmostEqual(em.stepdown, INCH_PER_MM)
        drills = {d.id: d for d in self.cfg.drills}
        self.assertAlmostEqual(drills['drill_13_64'].diameter, 13 / 64)
        self.assertAlmostEqual(drills['drill_13_64'].flute_length, 1.25)
        self.assertAlmostEqual(drills['drill_5_32'].diameter, 5 / 32)
        self.assertAlmostEqual(drills['drill_5_32'].flute_length, 2.0)
        for d in drills.values():   # from the shop's VCarve 1364.mmg
            self.assertEqual(d.spindle_speed, 6900)
            self.assertAlmostEqual(d.plunge_rate, 30.0)
            self.assertAlmostEqual(d.peck, 1.2 * INCH_PER_MM)
            self.assertAlmostEqual(d.peck_retract, 0.38 * INCH_PER_MM)

    def test_machine_and_setup(self):
        self.assertEqual((self.cfg.x_max, self.cfg.y_max, self.cfg.z_max), (24.0, 48.0, 2.0))
        self.assertAlmostEqual(self.cfg.overcut, INCH_PER_MM)
        self.assertFalse(self.cfg.remove_tabs)

    def test_materials_and_thicknesses(self):
        for mat in ('aluminum', 'polycarbonate'):
            m = self.cfg.material(mat)
            self.assertEqual([t.label for t in m.thicknesses], ['1/16', '1/8', '1/4'])
            for t in m.thicknesses:
                self.assertLess(t.tab_height, t.value / 2, 'tab must be thinner than half the stock')
        self.assertEqual(self.cfg.material('aluminum').find_thickness('0.25').label, '1/4')
        with self.assertRaises(ValueError):
            self.cfg.material('aluminum').find_thickness('3/16')
        with self.assertRaises(ValueError):
            self.cfg.material('wood')

    def test_drill_tip_length_118(self):
        d = self.cfg.tools['drill_13_64']
        self.assertAlmostEqual(d.tip_length, 0.30 * d.diameter, delta=0.002)

    def test_added_tool_is_used(self):
        with open(roscam.DEFAULT_CONFIG_PATH) as fh:
            data = yaml.safe_load(fh)
        data['tools']['drill_1_8'] = {'name': '1/8 drill', 'type': 'drill', 'diameter': '1/8',
                                      'flute_length': 1.0, 'tip_angle': 118, 'spindle_speed': 8000,
                                      'plunge_rate': 30, 'peck': '1/64'}
        cfg = roscam.load_config(data=data)
        self.assertEqual(roscam.match_drill(0.125, cfg).id, 'drill_1_8')

    def test_material_tool_overrides(self):
        with open(roscam.DEFAULT_CONFIG_PATH) as fh:
            data = yaml.safe_load(fh)
        data['materials']['polycarbonate']['tool_overrides'] = {
            'endmill_1_4': {'spindle_speed': 20978, 'feed_rate': 32.7, 'stepdown': '1.651mm'}}
        cfg = roscam.load_config(data=data)
        poly = cfg.material('polycarbonate').tool(cfg.profile_tool)
        self.assertEqual(poly.spindle_speed, 20978)
        self.assertAlmostEqual(poly.stepdown, 0.065)
        self.assertAlmostEqual(poly.plunge_rate, 10.0)  # not overridden
        self.assertEqual(cfg.material('aluminum').tool(cfg.profile_tool).spindle_speed, 17820)
        data['materials']['polycarbonate']['tool_overrides'] = {'endmill_1_4': {'diameter': 0.5}}
        with self.assertRaises(ValueError):
            roscam.load_config(data=data)

    def test_rejects_bad_config(self):
        with open(roscam.DEFAULT_CONFIG_PATH) as fh:
            data = yaml.safe_load(fh)
        bad = copy.deepcopy(data)
        bad['setup']['stock_margin'] = 0.1
        with self.assertRaises(ValueError):
            roscam.load_config(data=bad)
        bad = copy.deepcopy(data)
        bad['profile_tool'] = 'drill_5_32'
        with self.assertRaises(ValueError):
            roscam.load_config(data=bad)


class HolePlanTests(unittest.TestCase):
    def setUp(self):
        self.cfg = roscam.load_config()

    def _plan(self, diameters, overrides=None):
        circles = [{'center': (i, 0), 'diameter': d} for i, d in enumerate(diameters)]
        return roscam.plan_holes(circles, self.cfg, overrides)

    def test_matches_drills_within_tolerance(self):
        groups, errors, _ = self._plan([0.203125, 0.201, 0.15625, 0.159])
        self.assertEqual(errors, [])
        tools = {g.key: g.tool_id for g in groups}
        self.assertEqual(tools['0.2031'], 'drill_13_64')
        self.assertEqual(tools['0.2010'], 'drill_13_64')
        self.assertEqual(tools['0.1562'], 'drill_5_32')
        self.assertEqual(tools['0.1590'], 'drill_5_32')

    def test_big_holes_milled(self):
        groups, errors, _ = self._plan([0.5, 1.125])
        self.assertEqual(errors, [])
        self.assertTrue(all(g.tool_id == roscam.MILL for g in groups))

    def test_small_unmatched_hole_is_error(self):
        groups, errors, _ = self._plan([0.125])
        self.assertEqual(len(errors), 1)
        self.assertIn('match no drill', errors[0])
        self.assertIsNone(groups[0].tool_id)

    def test_override_to_mill_and_drill(self):
        groups, errors, warnings = self._plan([0.5], {'0.5000': 'drill_13_64'})
        self.assertEqual(errors, [])
        self.assertEqual(groups[0].tool_id, 'drill_13_64')
        self.assertEqual(groups[0].auto_tool_id, roscam.MILL)
        self.assertTrue(warnings)  # drilling a 1/2" hole with a 13/64" drill is flagged
        _, errors, _ = self._plan([0.203125], {'0.2031': roscam.MILL})
        self.assertIn('cannot be milled', errors[0])
        _, errors, _ = self._plan([0.5], {'0.5000': 'no_such_drill'})
        self.assertIn('unknown drill', errors[0])

    def test_same_size_as_endmill_warns(self):
        groups, errors, warnings = self._plan([0.25])
        self.assertEqual(errors, [])
        self.assertEqual(groups[0].tool_id, roscam.MILL)
        self.assertTrue(any('plunge' in w for w in warnings))


class GcodeHelperTests(unittest.TestCase):
    def test_shift_z_code_and_comments(self):
        out = roscam.shift_z(['G1 X1 Z0.0600 F10  ; tab at Z0.0600',
                              '(===== PASS 1/2 - cutting to 0.214" =====)'], -0.25)
        self.assertEqual(out[0], 'G1 X1 Z-0.1900 F10  ; tab at Z-0.1900')
        self.assertIn('cutting to Z-0.0360"', out[1])

    def test_peck_moves(self):
        moves = roscam._peck_moves(-0.05, 0.1, 0.02, 45, end_at_bottom=False)
        feeds = [m for m in moves if m.startswith('G1')]
        self.assertEqual(feeds, ['G1 Z-0.0200 F45', 'G1 Z-0.0400 F45', 'G1 Z-0.0500 F45'])
        self.assertEqual(moves[-1], 'G0 Z0.1000')
        self.assertIn('G0 Z-0.0100', moves)  # rapid back to just above the last peck

    def test_chip_break_pecks_like_vcarve(self):
        # 1364.mmg: G1 Z-1.206, G00 Z-0.825, G1 Z-2.413, ... (mm)
        moves = roscam._peck_moves(-0.19, 0.1, 0.0475, 30, end_at_bottom=False, chip_break=0.015)
        self.assertEqual(moves[:5], ['G0 Z0.1000', 'G1 Z-0.0475 F30', 'G0 Z-0.0325',
                                     'G1 Z-0.0950 F30', 'G0 Z-0.0800'])
        self.assertEqual(moves[-2:], ['G1 Z-0.1900 F30', 'G0 Z0.1000'])
        self.assertNotIn('G0 Z0.1000', moves[1:-1])  # never pulls out mid-hole

    def test_linearize_helices(self):
        lines = ['G0 X1.0000 Y0.0000', 'G1 Z0.0000 F30',
                 'G3 X1.0000 Y0.0000 I-1.0000 J0 Z-0.1000 F30  ; helix',
                 'G3 X1.0000 Y0.0000 I-1.0000 J0 F144  ; flat circle']
        out = roscam.linearize_helices(lines)
        moves = [l for l in out if l.startswith('G1 X')]
        self.assertEqual(len(moves), 36)
        self.assertEqual(moves[-1], 'G1 X1.0000 Y0.0000 Z-0.1000')
        self.assertIn('G1 X0.0000 Y1.0000 Z-0.0250', moves)  # quarter turn CCW, quarter depth
        self.assertEqual(out[-1], lines[-1])  # flat arc kept as an arc
        cw = roscam.linearize_helices(['G0 X1 Y0', 'G1 Z0 F30', 'G2 X1 Y0 I-1 J0 Z-0.1 F30'])
        self.assertIn('G1 X0.0000 Y-1.0000 Z-0.0250', cw)

    def test_single_plunge_when_no_peck(self):
        moves = roscam._peck_moves(-0.3, 0.1, 0.0, 45)
        self.assertEqual(moves, ['G0 Z0.1000', 'G1 Z-0.3000 F45'])

    def test_expand_g83(self):
        out = roscam.expand_canned_cycles(
            ['G0 X1 Y1', 'G83 X1.0000 Y1.0000 Z-0.0400 R0.3500 Q0.1000 F10  ; peck', 'G80  ; Cancel'],
            top=0.25)
        joined = '\n'.join(out)
        self.assertNotIn('G83', joined)
        self.assertNotIn('G80', joined)
        self.assertIn('G1 Z0.1500 F10', joined)
        self.assertEqual(out[-1], 'G1 Z-0.0400 F10')  # left at the bottom for the spiral pass


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.cfg = roscam.load_config()
        self.drill = self.cfg.tools['drill_13_64']
        self.em = self.cfg.profile_tool

    def test_drill_side_cut_rejected(self):
        g = 'G0 X1 Y1\nG0 Z0.1\nG1 Z-0.3 F45\nG1 X2 F45\nG0 Z0.2'
        errors, _ = roscam.preflight(g, self.drill, -0.35, self.cfg)
        self.assertTrue(any('straight down' in e for e in errors))

    def test_rapid_below_stock_rejected(self):
        g = 'G0 X1 Y1\nG1 Z-0.1 F10\nG0 X3 Y1'
        errors, _ = roscam.preflight(g, self.em, -0.3, self.cfg)
        self.assertTrue(any('rapid' in e for e in errors))

    def test_too_deep_for_flutes(self):
        g = 'G0 X1 Y1\nG1 Z-0.9 F10\nG0 Z0.5'
        errors, _ = roscam.preflight(g, self.em, -0.9, self.cfg)
        self.assertTrue(any('cutting length' in e for e in errors))

    def test_outside_work_area(self):
        g = 'G0 X25 Y1'
        errors, _ = roscam.preflight(g, self.em, -0.3, self.cfg)
        self.assertTrue(any('work area' in e for e in errors))
        errors, _ = roscam.preflight('G0 X-0.2 Y1', self.em, -0.3, self.cfg)
        self.assertTrue(any('off the stock' in e for e in errors))


class JobTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.plate = build_plate(os.path.join(cls.tmp.name, 'plate.dxf'))
        cls.cfg = roscam.load_config()
        cls.res = roscam.generate_job(cls.plate, 'aluminum', '1/4', cls.cfg, timestamp='2026-01-01 00:00')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_one_program_per_tool_in_order(self):
        self.assertTrue(self.res.success, self.res.errors)
        names = [p.filename for p in self.res.programs]
        self.assertEqual(names, ['01_plate_drill_5-32.nc', '02_plate_drill_13-64.nc',
                                 '03_plate_endmill_1-4.nc'])
        for p in self.res.programs:
            self.assertEqual(sum(1 for l in p.gcode.splitlines() if l.startswith('S')), 1)
            self.assertIn(f'S{p.tool.spindle_speed} M3', p.gcode)
            self.assertIn('M30', p.gcode)
            self.assertNotIn('G83', p.gcode)
            self.assertNotIn('G53', p.gcode)

    def test_drill_depths_and_counts(self):
        thk, over = 0.25, INCH_PER_MM
        for p, n in ((self.res.programs[0], 2), (self.res.programs[1], 5)):
            expected = -(thk + over + p.tool.tip_length)
            self.assertAlmostEqual(_min_z(p.gcode), expected, places=3)
            self.assertEqual(p.gcode.count('(Hole '), n)
            st = roscam.analyze_motion(p.gcode)
            self.assertEqual(st.side_cuts_below_top, 0)
            self.assertEqual(st.rapids_below_top, 0)

    def test_drill_hole_positions_offset_by_margin(self):
        drilled = self.res.programs[0].gcode
        self.assertIn('G0 X3.0000 Y1.0000', drilled)  # (2.5, 0.5) + 0.5" margin
        self.assertIn('G0 X4.0000 Y1.0000', drilled)

    def test_endmill_program(self):
        p = self.res.programs[2]
        st = roscam.analyze_motion(p.gcode)
        self.assertAlmostEqual(st.z_min, -(0.25 + INCH_PER_MM), places=3)
        self.assertGreaterEqual(st.x_min, 0.0)
        self.assertGreaterEqual(st.y_min, 0.0)
        self.assertAlmostEqual(st.x_max, 6.5 + 0.125, places=3)
        self.assertEqual(st.rapids_below_top, 0)
        self.assertIn('PERIMETER WITH TABS', p.gcode)
        self.assertIn('mill 2 holes', p.feature_summary)
        self.assertIn('1 pocket', p.feature_summary)
        # Tabs leave 0.05" above the stock bottom: Z = -0.25 + 0.05
        self.assertIn('Z-0.2000', p.gcode)
        # Ramps are straight moves: no arc changes Z (the converter warns on helices)
        for line in p.gcode.splitlines():
            code = line.split(';')[0]
            if code.startswith(('G2 ', 'G3 ')):
                self.assertNotIn('Z', code, line)
        # Every comment fits the converter's 60-character comment limit
        for line in p.gcode.splitlines()[:12]:
            if line.startswith('('):
                self.assertLessEqual(len(line) - 2, 60, line)
        # 1 mm step-downs: 0.289" total -> 8 passes
        self.assertIn('PASS 8/8', p.gcode)
        self.assertNotIn('PASS 9/', p.gcode)
        self.assertIn('S17820 M3', p.gcode)
        self.assertIn('F144', p.gcode)

    def test_stock_and_setup_sheet(self):
        self.assertEqual(self.res.stock_size, (7.0, 5.0))
        sheet = self.res.setup_sheet
        self.assertIn('LOWER-LEFT', sheet)
        self.assertIn('TOP of the stock', sheet)
        self.assertEqual(sheet.count('Zero Z on top of the stock.'), 3)
        self.assertLess(sheet.index('5/32" drill'), sheet.index('1/4" flat end mill'))

    def test_zip(self):
        with zipfile.ZipFile(io.BytesIO(self.res.zip_bytes())) as zf:
            self.assertEqual(sorted(zf.namelist()),
                             ['00_plate_SETUP.txt', '01_plate_drill_5-32.nc',
                              '02_plate_drill_13-64.nc', '03_plate_endmill_1-4.nc'])

    def test_thin_poly_and_override(self):
        res = roscam.generate_job(self.plate, 'polycarbonate', '1/16', self.cfg,
                                  overrides={'0.5000': 'drill_13_64'})
        self.assertTrue(res.success, res.errors)
        self.assertEqual(len(res.programs), 3)
        self.assertEqual(res.programs[1].gcode.count('(Hole '), 6)
        self.assertIn('mill 1 hole', res.programs[2].feature_summary)
        self.assertAlmostEqual(_min_z(res.programs[2].gcode), -(0.0625 + INCH_PER_MM), places=3)

    def test_unmakeable_hole_fails_job(self):
        path = _dxf(self.tmp.name, [(2, 1.5, 0.125)], name='bad.dxf')
        res = roscam.generate_job(path, 'aluminum', '1/8', self.cfg)
        self.assertFalse(res.success)
        self.assertEqual(res.programs, [])
        self.assertIn('match no drill', res.errors[0])

    def test_plate_with_no_holes_is_endmill_only(self):
        path = _dxf(self.tmp.name, [], name='blank.dxf')
        res = roscam.generate_job(path, 'aluminum', '1/8', self.cfg)
        self.assertTrue(res.success, res.errors)
        self.assertEqual([p.tool.id for p in res.programs], ['endmill_1_4'])

    def test_too_big_for_machine(self):
        path = _dxf(self.tmp.name, [], size=(30.0, 10.0), name='huge.dxf')
        res = roscam.generate_job(path, 'aluminum', '1/8', self.cfg)
        self.assertFalse(res.success)
        self.assertTrue(any('work area' in e for e in res.errors))
        res = roscam.generate_job(path, 'aluminum', '1/8', self.cfg, rotation=90)
        self.assertTrue(res.success, res.errors)

    def test_cli_writes_files(self):
        out = os.path.join(self.tmp.name, 'cli')
        rc = roscam.main([self.plate, '-m', 'aluminum', '-t', '1/4', '-o', out])
        self.assertEqual(rc, 0)
        self.assertEqual(len([f for f in os.listdir(out) if f.endswith('.nc')]), 3)
        rc = roscam.main([self.plate, '-m', 'aluminum', '-t', '1/4', '-o', out, '--zip',
                          '--hole', '0.5=drill_13_64'])
        self.assertEqual(rc, 0)
        self.assertTrue(os.path.exists(os.path.join(out, 'plate_roscam.zip')))



class WebApiTests(unittest.TestCase):
    def test_options(self):
        o = roscam.web_options()
        self.assertEqual([m['id'] for m in o['materials']], ['aluminum', 'polycarbonate'])
        self.assertEqual(o['materials'][0]['thicknesses'], ['1/16', '1/8', '1/4'])
        self.assertEqual([d['id'] for d in o['drills']], ['drill_5_32', 'drill_13_64'])

    def test_generate_from_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(build_plate(os.path.join(tmp, 'p.dxf')), 'rb') as fh:
                data = fh.read()
        out = roscam.web_generate(data, 'My Plate.dxf', 'aluminum', '1/4', {'0.5000': 'drill_13_64'})
        self.assertTrue(out['success'], out['errors'])
        self.assertEqual(out['part_name'], 'My Plate')
        self.assertEqual(len(out['programs']), 3)
        self.assertTrue(out['programs'][0]['gcode'].startswith('(RosCAM'))
        self.assertEqual(out['zip_name'], 'My Plate_roscam.zip')
        import base64
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(out['zip_base64']))) as zf:
            self.assertEqual(len(zf.namelist()), 4)

    def test_bad_dxf_reports_error(self):
        out = roscam.web_generate(b'not a dxf', 'junk.dxf', 'aluminum', '1/4')
        self.assertFalse(out['success'])
        self.assertIn('Could not process', out['errors'][0])


if __name__ == '__main__':
    unittest.main()
