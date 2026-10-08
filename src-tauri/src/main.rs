// src-tauri/src/main.rs
// Prevents console window on Windows release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--scanner-self-test") {
        std::process::exit(match autohr_lib::scanner_self_test() {
            Ok(()) => 0,
            Err(error) => { eprintln!("Scanner self-test failed: {error}"); 1 }
        });
    }
    autohr_lib::run();
}
