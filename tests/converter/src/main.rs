#[path = "/home/user/partstracker/src/gcode/mod.rs"]
#[allow(dead_code)]
mod gcode;
use gcode::richauto;
fn main() {
    for path in std::env::args().skip(1) {
        let src = std::fs::read_to_string(&path).unwrap();
        let stem = std::path::Path::new(&path).file_stem().unwrap().to_string_lossy().to_string();
        match richauto::convert(&src, &richauto::sanitize(&stem, 32), richauto::Options::default()) {
            Ok(c) => {
                let out = format!("{}.{}", path.trim_end_matches(".nc"), richauto::EXTENSION);
                std::fs::write(&out, &c.text).unwrap();
                println!("OK  {path}\n    report: {}", serde_json::to_string(&c.report).unwrap());
            }
            Err(e) => println!("ERR {path}: {e}"),
        }
    }
}
