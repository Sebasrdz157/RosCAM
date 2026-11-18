//! [`Program`] → text. The dialect-specific parts (number formatting, word
//! spacing, line endings) come from a [`Style`].

use super::ast::{Line, Program, Word};

pub struct Style {
    pub word: fn(&Word) -> String,
    /// Between words within a block.
    pub separator: &'static str,
    pub eol: &'static str,
}

pub fn serialize(program: &Program, style: &Style) -> String {
    let mut out = String::new();
    for line in &program.lines {
        match line {
            Line::Blank => {}
            Line::Percent => out.push('%'),
            Line::Comment(c) => {
                out.push('(');
                out.push_str(c);
                out.push(')');
            }
            Line::Block(b) => {
                if b.block_delete {
                    out.push('/');
                }
                let mut parts = Vec::with_capacity(b.words.len() + 1);
                if let Some(n) = b.number {
                    parts.push(format!("N{n}"));
                }
                parts.extend(b.words.iter().map(style.word));
                parts.extend(b.comments.iter().map(|c| format!("({c})")));
                out.push_str(&parts.join(style.separator));
            }
        }
        out.push_str(style.eol);
    }
    out
}
