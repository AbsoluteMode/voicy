import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { getSettings, Hotkeys } from "./settings";
import { voice } from "./voice";

export type HotkeyErrors = Partial<Record<keyof Hotkeys, string>>;

let applied = "";
let errors: HotkeyErrors = {};
let listening = false;

/**
 * Hands the bindings to the Rust side, which watches keys and mouse buttons
 * globally (also while Voicy is in the background, e.g. in a game) without
 * taking them away from other apps. Returns bindings it could not use.
 */
export async function applyHotkeys(): Promise<HotkeyErrors> {
  if (!listening) {
    listening = true;
    await listen<{ action: keyof Hotkeys; pressed: boolean }>("hotkey", ({ payload }) => {
      if (payload.action === "mute" && payload.pressed) void voice.toggleMic("hotkey");
      if (payload.action === "deafen" && payload.pressed) void voice.toggleDeafen("hotkey");
      if (payload.action === "ptt") void voice.pushToTalk(payload.pressed);
    });
  }
  const { hotkeys: hk, pushToTalk } = getSettings();
  const key = JSON.stringify([hk, pushToTalk]);
  if (key === applied) return errors;
  applied = key;
  // The push-to-talk key is only watched while the mode is on.
  const bindings = { mute: hk.mute, deafen: hk.deafen, ptt: pushToTalk ? hk.ptt : null };
  const bad = await invoke<(keyof Hotkeys)[]>("set_hotkeys", { bindings }).catch(() => [] as (keyof Hotkeys)[]);
  errors = Object.fromEntries(bad.map((a) => [a, "unsupported"]));
  return errors;
}

function mods(e: KeyboardEvent | MouseEvent): string[] {
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
}

/** Binding for a key press in the settings dialog, or null for a lone modifier. */
export function accelFrom(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  return [...mods(e), e.code].join("+");
}

/** Binding for a mouse button: middle and the two side buttons only. */
export function accelFromMouse(e: MouseEvent): string | null {
  const button = { 1: "MouseMiddle", 3: "Mouse4", 4: "Mouse5" }[e.button];
  return button ? [...mods(e), button].join("+") : null;
}

/** "Ctrl+Shift+KeyM" → "Ctrl + Shift + M", "Mouse4" → "Мышь 4". */
export function prettyAccel(accel: string | null): string {
  if (!accel) return "не назначено";
  return accel
    .split("+")
    .map((k) =>
      k
        .replace(/^Key/, "")
        .replace(/^Digit/, "")
        .replace(/^Numpad/, "Num ")
        .replace("MouseMiddle", "Колёсико")
        .replace(/^Mouse(\d)$/, "Мышь $1")
        .replace("Backquote", "`")
        .replace("Space", "Пробел")
        .replace("CapsLock", "Caps Lock"),
    )
    .join(" + ");
}
