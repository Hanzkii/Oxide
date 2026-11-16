// Prevents additional console window on Windows in both debug and release
#![windows_subsystem = "windows"]

fn main() {
    oxide_agent_lib::run()
}
