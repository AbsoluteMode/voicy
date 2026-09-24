import { FormEvent, useState } from "react";

import { getSettings, updateSettings } from "../lib/settings";
import { deployServer, errorText, SavedServer } from "../lib/tauri";
import { LogView, SshForm, useSshForm } from "./SshForm";
import { Modal } from "./ui";

type Line = { text: string; kind?: "ok" | "err" };

export function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: SavedServer) => void }) {
  const ssh = useSshForm();
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState(getSettings().nickname);
  const [phase, setPhase] = useState<"form" | "running" | "failed">("form");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");

  const push = (l: Line) => setLines((prev) => [...prev, l]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPhase("running");
    setLines([]);
    setError("");
    try {
      const server = await deployServer(
        { ssh: ssh.creds(), server_name: name.trim() || "Voicy", nickname: nickname.trim() },
        (text) => push({ text, kind: text.startsWith("VOICY_OK") ? "ok" : text.startsWith("VOICY_ERROR") ? "err" : undefined }),
      );
      updateSettings({ nickname: nickname.trim() });
      push({ text: "Готово! Ты владелец сервера.", kind: "ok" });
      onCreated(server);
    } catch (err) {
      const msg = errorText(err);
      push({ text: msg, kind: "err" });
      setError(msg);
      setPhase("failed");
    }
  }

  const running = phase === "running";
  const ready = ssh.valid && nickname.trim() !== "";

  return (
    <Modal
      title="Создать сервер"
      sub="Нужен свой VPS на Ubuntu или Debian. Voicy сам зайдёт по SSH, поставит всё нужное и сделает тебя владельцем."
      onClose={running ? undefined : onClose}
    >
      <form onSubmit={submit}>
        {phase === "form" || phase === "failed" ? (
          <>
            <SshForm form={ssh} />
            <div className="row">
              <label className="field">
                <span>Название сервера</span>
                <input type="text" maxLength={48} placeholder="Voicy" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span>Твой ник</span>
                <input type="text" maxLength={32} value={nickname} onChange={(e) => setNickname(e.target.value)} />
              </label>
            </div>
          </>
        ) : null}
        {lines.length > 0 && <LogView lines={lines} />}
        {phase === "failed" && error && (
          <div className="error">
            {error}
            <br />
            Можно поправить данные и попробовать ещё раз: установка безопасно продолжится с того же места.
          </div>
        )}
        <div className="foot">
          {!running && <button type="button" className="btn" onClick={onClose}>Отмена</button>}
          <button className="btn primary" disabled={running || !ready}>
            {running ? "Устанавливаю…" : phase === "failed" ? "Попробовать снова" : "Создать"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
