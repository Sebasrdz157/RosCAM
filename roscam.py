"""
RosCAM: one-click CAM for flat plates on a no-tool-changer router.

Takes a single-layer DXF of a flat part and produces ONE PROGRAM PER TOOL:

    01_<part>_drill_13-64.nc   peck-drill every hole that matches the 13/64" drill
    02_<part>_drill_5-32.nc    peck-drill every hole that matches the 5/32" drill
    03_<part>_endmill_1-4.nc   mill remaining holes + pockets, then the outline with tabs

plus a plain-text setup sheet telling the operator which bit to load for each file.

Geometry handling (DXF loading, hole detection, pocket clearing, tool compensation,
perimeter tabs) is PenguinCAM's FRCPostProcessor. RosCAM adds the tool library,
hole-to-drill matching, per-tool programs, the stock-top Z zero, and preflight
checks against the machine and the tools.

All coordinates are inches. Every program has X0 Y0 at the lower-left corner of the
stock and Z0 on the top of the stock.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import io
import math
import os
import re
import sys
import zipfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import pyclipper
import yaml
from shapely import affinity
from shapely.geometry import LineString, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.prepared import prep

from frc_cam_postprocessor import FRCPostProcessor, sanitize_filename_base
from gcode_hygiene import finalize_gcode
from team_config import TeamConfig, parse_length

DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'roscam_config.yaml')

MILL = 'mill'  # hole assignment: cut with the profile end mill instead of a drill

# Height above the stock top where a drill starts each peck (the G83 "R" plane).
DRILL_RETRACT = 0.1
# How far above the bottom of the previous peck the drill rapids back down to.
PECK_REENTRY_GAP = 0.01
EPS = 1e-6


# =============================================================================
# Configuration
# =============================================================================

def _length(value, what: str) -> float:
    parsed = parse_length(value)
    if parsed is None:
        raise ValueError(f'{what}: could not read length {value!r}')
    return parsed


@dataclass
class Tool:
    id: str
    name: str
    type: str                 # 'endmill' or 'drill'
    diameter: float
    flute_length: float
    spindle_speed: int
    plunge_rate: float
    overall_length: Optional[float] = None
    flutes: Optional[int] = None
    feed_rate: Optional[float] = None       # end mills: side-cutting feed
    ramp_feed_rate: Optional[float] = None  # end mills: ramp / helical entry feed
    stepdown: Optional[float] = None        # end mills: depth per pass
    tip_angle: Optional[float] = None       # drills
    peck: float = 0.0                       # drills: 0 = single plunge
    peck_retract: float = 0.0               # drills: lift between pecks; 0 = all the way out

    @property
    def is_drill(self) -> bool:
        return self.type == 'drill'

    @property
    def tip_length(self) -> float:
        """Length of a drill's conical point, so through-holes come out full size."""
        if not self.is_drill or not self.tip_angle:
            return 0.0
        return (self.diameter / 2) / math.tan(math.radians(self.tip_angle / 2))

    @property
    def short_label(self) -> str:
        """Filename-safe label: tool id 'drill_13_64' -> 'drill_13-64'."""
        head, _, rest = self.id.partition('_')
        label = f'{head}_{rest.replace("_", "-")}' if rest else head
        return sanitize_filename_base(label, self.type)


@dataclass
class Thickness:
    label: str
    value: float
    tab_width: float
    tab_height: float
    tab_spacing: float


@dataclass
class Material:
    id: str
    name: str
    stepover: float
    ramp_angle: float
    thicknesses: List[Thickness]
    tool_overrides: Dict[str, dict] = field(default_factory=dict)

    def tool(self, tool: Tool) -> Tool:
        """The tool with this material's speeds/feeds applied (see tool_overrides)."""
        over = self.tool_overrides.get(tool.id)
        return dataclasses.replace(tool, **over) if over else tool

    def find_thickness(self, thickness) -> Thickness:
        """Look up a stocked thickness by label ('1/8') or value (0.125)."""
        value = parse_length(thickness)
        if value is None:
            raise ValueError(f'Could not read thickness {thickness!r}')
        for t in self.thicknesses:
            if abs(t.value - value) < 0.001:
                return t
        stocked = ', '.join(f'{t.label}"' for t in self.thicknesses)
        raise ValueError(f'{self.name} is not stocked in {value:.4f}" thickness. '
                         f'Stocked thicknesses: {stocked}. Add it to roscam_config.yaml.')


@dataclass
class ShopConfig:
    machine_name: str
    controller: str
    x_max: float
    y_max: float
    z_max: float
    stock_margin: float
    overcut: float
    clearance_height: float
    safe_height: float
    drill_match_tolerance: float
    tools: Dict[str, Tool]
    profile_tool_id: str
    materials: Dict[str, Material]
    tabs_enabled: bool = True
    remove_tabs: bool = False
    cut_gap: float = 0.25        # solid material left between any two cuts (see setup.cut_gap)

    @property
    def profile_tool(self) -> Tool:
        return self.tools[self.profile_tool_id]

    @property
    def drills(self) -> List[Tool]:
        return sorted((t for t in self.tools.values() if t.is_drill), key=lambda t: t.diameter)

    @property
    def endmills(self) -> List[Tool]:
        """Every end mill, largest first."""
        return sorted((t for t in self.tools.values() if t.type == 'endmill'), key=lambda t: -t.diameter)

    def material(self, material_id: str) -> Material:
        try:
            return self.materials[material_id]
        except KeyError:
            raise ValueError(f'Unknown material {material_id!r}. '
                             f'Known: {", ".join(self.materials)}') from None


OVERRIDABLE_LENGTHS = {'stepdown', 'peck', 'peck_retract'}
OVERRIDABLE_NUMBERS = {'spindle_speed', 'feed_rate', 'plunge_rate', 'ramp_feed_rate'}


def tool_from_dict(tool_id: str, t: dict) -> Tool:
    """Build a Tool from a roscam_config.yaml entry or a tool-library row (same keys)."""
    if not tool_id:
        raise ValueError('a tool needs an id')
    ttype = t.get('type')
    if ttype not in ('endmill', 'drill'):
        raise ValueError(f'Tool {tool_id}: type must be endmill or drill, not {ttype!r}')

    def num(key, cast=float, required=True):
        v = t.get(key)
        if v is None or v == '':
            if required:
                raise ValueError(f'Tool {tool_id} is missing {key}')
            return None
        return cast(v)

    tool = Tool(
        id=tool_id,
        name=str(t.get('name') or tool_id),
        type=ttype,
        diameter=_length(t.get('diameter'), f'tool {tool_id} diameter'),
        flute_length=_length(t.get('flute_length'), f'tool {tool_id} flute_length'),
        overall_length=parse_length(t.get('overall_length')),
        flutes=int(t['flutes']) if t.get('flutes') not in (None, '') else None,
        spindle_speed=num('spindle_speed', lambda v: int(float(v))),
        plunge_rate=num('plunge_rate'),
        feed_rate=num('feed_rate', required=False),
        ramp_feed_rate=num('ramp_feed_rate', required=False),
        stepdown=parse_length(t.get('stepdown')) if t.get('stepdown') not in (None, '') else None,
        tip_angle=num('tip_angle', required=False),
        peck=parse_length(t.get('peck') or 0) or 0.0,
        peck_retract=parse_length(t.get('peck_retract') or 0) or 0.0,
    )
    if ttype == 'endmill':
        missing = [k for k in ('feed_rate', 'ramp_feed_rate', 'stepdown') if getattr(tool, k) is None]
        if missing:
            raise ValueError(f'End mill {tool_id} is missing: {", ".join(missing)}')
    for key in ('diameter', 'flute_length', 'spindle_speed', 'plunge_rate', 'feed_rate', 'ramp_feed_rate', 'stepdown'):
        v = getattr(tool, key)
        if v is not None and v <= 0:
            raise ValueError(f'Tool {tool_id}: {key} must be above 0')
    if tool.diameter > 1.0:
        raise ValueError(f'Tool {tool_id}: a {tool.diameter:g}" diameter looks wrong (lengths are inches)')
    return tool


_BASE_CONFIG: Optional['ShopConfig'] = None
_LIBRARY_CACHE: Dict[str, Tuple['ShopConfig', List[str]]] = {}


def base_config() -> 'ShopConfig':
    global _BASE_CONFIG
    if _BASE_CONFIG is None:
        _BASE_CONFIG = load_config()
    return _BASE_CONFIG


def config_with_tools(library: Optional[list], base: Optional['ShopConfig'] = None) -> Tuple['ShopConfig', List[str]]:
    """The shop config plus the tool library (rows from the Tools screen). A library tool
    with the same id as a built-in one replaces it. Rows that don't make a valid tool are
    skipped with a warning instead of breaking the job."""
    base = base or base_config()
    rows = [dict(r) for r in (library or []) if r and r.get('active', True) is not False]
    if not rows:
        return base, []
    import json
    key = json.dumps(rows, sort_keys=True, default=str) + '|' + str(id(base))
    if key in _LIBRARY_CACHE:
        return _LIBRARY_CACHE[key]
    tools = dict(base.tools)
    warnings = []
    for row in rows:
        tid = str(row.get('id') or '').strip()
        label = row.get('name') or tid or 'a tool'
        try:
            tool = tool_from_dict(tid, row)
        except (ValueError, TypeError, KeyError) as e:
            warnings.append(f'{label} in the tool library was skipped: {e}')
            continue
        if tid == base.profile_tool_id and tool.type != 'endmill':
            warnings.append(f'{label} in the tool library was skipped: it would replace the profile end mill with a drill.')
            continue
        tools[tid] = tool
    cfg = dataclasses.replace(base, tools=tools)
    _LIBRARY_CACHE[key] = (cfg, warnings)
    return cfg, warnings


def load_config(path: Optional[str] = None, data: Optional[dict] = None) -> ShopConfig:
    """Read roscam_config.yaml (or an already-parsed dict) into a ShopConfig."""
    if data is None:
        with open(path or DEFAULT_CONFIG_PATH, 'r', encoding='utf-8') as fh:
            data = yaml.safe_load(fh)

    m = data['machine']
    s = data.get('setup', {})
    if s.get('z_zero', 'stock_top') != 'stock_top':
        raise ValueError('Only setup.z_zero: stock_top is supported')

    tools = {tool_id: tool_from_dict(tool_id, t) for tool_id, t in data['tools'].items()}

    profile_tool_id = data['profile_tool']
    if profile_tool_id not in tools or tools[profile_tool_id].type != 'endmill':
        raise ValueError(f'profile_tool {profile_tool_id!r} must name an end mill in tools')

    materials = {}
    for mat_id, mat in data['materials'].items():
        thicknesses = []
        for label, t in mat['thicknesses'].items():
            thicknesses.append(Thickness(
                label=str(label),
                value=_length(label, f'material {mat_id} thickness'),
                tab_width=_length(t['tab_width'], f'{mat_id} {label} tab_width'),
                tab_height=_length(t['tab_height'], f'{mat_id} {label} tab_height'),
                tab_spacing=_length(t['tab_spacing'], f'{mat_id} {label} tab_spacing'),
            ))
        thicknesses.sort(key=lambda t: t.value)
        overrides = {}
        for tool_id, over in (mat.get('tool_overrides') or {}).items():
            if tool_id not in tools:
                raise ValueError(f'Material {mat_id}: tool_overrides names unknown tool {tool_id!r}')
            parsed = {}
            for key, value in over.items():
                if key in OVERRIDABLE_LENGTHS:
                    parsed[key] = _length(value, f'{mat_id} {tool_id} {key}')
                elif key in OVERRIDABLE_NUMBERS:
                    parsed[key] = float(value) if key != 'spindle_speed' else int(value)
                else:
                    raise ValueError(f'Material {mat_id}: {tool_id}.{key} cannot be overridden')
            overrides[tool_id] = parsed
        materials[mat_id] = Material(
            id=mat_id,
            name=mat.get('name', mat_id.title()),
            stepover=float(mat['stepover']),
            ramp_angle=float(mat['ramp_angle']),
            thicknesses=thicknesses,
            tool_overrides=overrides,
        )

    tabs = data.get('tabs', {})
    cfg = ShopConfig(
        machine_name=m.get('name', 'CNC router'),
        controller=m.get('controller', ''),
        x_max=_length(m['x_max'], 'machine x_max'),
        y_max=_length(m['y_max'], 'machine y_max'),
        z_max=_length(m['z_max'], 'machine z_max'),
        stock_margin=_length(s.get('stock_margin', 0.5), 'setup stock_margin'),
        overcut=_length(s.get('spoilboard_overcut', '1mm'), 'setup spoilboard_overcut'),
        clearance_height=_length(s.get('clearance_height', 0.2), 'setup clearance_height'),
        safe_height=_length(s.get('safe_height', 0.5), 'setup safe_height'),
        drill_match_tolerance=_length(data.get('holes', {}).get('drill_match_tolerance', 0.006),
                                      'holes drill_match_tolerance'),
        tools=tools,
        profile_tool_id=profile_tool_id,
        materials=materials,
        tabs_enabled=bool(tabs.get('enabled', True)),
        remove_tabs=bool(tabs.get('remove_tabs', False)),
        cut_gap=_length(s.get('cut_gap', 0.25), 'setup cut_gap'),
    )
    if cfg.cut_gap < 0:
        raise ValueError('setup.cut_gap cannot be negative')
    if cfg.stock_margin <= cfg.profile_tool.diameter / 2:
        raise ValueError(f'setup.stock_margin ({cfg.stock_margin}") must be larger than the '
                         f'profile tool radius ({cfg.profile_tool.diameter / 2}")')
    return cfg


# =============================================================================
# Hole planning
# =============================================================================

@dataclass
class HoleGroup:
    """All holes of one size, and what will make them."""
    key: str                      # diameter as text, e.g. '0.2031' - used for overrides
    diameter: float
    centers: List[Tuple[float, float]]
    tool_id: Optional[str]        # drill id, MILL, or None (cannot be made)
    auto_tool_id: Optional[str]   # what RosCAM picked before any override
    note: str = ''

    @property
    def count(self) -> int:
        return len(self.centers)

    def to_dict(self) -> dict:
        return {'key': self.key, 'diameter': round(self.diameter, 4), 'count': self.count,
                'tool': self.tool_id, 'auto_tool': self.auto_tool_id, 'note': self.note}


def group_key(diameter: float) -> str:
    return f'{diameter:.4f}'


def match_drill(diameter: float, cfg: ShopConfig) -> Optional[Tool]:
    """The library drill closest to this hole size, if one is within tolerance."""
    best = None
    for drill in cfg.drills:
        err = abs(drill.diameter - diameter)
        if err <= cfg.drill_match_tolerance + EPS and (best is None or err < abs(best.diameter - diameter)):
            best = drill
    return best


def _endmill_for_hole(diameter: float, cfg: ShopConfig) -> Optional[Tool]:
    """The largest end mill that fits in a hole (the profile end mill if it fits)."""
    for t in cfg.endmills:                      # largest first
        if diameter >= t.diameter - 0.002:
            return t
    return None


def plan_holes(circles: List[dict], cfg: ShopConfig,
               overrides: Optional[Dict[str, str]] = None) -> Tuple[List[HoleGroup], List[str], List[str]]:
    """Group circles by size and assign each group a drill, an end mill, or nothing.

    A group's tool is a drill id, MILL (the profile end mill), the id of a smaller end mill
    from the tool library, or None (cannot be made). overrides maps a group key ('0.2031')
    to any of those. Returns (groups, errors, warnings).
    """
    overrides = overrides or {}
    errors, warnings = [], []
    endmill = cfg.profile_tool

    def mill_id(t: Tool) -> str:
        return MILL if t.id == endmill.id else t.id

    # Group by size (to 0.1 thou) so DXF rounding doesn't split one hole size in two.
    by_size: Dict[str, List[dict]] = {}
    for c in circles:
        by_size.setdefault(group_key(c['diameter']), []).append(c)

    groups = []
    for key in sorted(by_size, key=float):
        members = by_size[key]
        diameter = float(key)
        centers = [tuple(c['center']) for c in members]

        drill = match_drill(diameter, cfg)
        mill = _endmill_for_hole(diameter, cfg)
        auto = drill.id if drill else (mill_id(mill) if mill else None)
        group = HoleGroup(key=key, diameter=diameter, centers=centers, tool_id=auto, auto_tool_id=auto)

        choice = overrides.get(key)
        if choice is not None and choice != auto:
            tool = endmill if choice == MILL else cfg.tools.get(choice)
            if tool is None:
                errors.append(f'Override for {key}" holes names unknown tool {choice!r}.')
            elif tool.is_drill:
                group.tool_id = choice
                group.note = f'override: {tool.name}'
                diff = tool.diameter - diameter
                if abs(diff) > cfg.drill_match_tolerance:
                    warnings.append(f'{group.count} hole(s) of {diameter:.4f}" will be drilled with the '
                                    f'{tool.name}, which is {abs(diff):.4f}" '
                                    f'{"larger" if diff > 0 else "smaller"} than the hole.')
            elif diameter < tool.diameter - 0.002:
                errors.append(f'{group.count} hole(s) of {diameter:.4f}" are smaller than the '
                              f'{tool.name} and cannot be milled with it.')
                group.tool_id = None
            else:
                group.tool_id = mill_id(tool)
                group.note = f'override: mill with {tool.name}'

        if group.tool_id is None and choice is None:
            smallest = cfg.endmills[-1] if cfg.endmills else endmill
            errors.append(f'{group.count} hole(s) of {diameter:.4f}" match no drill and are smaller than every '
                          f'end mill (smallest: {smallest.name}). Add a drill or a small end mill of that size '
                          f'on the Tools screen, or change the hole size in CAD.')
        mill_tool = endmill if group.tool_id == MILL else cfg.tools.get(group.tool_id or '')
        if mill_tool is not None and not mill_tool.is_drill and abs(diameter - mill_tool.diameter) <= 0.002:
            warnings.append(f'{group.count} hole(s) of {diameter:.4f}" are the same size as the {mill_tool.name}, '
                            f'so it will plunge straight down to make them.')
        groups.append(group)

    return groups, errors, warnings


# =============================================================================
# G-code helpers
# =============================================================================

# (Starts with \s*, not '(', so the G-code comment lint doesn't take it for a comment; also matches packed words like G1X1Z-2.)
_WORD_RE = re.compile(r'\s*([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))')


def _split_comment(line: str) -> Tuple[str, str]:
    """Split a line into (code, comment) where comment keeps its '(' or ';'."""
    idx = len(line)
    for marker in ('(', ';'):
        i = line.find(marker)
        if i != -1:
            idx = min(idx, i)
    return line[:idx], line[idx:]


def _words(code: str) -> Dict[str, float]:
    return {k: float(v) for k, v in _WORD_RE.findall(code.upper())}


def expand_canned_cycles(lines: List[str], top: float) -> List[str]:
    """Rewrite G83 peck cycles as plain G0/G1 moves.

    Plain moves are what VCarve writes for this machine, so the Richauto converter
    never has to understand canned cycles. Unlike a real G83 (which returns to R),
    the tool is left at the bottom of the hole, which is what PenguinCAM's
    peck-then-spiral holes expect for the clearing pass that follows.

    top is the Z of the stock surface in the frame the lines are written in.
    """
    out = []
    for line in lines:
        code, _comment = _split_comment(line)
        w = _words(code)
        gcodes = [int(g) for g in re.findall(r'G\s*(\d+)(?!\.)', code.upper())]
        if 83 not in gcodes:
            if 80 in gcodes and len(code.strip().split()) == 1:
                continue  # bare G80: nothing to cancel any more
            out.append(line)
            continue
        z, r, q, f = w['Z'], w['R'], w.get('Q', 0.0), w['F']
        out.append(f'(Peck drill to Z{z:.4f}, {q:.4f} pecks)')
        out.append(f'G0 X{w["X"]:.4f} Y{w["Y"]:.4f}')
        out.extend(_peck_moves(z, r, q, f, top=top))
    return out


def _peck_moves(bottom: float, r_plane: float, peck: float, feed: float,
                top: float = 0.0, end_at_bottom: bool = True, chip_break: float = 0.0) -> List[str]:
    """Plain G0/G1 peck moves from r_plane down to bottom.

    top is the Z of the stock surface; the first peck starts there. peck <= 0 means one
    straight plunge. Between pecks the drill either:
      * chip_break > 0: lifts just that far and feeds straight on (what VCarve writes
        for this shop's drills, e.g. 1.2 mm pecks with a 0.38 mm lift), or
      * chip_break == 0: rapids all the way out to r_plane to clear chips, then rapids
        back to just above the last peck (a classic G83).
    """
    moves = [f'G0 Z{r_plane:.4f}']
    deepest = top
    while deepest > bottom + EPS:
        target = bottom if peck <= EPS else max(deepest - peck, bottom)
        if deepest < top - EPS and chip_break <= EPS:
            moves.append(f'G0 Z{deepest + PECK_REENTRY_GAP:.4f}')
        moves.append(f'G1 Z{target:.4f} F{feed:g}')
        deepest = target
        if deepest > bottom + EPS:
            if chip_break > EPS:
                moves.append(f'G0 Z{deepest + chip_break:.4f}')
            else:
                moves.append(f'G0 Z{r_plane:.4f}')
    if not end_at_bottom:
        moves.append(f'G0 Z{r_plane:.4f}')
    return moves


def shift_z(lines: List[str], dz: float) -> List[str]:
    """Add dz to every Z value, so the program's Z0 moves to a new reference.

    Shifts Z words in the code AND in comments (PenguinCAM comments such as
    "lifting to Z0.0600" or "cutting to 0.214"" describe heights in the old frame),
    so the operator never reads a height measured from the wrong place.
    """
    def z_word(m):
        return f'Z{float(m.group(1)) + dz:.4f}'

    def cut_to(m):
        return f'cutting to Z{float(m.group(1)) + dz:.4f}"'

    out = []
    for line in lines:
        code, comment = _split_comment(line)
        code = _Z_RE.sub(z_word, code)
        comment = _Z_RE.sub(z_word, comment)
        comment = re.sub(r'cutting to ([-+]?(?:\d+\.?\d*|\.\d+))"', cut_to, comment)
        out.append(code + comment)
    return out


_Z_RE = re.compile(r'Z\s*([-+]?(?:\d+\.?\d*|\.\d+))')


def linearize_helices(lines: List[str], max_step_deg: float = 30.0, tolerance: float = 0.001) -> List[str]:
    """Replace helical arcs (G2/G3 that also move Z) with short straight G1 moves.

    The Richauto converter keeps helical arcs but warns that VCarve never writes
    them, so ramps into holes and pockets are written as straight segments instead,
    like VCarve's output. Flat arcs (no Z change) are left alone. Each straight segment stays
    within `tolerance` of the true arc (and turns at most max_step_deg), so a tiny ramp-in
    circle needs only a few segments.
    """
    out = []
    x = y = z = None
    feed = None
    motion = None
    for line in lines:
        code, comment = _split_comment(line)
        up = code.upper()
        gs = [int(g) for g in re.findall(r'G\s*(\d+)(?!\.)', up)]
        for g in gs:
            if g in (0, 1, 2, 3):
                motion = g
        w = _words(up)
        if 'F' in w:
            feed = w['F']
        nz = w.get('Z', z)
        is_helix = (motion in (2, 3) and ('I' in w or 'J' in w) and None not in (x, y, z)
                    and nz is not None and abs(nz - z) > EPS)
        if is_helix:
            nx, ny = w.get('X', x), w.get('Y', y)
            cx, cy = x + w.get('I', 0.0), y + w.get('J', 0.0)
            r = math.hypot(x - cx, y - cy)
            a0 = math.atan2(y - cy, x - cx)
            a1 = math.atan2(ny - cy, nx - cx)
            if motion == 3:   # counter-clockwise
                sweep = (a1 - a0) % (2 * math.pi) or 2 * math.pi
            else:
                sweep = -((a0 - a1) % (2 * math.pi) or 2 * math.pi)
            # largest angle whose chord stays within `tolerance` of the arc
            step = math.radians(max_step_deg)
            if r > tolerance:
                step = min(step, 2 * math.acos(1 - tolerance / r))
            n = max(4, int(math.ceil(abs(sweep) / step)))
            note = comment.strip()
            out.append(f'(Ramp {"CCW" if motion == 3 else "CW"} to Z{nz:.4f} as {n} straight moves)'
                       if not note else f'(Ramp to Z{nz:.4f}, {n} straight moves)')
            for k in range(1, n + 1):
                a = a0 + sweep * k / n
                px, py = (nx, ny) if k == n else (cx + r * math.cos(a), cy + r * math.sin(a))
                pz = z + (nz - z) * k / n
                out.append(f'G1 X{px:.4f} Y{py:.4f} Z{pz:.4f}' + (f' F{feed:g}' if k == 1 and feed else ''))
            x, y, z = nx, ny, nz
            motion = 1
            continue
        out.append(line)
        if 53 not in gs:
            x, y, z = w.get('X', x), w.get('Y', y), nz
    return out


def plural(n: int, word: str) -> str:
    return f'{n} {word}' if n == 1 else f'{n} {word}s'


# =============================================================================
# Preflight checks
# =============================================================================

@dataclass
class MotionStats:
    x_min: float = math.inf
    x_max: float = -math.inf
    y_min: float = math.inf
    y_max: float = -math.inf
    z_min: float = math.inf
    z_max: float = -math.inf
    side_cuts_below_top: int = 0      # XY feed moves with the tool below Z0
    rapids_below_top: int = 0         # XY rapid moves with the tool below Z0


def analyze_motion(gcode: str) -> MotionStats:
    """Track the tool through a program: extents, and dangerous moves below the stock top."""
    st = MotionStats()
    x = y = z = None   # unknown until the program sets them
    motion = None
    for raw in gcode.splitlines():
        code, _ = _split_comment(raw)
        code = code.strip().upper()
        if not code:
            continue
        gs = [int(g) for g in re.findall(r'G\s*(\d+)(?!\.)', code)]
        for g in gs:
            if g in (0, 1, 2, 3):
                motion = g
        if 53 in gs or 4 in gs:
            continue  # machine-coordinate moves and dwells don't move the work tool
        w = _words(code)
        if not any(k in w for k in 'XYZ'):
            continue
        nx, ny, nz = w.get('X', x), w.get('Y', y), w.get('Z', z)
        if nx is None or ny is None:
            # XY still unknown (e.g. the opening Z-only retract): only Z is tracked.
            if nz is not None:
                st.z_min, st.z_max = min(st.z_min, nz), max(st.z_max, nz)
            x, y, z = nx, ny, nz
            continue
        xy_move = x is None or y is None or abs(nx - x) > EPS or abs(ny - y) > EPS
        below = z is not None and nz is not None and max(z, nz) < -EPS
        if xy_move and below:
            if motion == 0:
                st.rapids_below_top += 1
            else:
                st.side_cuts_below_top += 1
        pts = [(nx, ny)]
        if motion in (2, 3) and ('I' in w or 'J' in w):
            cx, cy = x + w.get('I', 0.0), y + w.get('J', 0.0)
            rad = math.hypot(x - cx, y - cy)
            pts += [(cx - rad, cy - rad), (cx + rad, cy + rad)]
        for px, py in pts:
            st.x_min, st.x_max = min(st.x_min, px), max(st.x_max, px)
            st.y_min, st.y_max = min(st.y_min, py), max(st.y_max, py)
        if nz is not None:
            st.z_min, st.z_max = min(st.z_min, nz), max(st.z_max, nz)
        x, y, z = nx, ny, nz
    return st


def preflight(gcode: str, tool: Tool, expected_bottom: float, cfg: ShopConfig) -> Tuple[List[str], List[str]]:
    """Check one program against the machine and its tool. Returns (errors, warnings)."""
    errors, warnings = [], []
    st = analyze_motion(gcode)
    tol = 0.0005

    if st.x_min < -tol or st.y_min < -tol:
        errors.append(f'{tool.name}: toolpath goes below X0/Y0 (X min {st.x_min:.3f}", Y min {st.y_min:.3f}"), '
                      f'which is off the stock.')
    if st.x_max > cfg.x_max + tol or st.y_max > cfg.y_max + tol:
        errors.append(f'{tool.name}: toolpath reaches X {st.x_max:.3f}", Y {st.y_max:.3f}", outside the '
                      f'{cfg.x_max:g}" x {cfg.y_max:g}" work area.')
    if st.z_max > cfg.z_max + cfg.safe_height + tol:
        errors.append(f'{tool.name}: toolpath rises to Z {st.z_max:.3f}", above the machine\'s Z range.')
    if math.isfinite(st.z_min):
        if -st.z_min > tool.flute_length + tol:
            errors.append(f'{tool.name}: cuts {-st.z_min:.3f}" deep, deeper than its {tool.flute_length:g}" '
                          f'cutting length.')
        if st.z_min < expected_bottom - 0.002:
            warnings.append(f'{tool.name}: cuts to Z {st.z_min:.4f}", deeper than the expected '
                            f'{expected_bottom:.4f}".')
    if st.rapids_below_top:
        errors.append(f'{tool.name}: {st.rapids_below_top} rapid move(s) travel sideways below the top of '
                      f'the stock.')
    if tool.is_drill and st.side_cuts_below_top:
        errors.append(f'{tool.name}: {st.side_cuts_below_top} sideways cutting move(s). Drills can only '
                      f'cut straight down.')
    return errors, warnings


# =============================================================================
# Job generation
# =============================================================================

@dataclass
class Program:
    index: int
    tool: Tool
    filename: str
    gcode: str
    feature_summary: str
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {'index': self.index, 'filename': self.filename, 'tool_id': self.tool.id,
                'tool_name': self.tool.name, 'spindle_speed': self.tool.spindle_speed,
                'features': self.feature_summary, 'errors': self.errors, 'warnings': self.warnings}


@dataclass
class JobResult:
    success: bool
    part_name: str
    material: str = ''
    thickness_label: str = ''
    thickness: float = 0.0
    stock_size: Tuple[float, float] = (0.0, 0.0)
    hole_groups: List[HoleGroup] = field(default_factory=list)
    programs: List[Program] = field(default_factory=list)
    setup_sheet: str = ''
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    sheet_id: Optional[str] = None
    placement: Optional[Tuple[float, float]] = None       # part's lower-left corner on the sheet
    footprint: List[Tuple[float, float]] = field(default_factory=list)   # space the job needs
    cut_region: List[Tuple[float, float]] = field(default_factory=list)  # what to mark as used after cutting
    parts: List[dict] = field(default_factory=list)   # nested jobs: one entry per placed copy
    unplaced: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            'parts': self.parts,
            'unplaced': self.unplaced,
            'sheet_id': self.sheet_id,
            'placement': list(self.placement) if self.placement else None,
            'footprint': [list(p) for p in self.footprint],
            'cut_region': [list(p) for p in self.cut_region],
            'success': self.success, 'part_name': self.part_name, 'material': self.material,
            'thickness': self.thickness, 'thickness_label': self.thickness_label,
            'stock_size': [round(v, 3) for v in self.stock_size],
            'hole_groups': [g.to_dict() for g in self.hole_groups],
            'programs': [p.to_dict() for p in self.programs],
            'setup_sheet': self.setup_sheet, 'errors': self.errors, 'warnings': self.warnings,
        }

    def zip_bytes(self) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for p in self.programs:
                zf.writestr(p.filename, p.gcode)
            zf.writestr(f'00_{self.part_name}_SETUP.txt', self.setup_sheet)
        return buf.getvalue()


def _team_config_for(cfg: ShopConfig, material: Material, thickness: Thickness,
                     endmill: Optional[Tool] = None) -> TeamConfig:
    """Express the RosCAM shop settings as a PenguinCAM TeamConfig for an end mill pass
    (the profile end mill unless another one is given)."""
    em = material.tool(endmill or cfg.profile_tool)
    preset = {
        'name': material.name,
        'spindle_speed': em.spindle_speed,
        'feed_rate': em.feed_rate,
        'ramp_feed_rate': em.ramp_feed_rate,
        'plunge_rate': em.plunge_rate,
        'traverse_rate': 200.0,
        'approach_rate': em.ramp_feed_rate,
        'ramp_angle': material.ramp_angle,
        'ramp_start_clearance': 0.05,
        'stepover_percentage': material.stepover,
        'helix_radius_multiplier': 0.5,
        'max_slotting_depth': em.stepdown,
        'peck_drill_depth': em.stepdown,
        'tab_width': thickness.tab_width,
        'tab_height': thickness.tab_height,
    }
    return TeamConfig({
        'machine': {
            'name': cfg.machine_name,
            'controller': cfg.controller,
            'dimensions': {'x_max': cfg.x_max, 'y_max': cfg.y_max, 'z_max': cfg.z_max},
        },
        'machining': {
            'z_reference': {'sacrifice_board_depth': cfg.overcut,
                            'clearance_height': cfg.clearance_height},
            'tabs': {'enabled': cfg.tabs_enabled, 'width': thickness.tab_width,
                     'height': thickness.tab_height, 'spacing': thickness.tab_spacing,
                     'remove_tabs': cfg.remove_tabs},
            'fixturing': {'pause_before_perimeter': False},
            'default_tool': {'diameter': em.diameter},
        },
        'materials': {material.id: preset},
    })


def _program_header(cfg: ShopConfig, tool: Tool, part: str, material: Material, thickness: Thickness,
                    index: int, total: int, stock: Tuple[float, float], features: str,
                    timestamp: str, sheet_id: Optional[str] = None) -> List[str]:
    lines = [
        f'(RosCAM {part})',
        f'(Program {index} of {total}: {features})',
        f'(Tool: {tool.name})',
        f'(Spindle {tool.spindle_speed} RPM)',
        f'(Material: {material.name} {thickness.label} in)',
        (f'(Sheet {re.sub(r"[^A-Za-z0-9 _.#-]", "-", sheet_id)[:30]}, {stock[0]:g} x {stock[1]:g} in)' if sheet_id
         else f'(Stock at least {stock[0]:.2f} x {stock[1]:.2f} in)'),
        '(Zero X0 Y0 at lower-left corner of ' + ('sheet)' if sheet_id else 'stock)'),
        '(Zero Z0 on TOP of stock)',
        '(Re-zero Z after every bit change)',
        f'(Generated {timestamp})',
        '',
        'G17  ; XY plane',
        'G94  ; Feed per minute',
        'G91.1  ; Arc centers incremental',
        'G40  ; Cutter comp cancel',
        'G49  ; Tool length comp cancel',
        'G90  ; Absolute positioning',
        'G20  ; Inches',
        'G54  ; Work coordinate system',
        '',
        f'G0 Z{cfg.safe_height:.4f}  ; Safe height',
        f'S{tool.spindle_speed} M3  ; Spindle on',
        '',
    ]
    return lines


def _program_footer(cfg: ShopConfig) -> List[str]:
    return [
        '',
        '(===== FINISH =====)',
        f'G0 Z{cfg.safe_height:.4f}  ; Safe height',
        'M5  ; Spindle off',
        'G0 X0 Y0  ; Return to origin',
        'M30  ; Program end',
        '',
    ]


def _drill_body(tool: Tool, centers: List[Tuple[float, float]], bottom: float, cfg: ShopConfig) -> List[str]:
    lines = [f'(Drill {len(centers)} holes to Z{bottom:.4f})',
             f'(Depth = stock + {tool.tip_length:.4f} tip + {cfg.overcut:.4f} overcut)']
    for i, (cx, cy) in enumerate(centers, 1):
        lines.append(f'(Hole {i})')
        lines.append(f'G0 X{cx:.4f} Y{cy:.4f}')
        lines.extend(_peck_moves(bottom, DRILL_RETRACT, tool.peck, tool.plunge_rate, end_at_bottom=False,
                                 chip_break=tool.peck_retract))
        lines.append(f'G0 Z{cfg.clearance_height:.4f}')
    return lines


def _route(pp: FRCPostProcessor, centers: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
    if len(centers) <= 1:
        return list(centers)
    items, _, _ = pp._optimize_route([{'center': c} for c in centers], 'holes')
    return [tuple(i['center']) for i in items]


# =============================================================================
# Sheets: placing a part on a partly used sheet
# =============================================================================

# Spacing on a sheet. The end mill cuts a slot one cutter DIAMETER wide outside every
# outline, so a part needs outline + diameter + cfg.cut_gap of room: the gap is solid
# material left between that slot and anything else (another part's slot, the sheet edge,
# a used area), so tabs always have something to hold on to.
def _slot_width(endmill: 'Tool') -> float:
    return endmill.diameter
# Grid the automatic placement searches on.
PLACEMENT_STEP = 0.25


@dataclass
class Sheet:
    """A sheet of stock: its size and the areas already used up (polygons, inches,
    measured from the sheet's lower-left corner)."""
    id: str
    width: float
    height: float
    regions: List[List[Tuple[float, float]]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict) -> 'Sheet':
        return cls(id=str(d['id']), width=float(d['width']), height=float(d['height']),
                   regions=[[(float(x), float(y)) for x, y in poly] for poly in d.get('regions') or []])


def _part_outline(pp: FRCPostProcessor):
    """The part's outer boundary as a polygon (largest closed shape: polyline or circle)."""
    best = None
    for poly in pp.polylines:
        if len(poly) >= 3:
            shape = Polygon(poly)
            if not shape.is_valid:
                shape = shape.buffer(0)
            if best is None or shape.area > best.area:
                best = shape
    for c in pp.circles:
        shape = Point(c['center']).buffer(c['diameter'] / 2, 64)
        if best is None or shape.area > best.area:
            best = shape
    return best


def _coords(shape, tolerance: float = 0.005) -> List[Tuple[float, float]]:
    shape = shape.simplify(tolerance, preserve_topology=True)
    if shape.geom_type == 'MultiPolygon':
        shape = max(shape.geoms, key=lambda g: g.area)
    return [(round(x, 4), round(y, 4)) for x, y in shape.exterior.coords[:-1]]


def place_on_sheet(footprint, sheet: Sheet, cfg: ShopConfig,
                   placement: Optional[Tuple[float, float]] = None) -> Tuple[Optional[Tuple[float, float]], Optional[str]]:
    """Find where the part goes on the sheet.

    footprint is the space the job needs with the part's bounding box at (0, 0). Returns
    ((dx, dy), None) to move the part there, or (None, reason). With placement given,
    only that spot is checked; otherwise the lowest, then left-most, free spot is used.
    """
    usable = box(0, 0, min(sheet.width, cfg.x_max), min(sheet.height, cfg.y_max))
    blocked = unary_union([Polygon(r).buffer(0) for r in sheet.regions if len(r) >= 3]) if sheet.regions else None
    fminx, fminy, fmaxx, fmaxy = footprint.bounds

    def fits(dx, dy):
        moved = affinity.translate(footprint, dx, dy)
        if not usable_p.contains(moved):
            return False
        return blocked is None or moved.intersection(blocked).area < 1e-6

    usable_p = prep(usable)
    if placement is not None:
        dx, dy = float(placement[0]), float(placement[1])
        moved = affinity.translate(footprint, dx, dy)
        if not usable.contains(moved):
            return None, (f'The part does not fit on sheet {sheet.id} there: it needs '
                          f'{cfg.cut_gap:g}" of solid material between its cut and the sheet edge.')
        if blocked is not None and moved.intersection(blocked).area >= 1e-6:
            return None, f'That spot overlaps an area of sheet {sheet.id} that is already used.'
        return (dx, dy), None

    ux0, uy0, ux1, uy1 = usable.bounds
    y = uy0 - fminy
    while y + fmaxy <= uy1 + 1e-9:
        x = ux0 - fminx
        while x + fmaxx <= ux1 + 1e-9:
            if fits(x, y):
                return (round(x, 4), round(y, 4)), None
            x += PLACEMENT_STEP
        y += PLACEMENT_STEP
    return None, (f'No free space on sheet {sheet.id} for this part '
                  f'({fmaxx - fminx:.2f}" x {fmaxy - fminy:.2f}" including cutter clearance). '
                  f'Try rotating it or pick another sheet.')


def generate_job(dxf_path: str, material: str, thickness, cfg: Optional[ShopConfig] = None,
                 overrides: Optional[Dict[str, str]] = None, rotation: int = 0,
                 part_name: Optional[str] = None, timestamp: Optional[str] = None,
                 sheet: Optional[Sheet] = None,
                 placement: Optional[Tuple[float, float]] = None) -> JobResult:
    """Turn one flat-part DXF into per-tool programs plus a setup sheet.

    With a sheet, the part is placed on that sheet clear of its used areas (at
    `placement` if given: the part's lower-left corner in sheet coordinates) and the
    programs are zeroed on the sheet's lower-left corner.
    """
    cfg = cfg or load_config()
    part = sanitize_filename_base(part_name or os.path.splitext(os.path.basename(dxf_path))[0], 'part')
    timestamp = timestamp or datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    result = JobResult(success=False, part_name=part)

    try:
        mat = cfg.material(material)
        thk = mat.find_thickness(thickness)
    except ValueError as e:
        result.errors.append(str(e))
        return result
    result.material, result.thickness_label, result.thickness = mat.name, thk.label, thk.value

    endmill = mat.tool(cfg.profile_tool)
    pp = FRCPostProcessor(material_thickness=thk.value, tool_diameter=endmill.diameter,
                          units='inch', config=_team_config_for(cfg, mat, thk))
    pp.apply_material_preset(mat.id)
    pp.tab_spacing = thk.tab_spacing
    pp.load_dxf(dxf_path)
    if pp.layer_data:
        result.errors.append('This DXF has depth layers (2.5D). RosCAM only handles flat, through-cut plates.')
        return result

    if sheet is None:
        margin = cfg.stock_margin
        pp.transform_coordinates('bottom-left', rotation, placement_offset=(margin, margin))
        bbox = pp.bounding_box()
        if bbox:
            result.stock_size = (bbox[2] + margin, bbox[3] + margin)
            if result.stock_size[0] > cfg.x_max or result.stock_size[1] > cfg.y_max:
                result.errors.append(f'Part plus margin is {result.stock_size[0]:.2f}" x {result.stock_size[1]:.2f}", '
                                     f'bigger than the {cfg.x_max:g}" x {cfg.y_max:g}" work area. Try rotating it 90 deg.')
    else:
        # Normalize the part to (0, 0), find room on the sheet, then move it there.
        pp.transform_coordinates('bottom-left', rotation, placement_offset=(0.0, 0.0), enforce_bounds=False)
        outline = _part_outline(pp)
        if outline is None:
            result.errors.append('Could not find the outline of this part.')
            return result
        footprint = outline.buffer(_slot_width(endmill) + cfg.cut_gap)
        offset, why = place_on_sheet(footprint, sheet, cfg, placement)
        result.sheet_id = sheet.id
        result.stock_size = (sheet.width, sheet.height)
        if offset is None:
            result.errors.append(why)
            result.footprint = _coords(affinity.translate(footprint, *(placement or (0, 0))))
            result.placement = tuple(placement) if placement else None
            return result
        pp.transform_coordinates('bottom-left', 0, placement_offset=offset, enforce_bounds=False)
        result.placement = offset
        result.footprint = _coords(affinity.translate(footprint, *offset))
        result.cut_region = _coords(affinity.translate(outline.buffer(_slot_width(endmill)), *offset))

    # The outer boundary may itself be a circle (a round part); it isn't a hole.
    all_circles = list(pp.circles)
    perimeter_circle = _perimeter_circle(pp)
    hole_circles = [c for c in all_circles if c is not perimeter_circle]

    groups, errs, warns = plan_holes(hole_circles, cfg, overrides)
    result.hole_groups, result.errors, result.warnings = groups, result.errors + errs, warns
    if result.errors:
        return result

    # The end mill pass only sees the circles it should mill (plus a round perimeter).
    milled_keys = {g.key for g in groups if g.tool_id == MILL}
    pp.circles = [c for c in all_circles
                  if c is perimeter_circle or group_key(c['diameter']) in milled_keys]
    pp.classify_holes()
    pp.identify_perimeter_and_pockets()

    drill_bottom = lambda tool: -(thk.value + cfg.overcut + tool.tip_length)
    mill_bottom = -(thk.value + cfg.overcut)

    # --- drill programs, smallest drill first ---
    planned = []  # (tool, body_lines, bottom, summary)
    for drill in (mat.tool(d) for d in cfg.drills):
        centers = [c for g in groups if g.tool_id == drill.id for c in g.centers]
        if not centers:
            continue
        bottom = drill_bottom(drill)
        body = _drill_body(drill, _route(pp, centers), bottom, cfg)
        planned.append((drill, body, bottom, f'drill {plural(len(centers), "hole")}'))

    # --- end mill program: milled holes, pockets, then the outline with tabs ---
    pp._pending_clearance_rapid = True
    em = pp.generate_gcode(suggested_filename=part, timestamp=timestamp, include_header_footer=False)
    if not em.success:
        result.errors.extend(em.errors)
        return result
    result.warnings.extend(em.warnings)
    body = shift_z(expand_canned_cycles(em.gcode.splitlines(), top=thk.value), -thk.value)
    body = linearize_helices(body)
    bits = []
    if pp.holes:
        bits.append(f'mill {plural(len(pp.holes), "hole")}')
    if pp.pockets:
        bits.append(plural(len(pp.pockets), 'pocket'))
    if pp.perimeter:
        bits.append('outline with tabs' if cfg.tabs_enabled else 'outline')
    planned.append((endmill, body, mill_bottom, ', '.join(bits) or 'nothing'))

    total = len(planned)
    for i, (tool, body, bottom, summary) in enumerate(planned, 1):
        lines = (_program_header(cfg, tool, part, mat, thk, i, total, result.stock_size, summary, timestamp,
                                 result.sheet_id)
                 + body + _program_footer(cfg))
        gcode = finalize_gcode(lines)
        p_err, p_warn = preflight(gcode, tool, bottom, cfg)
        filename = f'{i:02d}_{part}_{tool.short_label}.nc'
        result.programs.append(Program(i, tool, filename, gcode, summary, p_err, p_warn))
        result.errors.extend(p_err)
        result.warnings.extend(p_warn)

    result.setup_sheet = build_setup_sheet(result, cfg, timestamp)
    result.success = not result.errors
    return result


def _perimeter_circle(pp: FRCPostProcessor):
    """If the part's outer boundary is a circle, return that circle dict."""
    if not pp.circles:
        return None
    biggest = max(pp.circles, key=lambda c: c['diameter'])
    bbox = pp.bounding_box()
    if not bbox:
        return None
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if abs(biggest['diameter'] - w) < 0.001 and abs(biggest['diameter'] - h) < 0.001:
        return biggest
    return None


def build_setup_sheet(result: JobResult, cfg: ShopConfig, timestamp: str) -> str:
    sx, sy = result.stock_size
    lines = [
        f'RosCAM setup sheet - {result.part_name}',
        f'Generated {timestamp}',
        '',
        f'Material: {result.material}, {result.thickness_label}" ({result.thickness:.4f}")',
    ]
    if result.sheet_id:
        lines += [f'Sheet:    {result.sheet_id} ({sx:g}" x {sy:g}")']
        if result.parts:
            lines.append(f'Parts:    {len(result.parts)} on this sheet')
            for p in result.parts:
                xs = [q[0] for q in p['outline']]
                ys = [q[1] for q in p['outline']]
                lines.append(f'          {p["label"]}: lower-left at X {min(xs):.3f}" Y {min(ys):.3f}", '
                             f'turned {p["rotation"]} deg')
        elif result.placement:
            px, py = result.placement
            lines.append(f'Part:     lower-left corner at X {px:.3f}" Y {py:.3f}" on the sheet')
        if result.unplaced:
            lines.append(f'Did NOT fit on this sheet: {", ".join(result.unplaced)}')
        lines.append('Zero:     X0 Y0 at the LOWER-LEFT corner of the SHEET, Z0 on TOP of the sheet')
    else:
        lines += [
            f'Stock:    at least {sx:.2f}" (X) x {sy:.2f}" (Y)',
            f'Zero:     X0 Y0 at the LOWER-LEFT corner of the stock, Z0 on TOP of the stock',
        ]
    lines += [
        '',
        'Holes:',
    ]
    for g in result.hole_groups:
        how = 'end mill' if g.tool_id == MILL else (cfg.tools[g.tool_id].name if g.tool_id else 'CANNOT MAKE')
        lines.append(f'  {g.count:3d} x {g.diameter:.4f}"  ->  {how}' + (f'   ({g.note})' if g.note else ''))
    if not result.hole_groups:
        lines.append('  none')
    lines += ['', 'Run order:']
    for p in result.programs:
        lines += [
            f'  {p.index}. Load the {p.tool.name}.',
            f'     Zero Z on top of the stock.',
            f'     Run {p.filename}  ({p.feature_summary}, {p.tool.spindle_speed} RPM)',
        ]
    lines += ['', 'Convert each .nc file with the PartsTracker /cnc page before running it.',
              'Dry-run above the stock first if anything looks unfamiliar.']
    if result.warnings:
        lines += ['', 'Warnings:'] + [f'  - {w}' for w in result.warnings]
    return '\n'.join(lines) + '\n'


# =============================================================================
# Several parts nested on one sheet
# =============================================================================

# Extra margin added to nesting shapes so simplifying their curves can never make
# them smaller than the real part.
NEST_TOLERANCE = 0.01


@dataclass
class PartFile:
    path: str
    name: str


def _load_part(path: str, cfg: ShopConfig, mat: Material, thk: Thickness, endmill: Tool) -> FRCPostProcessor:
    pp = FRCPostProcessor(material_thickness=thk.value, tool_diameter=endmill.diameter,
                          units='inch', config=_team_config_for(cfg, mat, thk))
    pp.apply_material_preset(mat.id)
    pp.tab_spacing = thk.tab_spacing
    pp.load_dxf(path)
    return pp


def _hole_circles(pp: FRCPostProcessor):
    perimeter = _perimeter_circle(pp)
    return perimeter, [c for c in pp.circles if c is not perimeter]


def part_info(path: str, name: str, material: str, thickness, cfg: Optional[ShopConfig] = None) -> dict:
    """What the nesting step needs to know about one part: its outline, the shape it may
    not overlap with others (outline + the cut's slot + half the cut gap), and its holes."""
    cfg = cfg or load_config()
    out = {'name': name, 'errors': [], 'warnings': [], 'hole_groups': [], 'outline': [], 'nest_shape': [],
           'width': 0.0, 'height': 0.0}
    try:
        mat = cfg.material(material)
        thk = mat.find_thickness(thickness)
        endmill = mat.tool(cfg.profile_tool)
        pp = _load_part(path, cfg, mat, thk, endmill)
    except Exception as e:
        out['errors'].append(f'Could not read {name}: {e}')
        return out
    if pp.layer_data:
        out['errors'].append(f'{name} has depth layers (2.5D). RosCAM only handles flat, through-cut plates.')
        return out
    pp.transform_coordinates('bottom-left', 0, placement_offset=(0.0, 0.0), enforce_bounds=False)
    outline = _part_outline(pp)
    if outline is None:
        out['errors'].append(f'Could not find the outline of {name}.')
        return out
    _, holes = _hole_circles(pp)
    groups, errs, warns = plan_holes(holes, cfg, {})
    shape = outline.buffer(_slot_width(endmill) + cfg.cut_gap / 2 + NEST_TOLERANCE, 16)
    shape = shape.simplify(NEST_TOLERANCE, preserve_topology=True)
    minx, miny, maxx, maxy = outline.bounds
    out.update(outline=_coords(outline, 0.002), nest_shape=_coords(shape, 0.0),
               width=round(maxx - minx, 4), height=round(maxy - miny, 4),
               hole_groups=[g.to_dict() for g in groups], errors=[f'{name}: {e}' for e in errs],
               warnings=[f'{name}: {w}' for w in warns])
    return out


def nest_setup(sheet: Sheet, cfg: Optional[ShopConfig] = None) -> dict:
    """The sheet as the nesting step sees it: the rectangle a part's nesting shape must stay
    inside, and the used areas it must stay out of. Nesting shapes are outline + slot + half
    the cut gap, so the sheet edge and used areas get the other half here, giving the same
    spacing generate_sheet_job checks."""
    cfg = cfg or load_config()
    half = cfg.cut_gap / 2 + NEST_TOLERANCE
    w, h = min(sheet.width, cfg.x_max), min(sheet.height, cfg.y_max)
    bin_rect = [[half, half], [w - half, half], [w - half, h - half], [half, h - half]]
    obstacles = []
    if sheet.regions:
        grown = unary_union([Polygon(rg).buffer(0) for rg in sheet.regions if len(rg) >= 3]).buffer(half, 8)
        geoms = getattr(grown, 'geoms', [grown])
        obstacles = [[list(p) for p in _coords(g, NEST_TOLERANCE / 2)] for g in geoms if not g.is_empty]
    return {'bin': bin_rect, 'obstacles': obstacles}


# ---- details the profile end mill can't reach ---------------------------------------------
#
# This geometry is done with Clipper (pyclipper: integer coordinates, so no floating-point
# topology failures) rather than shapely/GEOS. Growing and shrinking these cutter-shaped
# outlines tripped GEOS 3.12's buffer ("depth mismatch") in the browser, where that error is
# not catchable and kills the whole engine. Shapes are lists of polygons, each polygon a
# list of integer paths: the outer ring first, then its holes.

# Leftover thinner than this is ignored: every round cutter leaves a little in a sharp
# inside corner, and chasing that with ever smaller bits isn't what's wanted.
SLIVER = 0.02
_CS = 1_000_000                      # Clipper units per inch


def _c_paths(polys) -> list:
    return [path for poly in polys for path in poly]


def _c_tree(tree) -> list:
    """PolyTree -> [[outer, hole, ...], ...]."""
    out = []

    def walk(node):
        for child in node.Childs:
            if child.IsHole:
                continue
            out.append([child.Contour] + [h.Contour for h in child.Childs if h.IsHole])
            for h in child.Childs:              # islands inside holes
                walk(h)
    walk(tree)
    return [p for p in out if len(p[0]) >= 3]


def _c_from_shapely(g) -> list:
    polys = []
    for part in getattr(g, 'geoms', [g]):
        if part.geom_type != 'Polygon' or part.is_empty:
            continue
        # Clipper reads a clockwise ring as a hole (offsetting would shrink it), so outer
        # rings must run counter-clockwise and holes clockwise.
        part = orient(part, sign=1.0)
        rings = [part.exterior] + list(part.interiors)
        polys.append([[(int(round(x * _CS)), int(round(y * _CS))) for x, y in r.coords[:-1]] for r in rings])
    return polys


def _c_to_shapely(poly) -> Polygon:
    rings = [[(x / _CS, y / _CS) for x, y in path] for path in poly]
    return Polygon(rings[0], rings[1:])


def _c_area(poly) -> float:
    return abs(sum(pyclipper.Area(p) for p in poly)) / (_CS * _CS) if poly else 0.0


def _c_offset(polys, distance: float, closed_line: bool = False) -> list:
    """Grow (or shrink, if negative) polygons by distance inches, rounding the corners.
    closed_line: offset the rings as lines, giving the band a cutter sweeps along them."""
    if not polys:
        return []
    pco = pyclipper.PyclipperOffset()
    pco.ArcTolerance = 0.0002 * _CS
    end = pyclipper.ET_CLOSEDLINE if closed_line else pyclipper.ET_CLOSEDPOLYGON
    pco.AddPaths(_c_paths(polys), pyclipper.JT_ROUND, end)
    return _c_tree(pco.Execute2(distance * _CS))


def _c_op(op, subject, clip) -> list:
    if not subject:
        return []
    if not clip:                         # nothing to subtract / intersect with
        return [list(p) for p in subject] if op == pyclipper.CT_DIFFERENCE else []
    pc = pyclipper.Pyclipper()
    pc.AddPaths(_c_paths(subject), pyclipper.PT_SUBJECT, True)
    pc.AddPaths(_c_paths(clip), pyclipper.PT_CLIP, True)
    return _c_tree(pc.Execute2(op, pyclipper.PFT_NONZERO, pyclipper.PFT_NONZERO))


def _c_diff(a, b):
    return _c_op(pyclipper.CT_DIFFERENCE, a, b)


def _c_inter(a, b):
    return _c_op(pyclipper.CT_INTERSECTION, a, b)


def _c_union(a, b):
    polys = a + b
    if not polys:
        return []
    pc = pyclipper.Pyclipper()
    pc.AddPaths(_c_paths(polys), pyclipper.PT_SUBJECT, True)
    return _c_tree(pc.Execute2(pyclipper.CT_UNION, pyclipper.PFT_NONZERO, pyclipper.PFT_NONZERO))


def _significant(polys) -> list:
    """The polygons that are more than a sliver."""
    return [p for p in polys if _c_area(p) > 1e-6 and _c_offset([p], -SLIVER)]


def _out_of_reach(outline, pockets: List, radius: float):
    """Material a cutter of this radius can't remove: between narrow outside features (e.g.
    rack teeth) and in tight spots inside cutouts.

    Returns ([(region, allowed)], indexes of cutouts the cutter can't enter at all), where
    `allowed` is the area around the region that gets cut away anyway (the big end mill's
    slot outside the part, or the rest of the cutout), so a smaller bit may run into it:
    a tooth gap's open side is where the big end mill cuts, not a wall."""
    regions, whole = [], []
    part = _c_from_shapely(Polygon(outline.exterior.coords))
    # Outside: the cutter's centre runs on the outline grown by its radius; sweeping the
    # cutter along that path gives what it removes, and whatever is left between the path
    # and the part (e.g. between rack teeth) is out of reach.
    grown = _c_offset(part, radius)
    if grown:
        path = max(grown, key=_c_area)
        swept = _c_offset([[path[0]]], radius, closed_line=True)
        slot_zone = _c_diff(_c_offset(part, 2 * radius), part)
        regions += [(g, slot_zone) for g in _significant(_c_diff(_c_diff([[path[0]]], part), swept))]
    for i, pocket in enumerate(pockets):
        cp = _c_from_shapely(pocket)
        inner = _c_offset(cp, -radius)
        if not inner or sum(_c_area(p) for p in inner) < 0.001:
            whole.append(i)
            regions += [(p, cp) for p in cp]
            continue
        regions += [(g, cp) for g in _significant(_c_diff(cp, _c_offset(inner, radius)))]
    return regions, whole


def _grown(region, allowed, radius: float) -> list:
    """The region plus a bit's width of the area that gets cut away anyway."""
    return _c_union(_c_inter(_c_offset([region], 2 * radius), allowed), [region])


def _reaches(region, allowed, radius: float) -> bool:
    """Can a cutter of this radius clear the whole region (nothing but slivers left)?"""
    inner = _c_offset(_grown(region, allowed, radius), -radius)
    if not inner:
        return False
    return not _significant(_c_diff([region], _c_offset(inner, radius)))


def _detail_tool(region, allowed, candidates: List[Tool]) -> Tuple[Optional[Tool], bool]:
    """The largest end mill that clears the region; else the smallest that clears some of it.
    Returns (tool, clears_all)."""
    for t in candidates:                       # largest first
        if _reaches(region, allowed, t.diameter / 2):
            return t, True
    for t in reversed(candidates):             # smallest first
        if _c_offset(_grown(region, allowed, t.diameter / 2), -t.diameter / 2):
            return t, False
    return None, False


def _detail_pockets(region_polys, radius: float) -> List[Polygon]:
    """Split a (grown) detail region into pockets the bit can clear one at a time: one per
    separate place its centre can go."""
    out = []
    for inner in _c_offset(region_polys, -radius):
        if _c_area(inner) < 0.001:
            continue       # only a sliver of room for the bit's centre: nothing worth chasing
        for sub in _c_inter(_c_offset([inner], radius), region_polys):
            if _c_area(sub) >= 1e-5:
                out.append(_c_to_shapely(sub))
    return out


def _layered_pocket(pp: FRCPostProcessor, region, stepdown: float) -> List[str]:
    """Clear a region in depth layers of at most `stepdown` (PenguinCAM clears a pocket at
    full depth, too much for a small end mill). Each layer ramps in from just above the
    floor the last layer left."""
    top, bottom = pp.material_top, pp.cut_depth
    clearance = pp.ramp_start_clearance
    layers = max(1, int(math.ceil((top - bottom) / max(stepdown, 1e-3) - 1e-9)))
    lines = []
    try:
        for k in range(1, layers + 1):
            pp.material_top = top - (top - bottom) * (k - 1) / layers    # ramp in from the last floor,
            pp.ramp_start_clearance = clearance if k == 1 else 0.005     # starting just above it
            pp.cut_depth = top - (top - bottom) * k / layers
            pp._pending_clearance_rapid = True
            lines.append(f'(Layer {k} of {layers})')
            lines.append(f'G0 Z{pp.retract_height:.4f}')
            lines.extend(pp._generate_pocket_gcode_from_polygon(region))
    finally:
        pp.material_top, pp.cut_depth, pp.ramp_start_clearance = top, bottom, clearance
    return lines


def generate_sheet_job(parts: List[PartFile], placements: List[dict], material: str, thickness,
                       sheet: Sheet, cfg: Optional[ShopConfig] = None,
                       overrides: Optional[Dict[str, str]] = None,
                       unplaced: Optional[List[str]] = None,
                       job_name: Optional[str] = None, timestamp: Optional[str] = None) -> JobResult:
    """Programs for several parts laid out on one sheet.

    placements: one dict per copy: {'part': index into parts, 'x', 'y', 'rotation'}, where
    the copy's shape is the part's rotation-0 outline (lower-left at 0,0) turned
    `rotation` degrees counter-clockwise about the origin and then moved by (x, y): the
    layout the nesting step (web/nest) returns.
    """
    cfg = cfg or load_config()
    timestamp = timestamp or datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    name = sanitize_filename_base(job_name or (sheet.id if len(parts) != 1 else parts[0].name), 'job')
    result = JobResult(success=False, part_name=name, sheet_id=sheet.id,
                       stock_size=(sheet.width, sheet.height), unplaced=list(unplaced or []))
    try:
        mat = cfg.material(material)
        thk = mat.find_thickness(thickness)
    except ValueError as e:
        result.errors.append(str(e))
        return result
    result.material, result.thickness_label, result.thickness = mat.name, thk.label, thk.value
    endmill = mat.tool(cfg.profile_tool)
    slot = _slot_width(endmill)
    gap = cfg.cut_gap
    if not placements:
        result.errors.append('No parts are placed on the sheet.')
        return result

    # Rotation-0 outline of each part file, as the nesting step saw it.
    base_outline = {}
    for idx, part in enumerate(parts):
        pp0 = _load_part(part.path, cfg, mat, thk, endmill)
        if pp0.layer_data:
            result.errors.append(f'{part.name} has depth layers (2.5D). RosCAM only handles flat plates.')
            return result
        pp0.transform_coordinates('bottom-left', 0, placement_offset=(0.0, 0.0), enforce_bounds=False)
        base_outline[idx] = _part_outline(pp0)
        if base_outline[idx] is None:
            result.errors.append(f'Could not find the outline of {part.name}.')
            return result

    usable = box(0, 0, min(sheet.width, cfg.x_max), min(sheet.height, cfg.y_max))
    blocked = unary_union([Polygon(rg).buffer(0) for rg in sheet.regions if len(rg) >= 3]) if sheet.regions else None

    # Place every copy.
    copies = []   # (label, pp, outline)
    counts: Dict[int, int] = {}
    for pl in placements:
        idx = int(pl['part'])
        part = parts[idx]
        counts[idx] = counts.get(idx, 0) + 1
        label = f'{part.name} #{counts[idx]}'
        rot = int(round(float(pl.get('rotation', 0)))) % 360
        if rot % 90:
            result.errors.append(f'{label}: rotation {rot} deg is not a multiple of 90.')
            continue
        target = affinity.translate(affinity.rotate(base_outline[idx], rot, origin=(0, 0)),
                                    float(pl['x']), float(pl['y']))
        pp = _load_part(part.path, cfg, mat, thk, endmill)
        pp.transform_coordinates('bottom-left', (360 - rot) % 360, placement_offset=(0.0, 0.0), enforce_bounds=False)
        here = _part_outline(pp)
        dx, dy = target.bounds[0] - here.bounds[0], target.bounds[1] - here.bounds[1]
        pp.transform_coordinates('bottom-left', 0, placement_offset=(dx, dy), enforce_bounds=False)
        outline = _part_outline(pp)
        if outline.symmetric_difference(target).area > 1e-3 * max(target.area, 1e-9) + 1e-4:
            result.errors.append(f'{label}: internal error placing the part (shape mismatch).')
            continue
        copies.append((label, pp, outline))

    # Safety net: re-check the whole layout, whatever produced it.
    for label, pp, outline in copies:
        need = outline.buffer(slot + gap)
        if not usable.contains(need):
            result.errors.append(f'{label} is too close to the edge of sheet {sheet.id} (or off it): its cut needs '
                                 f'{gap:g}" of solid material before the edge.')
        if blocked is not None and need.intersection(blocked).area > 1e-6:
            result.errors.append(f'{label} overlaps an area of sheet {sheet.id} that is already used.')
    spaced = [outline.buffer(slot + gap / 2) for _, _, outline in copies]
    for i in range(len(copies)):
        for j in range(i + 1, len(copies)):
            if spaced[i].intersection(spaced[j]).area > 1e-6:
                result.errors.append(f'{copies[i][0]} and {copies[j][0]} are too close together: their cuts need '
                                     f'{gap:g}" of solid material between them.')
    if result.errors:
        return result

    # Holes: one plan for every hole on the sheet, so a size's tool is the same everywhere.
    all_holes, per_copy = [], []
    for label, pp, outline in copies:
        perimeter, holes = _hole_circles(pp)
        per_copy.append((perimeter, holes))
        all_holes.extend(holes)
    groups, errs, warns = plan_holes(all_holes, cfg, overrides)
    result.hole_groups, result.errors, result.warnings = groups, errs, warns
    if errs:
        return result
    milled = {g.key for g in groups if g.tool_id == MILL}
    small_holes: Dict[str, List[Tuple[str, dict]]] = {}      # end mill id -> [(label, circle)]
    small_group = {g.key: g.tool_id for g in groups if g.tool_id not in (None, MILL) and not cfg.tools[g.tool_id].is_drill}
    for (label, pp, outline), (perimeter, holes) in zip(copies, per_copy):
        for c in holes:
            tid = small_group.get(group_key(c['diameter']))
            if tid:
                small_holes.setdefault(tid, []).append((label, c))
        pp.circles = [c for c in pp.circles if c is perimeter or group_key(c['diameter']) in milled]
        pp.classify_holes()
        pp.identify_perimeter_and_pockets()

    # Details the profile end mill can't reach go to the largest smaller end mill that can.
    candidates = [mat.tool(t) for t in cfg.endmills if t.diameter < endmill.diameter - 1e-6]
    details: Dict[str, List[Tuple[str, object]]] = {}         # end mill id -> [(label, region)]
    for label, pp, outline in copies:
        pockets = [Polygon(p).buffer(0) for p in pp.pockets]
        regions, whole = _out_of_reach(outline, pockets, endmill.diameter / 2)
        if whole:                                              # cutouts the 1/4" can't enter at all
            pp.pockets = [p for i, p in enumerate(pp.pockets) if i not in set(whole)]
        for region, allowed in regions:
            tool, clears_all = _detail_tool(region, allowed, candidates)
            c = _c_to_shapely(region).centroid
            if tool is None:
                result.warnings.append(
                    f'{label}: a detail near X {c.x:.2f}" Y {c.y:.2f}" is too tight for the {endmill.name} and '
                    f'there is no smaller end mill in the tool library, so it will be left uncut. '
                    f'Add one on the Tools screen.')
                continue
            if not clears_all:
                result.warnings.append(
                    f'{label}: a detail near X {c.x:.2f}" Y {c.y:.2f}" is too tight even for the {tool.name}; '
                    f'it will be cut as far as that bit reaches.')
            details.setdefault(tool.id, []).append((label, _grown(region, allowed, tool.diameter / 2)))   # Clipper polys

    route_pp = copies[0][1]
    planned = []
    for drill in (mat.tool(d) for d in cfg.drills):
        centers = [c for g in groups if g.tool_id == drill.id for c in g.centers]
        if centers:
            bottom = -(thk.value + cfg.overcut + drill.tip_length)
            planned.append((drill, _drill_body(drill, _route(route_pp, centers), bottom, cfg), bottom,
                            f'drill {plural(len(centers), "hole")}'))

    # Smaller end mills next (largest first), before the profile end mill, while every part
    # is still held all round by the sheet: details out of the big bit's reach, and holes
    # assigned to them.
    for tool in candidates:
        if tool.id not in details and tool.id not in small_holes:
            continue
        pp_t = FRCPostProcessor(material_thickness=thk.value, tool_diameter=tool.diameter, units='inch',
                                config=_team_config_for(cfg, mat, thk, tool))
        pp_t.apply_material_preset(mat.id)
        lines, n_areas, n_small = [], 0, 0
        for label, c in small_holes.get(tool.id, []):
            (cx, cy), dia = c['center'], c['diameter']
            pp_t._pending_clearance_rapid = True
            lines += ['', f'(=== {label}: {dia:.4f} hole ===)', f'G0 Z{pp_t.retract_height:.4f}']
            lines += pp_t._generate_hole_gcode(cx, cy, dia, needs_peck_drill=dia < pp_t.min_millable_hole)
            n_small += 1
        for label, region in details.get(tool.id, []):
            for part_region in _detail_pockets(region, tool.diameter / 2):
                c = part_region.centroid
                lines += ['', f'(=== {label}: detail at X{c.x:.2f} Y{c.y:.2f} ===)']
                lines += _layered_pocket(pp_t, part_region, tool.stepdown)
                n_areas += 1
        if pp_t.errors:
            result.errors.extend(dict.fromkeys(f'{tool.name}: {e}' for e in pp_t.errors))   # once each
            continue
        body = shift_z(expand_canned_cycles(lines, top=thk.value), -thk.value)
        bits = []
        if n_small:
            bits.append(f'mill {plural(n_small, "hole")}')
        if n_areas:
            bits.append(f'{plural(n_areas, "detail")} the {endmill.name.split(",")[0]} cannot reach')
        planned.append((tool, linearize_helices(body), -(thk.value + cfg.overcut), ', '.join(bits)))
    if result.errors:
        return result

    # End mill: every copy's holes and pockets first, then every outline (the part
    # stays held by the sheet while its inside is cut).
    order = sorted(range(len(copies)), key=lambda k: (round(copies[k][2].bounds[1], 1), copies[k][2].bounds[0]))
    interiors, outlines = [], []
    n_holes = n_pockets = 0
    for k in order:
        label, pp, outline = copies[k]
        phases = pp.generate_part_phases()
        if phases['errors']:
            result.errors.extend(f'{label}: {e}' for e in phases['errors'])
            continue
        safe = f'G0 Z{pp.retract_height:.4f}'
        if phases['interior']:
            interiors += ['', f'(=== {label}: holes and pockets ===)', safe] + phases['interior']
        outlines += ['', f'(=== {label}: outline ===)', safe] + phases['perimeter'] + phases['tab_removal']
        n_holes += len(pp.holes)
        n_pockets += len(pp.pockets)
    if result.errors:
        return result
    body = shift_z(expand_canned_cycles(interiors + outlines, top=thk.value), -thk.value)
    body = linearize_helices(body)
    bits = []
    if n_holes:
        bits.append(f'mill {plural(n_holes, "hole")}')
    if n_pockets:
        bits.append(plural(n_pockets, 'pocket'))
    bits.append(plural(len(copies), 'outline') + (' with tabs' if cfg.tabs_enabled else ''))
    planned.append((endmill, body, -(thk.value + cfg.overcut), ', '.join(bits)))

    total = len(planned)
    for i, (tool, body, bottom, summary) in enumerate(planned, 1):
        lines = (_program_header(cfg, tool, name, mat, thk, i, total, result.stock_size, summary, timestamp,
                                 sheet.id)
                 + body + _program_footer(cfg))
        gcode = finalize_gcode(lines)
        p_err, p_warn = preflight(gcode, tool, bottom, cfg)
        result.programs.append(Program(i, tool, f'{i:02d}_{name}_{tool.short_label}.nc', gcode, summary, p_err, p_warn))
        result.errors.extend(p_err)
        result.warnings.extend(p_warn)

    for (label, pp, outline), pl in zip(copies, placements):
        result.parts.append({
            'label': label, 'x': float(pl['x']), 'y': float(pl['y']), 'rotation': int(pl.get('rotation', 0)) % 360,
            'outline': [list(p) for p in _coords(outline)],
            'footprint': [list(p) for p in _coords(outline.buffer(slot + gap / 2))],
            'cut_region': [list(p) for p in _coords(outline.buffer(slot))],
        })
    result.setup_sheet = build_setup_sheet(result, cfg, timestamp)
    result.success = not result.errors
    return result


# =============================================================================
# Browser API (used by web/worker.js through Pyodide)
# =============================================================================

def _tool_row(t: Tool, builtin: bool) -> dict:
    return {'id': t.id, 'name': t.name, 'type': t.type, 'diameter': t.diameter, 'flute_length': t.flute_length,
            'overall_length': t.overall_length, 'flutes': t.flutes, 'spindle_speed': t.spindle_speed,
            'feed_rate': t.feed_rate, 'plunge_rate': t.plunge_rate, 'ramp_feed_rate': t.ramp_feed_rate,
            'stepdown': t.stepdown, 'tip_angle': t.tip_angle, 'peck': t.peck, 'peck_retract': t.peck_retract,
            'builtin': builtin}


def web_options(cfg: Optional[ShopConfig] = None, tools: Optional[list] = None) -> dict:
    """What the web page needs to build its menus."""
    base = cfg or base_config()
    cfg, tool_warnings = config_with_tools(tools, base)
    return {
        'tools': [_tool_row(t, t.id in base.tools and t is base.tools[t.id]) for t in
                  sorted(cfg.tools.values(), key=lambda t: (t.type, t.diameter))],
        'endmills': [{'id': t.id, 'name': t.name, 'diameter': t.diameter} for t in cfg.endmills],
        'tool_warnings': tool_warnings,
        'materials': [{'id': m.id, 'name': m.name, 'thicknesses': [t.label for t in m.thicknesses]}
                      for m in cfg.materials.values()],
        'drills': [{'id': d.id, 'name': d.name, 'diameter': d.diameter} for d in cfg.drills],
        'endmill': {'id': cfg.profile_tool.id, 'name': cfg.profile_tool.name,
                    'diameter': cfg.profile_tool.diameter},
        'machine': {'name': cfg.machine_name, 'x_max': cfg.x_max, 'y_max': cfg.y_max},
    }


def web_generate(dxf_bytes: bytes, filename: str, material: str, thickness: str,
                 overrides: Optional[Dict[str, str]] = None, rotation: int = 0,
                 cfg: Optional[ShopConfig] = None, sheet: Optional[dict] = None,
                 placement=None) -> dict:
    """Run a job from an uploaded DXF and return everything the page shows, as JSON-able data."""
    import base64
    import tempfile
    part = os.path.splitext(os.path.basename(filename or 'part.dxf'))[0]
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'upload.dxf')
        with open(path, 'wb') as fh:
            fh.write(bytes(dxf_bytes))
        try:
            res = generate_job(path, material, thickness, cfg, overrides or {}, int(rotation), part_name=part,
                               sheet=Sheet.from_dict(sheet) if sheet else None,
                               placement=tuple(placement) if placement else None)
        except Exception as e:  # unreadable DXF etc: report it instead of crashing the page
            return {'success': False, 'part_name': part, 'errors': [f'Could not process this DXF: {e}'],
                    'warnings': [], 'hole_groups': [], 'programs': [], 'setup_sheet': ''}
    out = res.to_dict()
    for d, p in zip(out['programs'], res.programs):
        d['gcode'] = p.gcode
        d['tool_type'] = p.tool.type
        d['tool_diameter'] = p.tool.diameter
    out['zip_name'] = f'{res.part_name}_roscam.zip'
    out['zip_base64'] = base64.b64encode(res.zip_bytes()).decode('ascii') if res.success else ''
    return out


def web_part_info(dxf_bytes: bytes, filename: str, material: str, thickness: str,
                  cfg: Optional[ShopConfig] = None, tools: Optional[list] = None) -> dict:
    """Outline, nesting shape and holes of one uploaded DXF."""
    import tempfile
    cfg, _ = config_with_tools(tools, cfg or base_config())
    name = sanitize_filename_base(os.path.splitext(os.path.basename(filename or 'part.dxf'))[0], 'part')
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'part.dxf')
        with open(path, 'wb') as fh:
            fh.write(bytes(dxf_bytes))
        return part_info(path, name, material, thickness, cfg)


def web_nest_setup(sheet: dict, cfg: Optional[ShopConfig] = None, tools: Optional[list] = None) -> dict:
    cfg, _ = config_with_tools(tools, cfg or base_config())
    return nest_setup(Sheet.from_dict(sheet), cfg)


def web_generate_sheet(files: list, material: str, thickness: str, sheet: dict, placements: list,
                       overrides: Optional[Dict[str, str]] = None, unplaced: Optional[list] = None,
                       cfg: Optional[ShopConfig] = None, job_name: Optional[str] = None,
                       tools: Optional[list] = None) -> dict:
    """Programs for a nested layout. files: [{'name', 'bytes'}] in part-index order."""
    import base64
    import tempfile
    cfg, tool_warnings = config_with_tools(tools, cfg or base_config())
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for i, f in enumerate(files):
            path = os.path.join(tmp, f'part{i}.dxf')
            with open(path, 'wb') as fh:
                fh.write(bytes(f['bytes']))
            parts.append(PartFile(path, sanitize_filename_base(str(f['name']), f'part{i + 1}')))
        try:
            res = generate_sheet_job(parts, [dict(p) for p in placements], material, thickness,
                                     Sheet.from_dict(sheet), cfg, overrides or {}, list(unplaced or []),
                                     job_name=job_name)
        except Exception as e:
            return {'success': False, 'part_name': 'job', 'errors': [f'Could not make programs: {e}'],
                    'warnings': [], 'hole_groups': [], 'programs': [], 'setup_sheet': '', 'parts': []}
    out = res.to_dict()
    out['warnings'] = tool_warnings + out['warnings']
    for d, p in zip(out['programs'], res.programs):
        d['gcode'] = p.gcode
        d['tool_type'] = p.tool.type
        d['tool_diameter'] = p.tool.diameter
    out['zip_name'] = f'{res.part_name}_roscam.zip'
    out['zip_base64'] = base64.b64encode(res.zip_bytes()).decode('ascii') if res.success else ''
    return out


# =============================================================================
# CLI
# =============================================================================

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='RosCAM: per-tool CNC programs for a flat plate DXF')
    ap.add_argument('dxf', help='Single-layer DXF of the part (top face)')
    ap.add_argument('-m', '--material', required=True, help='Material id, e.g. aluminum or polycarbonate')
    ap.add_argument('-t', '--thickness', required=True, help='Stocked thickness, e.g. 1/4 or 0.125')
    ap.add_argument('-o', '--out', default=None, help='Output folder (default: next to the DXF)')
    ap.add_argument('--zip', action='store_true', help='Write one .zip instead of separate files')
    ap.add_argument('--rotate', type=int, default=0, choices=[0, 90, 180, 270])
    ap.add_argument('--config', default=None, help='Path to roscam_config.yaml')
    ap.add_argument('--hole', action='append', default=[], metavar='DIA=TOOL',
                    help='Override a hole size, e.g. --hole 0.2031=mill or --hole 0.1600=drill_5_32')
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    overrides = {}
    for spec in args.hole:
        dia, _, tool = spec.partition('=')
        overrides[group_key(float(dia))] = tool
    res = generate_job(args.dxf, args.material, args.thickness, cfg, overrides, args.rotate)

    print()
    print(f'Hole plan for {res.part_name}:')
    for g in res.hole_groups:
        print(f'  {g.count:3d} x {g.diameter:.4f}" -> {g.tool_id or "CANNOT MAKE"} {g.note}')
    for w in res.warnings:
        print(f'WARNING: {w}')
    if not res.success:
        for e in res.errors:
            print(f'ERROR: {e}')
        return 1

    out = args.out or os.path.dirname(os.path.abspath(args.dxf))
    os.makedirs(out, exist_ok=True)
    if args.zip:
        path = os.path.join(out, f'{res.part_name}_roscam.zip')
        with open(path, 'wb') as fh:
            fh.write(res.zip_bytes())
        print(f'Wrote {path}')
    else:
        for p in res.programs:
            with open(os.path.join(out, p.filename), 'w', encoding='ascii') as fh:
                fh.write(p.gcode)
            print(f'Wrote {p.filename}')
        with open(os.path.join(out, f'00_{res.part_name}_SETUP.txt'), 'w', encoding='ascii') as fh:
            fh.write(res.setup_sheet)
    print()
    print(res.setup_sheet)
    return 0


if __name__ == '__main__':
    sys.exit(main())
