"""Build the DXFs the browser tests use: plate, small, bracket and rack.

    uv run python tests/browser/make_parts.py $S/parts
"""
import os
import sys

import ezdxf

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tests.fixtures.make_roscam_plate import build as build_plate  # noqa: E402


def _save(doc, out, name):
    doc.saveas(os.path.join(out, name))


def small(out):
    doc = ezdxf.new(units=1)
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (3, 0), (3, 2), (0, 2)], close=True)       # 3 x 2, two 13/64 holes
    for x, y in ((0.5, 0.5), (2.5, 1.5)):
        msp.add_circle((x, y), 0.203125 / 2)
    _save(doc, out, 'small.dxf')


def bracket(out):
    doc = ezdxf.new(units=1)
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (5, 0), (5, 1.5), (1.5, 1.5), (1.5, 4), (0, 4)], close=True)  # L bracket
    for x, y in ((0.75, 0.75), (4.25, 0.75), (0.75, 3.25)):
        msp.add_circle((x, y), 0.203125 / 2)
    msp.add_circle((2.75, 0.75), 0.5 / 2)                                      # milled hole
    _save(doc, out, 'bracket.dxf')


def rack(out):
    # Same rack as RackTests in tests/test_roscam.py: teeth too narrow for the 1/4" end mill.
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
    msp.add_circle((5, 0.5), 0.18 / 2)
    _save(doc, out, 'rack.dxf')


if __name__ == '__main__':
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    build_plate(os.path.join(out, 'plate.dxf'))
    small(out)
    bracket(out)
    rack(out)
    print('wrote', sorted(os.listdir(out)))
