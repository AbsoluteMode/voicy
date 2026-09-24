import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { Download, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { CreateDialog } from "./components/CreateDialog";
import { JoinDialog } from "./components/JoinDialog";
import { ServerView } from "./components/ServerView";
import { Modal } from "./components/ui";
import { colorFor, initials } from "./components/ui";
import { getSettings } from "./lib/settings";
import { api, errorText, inviteFromClipboard, joinServer, listServers, RoomInfo, SavedServer } from "./lib/tauri";
import { confirmAndInstall, useUpdater } from "./lib/updater";
import { useVoice, voice } from "./lib/voice";

type Dialog = { kind: "choose" } | { kind: "join"; link?: string; error?: string } | { kind: "create" } | null;

/** First screen. Almost everyone arrives with an invite, so that comes first. */
function Welcome({ onInvite, onCreate }: { onInvite: (link: string) => void; onCreate: () => void }) {
  const [link, setLink] = useState("");
  return (
    <div className="welcome">
      <div style={{ width: "min(460px, 100%)" }}>
        <h1>Voicy</h1>
        <p style={{ margin: "0 auto 24px" }}>Голосовой чат для своих. Друг прислал ссылку? Вставь её сюда.</p>
        <form
          className="linkbox"
          onSubmit={(e) => {
            e.preventDefault();
            if (link.trim()) onInvite(link.trim());
          }}
        >
          <input type="text" autoFocus placeholder="https://…/join/…" value={link} onChange={(e) => setLink(e.target.value)} />
          <button className="btn primary" disabled={!link.trim()}>Войти</button>
        </form>
        <p style={{ marginTop: 28, fontSize: 13 }}>
          Хочешь свой сервер?{" "}
          <button className="linklike" onClick={onCreate}>Создать на своём VPS</button>
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const v = useVoice();

  const reload = useCallback(async () => {
    const list = await listServers().catch(() => []);
    setServers(list);
    setSelected((cur) => (cur && list.some((s) => s.host === cur) ? cur : (list[0]?.host ?? null)));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The mic goes live only from an explicit "Войти" click, never from a
  // link or the clipboard alone, and never replaces a call in progress.
  const added = useCallback(
    (s: SavedServer, connect: boolean) => {
      setDialog(null);
      void reload().then(() => {
        setSelected(s.host);
        if (!connect || voice.getSnapshot().state !== "idle") return;
        // A friend who just joined wants to be where people already are.
        void api<RoomInfo[]>(s.host, "GET", "/api/rooms")
          .then((rooms) => {
            const target = rooms.find((r) => r.participants.length > 0) ?? rooms[0];
            if (target) return voice.connect(s.host, target.id);
          })
          .catch(() => {});
      });
    },
    [reload],
  );

  // A clicked voicy:// link joins the server without questions when the
  // nickname is known; the voice channel still waits for a click.
  const handleInvite = useCallback(
    async (link: string) => {
      const nickname = getSettings().nickname;
      if (!nickname) return setDialog({ kind: "join", link });
      try {
        added(await joinServer(link, nickname), false);
      } catch (e) {
        setDialog({ kind: "join", link, error: errorText(e) });
      }
    },
    [added],
  );

  // voicy://join/... links, whether they launched the app or arrived later.
  useEffect(() => {
    const open = (urls: string[] | null) => {
      const link = urls?.find((u) => u.startsWith("voicy://join/"));
      if (link) void handleInvite(link);
    };
    getCurrent().then(open).catch(() => {});
    const unlisten = onOpenUrl(open);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [handleInvite]);

  // An invite copied to the clipboard (the invite page does this on
  // download) opens the join form on start and on focus. It only asks: the
  // user may just be forwarding the link to someone else.
  const dismissed = useRef(new Set<string>());
  useEffect(() => {
    const check = () =>
      inviteFromClipboard()
        .then((link) => {
          if (!link || dismissed.current.has(link)) return;
          dismissed.current.add(link);
          setDialog((d) => d ?? { kind: "join", link });
        })
        .catch(() => {});
    void check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  const update = useUpdater();
  const startUpdate = () => confirmAndInstall(v.state !== "idle");

  const current = servers.find((s) => s.host === selected);

  return (
    <div className="app">
      <nav className="rail">
        {servers.map((s) => (
          <button
            key={s.host}
            className={`rail-btn${s.host === selected ? " active" : ""}`}
            style={s.host === selected ? undefined : { background: colorFor(s.host) + "33" }}
            title={s.name}
            onClick={() => setSelected(s.host)}
          >
            {initials(s.name)}
            {v.host === s.host && v.state !== "idle" && <span className="live" />}
          </button>
        ))}
        {servers.length > 0 && <div className="rail-sep" />}
        <button className="rail-btn add" title="Добавить сервер" onClick={() => setDialog({ kind: "choose" })}>
          <Plus size={22} />
        </button>
        <div className="rail-spacer" />
        {update.kind === "available" && (
          <button
            className={`rail-btn update${update.error ? " failed" : ""}`}
            title={update.error ? `Не удалось обновиться: ${update.error}. Нажми, чтобы повторить.` : `Обновить Voicy до ${update.version}`}
            onClick={startUpdate}
          >
            <Download size={22} />
          </button>
        )}
        {update.kind === "installing" && (
          <div className="rail-btn update busy" title="Обновляю…">
            {update.percent === null ? "…" : `${update.percent}%`}
          </div>
        )}
      </nav>

      <main className="main">
        {current ? (
          <ServerView key={current.host} server={current} onChanged={reload} onRemoved={reload} />
        ) : (
          <Welcome onInvite={(link) => setDialog({ kind: "join", link })} onCreate={() => setDialog({ kind: "create" })} />
        )}
      </main>

      {dialog?.kind === "choose" && (
        <Modal title="Добавить сервер" onClose={() => setDialog(null)}>
          <div className="row">
            <button className="btn primary big" onClick={() => setDialog({ kind: "join" })}>По ссылке</button>
            <button className="btn big" onClick={() => setDialog({ kind: "create" })}>Создать свой</button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "join" && (
        <JoinDialog
          key={dialog.link ?? ""}
          initialLink={dialog.link}
          initialError={dialog.error}
          onClose={() => setDialog(null)}
          onJoined={(s) => added(s, true)}
        />
      )}
      {dialog?.kind === "create" && <CreateDialog onClose={() => setDialog(null)} onCreated={(s) => added(s, false)} />}
    </div>
  );
}
