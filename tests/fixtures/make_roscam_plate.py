"""Build roscam_plate.dxf: a 6" x 4" FRC-style plate used by the RosCAM tests.

Run with:  uv run python tests/fixtures/make_roscam_plate.py
"""
import os
import ezdxf

HERE = os.path.dirname(os.path.abspath(__file__))


def build(path=os.path.join(HERE, 'roscam_plate.dxf')):
    doc = ezdxf.new(units=1)  # inches
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (6, 0), (6, 4), (0, 4)], close=True)          # outline
    for x in (0.5, 5.5):                                                      # 13/64" (#10 clearance)
        for y in (0.5, 3.5):
            msp.add_circle((x, y), 0.203125 / 2)
    msp.add_circle((1.5, 2.0), 0.201 / 2)                                     # #7 drill size, also 13/64
    for x in (2.5, 3.5):                                                      # 5/32"
        msp.add_circle((x, 0.5), 0.15625 / 2)
    msp.add_circle((4.5, 2.0), 0.5 / 2)                                       # 1/2" - milled
    msp.add_circle((3.0, 2.0), 1.125 / 2)                                     # bearing bore - milled
    msp.add_lwpolyline([(1.0, 3.0), (2.5, 3.0), (2.5, 3.5), (1.0, 3.5)], close=True)  # slot pocket
    doc.saveas(path)
    return path


if __name__ == '__main__':
    print(build())
