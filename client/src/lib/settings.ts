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
}

// DeepFilterNet on by default, like Krisp in Discord: friends and family
// should not have to configure anything to keep the keyboard out. The
// browser's own echo cancellation and AGC stay off; they dull a good mic on
// headphones.
const DEFAULTS: AudioSettings = {
  inputDevice: "",
  outputDevice: "",
  bitrate: 128,
  noise: "standard",
  echoCancellation: false,
  autoGainControl: false,
  volumes: {},
  nickname: "",
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
