import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";

import { getSettings, Hotkeys } from "./settings";
import { voice } from "./voice";

export type HotkeyErrors = Partial<Record<keyof Hotkeys, string>>;

let applied = "";
let errors: HotkeyErrors = {};

/**
 * (Re)registers the global shortcuts from settings. They work while Voicy
 * is in the background, e.g. during a game. Returns the ones that could not
 * be registered, typically because another app already owns the combo.
 */
export async function applyHotkeys(): Promise<HotkeyErrors> {
  const hk = getSettings().hotkeys;
  const key = JSON.stringify(hk);
  if (key === applied) return errors;
  applied = key;
  await unregisterAll().catch(() => {});
  const next: HotkeyErrors = {};
  const bind = async (name: keyof Hotkeys, accel: string | null, fn: (pressed: boolean) => void) => {
    if (!accel) return;
    try {
      await register(accel, (e) => fn(e.state === "Pressed"));
    } catch (e) {
      next[name] = String(e);
    }
  };
  await bind("mute", hk.mute, (pressed) => pressed && void voice.toggleMic());
  await bind("deafen", hk.deafen, (pressed) => pressed && void voice.toggleDeafen());
  await bind("ptt", hk.ptt, (pressed) => void voice.pushToTalk(pressed));
  errors = next;
  return errors;
}

/** Accelerator for a key press in the settings dialog, or null for a lone modifier. */
export function accelFrom(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  return [...mods, e.code].join("+");
}

/** "Ctrl+Shift+KeyM" → "Ctrl + Shift + M". */
export function prettyAccel(accel: string | null): string {
  if (!accel) return "не назначено";
  return accel
    .split("+")
    .map((k) =>
      k
        .replace(/^Key/, "")
        .replace(/^Digit/, "")
        .replace(/^Numpad/, "Num ")
        .replace("Backquote", "`")
        .replace("Space", "Пробел")
        .replace("CapsLock", "Caps Lock"),
    )
    .join(" + ");
}
