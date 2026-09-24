import { getSettings } from "./settings";
import { api, errorCode, listServers, Member } from "./tauri";

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

export async function renderAvatar(img: HTMLImageElement, crop: Crop): Promise<LocalAvatar> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = AVATAR_PX;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_PX, AVATAR_PX);
  let blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/webp", 0.88));
  if (!blob || blob.type !== "image/webp") blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.9));
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

/** Uploads that failed for good (a server too old for avatars): not retried this session. */
const refused = new Set<string>();

/**
 * Brings our picture on `host` in line with the one chosen here. Returns
 * true when it changed something, so the caller can reload the members.
 */
export async function syncAvatar(host: string, me: Member): Promise<boolean> {
  const mine = getSettings().avatar;
  if (mine === undefined) return false;
  const want = mine?.version ?? null;
  const key = `${host} ${want}`;
  if ((me.avatar ?? null) === want || refused.has(key)) return false;
  try {
    if (mine) await api(host, "PUT", "/api/me/avatar", { data: mine.url.slice(mine.url.indexOf(",") + 1) });
    else await api(host, "DELETE", "/api/me/avatar");
    return true;
  } catch (e) {
    if (errorCode(e) !== "network") refused.add(key);
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
