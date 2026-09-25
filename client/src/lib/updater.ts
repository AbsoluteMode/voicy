import { relaunch } from "@tauri-apps/plugin-process";
import { check, Update } from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";

import { ask } from "./confirm";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; version: string; error?: string }
  | { kind: "installing"; percent: number | null }
  | { kind: "error"; message: string };

const CHECK_EVERY_MS = 30 * 60 * 1000;

// One store for the rail button and the settings dialog.
let state: UpdateState = { kind: "idle" };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((fn) => fn());
}

/**
 * Asks GitHub releases for a newer, signed build. The updater plugin
 * verifies the signature against the public key in tauri.conf.json.
 * `manual` checks report "latest" and errors; background ones stay quiet.
 */
export async function checkForUpdate(manual = false) {
  if (state.kind === "installing" || state.kind === "checking") return;
  const before = state;
  if (manual) set({ kind: "checking" });
  try {
    const found = await check();
    if (found) {
      pending = found;
      set({ kind: "available", version: found.version });
    } else {
      set(manual ? { kind: "latest" } : before.kind === "available" ? before : { kind: "idle" });
    }
  } catch (e) {
    console.warn("update check failed", e);
    if (manual) set({ kind: "error", message: "нет связи с GitHub" });
  }
}

export async function installUpdate() {
  const update = pending;
  if (!update) return;
  let total = 0;
  let done = 0;
  set({ kind: "installing", percent: null });
  try {
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      if (e.event === "Progress") {
        done += e.data.chunkLength;
        set({ kind: "installing", percent: total ? Math.round((done / total) * 100) : null });
      }
    });
    await relaunch();
  } catch (e) {
    // Keep the update on offer so the button can retry.
    set({ kind: "available", version: update.version, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Installing restarts Voicy, so a live call gets a warning first. */
export async function confirmAndInstall(inCall: boolean) {
  if (inCall && !(await ask({ title: "Обновить сейчас?", text: "Voicy перезапустится, и звонок прервётся на пару секунд.", confirm: "Обновить" }))) return;
  void installUpdate();
}

let started = false;

export function useUpdater(): UpdateState {
  if (!started) {
    started = true;
    void checkForUpdate();
    setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
  }
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}
