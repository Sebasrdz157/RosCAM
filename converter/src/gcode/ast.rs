//! Syntax tree for a G-code program: one `Line` per physical line of text.
//!
//! This is purely syntactic — words are kept in source order and nothing is
//! interpreted. Both the parser and the Richauto emitter produce it, and the
//! serializer turns it back into text.

#[derive(Debug, Clone, PartialEq)]
pub struct Program {
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    Block(Block),
    /// A line holding nothing but one comment. The text excludes the
    /// delimiters and never contains parentheses.
    Comment(String),
    /// `%` tape start/end marker.
    Percent,
    Blank,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Block {
    /// Leading `/` (optional-skip block).
    pub block_delete: bool,
    /// `N` sequence number.
    pub number: Option<u32>,
    pub words: Vec<Word>,
    /// Inline comments, in order.
    pub comments: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Word {
    /// Always an uppercase ASCII letter.
    pub letter: char,
    pub value: f64,
}

impl Word {
    pub fn new(letter: char, value: f64) -> Self {
        Word { letter, value }
    }

    /// G/M code number ×10, so `G1` is 10 and `G90.1` is 901.
    pub fn code(&self) -> i32 {
        (self.value * 10.0).round() as i32
    }
}

/// Human-readable form of a code from [`Word::code`], e.g. `G90.1`.
pub fn code_name(letter: char, code: i32) -> String {
    if code % 10 == 0 {
        format!("{letter}{}", code / 10)
    } else {
        format!("{letter}{}.{}", code / 10, code % 10)
    }
}
