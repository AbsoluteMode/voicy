import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { api, errorText, Invite } from "../lib/tauri";
import { Modal } from "./ui";

const LIFETIMES = [
  { hours: 1, label: "1 час" },
  { hours: 24, label: "Сутки" },
  { hours: 72, label: "3 дня" },
  { hours: 168, label: "Неделя" },
  { hours: 0, label: "Бессрочно" },
];

export function InviteDialog({ host, onClose }: { host: string; onClose: () => void }) {
  const [hours, setHours] = useState(72);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const inv = await api<Invite>(host, "POST", "/api/invites", { expires_in_hours: hours });
      setLink(inv.link ?? "");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
  }

  return (
    <Modal title="Пригласить друга" sub="Ссылка персональная: по ней может войти только один человек. Для каждого друга создай свою." onClose={onClose}>
      <div className="field">
        <span>Срок действия</span>
        <div className="seg">
          {LIFETIMES.map((l) => (
            <button key={l.hours} type="button" className={hours === l.hours ? "on" : ""} onClick={() => setHours(l.hours)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      {link && (
        <div className="field">
          <span>Ссылка</span>
          <div className="linkbox">
            <input type="text" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={copy}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? "Скопировано" : "Копировать"}
            </button>
          </div>
          <small>Отправь её в любой мессенджер. Друг кликнет, скачает Voicy, и приглашение подхватится само.</small>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="foot">
        <button className="btn" onClick={onClose}>Закрыть</button>
        <button className="btn primary" disabled={busy} onClick={create}>
          {link ? "Ещё одна ссылка" : "Создать ссылку"}
        </button>
      </div>
    </Modal>
  );
}
