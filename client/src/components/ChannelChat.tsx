import { MessageCircle, Paperclip, Send, X } from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

import { api, ChatMessage, errorText } from "../lib/tauri";
import { ChatAttachment } from "./ChatAttachment";
import { Modal } from "./ui";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function ChatMessages({ host, path, memberId, label, compact = false }: {
  host: string; path: string; memberId: string; label: string; compact?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const latest = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    latest.current = 0;
    setMessages([]);
    setFile(null);
    setError("");
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
    if ((!text && !file) || sending) return;
    setSending(true);
    try {
      if (file) {
        try {
          await api<{ max_bytes: number }>(host, "GET", "/api/attachments/support");
        } catch {
          throw new Error("Для отправки файлов обнови сервер Voicy.");
        }
      }
      const attachment = file ? { name: file.name, data: await fileBase64(file) } : undefined;
      const message = await api<ChatMessage>(host, "POST", path, { text, attachment });
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].slice(-100));
      setDraft("");
      setFile(null);
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  function chooseFile(selected: File | undefined) {
    if (!selected) return;
    if (selected.size === 0 || selected.size > MAX_FILE_BYTES) {
      setFile(null);
      setError("Файл должен быть размером от 1 байта до 10 МБ.");
      return;
    }
    setFile(selected);
    setError("");
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
        {messages.length === 0 && !error && <div className="chat-empty"><span className="chat-empty-icon"><MessageCircle size={24} /></span><strong>Пока здесь тихо</strong><span>Напиши первым.</span></div>}
        {messages.map((message) => (
          <div className={`chat-message${message.member_id === memberId ? " mine" : ""}${message.attachment ? " has-attachment" : ""}`} key={`${host}:${path}:${message.id}`}>
            <div className="chat-meta">
              <strong>{message.nickname}</strong>
              <time dateTime={new Date(message.created_at * 1000).toISOString()}>
                {new Date(message.created_at * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
              </time>
            </div>
            {message.text && <div className="chat-text">{message.text}</div>}
            {message.attachment && <ChatAttachment host={host} attachment={message.attachment} />}
          </div>
        ))}
      </div>
      {error && <div className={error.includes("после обновления сервера") ? "chat-notice" : "error"}>{error}</div>}
      {file && <div className="chat-selected-file"><Paperclip size={14} /><span>{file.name}</span><small>{file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} МБ` : `${Math.max(1, Math.round(file.size / 1024))} КБ`}</small><button type="button" onClick={() => setFile(null)} title="Убрать файл" aria-label="Убрать файл"><X size={15} /></button></div>}
      <form className="chat-compose" onSubmit={(event) => void send(event)}>
        <input ref={fileInput} type="file" hidden onChange={(event) => { chooseFile(event.target.files?.[0]); event.target.value = ""; }} />
        <button className="chat-attach" type="button" onClick={() => fileInput.current?.click()} disabled={sending} title="Прикрепить изображение или файл (до 10 МБ)" aria-label="Прикрепить файл"><Paperclip size={19} /></button>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          maxLength={2000}
          rows={2}
          placeholder={compact ? "Сообщение или файл…" : "Сообщение или файл · Enter — отправить, Shift+Enter — новая строка"}
          aria-label="Сообщение"
        />
        <button className="btn primary" disabled={sending || (!draft.trim() && !file)} title="Отправить сообщение" aria-label="Отправить сообщение">
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
