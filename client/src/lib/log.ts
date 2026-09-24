import { getVersion } from "@tauri-apps/api/app";

import { api } from "./tauri";

/**
 * Diagnostics for the server we are talking on: what happened to the mic
 * and the connection, so "my mic keeps cutting out" can be read afterwards
 * in `logs/<member>.log` on the server. Technical events only.
 */
type Entry = { t: number; ev: string } & Record<string, unknown>;

const MAX_BUFFER = 1000;
const BATCH = 300;

const buffer: Entry[] = [];
let host: string | null = null;
let version = "";
let sending = false;

getVersion()
  .then((v) => (version = v))
  .catch(() => {});

export function log(ev: string, data: Record<string, unknown> = {}) {
  buffer.push({ t: Date.now(), ev, ...data });
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  console.debug("[voicy]", ev, data);
}

/** Logs go to the server of the current (or last) call. */
export function logTo(next: string | null) {
  if (next === host) return;
  void flushLogs();
  host = next;
}

export async function flushLogs() {
  if (!host || sending || buffer.length === 0) return;
  sending = true;
  const batch = buffer.splice(0, BATCH);
  try {
    await api(host, "POST", "/api/logs", { version, entries: batch });
  } catch {
    // Best effort: an older server has no /api/logs, and a lost batch is
    // better than a buffer that never drains.
  } finally {
    sending = false;
  }
}

setInterval(() => void flushLogs(), 20_000);

window.addEventListener("error", (e) => log("js-error", { msg: String(e.message), at: `${e.filename}:${e.lineno}` }));
window.addEventListener("unhandledrejection", (e) => log("js-rejection", { msg: String(e.reason?.message ?? e.reason) }));
document.addEventListener("visibilitychange", () => log("visibility", { state: document.visibilityState }));
navigator.mediaDevices?.addEventListener("devicechange", () => {
  void navigator.mediaDevices
    .enumerateDevices()
    .then((ds) => log("devices", { inputs: ds.filter((d) => d.kind === "audioinput").map((d) => d.label || d.deviceId.slice(0, 8)) }))
    .catch(() => {});
});
