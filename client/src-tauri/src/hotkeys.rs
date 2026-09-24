//! Global hotkeys by polling the key state, like Discord does, instead of
//! RegisterHotKey: mouse side buttons work too, and the key still reaches
//! the game or app in front (a push-to-talk key must not be swallowed).
//!
//! Bindings use the frontend's accelerator form: `Ctrl+Shift+KeyM`, `F13`,
//! `Mouse4`, `Mouse5`, `MouseMiddle`. Every change of a binding's state is
//! emitted as a `hotkey` event: `{ action, pressed }`.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, PartialEq)]
struct Combo {
    mods: Vec<i32>,
    key: i32,
}

#[derive(Default)]
pub struct Hotkeys {
    bindings: Arc<Mutex<Vec<(String, Combo)>>>,
}

#[derive(Clone, Serialize)]
struct HotkeyEvent<'a> {
    action: &'a str,
    pressed: bool,
}

/// Windows virtual-key code for a `KeyboardEvent.code` or mouse button name.
fn vk(code: &str) -> Option<i32> {
    let bytes = code.as_bytes();
    if let Some(c) = code.strip_prefix("Key").filter(|c| c.len() == 1) {
        return Some(c.as_bytes()[0].to_ascii_uppercase() as i32);
    }
    if let Some(d) = code.strip_prefix("Digit").filter(|d| d.len() == 1) {
        return Some(d.as_bytes()[0] as i32);
    }
    if let Some(n) = code.strip_prefix("Numpad").and_then(|n| n.parse::<i32>().ok()) {
        return (0..=9).contains(&n).then_some(0x60 + n);
    }
    if bytes.first() == Some(&b'F') {
        if let Ok(n) = code[1..].parse::<i32>() {
            return (1..=24).contains(&n).then_some(0x6F + n);
        }
    }
    Some(match code {
        "Mouse4" => 0x05,
        "Mouse5" => 0x06,
        "MouseMiddle" => 0x04,
        "Ctrl" => 0x11,
        "Shift" => 0x10,
        "Alt" => 0x12,
        "Super" => 0x5B,
        "Space" => 0x20,
        "Tab" => 0x09,
        "Enter" => 0x0D,
        "Backquote" => 0xC0,
        "Minus" => 0xBD,
        "Equal" => 0xBB,
        "BracketLeft" => 0xDB,
        "BracketRight" => 0xDD,
        "Backslash" => 0xDC,
        "Semicolon" => 0xBA,
        "Quote" => 0xDE,
        "Comma" => 0xBC,
        "Period" => 0xBE,
        "Slash" => 0xBF,
        "CapsLock" => 0x14,
        "Insert" => 0x2D,
        "Delete" => 0x2E,
        "Home" => 0x24,
        "End" => 0x23,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "NumpadMultiply" => 0x6A,
        "NumpadAdd" => 0x6B,
        "NumpadSubtract" => 0x6D,
        "NumpadDecimal" => 0x6E,
        "NumpadDivide" => 0x6F,
        "Pause" => 0x13,
        "ScrollLock" => 0x91,
        "PrintScreen" => 0x2C,
        _ => return None,
    })
}

fn parse(accel: &str) -> Option<Combo> {
    let mut parts: Vec<&str> = accel.split('+').collect();
    let key = vk(parts.pop()?)?;
    let mods = parts.into_iter().map(vk).collect::<Option<Vec<_>>>()?;
    Some(Combo { mods, key })
}

#[cfg(windows)]
fn down(vk: i32) -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(vkey: i32) -> i16;
    }
    // SAFETY: plain Win32 query with no pointers involved.
    unsafe { GetAsyncKeyState(vk) < 0 }
}

#[cfg(not(windows))]
fn down(_vk: i32) -> bool {
    false
}

impl Hotkeys {
    /// Starts the polling thread. Cheap: a handful of state reads every 8 ms.
    pub fn start(&self, app: AppHandle) {
        let bindings = self.bindings.clone();
        std::thread::spawn(move || {
            let mut was: HashMap<String, bool> = HashMap::new();
            loop {
                std::thread::sleep(Duration::from_millis(8));
                let current = bindings.lock().unwrap().clone();
                for (action, combo) in &current {
                    let pressed = down(combo.key) && combo.mods.iter().all(|&m| down(m));
                    if was.get(action).copied().unwrap_or(false) != pressed {
                        was.insert(action.clone(), pressed);
                        let _ = app.emit("hotkey", HotkeyEvent { action, pressed });
                    }
                }
                was.retain(|a, _| current.iter().any(|(b, _)| b == a));
            }
        });
    }

    /// Replaces all bindings. Returns the actions whose binding was not
    /// understood.
    pub fn set(&self, requested: HashMap<String, Option<String>>) -> Vec<String> {
        let mut bad = Vec::new();
        let mut next = Vec::new();
        for (action, accel) in requested {
            let Some(accel) = accel else { continue };
            match parse(&accel) {
                Some(combo) => next.push((action, combo)),
                None => bad.push(action),
            }
        }
        *self.bindings.lock().unwrap() = next;
        bad
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keys_and_mouse() {
        assert_eq!(parse("Ctrl+Shift+KeyM"), Some(Combo { mods: vec![0x11, 0x10], key: 0x4D }));
        assert_eq!(parse("Mouse4"), Some(Combo { mods: vec![], key: 0x05 }));
        assert_eq!(parse("Alt+Mouse5"), Some(Combo { mods: vec![0x12], key: 0x06 }));
        assert_eq!(parse("F13").map(|c| c.key), Some(0x7C));
        assert_eq!(parse("Digit1").map(|c| c.key), Some(0x31));
        assert_eq!(parse("Numpad0").map(|c| c.key), Some(0x60));
        assert_eq!(parse("CapsLock").map(|c| c.key), Some(0x14));
        assert_eq!(parse("Ctrl+Nonsense"), None);
        assert_eq!(parse("F99"), None);
    }
}
