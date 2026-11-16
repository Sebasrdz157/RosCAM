//! Interpreted ops → a program in the dialect VCarve's Richauto post writes
//! for the Axiom router (the `.mmg` files the team has run successfully):
//!
//! ```text
//! (VECTRIC POST REVISION)
//! (51FB200A4C03F6229CDBFD772499C08A)
//! (Filename:  out)
//! N30M03S18000
//! N40G00X15.662Y528.643Z5.080
//! N50G1Z-1.651F127.0
//! N60G2X12.487Y531.818I0.000J3.175F831.6
//! ...
//! N2600G00Z20.320
//! N2610M05
//! N2620M30
//! %
//! ```
//!
//! Millimetres, absolute, one tool, the spindle started once in the header,
//! no spaces, `G00` for rapids but `G1`/`G2`/`G3` otherwise, only changed
//! axes on straight moves, arcs always as X/Y/I/J, F on the first feed move
//! after a rapid and whenever it changes, CRLF line endings, and
//! every line — comments included — consuming a line number in steps of 10.

use serde::Serialize;

use super::ast::{Block, Line, Program, Word};
use super::interp::{self, Op, Step};
use super::serialize::{Style, serialize};
use super::{Diagnostics, Error, Warning, parse};

pub const EXTENSION: &str = "mmg";

pub const STYLE: Style = Style {
    word: format_word,
    separator: "",
    eol: "\r\n",
};

fn format_word(w: &Word) -> String {
    match w.letter {
        'G' => match w.code() {
            0 => "G00".into(),
            c if c % 10 == 0 => format!("G{}", c / 10),
            c => format!("G{}.{}", c / 10, c % 10),
        },
        'M' => format!("M{:02}", w.code() / 10),
        'S' | 'T' => format!("{}{}", w.letter, w.value.round() as i64),
        'F' => format!("F{:.1}", w.value),
        l => format!("{l}{:.3}", w.value),
    }
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub warnings: Vec<Warning>,
    pub rpm: f64,
    /// Toolpath extents in mm, `[x, y, z]`.
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub lines_in: usize,
    pub lines_out: usize,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// Drop every comment except the header and one `(name)` per operation,
    /// matching what VCarve writes, in case the controller chokes on others.
    pub strip_comments: bool,
}

#[derive(Debug, Serialize)]
pub struct Conversion {
    pub text: String,
    pub report: Report,
    /// For each output line, the 1-based input line it came from, or 0 for
    /// lines the converter generated (header, footer, final retract).
    pub source_lines: Vec<usize>,
}

/// Parses ISO G-code and rewrites it for the Richauto controller. `name` goes
/// in the `(Filename: ...)` header.
pub fn convert(source: &str, name: &str, options: Options) -> Result<Conversion, Error> {
    let mut diag = Diagnostics::default();
    let program = parse::parse(source)?;
    let steps = interp::interpret(&program, &mut diag)?;
    let e = emit(&steps, name, options, &mut diag)?;
    let out = Program { lines: e.lines };
    let text = serialize(&out, &STYLE);

    // Our own output must read back to exactly itself and still interpret,
    // or the serializer wrote something the parser (and so likely the
    // controller) would read differently.
    let internal = |what: &str, e: String| Error {
        line: 0,
        message: format!("internal error: output failed to {what}: {e}"),
    };
    let reparsed = parse::parse(&text).map_err(|e| internal("re-parse", e.to_string()))?;
    if serialize(&reparsed, &STYLE) != text {
        return Err(internal("round-trip", "text changed".into()));
    }
    interp::interpret(&reparsed, &mut Diagnostics::default()).map_err(|e| internal("re-interpret", e.to_string()))?;

    let report = Report {
        warnings: diag.into_warnings(),
        rpm: e.rpm,
        min: e.min,
        max: e.max,
        lines_in: program.lines.len(),
        lines_out: out.lines.len(),
    };
    Ok(Conversion { text, report, source_lines: e.sources })
}

/// Rounds to `places` decimals, folding `-0` into `0` so it never prints as `-0.000`.
fn round_to(v: f64, places: i32) -> f64 {
    let p = 10f64.powi(places);
    let r = (v * p).round() / p;
    if r == 0.0 { 0.0 } else { r }
}

#[derive(Default)]
struct Emitter {
    lines: Vec<Line>,
    /// Parallel to `lines`: the input line each came from (0 = generated).
    sources: Vec<usize>,
    rpm: f64,
    /// Last position as printed (rounded), which is where the controller thinks it is.
    at: [Option<f64>; 3],
    feed: Option<f64>,
    min: [f64; 3],
    max: [f64; 3],
    negative_xy_line: Option<usize>,
}

impl Emitter {
    fn push(&mut self, line: Line, source: usize) {
        self.lines.push(line);
        self.sources.push(source);
    }

    fn block(&mut self, words: Vec<Word>, source: usize) {
        self.push(Line::Block(Block { words, ..Default::default() }), source);
    }

    /// Adds changed (or, with `always`, all) axes of `to` to `words`.
    fn axes(&mut self, line: usize, words: &mut Vec<Word>, to: &interp::Pos, always: [bool; 3]) {
        for (i, letter) in ['X', 'Y', 'Z'].into_iter().enumerate() {
            let Some(v) = to[i] else { continue };
            let v = round_to(v, 3);
            if always[i] || self.at[i] != Some(v) {
                words.push(Word::new(letter, v));
            }
            if self.at[i].is_none() {
                self.min[i] = v;
                self.max[i] = v;
            }
            self.min[i] = self.min[i].min(v);
            self.max[i] = self.max[i].max(v);
            if i < 2 && v < 0.0 && self.negative_xy_line.is_none() {
                self.negative_xy_line = Some(line);
            }
            self.at[i] = Some(v);
        }
    }

    fn feed(&mut self, words: &mut Vec<Word>, feed: f64) {
        let feed = round_to(feed, 1);
        if self.feed != Some(feed) {
            words.push(Word::new('F', feed));
            self.feed = Some(feed);
        }
    }
}

fn emit(steps: &[Step], name: &str, options: Options, diag: &mut Diagnostics) -> Result<Emitter, Error> {
    let mut tool = None;
    let mut rpm = None;
    // Source lines for the header/footer codes, so the diff view can point
    // at the input line each one replaces.
    let (mut spindle_on, mut spindle_off, mut end) = (0, 0, 0);
    for s in steps {
        match s.op {
            Op::ToolChange(t) => match tool {
                None => tool = Some(t),
                Some(first) if first != t => {
                    return Err(Error {
                        line: s.line,
                        message: format!(
                            "program changes tools (T{first} → T{t}); the controller runs one tool per file, \
                             so post each tool's toolpaths separately"
                        ),
                    });
                }
                Some(_) => {}
            },
            Op::SpindleOn { rpm: r, reverse } => {
                if reverse {
                    diag.warn(s.line, "counter-clockwise spindle (M4) written as M3");
                }
                match rpm {
                    None => {
                        rpm = Some(r);
                        spindle_on = s.line;
                    }
                    Some(first) if first != r => diag.warn(
                        s.line,
                        format!("spindle speed changes mid-program; the whole file runs at S{}", first.round()),
                    ),
                    Some(_) => {}
                }
            }
            Op::SpindleOff => spindle_off = s.line,
            Op::End => end = s.line,
            _ => {}
        }
    }
    let rpm = rpm.ok_or(Error {
        line: 0,
        message: "the program never starts the spindle (M3 with an S speed)".into(),
    })?;

    let mut e = Emitter { rpm, ..Default::default() };
    // Newer Richauto firmware looks for VCarve's post signature; it's the
    // same fixed pair in every file the team's machine has run since '26.
    e.push(Line::Comment("VECTRIC POST REVISION".into()), 0);
    e.push(Line::Comment("51FB200A4C03F6229CDBFD772499C08A".into()), 0);
    e.push(Line::Comment(format!("Filename:  {name}")), 0);
    e.block(vec![Word::new('M', 3.0), Word::new('S', rpm.round())], spindle_on);

    for s in steps {
        match &s.op {
            Op::Comment(c) => {
                // Skip header lines we write ourselves, in case the input is
                // itself a VCarve file.
                let c = sanitize(c, 60);
                let header = c.to_ascii_lowercase().starts_with("filename:")
                    || c == "VECTRIC POST REVISION"
                    || c == "51FB200A4C03F6229CDBFD772499C08A";
                if c.is_empty() || header {
                    continue;
                }
                if !options.strip_comments {
                    e.push(Line::Comment(c), s.line);
                } else if let Some(op) = operation_name(&c) {
                    e.push(Line::Comment(op.to_string()), s.line);
                }
            }
            Op::Rapid(to) => {
                let mut words = vec![Word::new('G', 0.0)];
                e.axes(s.line, &mut words, to, [false; 3]);
                if words.len() > 1 {
                    e.block(words, s.line);
                    // VCarve restates F on the first feed move after every
                    // rapid (all 3,920 cases in the team's files); match it in
                    // case the controller relies on it.
                    e.feed = None;
                }
            }
            Op::Linear { to, feed } => {
                let mut words = vec![Word::new('G', 1.0)];
                e.axes(s.line, &mut words, to, [false; 3]);
                if words.len() > 1 {
                    e.feed(&mut words, *feed);
                    e.block(words, s.line);
                }
            }
            Op::Arc { to, center, clockwise, feed } => {
                // Offsets from the printed start, so the controller's centre
                // is within rounding of the true one.
                let (Some(sx), Some(sy)) = (e.at[0], e.at[1]) else {
                    return Err(Error { line: s.line, message: "arc from an unknown XY position".into() });
                };
                let mut words = vec![Word::new('G', if *clockwise { 2.0 } else { 3.0 })];
                e.axes(s.line, &mut words, to, [true, true, false]);
                words.push(Word::new('I', round_to(center[0] - sx, 3)));
                words.push(Word::new('J', round_to(center[1] - sy, 3)));
                e.feed(&mut words, *feed);
                e.block(words, s.line);
            }
            Op::ToolChange(_) | Op::SpindleOn { .. } | Op::SpindleOff | Op::End => {}
        }
    }

    if let Some(line) = e.negative_xy_line {
        diag.warn(
            line,
            "negative X/Y coordinates; the team's VCarve jobs put the origin at the stock's lower-left corner, \
             so check the OnShape setup origin",
        );
    }

    // Finish lifted to the highest Z the program used, like VCarve's home-Z move.
    if let Some(z) = e.at[2]
        && e.max[2] > z
    {
        let mut words = vec![Word::new('G', 0.0)];
        e.axes(0, &mut words, &[None, None, Some(e.max[2])], [false; 3]);
        e.block(words, 0);
    }
    e.block(vec![Word::new('M', 5.0)], spindle_off);
    e.block(vec![Word::new('M', 30.0)], end);
    e.push(Line::Percent, 0);

    for (i, line) in e.lines.iter_mut().enumerate() {
        if let Line::Block(b) = line {
            b.number = Some(i as u32 * 10);
        }
    }
    Ok(e)
}

/// The toolpath name from an OnShape CAM Studio `(Operation: ...)` comment.
fn operation_name(comment: &str) -> Option<&str> {
    let (key, name) = comment.split_once(':')?;
    let name = name.trim();
    (key.trim().eq_ignore_ascii_case("operation") && !name.is_empty()).then_some(name)
}

/// Keeps comments to plain ASCII the controller's display can show.
pub fn sanitize(text: &str, max_len: usize) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || " _-.,:#/+=".contains(c) { c } else { ' ' })
        .collect();
    let mut out = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    out.truncate(max_len);
    out.trim_end().to_string()
}
