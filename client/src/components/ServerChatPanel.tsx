import { ArrowLeft, MessageCircle, MessagesSquare, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api, DirectThread, errorText, Member } from "../lib/tauri";
import { ChatMessages } from "./ChannelChat";

export type DirectPeer = Pick<Member, "id" | "nickname">;

export function ServerChatPanel({ host, memberId, members, peer, onPeer, onClose }: {
  host: string;
  memberId: string;
  members: Member[];
  peer: DirectPeer | null;
  onPeer: (peer: DirectPeer | null) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"general" | "direct">(peer ? "direct" : "general");
  const [threads, setThreads] = useState<DirectThread[]>([]);
  const [threadError, setThreadError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => { if (peer) setTab("direct"); }, [peer]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = await api<DirectThread[]>(host, "GET", "/api/dms");
        if (active) { setThreads(result); setThreadError(""); }
      } catch (e) {
        if (active) {
          const detail = errorText(e);
          setThreadError(detail.includes("404") ? "Личные сообщения появятся после обновления сервера Voicy." : detail);
        }
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [host]);

  const contacts = useMemo(() => {
    const byId = new Map(members.filter((m) => m.id !== memberId).map((m) => [m.id, m]));
    const ordered = threads.flatMap((t) => {
      const member = byId.get(t.peer_id);
      if (member) byId.delete(t.peer_id);
      return member ? [{ member, thread: t }] : [];
    });
    return [...ordered, ...Array.from(byId.values()).map((member) => ({ member, thread: undefined }))]
      .filter(({ member }) => member.nickname.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  }, [members, memberId, threads, search]);

  return (
    <aside className="server-chat" aria-label="Чат сервера">
      <div className="server-chat-head">
        <MessageCircle size={18} />
        <strong>{peer && tab === "direct" ? peer.nickname : "Чат сервера"}</strong>
        <button className="icon-btn sm" onClick={onClose} title="Закрыть чат" aria-label="Закрыть чат"><X size={17} /></button>
      </div>
      <div className="chat-tabs" role="tablist" aria-label="Разделы чата">
        <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")} role="tab" aria-selected={tab === "general"}>Общий</button>
        <button className={tab === "direct" ? "active" : ""} onClick={() => setTab("direct")} role="tab" aria-selected={tab === "direct"}>Личные</button>
      </div>
      {tab === "general" ? (
        <ChatMessages key="general" host={host} path="/api/messages" memberId={memberId} label="Сообщения общего чата" compact />
      ) : peer ? (
        <>
          <button className="chat-back" onClick={() => onPeer(null)}><ArrowLeft size={16} /> Все переписки</button>
          <ChatMessages key={peer.id} host={host} path={`/api/dms/${peer.id}`} memberId={memberId} label={`Личные сообщения с ${peer.nickname}`} compact />
        </>
      ) : (
        <div className="chat-contacts">
          <label className="chat-search"><span className="sr-only">Найти участника</span><input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Найти участника" /></label>
          {threadError && <div className="error">{threadError}</div>}
          {contacts.map(({ member, thread }) => (
            <button key={member.id} className="chat-contact" onClick={() => onPeer(member)}>
              <MessagesSquare size={17} />
              <span><strong>{member.nickname}</strong><small>{thread ? `${thread.member_id === memberId ? "Ты: " : ""}${thread.text}` : "Начать переписку"}</small></span>
            </button>
          ))}
          {contacts.length === 0 && !threadError && <div className="chat-empty">Участники не найдены.</div>}
        </div>
      )}
    </aside>
  );
}
