import { FormEvent, useState } from "react";

import { getSettings, updateSettings } from "../lib/settings";
import { errorText, joinServer, SavedServer } from "../lib/tauri";
import { Modal } from "./ui";

export function JoinDialog({ initialLink, onClose, onJoined }: { initialLink?: string; onClose: () => void; onJoined: (s: SavedServer) => void }) {
  const [link, setLink] = useState(initialLink ?? "");
  const [nickname, setNickname] = useState(getSettings().nickname);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const server = await joinServer(link, nickname);
      updateSettings({ nickname: nickname.trim() });
      onJoined(server);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Подключиться к серверу" sub="Вставь ссылку-приглашение, которую тебе прислали. Она одноразовая и работает только для тебя." onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Ссылка-приглашение</span>
          <input type="text" autoFocus placeholder="voicy://join/…" value={link} onChange={(e) => setLink(e.target.value)} />
        </label>
        <label className="field">
          <span>Твой ник</span>
          <input type="text" maxLength={32} value={nickname} onChange={(e) => setNickname(e.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="foot">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary" disabled={busy || !link.trim() || !nickname.trim()}>
            {busy ? "Подключаюсь…" : "Подключиться"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
