import { Trash2 } from "lucide-react";
import { useState } from "react";

import { api, errorCode, errorText, SavedServer, SshCreds, uninstallServer } from "../lib/tauri";
import { HostKeyPrompt, LogView, SshForm, useSshForm } from "./SshForm";
import { Modal, Toggle } from "./ui";

type Line = { text: string; kind?: "ok" | "err" };

/**
 * Deleting wipes all members and invites through the API (works from any
 * device). Removing the containers from the VPS needs SSH and is optional.
 */
export function DeleteDialog({ server, onClose, onDeleted }: { server: SavedServer; onClose: () => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [wipeVps, setWipeVps] = useState(true);
  const ssh = useSshForm();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");

  async function run(creds: SshCreds = ssh.creds()) {
    setBusy(true);
    setError("");
    setLines([]);
    try {
      try {
        await api(server.host, "DELETE", "/api/server");
        setLines((l) => [...l, { text: "Сервер удалён, все участники отключены.", kind: "ok" }]);
      } catch (e) {
        // Already deleted: carry on with the VPS cleanup.
        if (errorCode(e) !== "gone") throw e;
      }
      if (wipeVps) {
        await uninstallServer(creds, (text) => setLines((l) => [...l, { text }]));
        setLines((l) => [...l, { text: "VPS очищен.", kind: "ok" }]);
      }
      onDeleted();
    } catch (e) {
      if (!ssh.catchHostKey(e)) setError(errorText(e));
      setBusy(false);
    }
  }

  const ready = confirm.trim() === server.name && (!wipeVps || ssh.valid);

  return (
    <Modal
      title={`Удалить «${server.name}»`}
      icon={<Trash2 size={20} />}
      tone="danger"
      sub="Все участники и приглашения будут удалены. Это не отменить."
      onClose={busy ? undefined : onClose}
    >
      <label className="field">
        <span>Введи название сервера, чтобы подтвердить</span>
        <input type="text" autoFocus value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={server.name} />
      </label>
      <div className="card">
        <Toggle
          title="Удалить и с VPS"
          desc="Остановить контейнеры и стереть файлы на сервере. Нужен SSH-доступ."
          checked={wipeVps}
          onChange={setWipeVps}
        />
      </div>
      {wipeVps && <SshForm form={ssh} disabled={busy} />}
      <HostKeyPrompt form={ssh} onApprove={() => void run(ssh.approveHostKey())} />
      {lines.length > 0 && <LogView lines={lines} />}
      {error && <div className="error">{error}</div>}
      <div className="foot">
        {!busy && <button className="btn" onClick={onClose}>Отмена</button>}
        <button className="btn danger solid" disabled={busy || !ready} onClick={() => void run()}>
          {busy ? "Удаляю…" : "Удалить навсегда"}
        </button>
      </div>
    </Modal>
  );
}
