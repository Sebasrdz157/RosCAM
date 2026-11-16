//! G-code toolchain for the CNC router: parse ISO G-code (e.g. from OnShape
//! CAM) into an AST, interpret it, and re-emit it in the dialect the Axiom
//! router's Richauto controller accepts.
//!
//! text ─parse→ `ast::Program` ─interpret→ `interp::Op`s ─richauto::emit→
//! `ast::Program` ─serialize→ text

pub mod ast;
pub mod interp;
pub mod parse;
pub mod richauto;
pub mod serialize;

use std::fmt;

use serde::Serialize;

#[derive(Debug)]
pub struct Error {
    /// 1-based source line; 0 when not tied to one.
    pub line: usize,
    pub message: String,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.line == 0 {
            write!(f, "{}", self.message)
        } else {
            write!(f, "line {}: {}", self.line, self.message)
        }
    }
}

/// A non-fatal conversion note.
#[derive(Debug, Serialize)]
pub struct Warning {
    /// First input line it happened on; 0 when not tied to one.
    pub line: usize,
    pub message: String,
    /// How many times it happened.
    pub count: usize,
}

/// Non-fatal conversion notes, deduplicated by message.
#[derive(Default)]
pub struct Diagnostics {
    warnings: Vec<Warning>,
}

impl Diagnostics {
    pub fn warn(&mut self, line: usize, message: impl Into<String>) {
        let message = message.into();
        match self.warnings.iter_mut().find(|w| w.message == message) {
            Some(w) => w.count += 1,
            None => self.warnings.push(Warning { line, message, count: 1 }),
        }
    }

    pub fn into_warnings(self) -> Vec<Warning> {
        self.warnings
    }
}
