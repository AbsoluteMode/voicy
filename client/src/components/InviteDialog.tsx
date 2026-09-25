import { Check, Copy, RefreshCw, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";

import { api, errorText, Invite } from "../lib/tauri";
import { Modal } from "./ui";

/**
 * A fresh link as soon as the dialog opens: no expiry to pick, just copy.
 * Each link still admits one person.
 */
export function InviteDialog({ host, onClose }: { host: string; onClose: () => void }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const inv = await api<Invite>(host, "POST", "/api/invites", { expires_in_hours: 0 });
      setLink(inv.link ?? "");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void create();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function copy() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
  }

  return (
    <Modal
      title="Пригласить друга"
      sub="Ссылка на одного человека. Для каждого друга — своя."
      icon={<UserPlus size={20} />}
      onClose={onClose}
    >
      <button className={`btn big copy-link${copied ? " green" : " primary"}`} disabled={!link} onClick={copy}>
        {copied ? <Check size={18} /> : <Copy size={18} />}
        {!link ? "Создаю ссылку…" : copied ? "Ссылка скопирована" : "Скопировать ссылку"}
      </button>
      <p className="hint">Отправь в любой мессенджер. Друг кликнет, скачает Voicy, и приглашение подхватится само.</p>
      {error && <div className="error">{error}</div>}
      <div className="foot">
        <button className="btn" disabled={busy} onClick={create}>
          <RefreshCw size={15} /> Новая ссылка
        </button>
      </div>
    </Modal>
  );
}
