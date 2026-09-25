// Name fonts. Three kinds: ones shipped with the app (OFL, from
// @fontsource, WOFF2 only, downloaded by the page only once some name uses
// them), any Google Fonts family by name, and a member's own file.
import unboundedLatin from "@fontsource/unbounded/files/unbounded-latin-600-normal.woff2";
import unboundedCyrillic from "@fontsource/unbounded/files/unbounded-cyrillic-600-normal.woff2";
import montserratAlternatesLatin from "@fontsource/montserrat-alternates/files/montserrat-alternates-latin-600-normal.woff2";
import montserratAlternatesCyrillic from "@fontsource/montserrat-alternates/files/montserrat-alternates-cyrillic-600-normal.woff2";
import tekturLatin from "@fontsource/tektur/files/tektur-latin-600-normal.woff2";
import tekturCyrillic from "@fontsource/tektur/files/tektur-cyrillic-600-normal.woff2";
import comfortaaLatin from "@fontsource/comfortaa/files/comfortaa-latin-600-normal.woff2";
import comfortaaCyrillic from "@fontsource/comfortaa/files/comfortaa-cyrillic-600-normal.woff2";
import delaGothicOneLatin from "@fontsource/dela-gothic-one/files/dela-gothic-one-latin-400-normal.woff2";
import delaGothicOneCyrillic from "@fontsource/dela-gothic-one/files/dela-gothic-one-cyrillic-400-normal.woff2";
import rubikMonoOneLatin from "@fontsource/rubik-mono-one/files/rubik-mono-one-latin-400-normal.woff2";
import rubikMonoOneCyrillic from "@fontsource/rubik-mono-one/files/rubik-mono-one-cyrillic-400-normal.woff2";
import russoOneLatin from "@fontsource/russo-one/files/russo-one-latin-400-normal.woff2";
import russoOneCyrillic from "@fontsource/russo-one/files/russo-one-cyrillic-400-normal.woff2";
import yesevaOneLatin from "@fontsource/yeseva-one/files/yeseva-one-latin-400-normal.woff2";
import yesevaOneCyrillic from "@fontsource/yeseva-one/files/yeseva-one-cyrillic-400-normal.woff2";
import caveatLatin from "@fontsource/caveat/files/caveat-latin-600-normal.woff2";
import caveatCyrillic from "@fontsource/caveat/files/caveat-cyrillic-600-normal.woff2";
import marckScriptLatin from "@fontsource/marck-script/files/marck-script-latin-400-normal.woff2";
import marckScriptCyrillic from "@fontsource/marck-script/files/marck-script-cyrillic-400-normal.woff2";
import greatVibesLatin from "@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff2";
import greatVibesCyrillic from "@fontsource/great-vibes/files/great-vibes-cyrillic-400-normal.woff2";
import pacificoLatin from "@fontsource/pacifico/files/pacifico-latin-400-normal.woff2";
import pacificoCyrillic from "@fontsource/pacifico/files/pacifico-cyrillic-400-normal.woff2";
import lobsterLatin from "@fontsource/lobster/files/lobster-latin-400-normal.woff2";
import lobsterCyrillic from "@fontsource/lobster/files/lobster-cyrillic-400-normal.woff2";
import pressStart2pLatin from "@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2";
import pressStart2pCyrillic from "@fontsource/press-start-2p/files/press-start-2p-cyrillic-400-normal.woff2";
import pixelifySansLatin from "@fontsource/pixelify-sans/files/pixelify-sans-latin-600-normal.woff2";
import pixelifySansCyrillic from "@fontsource/pixelify-sans/files/pixelify-sans-cyrillic-600-normal.woff2";
import rubikGlitchLatin from "@fontsource/rubik-glitch/files/rubik-glitch-latin-400-normal.woff2";
import rubikGlitchCyrillic from "@fontsource/rubik-glitch/files/rubik-glitch-cyrillic-400-normal.woff2";
import rubikWetPaintLatin from "@fontsource/rubik-wet-paint/files/rubik-wet-paint-latin-400-normal.woff2";
import rubikWetPaintCyrillic from "@fontsource/rubik-wet-paint/files/rubik-wet-paint-cyrillic-400-normal.woff2";
import rubikBubblesLatin from "@fontsource/rubik-bubbles/files/rubik-bubbles-latin-400-normal.woff2";
import rubikBubblesCyrillic from "@fontsource/rubik-bubbles/files/rubik-bubbles-cyrillic-400-normal.woff2";
export interface ShippedFont {
  id: string;
  family: string;
  weight: number;
  /** Size factor, so every font reads about as big as the UI font. */
  k: number;
  group: "clean" | "bold" | "hand" | "play";
  /** Latin, then Cyrillic subset. */
  files: [string, string];
}

export const SHIPPED_FONTS: ShippedFont[] = [
  { id: "unbounded", family: "Unbounded", weight: 600, k: 0.88, group: "clean", files: [unboundedLatin, unboundedCyrillic] },
  { id: "montserrat-alternates", family: "Montserrat Alternates", weight: 600, k: 1, group: "clean", files: [montserratAlternatesLatin, montserratAlternatesCyrillic] },
  { id: "tektur", family: "Tektur", weight: 600, k: 1, group: "clean", files: [tekturLatin, tekturCyrillic] },
  { id: "comfortaa", family: "Comfortaa", weight: 600, k: 1, group: "clean", files: [comfortaaLatin, comfortaaCyrillic] },
  { id: "dela-gothic-one", family: "Dela Gothic One", weight: 400, k: 0.9, group: "bold", files: [delaGothicOneLatin, delaGothicOneCyrillic] },
  { id: "rubik-mono-one", family: "Rubik Mono One", weight: 400, k: 0.8, group: "bold", files: [rubikMonoOneLatin, rubikMonoOneCyrillic] },
  { id: "russo-one", family: "Russo One", weight: 400, k: 1, group: "bold", files: [russoOneLatin, russoOneCyrillic] },
  { id: "yeseva-one", family: "Yeseva One", weight: 400, k: 1.02, group: "bold", files: [yesevaOneLatin, yesevaOneCyrillic] },
  { id: "caveat", family: "Caveat", weight: 600, k: 1.3, group: "hand", files: [caveatLatin, caveatCyrillic] },
  { id: "marck-script", family: "Marck Script", weight: 400, k: 1.18, group: "hand", files: [marckScriptLatin, marckScriptCyrillic] },
  { id: "great-vibes", family: "Great Vibes", weight: 400, k: 1.35, group: "hand", files: [greatVibesLatin, greatVibesCyrillic] },
  { id: "pacifico", family: "Pacifico", weight: 400, k: 0.95, group: "hand", files: [pacificoLatin, pacificoCyrillic] },
  { id: "lobster", family: "Lobster", weight: 400, k: 1.08, group: "hand", files: [lobsterLatin, lobsterCyrillic] },
  { id: "press-start-2p", family: "Press Start 2P", weight: 400, k: 0.62, group: "play", files: [pressStart2pLatin, pressStart2pCyrillic] },
  { id: "pixelify-sans", family: "Pixelify Sans", weight: 600, k: 1.08, group: "play", files: [pixelifySansLatin, pixelifySansCyrillic] },
  { id: "rubik-glitch", family: "Rubik Glitch", weight: 400, k: 1, group: "play", files: [rubikGlitchLatin, rubikGlitchCyrillic] },
  { id: "rubik-wet-paint", family: "Rubik Wet Paint", weight: 400, k: 1, group: "play", files: [rubikWetPaintLatin, rubikWetPaintCyrillic] },
  { id: "rubik-bubbles", family: "Rubik Bubbles", weight: 400, k: 1, group: "play", files: [rubikBubblesLatin, rubikBubblesCyrillic] },
];

export const FONT_GROUPS: { id: ShippedFont["group"]; name: string }[] = [
  { id: "clean", name: "Чистые" },
  { id: "bold", name: "С характером" },
  { id: "hand", name: "Рукописные" },
  { id: "play", name: "Игровые" },
];

/** Google Fonts families come as "g:Family Name"; see `profile::font` on the server. */
export const GOOGLE_PREFIX = "g:";

const LATIN = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const CYRILLIC = "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116";

/** Declared once; the browser downloads a file only when a name needs its letters. */
(function declareShipped() {
  const css = SHIPPED_FONTS.flatMap((f) =>
    f.files.map(
      (url, i) =>
        `@font-face { font-family: "${f.family}"; font-weight: ${f.weight}; font-display: swap; ` +
        `src: url("${url}") format("woff2"); unicode-range: ${i ? CYRILLIC : LATIN}; }`,
    ),
  );
  const style = document.createElement("style");
  style.dataset.voicy = "fonts";
  style.textContent = css.join("\n");
  document.head.append(style);
})();

const byId = new Map(SHIPPED_FONTS.map((f) => [f.id, f]));
export const shippedFont = (id?: string | null) => (id ? byId.get(id) : undefined);

export const googleFamily = (font?: string | null) =>
  font?.startsWith(GOOGLE_PREFIX) ? font.slice(GOOGLE_PREFIX.length).trim() || null : null;

const cssUrl = (family: string) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&display=swap`;

const linked = new Set<string>();

/** Adds the family's stylesheet once; names in it fall back to the UI font until it arrives. */
function linkGoogle(family: string) {
  if (linked.has(family)) return;
  linked.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = cssUrl(family);
  document.head.append(link);
}

/** Whether Google Fonts has this family; they answer 400 for unknown ones. */
export async function googleFontExists(family: string) {
  try {
    return (await fetch(cssUrl(family))).ok;
  } catch {
    return false;
  }
}

const loaded = new Map<string, string>();

/** A member's own font, registered under a family named after its URL. */
function loadOwn(url: string) {
  let family = loaded.get(url);
  if (family) return family;
  family = `voicy-own-${loaded.size + 1}`;
  loaded.set(url, family);
  const face = new FontFace(family, `url("${url}")`, { display: "swap" });
  document.fonts.add(face);
  void face.load().catch(() => {
    // A broken file: the name stays in the UI font.
  });
  return family;
}

/**
 * CSS for a name in this font: the family (UI font as the fallback) and the
 * size factor. `own` is the URL of the member's own font file.
 */
export function fontCss(font?: string | null, own?: string | null): { family: string; weight?: number; k: number } | null {
  const shipped = shippedFont(font);
  if (shipped) return { family: `"${shipped.family}", var(--ui)`, weight: shipped.weight, k: shipped.k };
  const google = googleFamily(font);
  if (google) {
    linkGoogle(google);
    return { family: `"${google}", var(--ui)`, k: 1 };
  }
  if (font === "custom" && own) return { family: `"${loadOwn(own)}", var(--ui)`, k: 1 };
  return null;
}

/** Magic bytes of the formats the server keeps; see `profile::sniff_font`. */
function fontType(b: Uint8Array) {
  const tag = String.fromCharCode(...b.slice(0, 4));
  if (tag === "wOF2") return "font/woff2";
  if (tag === "wOFF") return "font/woff";
  if (tag === "OTTO") return "font/otf";
  if ((b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || tag === "true") return "font/ttf";
  return null;
}

/** `profile::FONT_MAX_BYTES` on the server. */
const FONT_MAX = 512 * 1024;

/** Checks a font file the member picked: size, kind, and that it actually parses. */
export async function readFontFile(file: File): Promise<Blob> {
  if (file.size > FONT_MAX) throw new Error("шрифт больше 512 КБ; возьми WOFF2 или шрифт с меньшим набором букв");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = fontType(bytes);
  if (!type) throw new Error("это не шрифт: подойдут TTF, OTF, WOFF и WOFF2");
  try {
    await new FontFace("voicy-probe", bytes).load();
  } catch {
    throw new Error("этот шрифт не открывается");
  }
  return new Blob([bytes], { type });
}
