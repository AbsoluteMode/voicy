import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CreateDialog } from "./components/CreateDialog";
import { JoinDialog } from "./components/JoinDialog";
import { ServerView } from "./components/ServerView";
import { Modal } from "./components/ui";
import { colorFor, initials } from "./components/ui";
import { listServers, SavedServer } from "./lib/tauri";
import { useVoice } from "./lib/voice";

type Dialog = { kind: "choose" } | { kind: "join"; link?: string } | { kind: "create" } | null;

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

  // voicy://join/... links, whether they launched the app or arrived later.
  useEffect(() => {
    const open = (urls: string[] | null) => {
      const link = urls?.find((u) => u.startsWith("voicy://join/"));
      if (link) setDialog({ kind: "join", link });
    };
    getCurrent().then(open).catch(() => {});
    const unlisten = onOpenUrl(open);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const added = (s: SavedServer) => {
    setDialog(null);
    void reload().then(() => setSelected(s.host));
  };

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
      </nav>

      <main className="main">
        {current ? (
          <ServerView key={current.host} server={current} onChanged={reload} onRemoved={reload} />
        ) : (
          <div className="welcome">
            <div>
              <h1>Voicy</h1>
              <p>Голосовой чат для своих. Подними сервер на своём VPS или зайди к друзьям по ссылке.</p>
              <div className="actions">
                <button className="btn primary big" onClick={() => setDialog({ kind: "create" })}>Создать сервер</button>
                <button className="btn big" onClick={() => setDialog({ kind: "join" })}>Подключиться</button>
              </div>
            </div>
          </div>
        )}
      </main>

      {dialog?.kind === "choose" && (
        <Modal title="Добавить сервер" onClose={() => setDialog(null)}>
          <div className="row">
            <button className="btn primary big" onClick={() => setDialog({ kind: "create" })}>Создать свой</button>
            <button className="btn big" onClick={() => setDialog({ kind: "join" })}>По ссылке</button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "join" && <JoinDialog initialLink={dialog.link} onClose={() => setDialog(null)} onJoined={added} />}
      {dialog?.kind === "create" && <CreateDialog onClose={() => setDialog(null)} onCreated={added} />}
    </div>
  );
}
