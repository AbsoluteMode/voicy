import { MessageCircle, Send } from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

import { api, ChatMessage, errorText } from "../lib/tauri";
import { Modal } from "./ui";

export function ChatMessages({ host, path, memberId, label, compact = false }: {
  host: string; path: string; memberId: string; label: string; compact?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const latest = useRef(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const incoming = await api<ChatMessage[]>(host, "GET", `${path}?after=${latest.current}`);
        if (!active || incoming.length === 0) return;
        latest.current = Math.max(latest.current, incoming[incoming.length - 1].id);
        setMessages((current) => {
          const seen = new Set(current.map((message) => message.id));
          return [...current, ...incoming.filter((message) => !seen.has(message.id))].slice(-100);
        });
        setError("");
      } catch (e) {
        if (active) {
          const detail = errorText(e);
          setError(detail.includes("404") ? "Чат заработает после обновления сервера Voicy." : detail);
        }
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [host, path]);

  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const message = await api<ChatMessage>(host, "POST", path, { text });
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].slice(-100));
      setDraft("");
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="chat-body">
      <div className="chat-list" ref={list} role="log" aria-label={label}>
        {messages.length === 0 && !error && <div className="chat-empty">Пока сообщений нет. Напиши первым.</div>}
        {messages.map((message) => (
          <div className={`chat-message${message.member_id === memberId ? " mine" : ""}`} key={message.id}>
            <div className="chat-meta">
              <strong>{message.nickname}</strong>
              <time dateTime={new Date(message.created_at * 1000).toISOString()}>
                {new Date(message.created_at * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
              </time>
            </div>
            <div className="chat-text">{message.text}</div>
          </div>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <form className="chat-compose" onSubmit={(event) => void send(event)}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          maxLength={2000}
          rows={2}
          placeholder={compact ? "Написать сообщение…" : "Сообщение · Enter — отправить, Shift+Enter — новая строка"}
          aria-label="Сообщение"
        />
        <button className="btn primary" disabled={sending || !draft.trim()} title="Отправить сообщение" aria-label="Отправить сообщение">
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}

export function ChannelChat({ host, room, roomName, memberId, onClose }: {
  host: string; room: string; roomName: string; memberId: string; onClose: () => void;
}) {
  return (
    <Modal title={`Чат · ${roomName}`} icon={<MessageCircle size={20} />} onClose={onClose} wide>
      <ChatMessages host={host} path={`/api/rooms/${room}/messages`} memberId={memberId} label={`Сообщения ${roomName}`} />
    </Modal>
  );
}
