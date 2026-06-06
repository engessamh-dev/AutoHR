// src-tauri/src/main.rs
// Prevents console window on Windows release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    autohr_lib::run();
}
