import { relaunch } from "@tauri-apps/plugin-process";
import { check, Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";

export type UpdateState =
  | { kind: "none" }
  | { kind: "available"; version: string }
  | { kind: "installing"; percent: number | null }
  | { kind: "error"; message: string };

const CHECK_EVERY_MS = 30 * 60 * 1000;

/**
 * Polls GitHub releases for a newer, signed build. The updater plugin
 * verifies the signature against the public key in tauri.conf.json.
 */
export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ kind: "none" });
  const update = useRef<Update | null>(null);

  const poll = useCallback(async () => {
    try {
      const found = await check();
      if (found) {
        update.current = found;
        setState((s) => (s.kind === "installing" ? s : { kind: "available", version: found.version }));
      }
    } catch (e) {
      // Offline or GitHub hiccup: try again next time, quietly.
      console.warn("update check failed", e);
    }
  }, []);

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), CHECK_EVERY_MS);
    return () => clearInterval(t);
  }, [poll]);

  const install = useCallback(async () => {
    const u = update.current;
    if (!u) return;
    let total = 0;
    let done = 0;
    setState({ kind: "installing", percent: null });
    try {
      await u.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") {
          done += e.data.chunkLength;
          setState({ kind: "installing", percent: total ? Math.round((done / total) * 100) : null });
        }
      });
      await relaunch();
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  return { state, install };
}
