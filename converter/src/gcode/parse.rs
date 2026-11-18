//! Text → [`Program`]. Accepts the common RS-274/ISO surface syntax: `N`
//! numbers, `(...)` and `;` comments, `/` block delete, `%` markers, any case,
//! and optional whitespace between words. Parameters and expressions (`#1`,
//! `[...]`) are rejected — CAM posts for routers don't emit them.

use super::Error;
use super::ast::{Block, Line, Program, Word};

pub fn parse(source: &str) -> Result<Program, Error> {
    let mut lines = Vec::new();
    let mut rest = source;
    while !rest.is_empty() {
        let (line, tail) = match rest.find('\n') {
            Some(i) => (&rest[..i], &rest[i + 1..]),
            None => (rest, ""),
        };
        let line_no = lines.len() + 1;
        lines.push(parse_line(line).map_err(|message| Error { line: line_no, message })?);
        rest = tail;
    }
    Ok(Program { lines })
}

fn parse_line(text: &str) -> Result<Line, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Line::Blank);
    }
    if text == "%" {
        return Ok(Line::Percent);
    }

    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let mut block = Block::default();
    if chars[0] == '/' {
        block.block_delete = true;
        i = 1;
    }

    while i < chars.len() {
        let c = chars[i];
        match c {
            c if c.is_whitespace() => i += 1,
            '(' => {
                let start = i + 1;
                let mut end = start;
                while end < chars.len() && chars[end] != ')' {
                    if chars[end] == '(' {
                        return Err("nested comment".into());
                    }
                    end += 1;
                }
                if end == chars.len() {
                    return Err("unterminated comment".into());
                }
                block.comments.push(chars[start..end].iter().collect());
                i = end + 1;
            }
            ';' => {
                let comment: String = chars[i + 1..].iter().collect();
                block.comments.push(comment.replace(['(', ')'], ""));
                break;
            }
            c if c.is_ascii_alphabetic() => {
                let letter = c.to_ascii_uppercase();
                i += 1;
                while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
                    i += 1;
                }
                let start = i;
                if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
                    i += 1;
                }
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                    i += 1;
                }
                let number: String = chars[start..i].iter().collect();
                let value: f64 = number
                    .parse()
                    .map_err(|_| format!("`{letter}` needs a number, found `{number}`"))?;
                if !value.is_finite() {
                    return Err(format!("`{letter}{number}` is out of range"));
                }
                if letter == 'N' {
                    if block.number.is_some() || !block.words.is_empty() {
                        return Err("`N` must be the first word of a line".into());
                    }
                    if value < 0.0 || value.fract() != 0.0 || value > u32::MAX as f64 {
                        return Err(format!("bad line number `N{number}`"));
                    }
                    block.number = Some(value as u32);
                } else {
                    block.words.push(Word::new(letter, value));
                }
            }
            '#' | '[' | ']' | '=' => {
                return Err("parameters and expressions (`#`, `[...]`) aren't supported".into());
            }
            c => return Err(format!("unexpected character `{c}`")),
        }
    }

    if !block.block_delete && block.number.is_none() && block.words.is_empty() && block.comments.len() == 1 {
        return Ok(Line::Comment(block.comments.pop().unwrap()));
    }
    Ok(Line::Block(block))
}
