import { useSyncExternalStore } from "react";

import type { NoiseMode } from "./noise";

export interface AudioSettings {
  inputDevice: string;
  outputDevice: string;
  /** Opus target, kbit/s. */
  bitrate: number;
  noise: NoiseMode;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /** Per-member playback volume, 0..2, keyed by member id. */
  volumes: Record<string, number>;
  nickname: string;
  /** Bumped when a default changes and old saved settings must follow. */
  version: number;
}

// Like Discord out of the box: DeepFilterNet keeps the keyboard out, and
// echo cancellation keeps a friend's leaky headphones or speakers from
// sending your own voice back to you. AGC stays off: it pumps up the
// background between words.
const DEFAULTS: AudioSettings = {
  inputDevice: "",
  outputDevice: "",
  bitrate: 128,
  noise: "standard",
  echoCancellation: true,
  autoGainControl: false,
  volumes: {},
  nickname: "",
  version: 2,
};

export const BITRATES = [64, 96, 128, 192, 256];

const KEY = "voicy.settings";
const listeners = new Set<() => void>();

function read(): AudioSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw);
    // 0.1.0 had an on/off switch for Chromium's own suppression.
    if (typeof saved.noiseSuppression === "boolean" && !saved.noise) saved.noise = saved.noiseSuppression ? "standard" : "off";
    delete saved.noiseSuppression;
    // RNNoise ("light") is a fallback now, no longer a choice.
    if (saved.noise === "light") saved.noise = "soft";
    // Before version 2 echo cancellation defaulted to off and was saved as
    // such without anyone choosing it.
    if (!(saved.version >= 2)) {
      saved.echoCancellation = true;
      saved.version = 2;
    }
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

let current = read();

export function getSettings(): AudioSettings {
  return current;
}

export function updateSettings(patch: Partial<AudioSettings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Settings still apply for this session.
  }
  listeners.forEach((fn) => fn());
}

export function useSettings(): AudioSettings {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSettings,
  );
}
