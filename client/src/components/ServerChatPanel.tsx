import { MessageCircle, X } from "lucide-react";

import { ChatMessages } from "./ChannelChat";

export function ServerChatPanel({ host, memberId, onClose }: {
  host: string;
  memberId: string;
  onClose: () => void;
}) {
  return (
    <aside className="server-chat" aria-label="Общий чат сервера">
      <div className="server-chat-head">
        <span className="chat-mark"><MessageCircle size={18} /></span>
        <span className="chat-heading"><strong>Общий чат</strong><small>Для всех участников сервера</small></span>
        <button className="icon-btn sm" onClick={onClose} title="Закрыть чат" aria-label="Закрыть чат"><X size={17} /></button>
      </div>
      <ChatMessages host={host} path="/api/messages" memberId={memberId} label="Сообщения общего чата" compact />
    </aside>
  );
}
