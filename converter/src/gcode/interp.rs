//! [`Program`] → a flat list of machine operations with every modal detail
//! resolved: positions are absolute millimetres, arcs carry absolute centres,
//! and canned drilling cycles are expanded into plain moves. This is what lets
//! the emitter write a dialect with none of the ISO niceties.

use super::ast::{Block, Line, Program, code_name};
use super::{Diagnostics, Error};

const MM_PER_INCH: f64 = 25.4;
/// How far above the previous depth a peck cycle stops before feeding again
/// (LinuxCNC's 0.010").
const PECK_CLEARANCE: f64 = 0.254;
/// Arc start/end radius disagreement (mm) worth a warning…
const ARC_WARN: f64 = 0.01;
/// …and one that means the arc is simply wrong.
const ARC_REJECT: f64 = 0.5;

/// X, Y, Z; `None` until the program first sets that axis.
pub type Pos = [Option<f64>; 3];

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Comment(String),
    ToolChange(u32),
    SpindleOn { rpm: f64, reverse: bool },
    SpindleOff,
    Rapid(Pos),
    Linear { to: Pos, feed: f64 },
    /// XY-plane arc; `center` is absolute. A Z change makes it a helix.
    Arc { to: Pos, center: [f64; 2], clockwise: bool, feed: f64 },
    End,
}

#[derive(Debug, Clone)]
pub struct Step {
    /// Source line, for error messages.
    pub line: usize,
    pub op: Op,
}

pub fn interpret(program: &Program, diag: &mut Diagnostics) -> Result<Vec<Step>, Error> {
    let mut state = State::new(diag);
    let mut ended = false;
    for (i, line) in program.lines.iter().enumerate() {
        match line {
            Line::Comment(c) => state.push(i + 1, Op::Comment(c.clone())),
            Line::Block(b) => {
                if state.block(i + 1, b)? {
                    ended = true;
                    break;
                }
            }
            Line::Percent | Line::Blank => {}
        }
    }
    if !ended {
        state.diag.warn(0, "no M2/M30 program end; one was added");
    }
    Ok(state.steps)
}

/// Sticky canned-cycle parameters (they carry over between cycle blocks).
#[derive(Default)]
struct Cycle {
    z: Option<f64>,
    r: Option<f64>,
    q: Option<f64>,
    /// Z before this run of cycles began; `G98` retracts back to it.
    initial_z: Option<f64>,
}

struct State<'a> {
    diag: &'a mut Diagnostics,
    steps: Vec<Step>,
    pos: Pos,
    /// `None` until G20/G21 is seen.
    inches: Option<bool>,
    absolute: bool,
    arc_absolute: bool,
    plane_xy: bool,
    /// Active motion code ×10 (0, 10, 20, 30, 730, 810, 820, 830).
    motion: Option<i32>,
    /// mm/min.
    feed: Option<f64>,
    rpm: Option<f64>,
    spindle: Option<bool>,
    tool: Option<u32>,
    retract_to_initial: bool,
    cycle: Cycle,
}

#[derive(Default)]
struct Words {
    g: Vec<i32>,
    m: Vec<i32>,
    values: [Option<f64>; 26],
}

impl Words {
    fn get(&self, letter: char) -> Option<f64> {
        self.values[(letter as u8 - b'A') as usize]
    }
}

const AXES: [char; 3] = ['X', 'Y', 'Z'];

fn is_cycle(code: i32) -> bool {
    matches!(code, 730 | 810 | 820 | 830)
}

impl<'a> State<'a> {
    fn new(diag: &'a mut Diagnostics) -> Self {
        State {
            diag,
            steps: Vec::new(),
            pos: [None; 3],
            inches: None,
            absolute: true,
            arc_absolute: false,
            plane_xy: true,
            motion: None,
            feed: None,
            rpm: None,
            spindle: None,
            tool: None,
            retract_to_initial: true,
            cycle: Cycle::default(),
        }
    }

    fn push(&mut self, line: usize, op: Op) {
        self.steps.push(Step { line, op });
    }

    /// Converts a length in program units to mm.
    fn mm(&mut self, line: usize, v: f64) -> f64 {
        match self.inches {
            Some(true) => v * MM_PER_INCH,
            Some(false) => v,
            None => {
                self.diag.warn(line, "no G20/G21 before the first length; assuming millimetres");
                self.inches = Some(false);
                v
            }
        }
    }

    /// Runs one block. Returns `true` at program end.
    fn block(&mut self, line: usize, b: &Block) -> Result<bool, Error> {
        let err = |message: String| Error { line, message };

        if b.block_delete {
            self.diag.warn(line, "block-delete (`/`) lines are always run");
        }
        for c in &b.comments {
            self.push(line, Op::Comment(c.clone()));
        }

        let mut w = Words::default();
        for word in &b.words {
            match word.letter {
                'G' => w.g.push(word.code()),
                'M' => w.m.push(word.code()),
                'O' => {} // program number
                'A' | 'B' | 'C' | 'U' | 'V' | 'W' => {
                    return Err(err(format!("{}-axis words aren't supported (3-axis router)", word.letter)));
                }
                'L' => return Err(err("`L` repeat counts aren't supported".into())),
                l @ ('D' | 'F' | 'H' | 'I' | 'J' | 'K' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'X' | 'Y' | 'Z') => {
                    let slot = &mut w.values[(l as u8 - b'A') as usize];
                    if slot.is_some() {
                        return Err(err(format!("`{l}` appears twice in one block")));
                    }
                    *slot = Some(word.value);
                }
                l => return Err(err(format!("unsupported word `{l}`"))),
            }
        }

        // Modal settings first: units must be known before F and coordinates.
        let has_axes = AXES.iter().any(|&c| w.get(c).is_some());
        let mut motion = None;
        let mut machine_move = None;
        let mut dwell = false;
        for &g in &w.g {
            match g {
                0 | 10 | 20 | 30 | 730 | 800 | 810 | 820 | 830 => {
                    // Fanuc "safe start" lines like `G0 G90 G17 G40 G49 G80`
                    // stack motion codes; Fanuc takes the last. Only allow
                    // that when there's no move it could make ambiguous.
                    if motion.replace(g).is_some() && has_axes {
                        return Err(err("two motion codes in one block".into()));
                    }
                }
                40 => dwell = true,
                170 => self.plane_xy = true,
                180 | 190 => self.plane_xy = false,
                200 => self.inches = Some(true),
                210 => self.inches = Some(false),
                900 => self.absolute = true,
                910 => self.absolute = false,
                901 => self.arc_absolute = true,
                911 => self.arc_absolute = false,
                980 => self.retract_to_initial = true,
                990 => self.retract_to_initial = false,
                // Feed per minute, cutter comp off, tool length offsets, path
                // control: nothing to do on this machine.
                940 | 400 | 430 | 490 | 610 | 611 | 640 => {}
                540 => {}
                550 | 560 | 570 | 580 | 590 => self.diag.warn(
                    line,
                    format!("{} work offset ignored; the controller cuts from the origin set at the machine", code_name('G', g)),
                ),
                280 | 300 | 530 => machine_move = Some(g),
                930 | 950 => return Err(err("inverse-time and per-revolution feeds (G93/G95) aren't supported".into())),
                410 | 420 => {
                    return Err(err(
                        "cutter compensation (G41/G42) isn't supported; have the CAM compute the offset path".into(),
                    ));
                }
                _ => return Err(err(format!("unsupported code {}", code_name('G', g)))),
            }
        }

        if let Some(f) = w.get('F') {
            if f <= 0.0 {
                return Err(err("feed rate must be positive".into()));
            }
            self.feed = Some(self.mm(line, f));
        }
        if let Some(t) = w.get('T') {
            if t < 0.0 || t.fract() != 0.0 {
                return Err(err(format!("bad tool number T{t}")));
            }
            self.tool = Some(t as u32);
        }
        let starts_spindle = w.m.iter().any(|&m| m == 30 || m == 40);
        if let Some(s) = w.get('S') {
            if s < 0.0 {
                return Err(err("spindle speed can't be negative".into()));
            }
            let changed = self.rpm != Some(s);
            self.rpm = Some(s);
            if let (Some(reverse), true, false) = (self.spindle, changed, starts_spindle) {
                self.push(line, Op::SpindleOn { rpm: s, reverse });
            }
        }

        // RS-274 order within a block: tool change, spindle, the rest, then stop.
        let mut m_codes = w.m.clone();
        m_codes.sort_by_key(|&m| match m {
            60 => 0,
            30 | 40 | 50 => 1,
            20 | 300 => 3,
            _ => 2,
        });
        let mut end = false;
        for m in m_codes {
            match m {
                60 => self.push(line, Op::ToolChange(self.tool.unwrap_or(0))),
                30 | 40 => {
                    let rpm = self.rpm.ok_or_else(|| err("spindle started without a speed (S)".into()))?;
                    self.spindle = Some(m == 40);
                    self.push(line, Op::SpindleOn { rpm, reverse: m == 40 });
                }
                50 => {
                    self.spindle = None;
                    self.push(line, Op::SpindleOff);
                }
                20 | 300 => end = true,
                70 | 80 | 90 => self.diag.warn(line, "coolant commands (M7/M8/M9) dropped"),
                0 | 10 => self.diag.warn(line, "program stops (M0/M1) dropped; the file will run straight through"),
                _ => self.diag.warn(line, format!("{} dropped (not supported)", code_name('M', m))),
            }
        }

        if dwell {
            self.diag.warn(line, "dwells (G4) dropped");
        }

        if let Some(g) = motion {
            if !is_cycle(g) {
                self.cycle = Cycle::default();
            }
            self.motion = (g != 800).then_some(g);
        }

        if let Some(g) = machine_move {
            // The axis words belong to G28/G30/G53, not to the motion mode.
            self.diag.warn(
                line,
                format!("{} machine-coordinate moves skipped; the output retracts Z at the end instead", code_name('G', g)),
            );
        } else if has_axes {
            match self.motion {
                None => return Err(err("coordinates with no motion mode active (after G80)".into())),
                Some(0) => {
                    let to = self.target(line, &w)?;
                    self.go(line, to, None);
                }
                Some(10) => {
                    let feed = self.feed.ok_or_else(|| err("feed move with no feed rate set (F)".into()))?;
                    let to = self.target(line, &w)?;
                    self.go(line, to, Some(feed));
                }
                Some(g @ (20 | 30)) => self.arc(line, &w, g == 20)?,
                Some(g) => self.cycle(line, &w, g)?,
            }
        } else if matches!(self.motion, Some(20 | 30)) && ['I', 'J', 'R'].iter().any(|&c| w.get(c).is_some()) {
            return Err(err("arc without an end point".into()));
        }

        if end {
            self.push(line, Op::End);
        }
        Ok(end)
    }

    fn target(&mut self, line: usize, w: &Words) -> Result<Pos, Error> {
        let mut to = self.pos;
        for (i, c) in AXES.into_iter().enumerate() {
            if let Some(v) = w.get(c) {
                let v = self.mm(line, v);
                to[i] = Some(if self.absolute {
                    v
                } else {
                    self.pos[i].ok_or_else(|| Error {
                        line,
                        message: format!("incremental (G91) {c} move from an unknown position"),
                    })? + v
                });
            }
        }
        Ok(to)
    }

    /// Straight move; `None` feed means rapid.
    fn go(&mut self, line: usize, to: Pos, feed: Option<f64>) {
        let op = match feed {
            Some(feed) => Op::Linear { to, feed },
            None => Op::Rapid(to),
        };
        self.push(line, op);
        self.pos = to;
    }

    fn go_z(&mut self, line: usize, z: f64, feed: Option<f64>) {
        let mut to = self.pos;
        to[2] = Some(z);
        self.go(line, to, feed);
    }

    fn arc(&mut self, line: usize, w: &Words, clockwise: bool) -> Result<(), Error> {
        let err = |message: &str| Error { line, message: message.into() };
        if !self.plane_xy {
            return Err(err("arcs outside the XY plane (G18/G19) aren't supported"));
        }
        let feed = self.feed.ok_or_else(|| err("arc with no feed rate set (F)"))?;
        let (Some(sx), Some(sy)) = (self.pos[0], self.pos[1]) else {
            return Err(err("arc from an unknown XY position"));
        };
        let to = self.target(line, w)?;
        let (ex, ey) = (to[0].unwrap(), to[1].unwrap());

        let (i, j) = (w.get('I'), w.get('J'));
        let center = if let Some(r) = w.get('R') {
            if i.is_some() || j.is_some() {
                return Err(err("arc has both R and I/J"));
            }
            let r = self.mm(line, r);
            center_from_radius([sx, sy], [ex, ey], r, clockwise)
                .ok_or_else(|| err("R-format arc radius is too small for its end point (or it's a full circle)"))?
        } else {
            if i.is_none() && j.is_none() {
                return Err(err("arc needs I/J or R"));
            }
            let i = self.mm(line, i.unwrap_or(0.0));
            let j = self.mm(line, j.unwrap_or(0.0));
            if self.arc_absolute { [i, j] } else { [sx + i, sy + j] }
        };

        let r_start = (sx - center[0]).hypot(sy - center[1]);
        let r_end = (ex - center[0]).hypot(ey - center[1]);
        let mismatch = (r_start - r_end).abs();
        if mismatch > ARC_REJECT {
            return Err(Error {
                line,
                message: format!("arc end point is {mismatch:.3} mm off its circle"),
            });
        } else if mismatch > ARC_WARN {
            self.diag.warn(line, format!("arc end points disagree with their centre by more than {ARC_WARN} mm"));
        }
        if to[2] != self.pos[2] {
            self.diag.warn(line, "helical arcs (Z changes during G2/G3) kept; VCarve never sends these, so dry-run first");
        }

        self.push(line, Op::Arc { to, center, clockwise, feed });
        self.pos = to;
        Ok(())
    }

    /// Expands one G73/G81/G82/G83 hole into rapids and feeds.
    fn cycle(&mut self, line: usize, w: &Words, code: i32) -> Result<(), Error> {
        let err = |message: &str| Error { line, message: message.into() };
        if !self.absolute {
            return Err(err("canned cycles in incremental mode (G91) aren't supported"));
        }
        if !self.plane_xy {
            return Err(err("canned cycles outside the XY plane aren't supported"));
        }
        if let Some(v) = w.get('Z') {
            self.cycle.z = Some(self.mm(line, v));
        }
        if let Some(v) = w.get('R') {
            self.cycle.r = Some(self.mm(line, v));
        }
        if let Some(v) = w.get('Q') {
            self.cycle.q = Some(self.mm(line, v));
        }
        if code == 820 {
            self.diag.warn(line, "G82 dwell dropped; drilled as G81");
        }
        let bottom = self.cycle.z.ok_or_else(|| err("canned cycle without a Z depth"))?;
        let r = self.cycle.r.ok_or_else(|| err("canned cycle without an R plane"))?;
        let feed = self.feed.ok_or_else(|| err("canned cycle with no feed rate set (F)"))?;
        let z0 = self.pos[2].ok_or_else(|| err("canned cycle from an unknown Z height"))?;
        if bottom > r {
            return Err(err("canned cycle's Z depth is above its R plane"));
        }
        let initial = *self.cycle.initial_z.get_or_insert(z0);

        let x = match w.get('X') {
            Some(v) => Some(self.mm(line, v)),
            None => self.pos[0],
        };
        let y = match w.get('Y') {
            Some(v) => Some(self.mm(line, v)),
            None => self.pos[1],
        };
        let (Some(x), Some(y)) = (x, y) else {
            return Err(err("canned cycle at an unknown XY position"));
        };

        if z0 < r {
            self.go_z(line, r, None);
        }
        self.go(line, [Some(x), Some(y), self.pos[2]], None);
        self.go_z(line, r, None);
        match code {
            810 | 820 => self.go_z(line, bottom, Some(feed)),
            _ => {
                let q = self.cycle.q.filter(|q| *q > 0.0).ok_or_else(|| err("peck cycle needs a positive Q"))?;
                let mut depth = r;
                loop {
                    let next = (depth - q).max(bottom);
                    self.go_z(line, next, Some(feed));
                    if next <= bottom {
                        break;
                    }
                    if code == 830 {
                        self.go_z(line, r, None);
                    }
                    self.go_z(line, next + PECK_CLEARANCE, None);
                    depth = next;
                }
            }
        }
        let clear = if self.retract_to_initial { initial.max(r) } else { r };
        self.go_z(line, clear, None);
        Ok(())
    }
}

/// Centre of an R-format arc. Positive R is the short way round, negative the long way.
fn center_from_radius(start: [f64; 2], end: [f64; 2], r: f64, clockwise: bool) -> Option<[f64; 2]> {
    let (dx, dy) = (end[0] - start[0], end[1] - start[1]);
    let chord = dx.hypot(dy);
    if chord < 1e-9 {
        return None;
    }
    let half = chord / 2.0;
    if r.abs() < half - 0.001 {
        return None;
    }
    let h = (r * r - half * half).max(0.0).sqrt();
    // Unit normal pointing to the left of the chord. A CCW short arc curves
    // around a centre on the left; CW or long (negative R) flips the side.
    let (nx, ny) = (-dy / chord, dx / chord);
    let side = if clockwise { -1.0 } else { 1.0 } * r.signum();
    Some([start[0] + dx / 2.0 + side * h * nx, start[1] + dy / 2.0 + side * h * ny])
}
