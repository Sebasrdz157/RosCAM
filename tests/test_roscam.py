"""Tests for RosCAM: tool library, hole-to-drill matching, per-tool programs,
stock-top Z zero, peck expansion, and preflight checks."""

import copy
import io
import json
import math
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile

import ezdxf
import yaml
from shapely import affinity
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

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


def _cutting_stats(gcode):
    """Motion extents before the finish block (which returns to X0 Y0)."""
    return roscam.analyze_motion(gcode.split('(===== FINISH =====)')[0])


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


class ToolLibraryTests(unittest.TestCase):
    """Bits added on the Tools screen (Supabase rows) on top of roscam_config.yaml."""

    def setUp(self):
        self.base = roscam.load_config()

    def test_adds_tools(self):
        rows = [{'id': 'drill_1_8', 'name': '1/8 drill', 'type': 'drill', 'diameter': '1/8', 'flute_length': 1,
                 'tip_angle': 118, 'spindle_speed': 8000, 'plunge_rate': 25, 'peck': '1mm', 'peck_retract': '0.3mm'},
                {'id': 'endmill_1_8', 'name': '1/8 end mill', 'type': 'endmill', 'diameter': 0.125,
                 'flute_length': 0.5, 'spindle_speed': 18000, 'feed_rate': 40, 'plunge_rate': 5,
                 'ramp_feed_rate': 15, 'stepdown': 0.02}]
        cfg, warnings = roscam.config_with_tools(rows, self.base)
        self.assertEqual(warnings, [])
        self.assertEqual(roscam.match_drill(0.125, cfg).id, 'drill_1_8')
        self.assertEqual([t.id for t in cfg.endmills], ['endmill_1_4', 'endmill_1_8'])
        self.assertNotIn('drill_1_8', self.base.tools)          # the base config is untouched

    def test_bad_rows_skipped_with_warning(self):
        rows = [{'id': 'bad', 'name': 'Broken bit', 'type': 'endmill', 'diameter': 0.125, 'flute_length': 0.5,
                 'spindle_speed': 18000, 'plunge_rate': 5},                    # no feed / ramp / stepdown
                {'id': 'huge', 'name': 'Typo', 'type': 'drill', 'diameter': 5, 'flute_length': 1,
                 'spindle_speed': 1, 'plunge_rate': 1},
                {'id': 'off', 'name': 'Retired', 'type': 'drill', 'diameter': 0.1, 'flute_length': 1,
                 'spindle_speed': 1, 'plunge_rate': 1, 'active': False}]
        cfg, warnings = roscam.config_with_tools(rows, self.base)
        self.assertEqual(len(warnings), 2)
        self.assertIn('Broken bit', warnings[0])
        self.assertNotIn('off', cfg.tools)

    def test_library_can_replace_builtin_feeds(self):
        row = {**roscam.web_options()['tools'][0]}
        row.update(spindle_speed=7500)
        cfg, _ = roscam.config_with_tools([row], self.base)
        self.assertEqual(cfg.tools[row['id']].spindle_speed, 7500)

    def test_web_options_lists_library_tools(self):
        o = roscam.web_options(tools=[{'id': 'drill_3_16', 'name': '3/16 drill', 'type': 'drill', 'diameter': '3/16',
                                       'flute_length': 1, 'spindle_speed': 7000, 'plunge_rate': 30}])
        ids = {t['id']: t['builtin'] for t in o['tools']}
        self.assertTrue(ids['drill_13_64'])
        self.assertFalse(ids['drill_3_16'])
        self.assertIn('drill_3_16', [d['id'] for d in o['drills']])


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
        self.assertIn('unknown tool', errors[0])

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
        self.assertEqual(moves[-1], 'G1 X1.0000 Y0.0000 Z-0.1000')
        self.assertEqual(out[-1], lines[-1])  # flat arc kept as an arc
        prev = (1.0, 0.0)
        for i, m in enumerate(moves, 1):       # every chord within 0.001" of the true circle
            w = roscam._words(m)
            self.assertAlmostEqual(math.hypot(w['X'], w['Y']), 1.0, places=3)
            mx, my = (prev[0] + w['X']) / 2, (prev[1] + w['Y']) / 2
            self.assertLess(1.0 - math.hypot(mx, my), 0.0011)
            self.assertAlmostEqual(w['Z'], -0.1 * i / len(moves), places=3)
            prev = (w['X'], w['Y'])
        self.assertGreater(roscam._words(moves[len(moves) // 4])['Y'], 0.9)   # turning counter-clockwise
        cw = [l for l in roscam.linearize_helices(['G0 X1 Y0', 'G1 Z0 F30', 'G2 X1 Y0 I-1 J0 Z-0.1 F30'])
              if l.startswith('G1 X')]
        self.assertLess(roscam._words(cw[len(cw) // 4])['Y'], -0.9)           # clockwise
        tiny = [l for l in roscam.linearize_helices(['G0 X0.0150 Y0', 'G1 Z0 F30',
                                                      'G3 X0.0150 Y0 I-0.0150 J0 Z-0.02 F30'])
                if l.startswith('G1 X')]
        self.assertLessEqual(len(tiny), 16)    # a tiny ramp-in circle needs only a few segments

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



class SheetTests(unittest.TestCase):
    """Placing a part on a partly used 24 x 48 sheet."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.plate = build_plate(os.path.join(cls.tmp.name, 'plate.dxf'))   # 6 x 4 plate
        cls.cfg = roscam.load_config()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _job(self, sheet, **kw):
        return roscam.generate_job(self.plate, 'aluminum', '1/4', self.cfg, sheet=sheet, **kw)

    def test_empty_sheet_places_bottom_left(self):
        res = self._job(roscam.Sheet('AL-1', 24, 48))
        self.assertTrue(res.success, res.errors)
        # the 1/4" slot + 1/4" of solid material from the sheet corner
        self.assertEqual(res.placement, (0.5, 0.5))
        self.assertEqual(res.stock_size, (24, 48))
        self.assertEqual(res.sheet_id, 'AL-1')
        self.assertIn('Sheet AL-1', res.programs[0].gcode)
        self.assertIn('lower-left corner of sheet', res.programs[0].gcode)
        self.assertIn('LOWER-LEFT corner of the SHEET', res.setup_sheet)
        st = _cutting_stats(res.programs[-1].gcode)
        self.assertAlmostEqual(st.x_min, 0.375, places=3)  # cutter edge leaves the cut gap to the sheet edge

    def test_avoids_used_areas(self):
        used = [[(0, 0), (24, 0), (24, 10), (0, 10)],        # bottom strip used
                [(0, 10), (8, 10), (8, 20), (0, 20)]]        # and a block above it on the left
        res = self._job(roscam.Sheet('AL-2', 24, 48, used))
        self.assertTrue(res.success, res.errors)
        fp = Polygon(res.footprint)
        for r in used:
            self.assertLess(fp.intersection(Polygon(r)).area, 1e-6)
        self.assertGreaterEqual(res.placement[1], 10.0)
        # every drill plunge is inside the free area
        for p in res.programs[:-1]:
            st = _cutting_stats(p.gcode)
            self.assertGreaterEqual(st.y_min, 10.0)
        cut = Polygon(res.cut_region)
        self.assertAlmostEqual(cut.bounds[2] - cut.bounds[0], 6.5, places=1)  # part + the 1/4" slot each side

    def test_manual_placement_checked(self):
        used = [[(10, 10), (20, 10), (20, 20), (10, 20)]]
        sheet = roscam.Sheet('AL-3', 24, 48, used)
        ok = self._job(sheet, placement=(2, 30))
        self.assertTrue(ok.success, ok.errors)
        self.assertEqual(ok.placement, (2.0, 30.0))
        st = _cutting_stats(ok.programs[0].gcode)
        self.assertGreaterEqual(st.x_min, 2.0)
        self.assertGreaterEqual(st.y_min, 30.0)
        bad = self._job(sheet, placement=(12, 12))
        self.assertFalse(bad.success)
        self.assertIn('already used', bad.errors[0])
        edge = self._job(sheet, placement=(20, 30))   # 6" part would hang off the 24" sheet
        self.assertFalse(edge.success)
        self.assertIn('does not fit', edge.errors[0])

    def test_full_sheet_reports_no_space(self):
        res = self._job(roscam.Sheet('AL-4', 24, 48, [[(0, 0), (24, 0), (24, 45), (0, 45)]]))
        self.assertFalse(res.success)
        self.assertIn('No free space', res.errors[0])

    def test_rotation_can_make_it_fit(self):
        # only a tall, narrow strip is free: 5" wide x 30" tall
        used = [[(5, 0), (24, 0), (24, 48), (5, 48)], [(0, 30), (5, 30), (5, 48), (0, 48)]]
        sheet = roscam.Sheet('AL-5', 24, 48, used)
        self.assertFalse(self._job(sheet).success)
        self.assertTrue(self._job(sheet, rotation=90).success)

    def test_sheet_id_safe_in_gcode(self):
        res = self._job(roscam.Sheet('AL (3) [x]', 24, 48))
        self.assertTrue(res.success, res.errors)  # strict hygiene mode would raise on a bad comment

    def test_web_generate_with_sheet(self):
        with open(self.plate, 'rb') as fh:
            data = fh.read()
        out = roscam.web_generate(data, 'p.dxf', 'aluminum', '1/4',
                                  sheet={'id': 'AL-9', 'width': 24, 'height': 48,
                                         'regions': [[[0, 0], [24, 0], [24, 5], [0, 5]]]})
        self.assertTrue(out['success'], out['errors'])
        self.assertEqual(out['sheet_id'], 'AL-9')
        self.assertGreaterEqual(out['placement'][1], 5)
        self.assertGreater(len(out['cut_region']), 3)


class NestedJobTests(unittest.TestCase):
    """Several parts laid out on one sheet (the layout comes from the nesting step)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.plate = build_plate(os.path.join(cls.tmp.name, 'plate.dxf'))             # 6 x 4
        cls.small = _dxf(cls.tmp.name, [(0.5, 0.5, 0.203125), (2.5, 1.5, 0.203125)],
                         size=(3.0, 2.0), name='small.dxf')                         # 3 x 2, two 13/64 holes
        cls.cfg = roscam.load_config()
        cls.parts = [roscam.PartFile(cls.plate, 'plate'), roscam.PartFile(cls.small, 'small')]

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _job(self, placements, regions=None, **kw):
        sheet = roscam.Sheet('AL-250-07', 24, 48, regions or [])
        return roscam.generate_sheet_job(self.parts, placements, 'aluminum', '1/4', sheet, self.cfg,
                                         timestamp='2026-01-01 00:00', **kw)

    def test_part_info(self):
        info = roscam.part_info(self.plate, 'plate', 'aluminum', '1/4', self.cfg)
        self.assertEqual(info['errors'], [])
        self.assertEqual((info['width'], info['height']), (6.0, 4.0))
        shape = Polygon(info['nest_shape'])
        # outline + the cut's slot (1/4") + half the cut gap (+ a hair for curve simplifying)
        self.assertAlmostEqual(shape.bounds[2] - shape.bounds[0], 6 + 2 * (0.25 + 0.125 + 0.01), places=2)
        self.assertTrue(shape.contains(Polygon(info['outline']).buffer(0.25 + 0.125)))
        self.assertEqual(sum(g['count'] for g in info['hole_groups']), 9)

    def test_two_parts_three_copies_with_rotation(self):
        res = self._job([
            {'part': 0, 'x': 0.5, 'y': 0.5, 'rotation': 0},
            {'part': 1, 'x': 7.5, 'y': 0.5, 'rotation': 0},
            {'part': 0, 'x': 10, 'y': 20, 'rotation': 90},
        ])
        self.assertTrue(res.success, res.errors)
        self.assertEqual([p.filename for p in res.programs],
                         ['01_AL-250-07_drill_5-32.nc', '02_AL-250-07_drill_13-64.nc', '03_AL-250-07_endmill_1-4.nc'])
        drill = res.programs[1].gcode
        self.assertEqual(drill.count('(Hole '), 5 + 2 + 5)
        self.assertIn('G0 X1.0000 Y1.0000', drill)          # plate #1 hole (0.5,0.5) + (0.5,0.5)
        self.assertIn('G0 X8.0000 Y1.0000', drill)          # small hole (0.5,0.5) + (7.5,0.5)
        self.assertIn('G0 X9.5000 Y20.5000', drill)         # plate #2: (0.5,0.5) turned 90 CCW -> (-0.5,0.5), + (10,20)
        self.assertEqual([p['label'] for p in res.parts], ['plate #1', 'small #1', 'plate #2'])
        p2 = Polygon(res.parts[2]['outline'])
        self.assertEqual(tuple(round(v, 3) for v in p2.bounds), (6.0, 20.0, 10.0, 26.0))
        em = res.programs[2].gcode
        last_inside = max(em.index('(=== plate #1: holes and pockets'), em.index('(=== plate #2: holes and pockets'))
        first_outline = min(em.index(f'(=== {n}: outline') for n in ('plate #1', 'small #1', 'plate #2'))
        self.assertLess(last_inside, first_outline)          # insides first, outlines last
        self.assertEqual(em.count('PERIMETER WITH TABS'), 3)
        self.assertIn('3 outlines with tabs', res.programs[2].feature_summary)
        self.assertIn('small #1: lower-left at X 7.500" Y 0.500"', res.setup_sheet)
        for p in res.programs:
            self.assertEqual(p.errors, [])
        st = roscam.analyze_motion(em)
        self.assertEqual(st.rapids_below_top, 0)

    def test_layout_checks(self):
        overlap = self._job([{'part': 0, 'x': 0.5, 'y': 0.5}, {'part': 1, 'x': 6.6, 'y': 0.5}])
        self.assertFalse(overlap.success)
        self.assertIn('too close together', overlap.errors[0])
        edge = self._job([{'part': 0, 'x': 0.1, 'y': 0.5}])
        self.assertIn('edge', edge.errors[0])
        used = self._job([{'part': 0, 'x': 0.5, 'y': 0.5}], regions=[[(5, 0), (24, 0), (24, 3), (5, 3)]])
        self.assertIn('already used', used.errors[0])
        self.assertIn('not a multiple of 90', self._job([{'part': 0, 'x': 5, 'y': 5, 'rotation': 45}]).errors[0])

    def test_unplaced_listed_and_overrides_apply_everywhere(self):
        res = self._job([{'part': 0, 'x': 0.5, 'y': 0.5}, {'part': 1, 'x': 7.5, 'y': 0.5}],
                        overrides={'0.2031': 'drill_5_32', '0.2010': 'drill_5_32'}, unplaced=['small #2'])
        self.assertTrue(res.success, res.errors)
        self.assertEqual(len(res.programs), 2)                # every 13/64 hole moved to the 5/32 drill
        self.assertIn('Did NOT fit on this sheet: small #2', res.setup_sheet)

    def test_web_generate_sheet(self):
        files = []
        for path, name in ((self.plate, 'plate'), (self.small, 'small')):
            with open(path, 'rb') as fh:
                files.append({'name': name, 'bytes': fh.read()})
        out = roscam.web_generate_sheet(files, 'aluminum', '1/4', {'id': 'AL-1', 'width': 24, 'height': 48},
                                        [{'part': 0, 'x': 1, 'y': 1, 'rotation': 0},
                                         {'part': 1, 'x': 1, 'y': 9, 'rotation': 270}])   # spans y 6..9
        self.assertTrue(out['success'], out['errors'])
        self.assertEqual(len(out['parts']), 2)
        self.assertTrue(out['zip_base64'])
        with open(self.small, 'rb') as fh:
            info = roscam.web_part_info(fh.read(), 'small.dxf', 'aluminum', '1/4')
        self.assertEqual(info['name'], 'small')


@unittest.skipUnless(shutil.which('node'), 'needs node to run the nesting engine')
class NestingEngineTests(unittest.TestCase):
    """The nesting engine (web/nest, adapted from SVGnest) end to end: Python describes the
    parts, the engine lays them out in node, and generate_sheet_job must accept the layout."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.plate = build_plate(os.path.join(cls.tmp.name, 'plate.dxf'))
        cls.small = _dxf(cls.tmp.name, [(0.5, 0.5, 0.203125)], size=(3.0, 2.0), name='small.dxf')
        cls.cfg = roscam.load_config()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _nest(self, sheet, quantities, angles=(0, 90, 180, 270), steps=150):
        files = [(self.plate, 'plate'), (self.small, 'small')]
        infos = [roscam.part_info(p, n, 'aluminum', '1/4', self.cfg) for p, n in files]
        setup = roscam.nest_setup(sheet, self.cfg)
        job = {'bin': setup['bin'], 'obstacles': setup['obstacles'], 'angles': list(angles), 'steps': steps,
               'parts': [{'shape': i['nest_shape'], 'quantity': q} for i, q in zip(infos, quantities)]}
        script = """
const path = require('path'); const dir = process.argv[1];
globalThis.self = globalThis;
self.ClipperLib = require(path.join(dir, 'clipper.js'));
for (const f of ['geometryutil.js', 'nester.js']) require(path.join(dir, f));
let seed = 1; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const job = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const n = new self.RosNester({ ...job, random });
for (let i = 0; i < job.steps; i++) n.step();
process.stdout.write(JSON.stringify({ best: n.best, util: n.utilization() }));
"""
        out = subprocess.run(['node', '-e', script, os.path.join(HERE, '..', 'web', 'nest')],
                             input=json.dumps(job), capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout), files

    def _check(self, sheet, result, files):
        best = result['best']
        parts = [roscam.PartFile(p, n) for p, n in files]
        res = roscam.generate_sheet_job(parts, best['placements'], 'aluminum', '1/4', sheet, self.cfg)
        self.assertTrue(res.success, res.errors)
        return res

    def test_fills_empty_sheet(self):
        sheet = roscam.Sheet('AL-1', 24, 48)
        result, files = self._nest(sheet, [6, 4])
        self.assertEqual(result['best']['unplaced'], [])
        self.assertEqual(len(result['best']['placements']), 10)
        res = self._check(sheet, result, files)
        self.assertEqual(len(res.parts), 10)
        # gravity: everything packed into the bottom of the sheet (10 parts, ~170 sq in, need < 16")
        self.assertLess(max(Polygon(p['outline']).bounds[3] for p in res.parts), 16)

    def test_packs_around_used_areas(self):
        used = [[(0, 0), (24, 0), (24, 8), (0, 8)], [(8, 8), (14, 8), (14, 20), (8, 20)]]
        sheet = roscam.Sheet('AL-2', 24, 48, used)
        result, files = self._nest(sheet, [4, 6])
        self.assertEqual(result['best']['unplaced'], [])
        res = self._check(sheet, result, files)
        for p in res.parts:
            for u in used:
                self.assertLess(Polygon(p['cut_region']).intersection(Polygon(u)).area, 1e-6)

    def test_cuts_leave_solid_material_between_parts(self):
        """Read the end mill's real cutting moves: around each part, the cutter's far edge must
        leave cfg.cut_gap of solid material before any other part's cut, the sheet edge and
        any used area, so tabs always have material to hold on to."""
        used = [[(0, 0), (24, 0), (24, 6), (0, 6)]]
        sheet = roscam.Sheet('AL-5', 24, 48, used)
        result, files = self._nest(sheet, [5, 6])
        res = self._check(sheet, result, files)
        gap, d = self.cfg.cut_gap, self.cfg.profile_tool.diameter
        r = d / 2
        em = res.programs[-1].gcode
        slots = {p['label']: Polygon(p['outline']).buffer(d) for p in res.parts}
        for p in res.parts:
            label = p['label']
            start = em.index(f'(=== {label}: outline ===)')
            nxt = em.find('(=== ', start + 5)
            section = em[start:nxt if nxt != -1 else len(em)]
            pts = []
            z = 1.0
            for line in section.splitlines():
                w = roscam._words(roscam._split_comment(line)[0].upper())
                z = w.get('Z', z)
                if 'X' in w and 'Y' in w and z < 0:
                    pts.append(Point(w['X'], w['Y']))
            self.assertTrue(pts, label)
            for other, slot in slots.items():
                if other == label:
                    continue
                closest = min(slot.distance(pt) for pt in pts) - r     # cutter edge to the other slot
                self.assertGreaterEqual(closest, gap - 0.005, f'{label} vs {other}: {closest:.3f}"')
            edge = min(min(pt.x, pt.y, 24 - pt.x, 48 - pt.y) for pt in pts) - r
            self.assertGreaterEqual(edge, gap - 0.005, f'{label} to sheet edge: {edge:.3f}"')
            used_dist = min(Polygon(used[0]).distance(pt) for pt in pts) - r
            self.assertGreaterEqual(used_dist, gap - 0.005, f'{label} to used area: {used_dist:.3f}"')
        # Mark as cut records the whole slot, not half of it
        for p in res.parts:
            self.assertAlmostEqual(Polygon(p['cut_region']).area, slots[p['label']].area, delta=0.05)

    def test_reports_what_does_not_fit(self):
        sheet = roscam.Sheet('AL-3', 24, 48, [[(0, 0), (24, 0), (24, 40), (0, 40)]])   # 8" strip left
        result, files = self._nest(sheet, [8, 0], steps=60)
        self.assertGreater(len(result['best']['unplaced']), 0)
        self.assertGreater(len(result['best']['placements']), 0)
        self._check(sheet, result, files)

    def test_no_rotation_option(self):
        sheet = roscam.Sheet('AL-4', 24, 48)
        result, files = self._nest(sheet, [3, 3], angles=[0])
        self.assertTrue(all(p['rotation'] == 0 for p in result['best']['placements']))
        self._check(sheet, result, files)


class DetailToolTests(unittest.TestCase):
    """Details the 1/4" end mill can't reach (rack teeth, narrow slots) go to a smaller end
    mill from the tool library, cut in layers before the 1/4" end mill runs."""

    EIGHTH = {'id': 'endmill_1_8', 'name': '1/8 end mill', 'type': 'endmill', 'diameter': 0.125,
              'flute_length': 0.5, 'spindle_speed': 18000, 'feed_rate': 40, 'plunge_rate': 5,
              'ramp_feed_rate': 15, 'stepdown': 0.02}

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        # A 6" rack: 1" tall body with 0.2" teeth on a 0.3" pitch; each gap is 0.18" wide at the
        # root and 0.22" at the tip: too narrow for a 1/4" end mill, fine for a 1/8" one.
        # Plus a 0.18" x 1.2" slot.
        pts = [(0, 0), (6, 0), (6, 1)]
        x = 6.0
        while x > 0.3 + 1e-9:
            pts += [(x - 0.09, 1.0), (x - 0.11, 1.2), (x - 0.19, 1.2), (x - 0.21, 1.0)]
            x -= 0.3
        pts += [(0, 1)]
        doc = ezdxf.new(units=1)
        msp = doc.modelspace()
        msp.add_lwpolyline(pts, close=True)
        msp.add_lwpolyline([(2, 0.3), (3.2, 0.3), (3.2, 0.48), (2, 0.48)], close=True)
        msp.add_circle((5, 0.5), 0.18 / 2)                      # 0.18" hole: no drill, smaller than 1/4"
        cls.rack = os.path.join(cls.tmp.name, 'rack.dxf')
        doc.saveas(cls.rack)
        cls.outline = Polygon(pts)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _job(self, library):
        cfg, _ = roscam.config_with_tools(library)
        sheet = roscam.Sheet('AL-9', 24, 48)
        return roscam.generate_sheet_job([roscam.PartFile(self.rack, 'rack')],
                                         [{'part': 0, 'x': 1, 'y': 1, 'rotation': 0}],
                                         'aluminum', '1/4', sheet, cfg), cfg

    def test_uses_smaller_end_mill_for_details(self):
        res, cfg = self._job([self.EIGHTH])
        self.assertTrue(res.success, res.errors)
        self.assertEqual([p.tool.id for p in res.programs], ['endmill_1_8', 'endmill_1_4'])
        detail = res.programs[0]
        self.assertEqual(res.warnings, [])                       # every detail found a bit
        self.assertIn('19 details', detail.feature_summary)      # 18 tooth gaps + the narrow slot
        self.assertIn('mill 1 hole', detail.feature_summary)
        self.assertIn('details', detail.feature_summary)
        self.assertIn('(Layer 15 of 15)', detail.gcode)          # 0.289" deep in 0.02" layers
        self.assertEqual(detail.errors, [])
        # The 1/8" bit never cuts into the part, and it does clear the gaps between the teeth.
        part = affinity.translate(self.outline, 1, 1)
        r = 0.0625
        runs, run, z = [], [], 1.0          # cutting moves, as connected runs below the stock top
        x = y = None
        for line in detail.gcode.splitlines():
            w = roscam._words(roscam._split_comment(line)[0].upper())
            z = w.get('Z', z)
            x, y = w.get('X', x), w.get('Y', y)
            if x is None or y is None:
                continue
            if z < 0:
                run.append((x, y))
            elif run:
                runs.append(run)
                run = []
        if run:
            runs.append(run)
        inside = unary_union([Polygon([(3, 1.3), (4.2, 1.3), (4.2, 1.48), (3, 1.48)]).buffer(0.01),
                              Point(6, 1.5).buffer(0.1)])          # the slot and the 0.18" hole, placed
        near = [[p for p in rr if not inside.contains(Point(p))] for rr in runs]
        pts = [Point(p) for rr in near for p in rr]
        self.assertTrue(pts)
        for pt in pts:                                          # the bit's edge never enters the part
            self.assertFalse(part.buffer(-1e-3).contains(pt))
            self.assertGreaterEqual(part.exterior.distance(pt), r - 0.003)
        gaps = part.buffer(0.125, 32).buffer(-0.125, 32).difference(part)
        swept = unary_union([LineString(rr).buffer(r, 8) if len(rr) > 1 else Point(rr[0]).buffer(r, 8)
                             for rr in near if rr])
        uncut = gaps.difference(swept)
        # all that's left is the round bit's corner fillets at the roots of the gaps (slivers)
        slivers_only = [g for g in getattr(uncut, 'geoms', [uncut])
                        if g.area > 1e-6 and not g.buffer(-roscam.SLIVER).is_empty]
        self.assertEqual(slivers_only, [], f'{uncut.area:.4f} sq in of the gaps left uncut')
        self.assertGreater(swept.intersection(gaps).area / gaps.area, 0.9)
        self.assertLess(len(detail.gcode.splitlines()), 60000)

    def test_warns_without_a_small_end_mill(self):
        res, _ = self._job([])
        self.assertFalse(res.success)                             # the 0.2" hole can't be made at all
        self.assertIn('smaller than every end mill', ' '.join(res.errors))
        res2, _ = self._job([{**self.EIGHTH, 'id': 'drill_0_18', 'name': '0.18 drill', 'type': 'drill',
                              'diameter': 0.18, 'flute_length': 1, 'plunge_rate': 30, 'spindle_speed': 7000}])
        self.assertTrue(res2.success, res2.errors)
        self.assertTrue(any('no smaller end mill' in w for w in res2.warnings))
        self.assertEqual([p.tool.id for p in res2.programs], ['drill_0_18', 'endmill_1_4'])


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
