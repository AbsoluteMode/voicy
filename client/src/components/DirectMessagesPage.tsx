import { ArrowLeft, MessageCircle, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api, DirectThread, errorText, Member, SavedServer } from "../lib/tauri";
import { ChatMessages } from "./ChannelChat";

export type DirectPeer = Pick<Member, "id" | "nickname">;

export function DirectMessagesPage({ server, peer, onPeer, onReturn }: {
  server?: SavedServer;
  peer: DirectPeer | null;
  onPeer: (peer: DirectPeer | null) => void;
  onReturn: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [threads, setThreads] = useState<DirectThread[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const host = server?.host;

  useEffect(() => {
    if (!host) return;
    const serverHost = host;
    let active = true;
    async function loadMembers() {
      try {
        const result = await api<Member[]>(serverHost, "GET", "/api/members");
        if (active) setMembers(result);
      } catch (e) {
        if (active) setError(errorText(e));
      }
    }
    async function loadThreads() {
      try {
        const result = await api<DirectThread[]>(serverHost, "GET", "/api/dms");
        if (active) { setThreads(result); setError(""); }
      } catch (e) {
        if (active) {
          const detail = errorText(e);
          setError(detail.includes("404") ? "Личные сообщения появятся после обновления сервера Voicy." : detail);
        }
      }
    }
    void loadMembers();
    void loadThreads();
    const membersTimer = window.setInterval(() => void loadMembers(), 30_000);
    const threadsTimer = window.setInterval(() => void loadThreads(), 5000);
    return () => {
      active = false;
      window.clearInterval(membersTimer);
      window.clearInterval(threadsTimer);
    };
  }, [host]);

  const contacts = useMemo(() => {
    if (!server) return [];
    const byId = new Map(members.filter((member) => member.id !== server.member_id).map((member) => [member.id, member]));
    const ordered = threads.flatMap((thread) => {
      const member = byId.get(thread.peer_id);
      if (member) byId.delete(thread.peer_id);
      return member ? [{ member, thread }] : [];
    });
    return [...ordered, ...Array.from(byId.values()).map((member) => ({ member, thread: undefined }))]
      .filter(({ member }) => member.nickname.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  }, [members, threads, search, server]);

  return (
    <div className="inbox-page">
      <header className="inbox-page-head">
        <span className="inbox-page-icon"><Send size={22} /></span>
        <span className="inbox-page-title"><strong>Личные сообщения</strong><small>{server ? `Переписки на сервере «${server.name}»` : "Выбери сервер, чтобы начать переписку"}</small></span>
        {server && <button className="btn inbox-return" onClick={onReturn}><ArrowLeft size={16} /> К серверу</button>}
      </header>
      {!server ? (
        <div className="inbox-placeholder"><Send size={28} /><strong>Пока нет сервера</strong><span>Добавь сервер кнопкой «+» слева, чтобы открыть личные сообщения.</span></div>
      ) : (
        <div className="inbox-layout">
          <aside className="inbox-sidebar" aria-label="Список личных переписок">
            <label className="chat-search"><span className="sr-only">Найти участника</span><input type="text" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти участника" /></label>
            {error && <div className={error.includes("после обновления сервера") ? "chat-notice" : "error"}>{error}</div>}
            <div className="inbox-contacts">
              {contacts.map(({ member, thread }) => (
                <button key={member.id} className={`chat-contact${peer?.id === member.id ? " selected" : ""}`} onClick={() => onPeer(member)}>
                  <span className="inbox-contact-avatar">{member.nickname.slice(0, 2).toUpperCase()}</span>
                  <span><strong>{member.nickname}</strong><small>{thread ? `${thread.member_id === server.member_id ? "Ты: " : ""}${thread.text}` : "Начать переписку"}</small></span>
                </button>
              ))}
              {contacts.length === 0 && !error && <div className="inbox-no-contacts">Участники не найдены.</div>}
            </div>
          </aside>
          <section className="inbox-dialog" aria-label={peer ? `Переписка с ${peer.nickname}` : "Личные сообщения"}>
            {peer ? (
              <>
                <div className="inbox-dialog-head"><span className="inbox-dialog-avatar">{peer.nickname.slice(0, 2).toUpperCase()}</span><span><strong>{peer.nickname}</strong><small>Личная переписка</small></span></div>
                <ChatMessages key={peer.id} host={server.host} path={`/api/dms/${peer.id}`} memberId={server.member_id} label={`Личные сообщения с ${peer.nickname}`} compact />
              </>
            ) : (
              <div className="inbox-placeholder"><MessageCircle size={28} /><strong>Выбери переписку</strong><span>Нажми на участника слева, чтобы написать ему.</span></div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
