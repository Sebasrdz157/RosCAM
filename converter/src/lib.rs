//! WebAssembly wrapper around PartsTracker's Richauto converter (`gcode/`, copied verbatim).
//!
//! `convert_named` does exactly what PartsTracker's `POST /cnc/convert` does with an upload:
//! the same file-name cleanup, the same `richauto::convert`, the same JSON shape
//! (`name`, `text`, `report`), so a file converted in RosCAM is byte-for-byte the file the
//! /cnc page would give back.
//!
//! The wasm interface is plain exports (no wasm-bindgen): the page `alloc`s two buffers,
//! copies the G-code and the file name in as UTF-8, calls `convert`, then reads the JSON
//! answer from `result_ptr`/`result_len`.

#[allow(dead_code)]
mod gcode;

use std::cell::RefCell;

use gcode::richauto;

/// Same cleanup as PartsTracker's `/cnc/convert` handler, then the conversion.
pub fn convert_named(source: &str, file_name: &str, strip_comments: bool) -> serde_json::Value {
    let stem = file_name.rsplit_once('.').map_or(file_name, |(stem, _)| stem);
    let mut stem = richauto::sanitize(stem, 32).replace(['/', '#', ':'], "_");
    if stem.is_empty() {
        stem = "program".into();
    }
    let options = richauto::Options { strip_comments };
    match richauto::convert(source, &stem, options) {
        Ok(c) => serde_json::json!({
            "name": format!("{stem}.{}", richauto::EXTENSION),
            "text": c.text,
            "report": c.report,
        }),
        Err(e) => serde_json::json!({ "error": e.to_string() }),
    }
}

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// A buffer of `len` bytes for the page to write into; give it back with `dealloc`.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must come from one `alloc(len)` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) }
}

/// Converts the G-code in `src` (named `name`); the JSON answer is left in the result buffer.
///
/// # Safety
/// Both pointers must point at that many initialised bytes from `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn convert(src: *const u8, src_len: usize, name: *const u8, name_len: usize,
                                 strip_comments: u32) {
    let source = unsafe { std::slice::from_raw_parts(src, src_len) };
    let name = unsafe { std::slice::from_raw_parts(name, name_len) };
    let answer = match (std::str::from_utf8(source), std::str::from_utf8(name)) {
        (Ok(source), Ok(name)) => convert_named(source, name, strip_comments != 0),
        _ => serde_json::json!({ "error": "File isn't text; expected G-code." }),
    };
    let bytes = serde_json::to_vec(&answer).unwrap_or_default();
    RESULT.with(|r| *r.borrow_mut() = bytes);
}

#[unsafe(no_mangle)]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_like_the_cnc_page() {
        let nc = "G20 G90\nG0 Z0.5\nM3 S18000\nG0 X1 Y1\nG1 Z-0.1 F10\nG1 X2 F100\nG0 Z0.5\nM5\nM30\n";
        let out = convert_named(nc, "01_AL-250-01_endmill_1-4.nc", false);
        assert_eq!(out["name"], "01_AL-250-01_endmill_1-4.mmg");
        let text = out["text"].as_str().unwrap();
        assert!(text.starts_with("(VECTRIC POST REVISION)\r\n"), "{text}");
        assert!(text.contains("M03S18000"), "{text}");
        assert!(text.trim_end().ends_with('%'), "{text}");
    }

    #[test]
    fn bad_gcode_is_an_error_not_a_panic() {
        let out = convert_named("G1 X\n", "x.nc", false);
        assert!(out.get("error").is_some() || out.get("text").is_some());
    }
}
