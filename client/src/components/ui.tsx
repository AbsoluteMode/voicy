import { Crown, Headphones, ShieldCheck } from "lucide-react";
import { ReactNode, useEffect } from "react";

import { Role } from "../lib/tauri";

export function Modal({ title, sub, onClose, children }: { title: string; sub?: ReactNode; onClose?: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-label={title}>
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

const PALETTE = ["#7c6cff", "#2fb6ff", "#ff6b9d", "#ff9f43", "#20c997", "#e056fd", "#4dabf7", "#f06595"];

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
  admin: { Icon: ShieldCheck, color: "var(--accent-2)", title: "Админ" },
  member: { Icon: Headphones, color: "#3fd0c9", title: "Участник" },
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
