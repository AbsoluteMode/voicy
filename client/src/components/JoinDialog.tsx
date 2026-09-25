import { Link2 } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

import { getSettings, updateSettings } from "../lib/settings";
import { errorText, inviteInfo, joinServer, osUsername, SavedServer } from "../lib/tauri";
import { Modal } from "./ui";

/**
 * With a link (from a click, deep link or the clipboard) this is a one-field
 * form: the server is named and the nickname is prefilled.
 */
export function JoinDialog(props: {
  initialLink?: string;
  initialError?: string;
  onClose: () => void;
  onJoined: (s: SavedServer) => void;
}) {
  const { initialLink, onClose, onJoined } = props;
  const [link, setLink] = useState(initialLink ?? "");
  const [nickname, setNickname] = useState(getSettings().nickname);
  const [serverName, setServerName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(props.initialError ?? "");

  useEffect(() => {
    if (!nickname) osUsername().then((u) => u && setNickname((n) => n || u)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setServerName(null);
    if (!link.trim()) return;
    let stale = false;
    const t = setTimeout(() => {
      inviteInfo(link)
        .then((info) => !stale && setServerName(info.deleted ? null : info.name))
        .catch(() => {});
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [link]);

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

  const invited = Boolean(initialLink);

  return (
    <Modal
      title={serverName ? `Тебя зовут на «${serverName}»` : "Подключиться к серверу"}
      icon={<Link2 size={20} />}
      sub={invited ? "Впиши ник, под которым тебя увидят друзья." : "Вставь ссылку-приглашение, которую тебе прислали."}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        {!invited && (
          <label className="field">
            <span>Ссылка-приглашение</span>
            <input type="text" autoFocus placeholder="https://…/join/…" value={link} onChange={(e) => setLink(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>Твой ник</span>
          <input type="text" autoFocus={invited} maxLength={32} value={nickname} onChange={(e) => setNickname(e.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="foot">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn primary big" disabled={busy || !link.trim() || !nickname.trim()}>
            {busy ? "Вхожу…" : "Войти"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
