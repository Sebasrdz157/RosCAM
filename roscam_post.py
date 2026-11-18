"""Post processors that turn RosCAM's per-tool programs into one machine's own G-code.

The shop's Axiom (Richauto) gets its `.mmg` files from the converter in the browser
(`converter/`). Machines listed here get their file straight from the engine instead.

Avid EX controllers (Centroid CNC12), e.g. an Avid PRO4848
-----------------------------------------------------------
Written in the exact style of Vectric's "Avid EX Controllers, Ver 1.2 for 11x and later"
post, read from files that machine has run (tests/fixtures/avid/):

    N0010 ; ---------------------------------------------      every line numbered, steps of 10,
    ...                                                         4 digits until it needs more
    N0330 T5 M6                                                 the controller pauses for each bit
    N0350 M3  S16782                                            and its tool setter measures it;
    N0370 G53 Z0                                                the VFD takes the S word
    N0380 G0 X3.7544 Y0.6616                                    4 decimals, only changed axes
    N0430 G1 Z0.0000 F5                                         F on the first feed after a rapid
    N0640 G2 X3.8428 Y3.8720 I0.1250 J0.0000                    and whenever it changes; arcs
    ...                                                         always X Y I J (incremental)

Inches, absolute, `;` comments, CRLF line endings, `.cnc` files. All the job's bits go in
one file, one tool-change block each. X0 Y0 is the lower-left corner of the stock and Z0 its
top, like every RosCAM program.
"""
import re
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from gcode_hygiene import finalize_gcode

RULE = '; ---------------------------------------------'

# Setup words RosCAM's engine writes that the Avid header already covers (or that the
# tool-change block replaces): plane, feed mode, arc mode, comp/length cancel, units,
# work offset, spindle and program end.
_SKIP_G = {'17', '20', '40', '49', '54', '90', '91.1', '94'}
_SKIP_M = {'3', '5', '30'}


def _words(code: str) -> List[Tuple[str, str]]:
    """'G1 X1.5 Y-2 F10' -> [('G', '1'), ('X', '1.5'), ('Y', '-2'), ('F', '10')]."""
    out, i, n = [], 0, len(code)
    while i < n:
        ch = code[i]
        if 'A' <= ch <= 'Z':
            j = i + 1
            while j < n and code[j] == ' ':
                j += 1
            k = j
            while k < n and (code[k].isdigit() or code[k] in '.+-'):
                k += 1
            if k > j:
                out.append((ch, code[j:k]))
            i = k if k > j else i + 1
        else:
            i += 1
    return out


class PostError(ValueError):
    """The programs can't be written for this machine (e.g. a bit has no tool number)."""


# Parentheses and square brackets, spelled by code point so no source literal looks like a comment.
_UNSAFE_IN_COMMENT = {c: ' ' for c in (40, 41, 91, 93)}


def _clean_comment(text: str) -> str:
    """Comment text that's safe after a `;`: no parentheses or brackets, single-spaced."""
    return re.sub(r'\s+', ' ', text.translate(_UNSAFE_IN_COMMENT)).strip()


def _num(v: float) -> str:
    s = f'{v:.4f}'
    return '0.0000' if s == '-0.0000' else s


def _feed(f: float) -> str:
    """F15, F72, F7.5: whole numbers without a decimal, as the Avid post writes them."""
    if abs(f - round(f)) < 1e-6:
        return f'F{int(round(f))}'
    return 'F' + f'{f:.2f}'.rstrip('0').rstrip('.')


def _motion(gcode: str) -> List[Tuple[str, Dict[str, float], Optional[str]]]:
    """The moves of one RosCAM program: (G0|G1|G2|G3, words, None) or ('comment', {}, text).

    Stops at the program's FINISH block (spindle off, return to origin): the Avid file
    ends or changes tools in its own way.
    """
    out = []
    modal = None
    started = False
    for raw in gcode.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith('(===== FINISH'):
            break
        code, _, _ = line.partition(';')
        code = code.strip()
        if code.startswith('(') and code.endswith(')') and code.count('(') == 1:
            if started:                       # the engine's own header comments are replaced
                out.append(('comment', {}, _clean_comment(code[1:-1])))
            continue
        code = re.sub(r'\([^)]*\)', ' ', code).upper()
        words = _words(code)
        if not words:
            continue
        gs = [v for k, v in words if k == 'G']
        motion = None
        for g in gs:
            g = g.lstrip('0') or '0'
            if g in ('0', '1', '2', '3'):
                motion = 'G' + g
            elif g not in _SKIP_G:
                raise PostError(f'The Avid post does not handle G{g} (line "{raw.strip()}").')
        for k, v in words:
            if k == 'M' and (v.lstrip('0') or '0') not in _SKIP_M:
                raise PostError(f'The Avid post does not handle M{v} (line "{raw.strip()}").')
        axes = {k: float(v) for k, v in words if k in 'XYZIJF'}
        if motion:
            modal = motion
        elif any(k in axes for k in 'XYZ'):
            motion = modal
        # An arc may give only I/J (a full circle back to where it started).
        if motion and (any(k in axes for k in 'XYZ') or (motion in ('G2', 'G3') and ('I' in axes or 'J' in axes))):
            out.append((motion, axes, None))
            started = True
    return out


def avid_ex(job_name: str, programs: Sequence, stock_size: Tuple[float, float], thickness: float,
            safe_height: float) -> str:
    """One `.cnc` file for an Avid EX controller with every program's bit in it.

    programs: RosCAM Program objects in run order (each with .gcode, .tool and
    .feature_summary); every tool needs a tool_number (the T word the machine expects).
    """
    missing = sorted({p.tool.name for p in programs if p.tool.tool_number is None})
    if missing:
        raise PostError('Give these bits a tool number (the T number the Avid machine uses) on the Tools '
                        'screen: ' + ', '.join(missing))
    name = _clean_comment(job_name)
    sx, sy = stock_size
    tools_used: List[Tuple[int, str]] = []
    for p in programs:
        entry = (p.tool.tool_number, _clean_comment(p.tool.name))
        if entry not in tools_used:
            tools_used.append(entry)

    lines = [
        RULE,
        f'; Filename: {name}',
        ';XY Origin PositionBottom Left Corner',
        ';XY Origin Value X0.000 Y0.000',
        ';Z Origin Material Surface',
        ';',
        ';Material size:',
        f';X {sx:.3f} Y {sy:.3f} Z {thickness:.3f}',
        ';',
        ';Tools Used In Job:',
        *[f';{n} = {tname}' for n, tname in tools_used],
        ';',
        ';Toolpaths In this Job',
        *[f';{p.index}. {_clean_comment(p.feature_summary)}' for p in programs],
        ';',
        '; Generated by RosCAM for Avid EX Controllers',
        '; Same format as the Vectric Avid EX post, Ver 1.2',
        RULE,
        '; Move to Z home ',
        'G53 Z0',
        '; Circular Interpolation Plane Selection XY - Cutter Compensation Cancel',
        'G17 G40',
        '; Select Inches Units',
        'G20',
        '; Canned Cycle Cancel',
        'G80',
        '; Absolute Positioning Mode',
        'G90',
    ]
    for i, p in enumerate(programs):
        t = p.tool
        if i:
            lines.append(f'G0 Z{_num(safe_height)}')
        lines += [
            RULE,
            f'; Toolchange: T{t.tool_number} - Speed: S{t.spindle_speed}',
            RULE,
            '; Start Tool Change',
            f'T{t.tool_number} M6',
            '; Spindle on CW',
            f'M3  S{t.spindle_speed}',
            RULE,
            'G53 Z0',
        ]
        lines += list(_moves(_motion(p.gcode)))
    lines += [
        f'G0 Z{_num(safe_height)}',
        RULE,
        'G53 Z0',
        '; Spindle off',
        'M5',
        '; Coolant Off',
        'M9',
        '; Canned Cycle Cancel',
        'G80',
        '; End-Custom M Code',
        'M30',
    ]
    numbered = [f'N{10 * (n + 1):04d} {line}' for n, line in enumerate(lines)]
    return finalize_gcode(numbered).replace('\n', '\r\n') + '\r\n'


def _moves(moves) -> Iterable[str]:
    """Format one tool's moves: only changed axes on straight moves (after the G53 Z0 at a tool
    change nothing is known, so the first moves give every axis), X Y I J on every arc,
    F on the first feed move after a rapid and whenever it changes."""
    pos: Dict[str, Optional[float]] = {'X': None, 'Y': None, 'Z': None}
    feed = None          # last F the engine set (modal)
    written = None       # last F written to the file
    after_rapid = True
    for kind, words, text in moves:
        if kind == 'comment':
            if text:
                yield f'; {text}'
            continue
        if 'F' in words:
            feed = words['F']
        target = {k: words.get(k, pos[k]) for k in 'XYZ'}
        if kind in ('G0', 'G1'):
            parts = [f'{k}{_num(target[k])}' for k in 'XYZ'
                     if target[k] is not None and (pos[k] is None or _num(pos[k]) != _num(target[k]))]
            if not parts:
                continue
        else:
            if target['X'] is None or target['Y'] is None or not ('I' in words or 'J' in words):
                raise PostError('An arc needs a known start point and a centre (I/J) to be written for the Avid machine.')
            parts = [f'X{_num(target["X"])}', f'Y{_num(target["Y"])}',
                     f'I{_num(words.get("I", 0.0))}', f'J{_num(words.get("J", 0.0))}']
            if target['Z'] is not None and pos['Z'] is not None and _num(pos['Z']) != _num(target['Z']):
                parts.insert(2, f'Z{_num(target["Z"])}')
        line = f'{kind} ' + ' '.join(parts)
        if kind == 'G0':
            after_rapid = True
        else:
            if feed is None:
                raise PostError('A cutting move has no feed rate.')
            if after_rapid or written is None or _feed(feed) != _feed(written):
                line += ' ' + _feed(feed)
                written = feed
            after_rapid = False
        pos.update({k: v for k, v in target.items() if v is not None})
        yield line
