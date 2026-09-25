import { applyPalette, GIFEncoder, quantize } from "gifenc";

import { getSettings } from "./settings";
import { api, listServers, Member } from "./tauri";

export interface LocalAvatar {
  /** The cropped picture as a data: URL (WebP, or JPEG as a fallback; GIF when animated). */
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
  return localAvatar(blob);
}

/** A file as we keep and send it: a data: URL and the server's content hash. */
export async function localAvatar(blob: Blob): Promise<LocalAvatar> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const url = await new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });
  return { url, version: await versionOf(bytes) };
}

/** Kinds that can move, by magic bytes: file types and Pinterest's bytes can't be trusted. */
async function motionType(blob: Blob) {
  const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const text = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (text(0, 4) === "GIF8") return "image/gif";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  if (b[0] === 0x89 && text(1, 4) === "PNG") return "image/png"; // APNG
  return null;
}

/** WebCodecs' decoder for the picture when it has more than one frame, else null. */
async function animationDecoder(blob: Blob) {
  const type = await motionType(blob);
  if (!type || typeof ImageDecoder === "undefined" || !(await ImageDecoder.isTypeSupported(type))) return null;
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type });
  try {
    // Tracks can still be empty when the data is in; wait for both.
    await Promise.all([decoder.tracks.ready, decoder.completed]);
    const track = decoder.tracks.selectedTrack;
    if (track?.animated && track.frameCount > 1) return decoder;
  } catch {
    // Not decodable here: treat it as a still picture.
  }
  decoder.close();
  return null;
}

export async function isAnimated(blob: Blob) {
  const decoder = await animationDecoder(blob);
  decoder?.close();
  return Boolean(decoder);
}

/**
 * The server keeps up to 512 KB (`avatar::MAX_BYTES`), servers that
 * predate animation too, so a GIF is made to fit rather than the limit
 * raised. Tried in order until one fits: side in px, shortest frame in ms.
 */
const MAX_UPLOAD = 512 * 1024;
const GIF_TRIES = [
  [160, 40],
  [128, 40],
  [128, 70],
  [96, 70],
  [96, 120],
] as const;
/** Frames kept at most; longer animations drop every other one and so on. */
const MAX_FRAMES = 150;

interface Frame {
  canvas: HTMLCanvasElement;
  /** Milliseconds. */
  delay: number;
}

/**
 * Crops every frame of an animated GIF, WebP or APNG and saves it as a GIF,
 * the one moving format a canvas can be turned into here.
 */
export async function renderAnimatedAvatar(blob: Blob, crop: Crop): Promise<LocalAvatar> {
  const decoder = await animationDecoder(blob);
  if (!decoder) throw new Error("это не анимация");
  const base = GIF_TRIES[0][0];
  const frames: Frame[] = [];
  let total = 0;
  try {
    const count = decoder.tracks.selectedTrack!.frameCount;
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
      // Browsers play 0-10 ms frames at 100 ms; do the same.
      const delay = image.duration && image.duration > 10_000 ? image.duration / 1000 : 100;
      // Two steps down, as in `renderAvatar`, for big sources.
      const mid = square(Math.max(base, Math.min(base * 2, Math.round(crop.size))));
      mid.ctx.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, mid.canvas.width, mid.canvas.width);
      image.close();
      const frame = square(base);
      frame.ctx.drawImage(mid.canvas, 0, 0, base, base);
      frames.push({ canvas: frame.canvas, delay });
      total += delay;
    }
  } finally {
    decoder.close();
  }
  for (const [px, minDelay] of GIF_TRIES) {
    const bytes = encodeGif(frames, px, Math.max(minDelay, total / MAX_FRAMES));
    if (bytes.length <= MAX_UPLOAD) return localAvatar(new Blob([bytes as BlobPart], { type: "image/gif" }));
  }
  throw new Error("гифка слишком тяжёлая даже в маленьком размере, возьми покороче");
}

/** Frames shorter than `minDelay` are merged into the one before, so the timing stays. */
function encodeGif(frames: Frame[], px: number, minDelay: number) {
  const gif = GIFEncoder();
  const { ctx } = square(px);
  let pending: { frame: Frame; delay: number } | null = null;
  const write = ({ frame, delay }: { frame: Frame; delay: number }) => {
    ctx.clearRect(0, 0, px, px);
    ctx.drawImage(frame.canvas, 0, 0, px, px);
    const { data } = ctx.getImageData(0, 0, px, px);
    let holes = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 128) { holes = true; break; }
    const format = holes ? "rgba4444" : "rgb565";
    const palette = quantize(data, 256, { format, oneBitAlpha: holes });
    const clear = holes ? palette.findIndex((c) => c[3] === 0) : -1;
    gif.writeFrame(applyPalette(data, palette, format), px, px, {
      palette,
      delay: Math.round(delay),
      transparent: clear >= 0,
      transparentIndex: Math.max(clear, 0),
      // Frames come whole: clear the last one so its pixels don't show through.
      dispose: 2,
    });
  };
  for (const frame of frames) {
    if (pending && pending.delay < minDelay) pending.delay += frame.delay;
    else {
      if (pending) write(pending);
      pending = { frame, delay: frame.delay };
    }
  }
  if (pending) write(pending);
  gif.finish();
  return gif.bytes();
}

/** Side of a still decoration: what Discord uses too. */
const DECORATION_PX = 288;
/** `profile::DECORATION_MAX_BYTES` on the server. */
const DECORATION_MAX = 1024 * 1024;

/**
 * A decoration of one's own, in Discord's layout: a square 1.2 times the
 * avatar. Still pictures are cut to a centered square and made small;
 * moving ones go up as they are, since nothing here writes APNG.
 */
export async function renderDecoration(blob: Blob): Promise<LocalAvatar> {
  if (await isAnimated(blob)) {
    if (blob.size > DECORATION_MAX) throw new Error("анимированная декорация больше 1 МБ, сожми её или возьми поменьше");
    return localAvatar(blob);
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const px = Math.min(DECORATION_PX, side);
    const { canvas, ctx } = square(px);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, px, px);
    // WebP keeps the see-through parts, which a decoration is mostly made of.
    let out = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/webp", 0.92));
    if (!out || out.type !== "image/webp") out = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
    if (!out) throw new Error("не удалось сохранить картинку");
    return localAvatar(out);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Files we upload: the avatar, a decoration and a name font of our own. */
const PICTURES = {
  avatar: { setting: "avatar", field: "avatar", path: "/api/me/avatar" },
  decoration: { setting: "decorationFile", field: "decoration_file", path: "/api/me/decoration" },
  font: { setting: "fontFile", field: "font_file", path: "/api/me/font" },
} as const;

export type PictureKind = keyof typeof PICTURES;

/**
 * When an upload last failed, by host and picture. A server may be too old
 * for it, or restarting mid-upload; either way try again a bit later
 * instead of hammering it on every poll or giving up for good.
 */
const failedAt = new Map<string, number>();
const RETRY_MS = 60_000;

/**
 * Brings our picture on `host` in line with the one chosen here. Returns
 * true when it changed something, so the caller can reload the members.
 */
export async function syncPicture(host: string, me: Member, kind: PictureKind): Promise<boolean> {
  const { setting, field, path } = PICTURES[kind];
  const mine = getSettings()[setting];
  if (mine === undefined) return false;
  const want = mine?.version ?? null;
  const key = `${kind} ${host} ${want}`;
  if ((me[field] ?? null) === want || Date.now() - (failedAt.get(key) ?? 0) < RETRY_MS) return false;
  try {
    if (mine) await api(host, "PUT", path, { data: mine.url.slice(mine.url.indexOf(",") + 1) });
    else await api(host, "DELETE", path);
    failedAt.delete(key);
    return true;
  } catch (e) {
    failedAt.set(key, Date.now());
    console.warn(`${kind} sync with ${host} failed`, e);
    return false;
  }
}

export const syncAvatar = (host: string, me: Member) => syncPicture(host, me, "avatar");

/** After a new pick: every server, not just the open one, so friends see it right away. */
export async function syncPictureEverywhere(kind: PictureKind) {
  const servers = await listServers().catch(() => []);
  await Promise.all(
    servers.map(async (s) => {
      try {
        await syncPicture(s.host, await api<Member>(s.host, "GET", "/api/me"), kind);
      } catch {
        // Offline or gone: the next visit to that server syncs it.
      }
    }),
  );
}

export const syncAvatarEverywhere = () => syncPictureEverywhere("avatar");
