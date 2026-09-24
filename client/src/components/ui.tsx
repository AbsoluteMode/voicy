import { Crown, Headphones, ShieldCheck } from "lucide-react";
import { ReactNode, useEffect, useState } from "react";

import { Role } from "../lib/tauri";

export function Modal({ title, sub, onClose, wide, children }: { title: string; sub?: ReactNode; onClose?: () => void; wide?: boolean; children: ReactNode }) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {sub && <p className="sub">{sub}</p>}
        {children}
      </div>
    </div>
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
