import { AlertTriangle, Crown, Headphones, HelpCircle, ShieldCheck, X } from "lucide-react";
import { ReactNode, useEffect, useState } from "react";

import { answer, usePendingAsk } from "../lib/confirm";
import { Role } from "../lib/tauri";

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

/** A member's picture, or their initials on a color of their own (grey when `plain`). */
export function Avatar(props: { id: string; name: string; src?: string | null; className: string; plain?: boolean; children?: ReactNode }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [props.src]);
  return (
    <div className={props.className} style={props.plain ? undefined : { background: colorFor(props.id) }}>
      {props.src && !broken ? <img src={props.src} alt="" draggable={false} onError={() => setBroken(true)} /> : initials(props.name)}
      {props.children}
    </div>
  );
}
