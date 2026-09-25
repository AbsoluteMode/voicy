import { AlertTriangle, Crown, Headphones, HelpCircle, ShieldCheck, X } from "lucide-react";
import { CSSProperties, ReactNode, useEffect, useRef, useState } from "react";

import { answer, usePendingAsk } from "../lib/confirm";
import { fontCss } from "../lib/fonts";
import { styleOf } from "../lib/profile";
import { decorationById } from "../lib/decorations";
import { Profile, Role } from "../lib/tauri";

export type Tone = "accent" | "danger" | "neutral";

/**
 * Every dialog: a sheet from the bottom in the narrow window, a centered
 * card when there is room. Title row with an optional icon and a close
 * button; a `.foot` inside stays pinned while the body scrolls.
 */
export function Modal(props: {
  title: string;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  onClose?: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const { title, sub, icon, tone = "accent", onClose, wide, children } = props;
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal aria-label={title}>
        <header className="modal-head">
          {icon && <div className={`modal-icon ${tone}`}>{icon}</div>}
          <div className="modal-titles">
            <h2>{title}</h2>
            {sub && <p className="sub">{sub}</p>}
          </div>
          {onClose && (
            <button type="button" className="icon-btn modal-x" onClick={onClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Renders questions from `ask()`; mounted once at the app root. */
export function ConfirmHost() {
  const q = usePendingAsk();
  if (!q) return null;
  return (
    <Modal
      title={q.title}
      sub={q.text}
      icon={q.danger ? <AlertTriangle size={20} /> : <HelpCircle size={20} />}
      tone={q.danger ? "danger" : "accent"}
      onClose={() => answer(false)}
    >
      <div className="foot">
        <button type="button" className="btn" onClick={() => answer(false)}>Отмена</button>
        <button type="button" className={`btn ${q.danger ? "danger solid" : "primary"}`} onClick={() => answer(true)}>
          {q.confirm}
        </button>
      </div>
    </Modal>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch" aria-label={label}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
  );
}

export function Toggle(props: { title: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="toggle">
      <div>
        <div className="t">{props.title}</div>
        {props.desc && <div className="d">{props.desc}</div>}
      </div>
      <Switch checked={props.checked} onChange={props.onChange} label={props.title} />
    </div>
  );
}

// Light pastels: initials sit on them in near-black.
const PALETTE = ["#ffab85", "#8cb8ff", "#d2a8ff", "#7fe3b5", "#ffd479", "#ff9fc4", "#9be7f0", "#c6b8ff"];

export function colorFor(key: string) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2);
  return s.toUpperCase() || "?";
}

const ROLE_ICONS: Record<Role, { Icon: typeof Crown; color: string; title: string }> = {
  owner: { Icon: Crown, color: "#ffc53d", title: "Владелец" },
  admin: { Icon: ShieldCheck, color: "var(--accent)", title: "Админ" },
  member: { Icon: Headphones, color: "var(--faint)", title: "Участник" },
};

/** Role as a small icon; the name shows on hover. */
export function RoleBadge({ role, size = 15 }: { role?: Role; size?: number }) {
  if (!role) return null;
  const { Icon, color, title } = ROLE_ICONS[role];
  return (
    <span className="role-icon" title={title} aria-label={title} style={{ color }}>
      <Icon size={size} strokeWidth={2.2} />
    </span>
  );
}

type Vars = CSSProperties & Record<`--${string}`, string>;

/**
 * An image that may move. With `still` a canvas with its first frame
 * covers it, and CSS lifts the cover while its owner talks or on hover.
 */
function MaybeMoving({ src, still, onError }: { src: string; still?: boolean; onError?: () => void }) {
  const poster = useRef<HTMLCanvasElement>(null);
  return (
    <>
      <img
        src={src}
        alt=""
        draggable={false}
        onError={onError}
        onLoad={(e) => {
          // Drawn when the picture arrives, so the first frame; a still one
          // looks the same either way. Cross-origin only taints the canvas.
          const c = poster.current;
          if (!c) return;
          const k = Math.min(1, 288 / Math.max(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight));
          c.width = Math.round(e.currentTarget.naturalWidth * k);
          c.height = Math.round(e.currentTarget.naturalHeight * k);
          c.getContext("2d")?.drawImage(e.currentTarget, 0, 0, c.width, c.height);
        }}
      />
      {still && <canvas ref={poster} aria-hidden />}
    </>
  );
}

/** Art over the avatar, Discord's way: a square 1.2 times its size. */
function Decoration({ id, src, still }: { id: string | null; src?: string | null; still?: boolean }) {
  if (id === "custom") return src ? <div className="deco own"><MaybeMoving src={src} still={still} /></div> : null;
  const deco = decorationById(id);
  if (!deco) return null;
  return (
    // The markup comes from our own .deco files, parsed at start-up.
    <svg className={`deco d-${deco.id}`} viewBox="0 0 120 120" aria-hidden dangerouslySetInnerHTML={{ __html: deco.svg }} />
  );
}

/**
 * A member's picture, or their initials on a color of their own (grey when
 * `plain`), under their decoration. With `still` an animated picture and
 * the decoration hold still until the row is hovered or the class says
 * `speaking`. `decoration` is the URL of their own decoration image.
 */
export function Avatar(props: {
  id: string;
  name: string;
  src?: string | null;
  profile?: Profile;
  decoration?: string | null;
  className: string;
  plain?: boolean;
  still?: boolean;
  children?: ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [props.src]);
  const look = styleOf(props.profile);
  const style: Vars = {};
  if (!props.plain) style.background = colorFor(props.id);
  if (look.color) style["--c1"] = look.color;
  return (
    <div className={`${props.className}${props.still ? " still" : ""}`} style={style}>
      {props.src && !broken ? <MaybeMoving src={props.src} still={props.still} onError={() => setBroken(true)} /> : initials(props.name)}
      <Decoration id={look.decoration} src={props.decoration} still={props.still} />
      {props.children}
    </div>
  );
}

/**
 * A name in the member's font, colors and effect, like Discord's name
 * styles. `font` is the URL of their own font file, if they use one.
 */
export function Nick({ name, profile, font, className }: { name: string; profile?: Profile; font?: string | null; className?: string }) {
  const look = styleOf(profile);
  const css = fontCss(look.font, font);
  const style: Vars = {};
  if (look.color) style["--c1"] = look.color;
  if (look.color2) style["--c2"] = look.color2;
  if (css) {
    style.fontFamily = css.family;
    if (css.weight) style.fontWeight = css.weight;
    style["--k"] = String(css.k);
  }
  const cls = ["nick", className, look.effect && `fx-${look.effect}`, look.color && "tinted"];
  return (
    <span className={cls.filter(Boolean).join(" ")} style={style}>
      {name}
    </span>
  );
}
