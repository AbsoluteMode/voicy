// Parser for `.deco` files: avatar decorations as SVG with a few macros, so
// each one reads like a drawing instead of a pile of numbers. The format is
// described in src/decorations/README.md; this turns a file into plain SVG
// markup for a 120 x 120 canvas with the avatar at (60, 60) r 50.

export interface Deco {
  id: string;
  name: string;
  order: number;
  /** Inner markup for `<svg viewBox="0 0 120 120">`. */
  svg: string;
}

const INK = "#0b0b0e";
/** Outline width, see DESIGN.md. */
const LINE = 2.4;
const CENTER = 60;

type Params = Record<string, number | string>;

/* ─── Arithmetic in {…} and @(…) ─── */

/** `+ - * /`, parentheses, numbers and parameter names; nothing else. */
function evaluate(src: string, params: Params): number {
  const tokens = src.match(/\d*\.\d+|\d+|[A-Za-z_]\w*|[-+*/()]/g) ?? [];
  if (tokens.join("") !== src.replace(/\s+/g, "")) throw new Error(`bad expression "${src}"`);
  let at = 0;
  const peek = () => tokens[at];
  const atom = (): number => {
    const t = tokens[at++];
    if (t === "(") {
      const v = sum();
      if (tokens[at++] !== ")") throw new Error(`missing ) in "${src}"`);
      return v;
    }
    if (t === "-") return -atom();
    if (t === undefined) throw new Error(`unfinished "${src}"`);
    if (/^[\d.]/.test(t)) return Number(t);
    const v = params[t];
    if (typeof v !== "number") throw new Error(`unknown number "${t}" in "${src}"`);
    return v;
  };
  const product = (): number => {
    let v = atom();
    while (peek() === "*" || peek() === "/") v = tokens[at++] === "*" ? v * atom() : v / atom();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = tokens[at++] === "+" ? v + product() : v - product();
    return v;
  };
  const v = sum();
  if (at !== tokens.length) throw new Error(`bad expression "${src}"`);
  return v;
}

const num = (n: number) => String(+n.toFixed(2));

/** A point on a circle around the avatar center; 0 degrees is up, clockwise. */
function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CENTER + r * Math.sin(a), CENTER - r * Math.cos(a)];
}

/** Replaces `@(deg, r)` with "x y" and `{expr}` with its value. */
function interpolate(value: string, params: Params): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "@" && value[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < value.length; j++) {
        if (value[j] === "(") depth++;
        if (value[j] === ")" && --depth === 0) break;
      }
      const args = splitTop(value.slice(i + 2, j)).map((a) => evaluate(interpolate(a, params), params));
      if (args.length !== 2) throw new Error(`@() takes an angle and a radius: "${value.slice(i, j + 1)}"`);
      const [x, y] = polar(args[0], args[1]);
      out += `${num(x)} ${num(y)}`;
      i = j;
    } else if (value[i] === "{") {
      const j = value.indexOf("}", i);
      if (j < 0) throw new Error(`missing } in "${value}"`);
      const expr = value.slice(i + 1, j).trim();
      // {fill}: a template's text parameter goes in as it is.
      out += typeof params[expr] === "string" ? params[expr] : num(evaluate(expr, params));
      i = j;
    } else out += value[i];
  }
  return out;
}

/** Splits on commas outside parentheses. */
function splitTop(s: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    if (s[i] === ")") depth--;
    if (s[i] === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  return [...parts, s.slice(start)];
}

/* ─── Shapes the macros draw ─── */

/** A smooth closed outline through the points (Catmull-Rom as cubic Béziers). */
function blobPath(p: [number, number][]) {
  const n = p.length;
  let d = `M${num(p[0][0])} ${num(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [p[(i - 1 + n) % n], p[i], p[(i + 1) % n], p[(i + 2) % n]];
    d += ` C${num(p1[0] + (p2[0] - p0[0]) / 6)} ${num(p1[1] + (p2[1] - p0[1]) / 6)}`;
    d += ` ${num(p2[0] - (p3[0] - p1[0]) / 6)} ${num(p2[1] - (p3[1] - p1[1]) / 6)} ${num(p2[0])} ${num(p2[1])}`;
  }
  return d + "Z";
}

/** Four-point glint. */
function glintPath(x: number, y: number, r: number) {
  const k = r * 0.28;
  return `M${num(x)} ${num(y - r)}Q${num(x + k)} ${num(y - k)} ${num(x + r)} ${num(y)}Q${num(x + k)} ${num(y + k)} ${num(x)} ${num(y + r)}Q${num(x - k)} ${num(y + k)} ${num(x - r)} ${num(y)}Q${num(x - k)} ${num(y - k)} ${num(x)} ${num(y - r)}Z`;
}

/* ─── Expansion ─── */

interface Template {
  params: Params;
  body: Element[];
}

interface Ctx {
  params: Params;
  templates: Map<string, Template>;
  /** Inside the first pass of a <sticker>: every shape turns into its outline. */
  silhouette: boolean;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const SHAPES = new Set(["path", "circle", "ellipse", "rect", "line", "polygon", "polyline"]);

function attrsOf(el: Element, ctx: Ctx, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) if (!skip.includes(a.name)) out[a.name] = interpolate(a.value, ctx.params);
  // outline, outline="1.6": the ink stroke every piece gets.
  if ("outline" in out) {
    const w = out.outline && out.outline !== "outline" ? out.outline : String(LINE);
    delete out.outline;
    out.stroke = INK;
    out["stroke-width"] = w;
    out["stroke-linejoin"] ??= "round";
    out["stroke-linecap"] ??= "round";
  }
  // anim="flicker" delay="0.3": one of the loops in styles.css.
  if (out.anim) {
    out.class = [out.class, `a-${out.anim}`].filter(Boolean).join(" ");
    delete out.anim;
  }
  if (out.delay) {
    out.style = [out.style, `animation-delay:${out.delay}s`].filter(Boolean).join(";");
    delete out.delay;
  }
  if (ctx.silhouette && SHAPES.has(el.localName)) {
    const w = out.stroke && out.stroke !== "none" ? Number(out["stroke-width"] ?? 1) : 0;
    if (out.fill !== "none") out.fill = INK;
    out.stroke = INK;
    out["stroke-width"] = num(w + LINE * 2);
    out["stroke-linejoin"] = "round";
    out["stroke-linecap"] ??= "round";
  }
  return out;
}

function tag(name: string, attrs: Record<string, string>, inner = "") {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  return inner ? `<${name}${a}>${inner}</${name}>` : `<${name}${a}/>`;
}

const kids = (el: Element) => Array.from(el.children);

function expandAll(els: Element[], ctx: Ctx): string {
  return els.map((el) => expand(el, ctx)).join("");
}

function number(attrs: Record<string, string>, key: string, fallback?: number): number {
  const v = attrs[key];
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`missing ${key}=""`);
    return fallback;
  }
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${key}="${v}" is not a number`);
  return n;
}

/** Attributes a macro passes on to the <g> around what it draws. */
function rest(attrs: Record<string, string>, used: string[]) {
  return Object.fromEntries(Object.entries(attrs).filter(([k]) => !used.includes(k)));
}

const wrap = (attrs: Record<string, string>, inner: string) => (Object.keys(attrs).length ? tag("g", attrs, inner) : inner);

function expand(el: Element, ctx: Ctx): string {
  const name = el.localName;
  const template = ctx.templates.get(name);
  if (template) {
    const params: Params = { ...ctx.params, ...template.params };
    for (const a of Array.from(el.attributes)) {
      const v = interpolate(a.value, ctx.params);
      params[a.name] = v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
    }
    return expandAll(template.body, { ...ctx, params });
  }
  switch (name) {
    case "band": {
      const a = attrsOf(el, ctx);
      const w = number(a, "width");
      const line = { d: a.d, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
      const under = tag("path", { ...line, stroke: INK, "stroke-width": num(w + LINE * 2) });
      const over = ctx.silhouette ? "" : tag("path", { ...line, stroke: a.color ?? INK, "stroke-width": num(w) });
      return wrap(rest(a, ["d", "width", "color"]), under + over);
    }
    case "sticker": {
      const inner = kids(el);
      const a = attrsOf(el, ctx);
      return wrap(a, expandAll(inner, { ...ctx, silhouette: true }) + (ctx.silhouette ? "" : expandAll(inner, ctx)));
    }
    case "pair":
    case "mirror": {
      const inner = expandAll(kids(el), ctx);
      const flipped = tag("g", { transform: `translate(${CENTER * 2} 0) scale(-1 1)` }, inner);
      return wrap(attrsOf(el, ctx), name === "pair" ? inner + flipped : flipped);
    }
    case "ring": {
      const a = attrsOf(el, ctx);
      const n = number(a, "n");
      const [cx, cy] = (a.around ?? `${CENTER} ${CENTER}`).trim().split(/[\s,]+/).map(Number);
      const turn = number(a, "turn", 0);
      // span="120": copies spread over an arc, both ends included.
      const span = number(a, "span", 360);
      const step = span >= 360 || n < 2 ? span / n : span / (n - 1);
      let out = "";
      for (let i = 0; i < n; i++) {
        const inner = expandAll(kids(el), { ...ctx, params: { ...ctx.params, i } });
        out += tag("g", { transform: `rotate(${num(turn + i * step)} ${cx} ${cy})`, style: `--i:${i}` }, inner);
      }
      return wrap(rest(a, ["n", "around", "turn", "span"]), out);
    }
    case "glint": {
      const a = attrsOf(el, ctx);
      const d = glintPath(number(a, "x"), number(a, "y"), number(a, "r"));
      const cls = ["a-twinkle", a.class].filter(Boolean).join(" ");
      const fill = ctx.silhouette ? INK : (a.color ?? "#fff");
      return tag("path", { ...rest(a, ["x", "y", "r", "color", "class"]), class: cls, d, fill, stroke: INK, "stroke-width": ctx.silhouette ? "4.8" : "1.6", "stroke-linejoin": "round" });
    }
    case "blob": {
      const a = attrsOf(el, ctx);
      const n = (a.points ?? "").trim().split(/[\s,]+/).map(Number);
      if (n.length < 6 || n.length % 2 || n.some(Number.isNaN)) throw new Error(`<blob> needs three or more "x y" points`);
      const pts = Array.from({ length: n.length / 2 }, (_, i) => [n[i * 2], n[i * 2 + 1]] as [number, number]);
      return tag("path", { ...rest(a, ["points"]), d: blobPath(pts) });
    }
    case "pixels": {
      const a = attrsOf(el, ctx);
      const [x, y, px] = [number(a, "x"), number(a, "y"), number(a, "size", 2.4)];
      const rows = (el.textContent ?? "").split("\n").map((r) => r.trim()).filter(Boolean);
      const at = (c: number, r: number) => rows[r]?.[c] ?? ".";
      const filled = (c: number, r: number) => at(c, r) !== ".";
      const colors: Record<string, string> = { X: a.fill ?? "#fff", o: a.light ?? "#fff", d: a.dark ?? INK };
      let cells = "";
      const width = Math.max(...rows.map((r) => r.length));
      for (let r = -1; r <= rows.length; r++) {
        for (let c = -1; c <= width; c++) {
          const on = filled(c, r);
          const edge = !on && [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dc, dr]) => filled(c + dc, r + dr));
          if (!on && !edge) continue;
          const fill = on && !ctx.silhouette ? (colors[at(c, r)] ?? colors.X) : INK;
          cells += tag("rect", { x: num(x + c * px), y: num(y + r * px), width: num(px + 0.05), height: num(px + 0.05), fill });
        }
      }
      return tag("g", { ...rest(a, ["x", "y", "size", "fill", "light", "dark"]), "shape-rendering": "crispEdges" }, cells);
    }
    default: {
      const a = attrsOf(el, ctx);
      // <text>zxc</text>: the words go in as they are, with {expr} worked out.
      const words = !el.children.length && el.textContent?.trim() ? esc(interpolate(el.textContent.trim(), ctx.params)) : "";
      if (words && ctx.silhouette) {
        a.fill = INK;
        a.stroke = INK;
        a["stroke-width"] = num(Number(a["stroke-width"] ?? 0) + LINE * 2);
        a["stroke-linejoin"] = "round";
      }
      return tag(name, a, words || expandAll(kids(el), ctx));
    }
  }
}

/* ─── Files ─── */

/** Header lines: `name: …`, `order: …`, `$color: #hex`. `//` starts a comment. */
function header(text: string) {
  const meta: Record<string, string> = {};
  const palette: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^(\$?[\w-]+)\s*:\s*(.+)$/);
    if (!m) throw new Error(`header line "${line}" should be "key: value"`);
    if (m[1].startsWith("$")) palette[m[1].slice(1)] = m[2];
    else meta[m[1]] = m[2];
  }
  return { meta, palette };
}

/** Parses one `.deco` file; `id` is its file name without the extension. */
export function parseDeco(id: string, text: string): Deco {
  const src = text.replace(/\r\n/g, "\n");
  const cut = src.search(/^---\s*$/m);
  if (cut < 0) throw new Error(`${id}.deco: no "---" between the header and the drawing`);
  const { meta, palette } = header(src.slice(0, cut));
  if (!meta.name) throw new Error(`${id}.deco: no "name:"`);
  // $ink and $me are there in every file; $me falls back to the file's own.
  const colors: Record<string, string> = { ink: INK, ...palette, me: `var(--c1, ${palette.me ?? "#c6f36b"})` };
  const body = src
    .slice(src.indexOf("\n", cut) + 1)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\$([A-Za-z][\w-]*)/g, (_, key: string) => {
      if (!(key in colors)) throw new Error(`${id}.deco: unknown color $${key}`);
      return colors[key];
    })
    // A bare `outline` is the usual case; XML wants a value.
    .replace(/(\s)outline(?=[\s/>])/g, '$1outline="outline"');
  const doc = new DOMParser().parseFromString(`<deco>${body}</deco>`, "application/xml");
  const error = doc.querySelector("parsererror");
  // Chromium wraps the message: "This page contains the following errors:<message>\nBelow is…".
  if (error) throw new Error(`${id}.deco: ${error.textContent?.replace(/^[\s\S]*?errors:/, "").split("\n")[0].trim() || "bad markup"}`);

  const templates = new Map<string, Template>();
  const top: Element[] = [];
  for (const el of Array.from(doc.documentElement.children)) {
    if (el.localName !== "define") {
      top.push(el);
      continue;
    }
    const tname = el.getAttribute("name");
    if (!tname) throw new Error(`${id}.deco: <define> without name=""`);
    const params: Params = {};
    for (const p of (el.getAttribute("params") ?? "").split(/\s+/).filter(Boolean)) {
      const [k, v] = p.split("=");
      if (v !== undefined) params[k] = Number.isNaN(Number(v)) ? v : Number(v);
    }
    templates.set(tname, { params, body: Array.from(el.children) });
  }
  try {
    const svg = expandAll(top, { params: {}, templates, silhouette: false });
    return { id, name: meta.name, order: Number(meta.order ?? 1000), svg };
  } catch (e) {
    throw new Error(`${id}.deco: ${e instanceof Error ? e.message : e}`);
  }
}
