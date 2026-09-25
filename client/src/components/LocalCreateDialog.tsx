import { FormEvent, useState } from "react";

import { getSettings, updateSettings } from "../lib/settings";
import { createLocalServer, errorText, SavedServer } from "../lib/tauri";
import { Modal } from "./ui";

export function LocalCreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (server: SavedServer) => void }) {
  const [name, setName] = useState("Мой локальный сервер");
  const [nickname, setNickname] = useState(getSettings().nickname);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setLines([]);
    try {
      const server = await createLocalServer(name.trim(), nickname.trim(), (line) => setLines((current) => [...current, line]));
      updateSettings({ nickname: nickname.trim() });
      onCreated(server);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Создать сервер на этом компьютере" sub="Нужен запущенный Docker Desktop. Сервер будет доступен только на этом ПК." onClose={busy ? undefined : onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="row">
          <label className="field">
            <span>Название сервера</span>
            <input value={name} maxLength={48} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span>Твой ник</span>
            <input value={nickname} maxLength={32} onChange={(e) => setNickname(e.target.value)} disabled={busy} />
          </label>
        </div>
        {lines.length > 0 && <div className="log selectable">{lines.map((line, index) => <div key={index}>{line}</div>)}</div>}
        {error && <div className="error">{error}</div>}
        <div className="foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn primary" disabled={busy || !name.trim() || !nickname.trim()}>
            {busy ? "Запускаю…" : "Создать и открыть"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
