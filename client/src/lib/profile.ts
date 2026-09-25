import { decorationById } from "./decorations";
import { googleFamily, shippedFont } from "./fonts";
import { getSettings } from "./settings";
import { api, listServers, Member, Profile } from "./tauri";

/** Name effects, as in Discord's name styles; `two` ones use a second color. */
export const EFFECTS: { id: string | null; name: string; two?: boolean }[] = [
  { id: null, name: "Обычный" },
  { id: "gradient", name: "Градиент", two: true },
  { id: "neon", name: "Неон" },
  { id: "toon", name: "Мульт", two: true },
  { id: "pop", name: "Поп", two: true },
];

/** Bright enough to read on the dark background. */
export const COLORS = ["#c6f36b", "#7fe3b5", "#5ee0f0", "#8cb8ff", "#b69cff", "#f08cff", "#ff8fb8", "#ff7a7a", "#ffab5c", "#ffd84d"];

export const STATUS_MAX = 60;

export const STATUS_IDEAS = ["🎮 Играю", "😴 АФК", "🔕 Не беспокоить", "🍕 Ем", "📚 Учусь", "🎧 Слушаю музыку"];


/**
 * What to draw, with anything this app does not know dropped: a newer app
 * may have more fonts, effects or decorations.
 */
export function styleOf(p?: Profile) {
  const effect = EFFECTS.find((e) => e.id === p?.effect) ?? EFFECTS[0];
  const font = p?.font && (shippedFont(p.font) || googleFamily(p.font) || p.font === "custom") ? p.font : null;
  const decoration = p?.decoration === "custom" ? "custom" : (decorationById(p?.decoration)?.id ?? null);
  return {
    font,
    effect: effect.id,
    color: p?.color ?? null,
    color2: effect.two ? (p?.color2 ?? null) : null,
    decoration,
  };
}

/** Unix seconds the status should stop showing at, from a choice in minutes (0 = never). */
export function statusUntil(minutes: number | "day"): number | null {
  if (minutes === 0) return null;
  if (minutes === "day") {
    const end = new Date();
    end.setHours(24, 0, 0, 0);
    return Math.floor(end.getTime() / 1000);
  }
  return Math.floor(Date.now() / 1000) + minutes * 60;
}

/** The status if it has not run out yet. */
export function statusOf(p?: Profile): string | null {
  if (!p?.status) return null;
  return p.status_until && p.status_until * 1000 <= Date.now() ? null : p.status;
}

const FIELDS = ["color", "color2", "font", "effect", "status", "status_until", "decoration"] as const;

/** The same trimming and checks the server does, so the two compare equal after a save. */
export function cleanProfile(p: Profile): Profile {
  const color = (c?: string | null) => {
    const v = c?.trim().toLowerCase();
    return v && /^#[0-9a-f]{6}$/.test(v) ? v : null;
  };
  const status = p.status?.trim() || null;
  return {
    color: color(p.color),
    color2: color(p.color2),
    font: p.font || null,
    effect: p.effect || null,
    status: status ? [...status].slice(0, STATUS_MAX).join("") : null,
    status_until: status ? (p.status_until ?? null) : null,
    decoration: p.decoration || null,
  };
}

/** As shown now: without a status that has run out. */
function current(p: Profile): Profile {
  const c = cleanProfile(p);
  return statusOf(c) ? c : { ...c, status: null, status_until: null };
}

const same = (a: Profile, b: Profile) => FIELDS.every((f) => a[f] === b[f]);

/** When an upload last failed, by host and profile; see `syncPicture`. */
const failedAt = new Map<string, number>();
const RETRY_MS = 60_000;

/**
 * Brings our profile on `host` in line with the one chosen here. Returns
 * true when it changed something, so the caller can reload the members.
 */
export async function syncProfile(host: string, me: Member): Promise<boolean> {
  const mine = getSettings().profile;
  if (mine === undefined) return false;
  const want = current(mine);
  const key = `${host} ${JSON.stringify(want)}`;
  if (same(current(me), want) || Date.now() - (failedAt.get(key) ?? 0) < RETRY_MS) return false;
  try {
    await api(host, "PUT", "/api/me/profile", want);
    failedAt.delete(key);
    return true;
  } catch (e) {
    // Servers before profiles answer 404; they get it once they update.
    failedAt.set(key, Date.now());
    console.warn(`profile sync with ${host} failed`, e);
    return false;
  }
}

/** After a change: every server, so friends see it right away. */
export async function syncProfileEverywhere() {
  const servers = await listServers().catch(() => []);
  await Promise.all(
    servers.map(async (s) => {
      try {
        await syncProfile(s.host, await api<Member>(s.host, "GET", "/api/me"));
      } catch {
        // Offline or gone: the next visit to that server syncs it.
      }
    }),
  );
}
