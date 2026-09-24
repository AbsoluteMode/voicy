import { getSettings } from "./settings";
import { api, listServers, Member } from "./tauri";

export interface LocalAvatar {
  /** The cropped picture as a data: URL (WebP, or JPEG as a fallback). */
  url: string;
  /** The content hash the server derives too, to tell when a server is behind. */
  version: string;
}

/** Stored and sent at this size; shown at 72 px at most, 2x for HiDPI and then some. */
export const AVATAR_PX = 256;

/** First 9 bytes of SHA-256, base64url: the same as `avatar::version` on the server. */
async function versionOf(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)).slice(0, 9);
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_");
}

/** Visible square of the source image, in its own pixels. */
export interface Crop {
  x: number;
  y: number;
  size: number;
}

function square(px: number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

export async function renderAvatar(img: HTMLImageElement, crop: Crop): Promise<LocalAvatar> {
  // Halve step by step: one big jump (a 2000 px photo down to 256) skips
  // most source pixels and comes out grainy.
  let px = Math.max(AVATAR_PX, Math.min(2048, Math.round(crop.size)));
  let step = square(px);
  step.ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, px, px);
  while (px > AVATAR_PX) {
    px = Math.max(AVATAR_PX, Math.round(px / 2));
    const next = square(px);
    next.ctx.drawImage(step.canvas, 0, 0, px, px);
    step = next;
  }
  const { canvas } = step;
  let blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/webp", 0.95));
  if (!blob || blob.type !== "image/webp") blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.93));
  if (!blob) throw new Error("не удалось сохранить картинку");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const url = await new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });
  return { url, version: await versionOf(bytes) };
}

/**
 * When an upload last failed, by host and picture. A server may be too old
 * for avatars, or restarting mid-upload; either way try again a bit later
 * instead of hammering it on every poll or giving up for good.
 */
const failedAt = new Map<string, number>();
const RETRY_MS = 60_000;

/**
 * Brings our picture on `host` in line with the one chosen here. Returns
 * true when it changed something, so the caller can reload the members.
 */
export async function syncAvatar(host: string, me: Member): Promise<boolean> {
  const mine = getSettings().avatar;
  if (mine === undefined) return false;
  const want = mine?.version ?? null;
  const key = `${host} ${want}`;
  if ((me.avatar ?? null) === want || Date.now() - (failedAt.get(key) ?? 0) < RETRY_MS) return false;
  try {
    if (mine) await api(host, "PUT", "/api/me/avatar", { data: mine.url.slice(mine.url.indexOf(",") + 1) });
    else await api(host, "DELETE", "/api/me/avatar");
    failedAt.delete(key);
    return true;
  } catch (e) {
    failedAt.set(key, Date.now());
    console.warn(`avatar sync with ${host} failed`, e);
    return false;
  }
}

/** After a new pick: every server, not just the open one, so friends see it right away. */
export async function syncAvatarEverywhere() {
  const servers = await listServers().catch(() => []);
  await Promise.all(
    servers.map(async (s) => {
      try {
        await syncAvatar(s.host, await api<Member>(s.host, "GET", "/api/me"));
      } catch {
        // Offline or gone: the next visit to that server syncs it.
      }
    }),
  );
}
