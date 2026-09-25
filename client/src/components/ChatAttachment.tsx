import { Download, File as FileIcon, Image as ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, ChatAttachment as AttachmentMeta, errorText } from "../lib/tauri";

type FileData = { name: string; mime: string; data: string };

function bytesFromBase64(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sizeLabel(size: number) {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} МБ` : `${Math.max(1, Math.round(size / 1024))} КБ`;
}

function saveFile(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}

export function ChatAttachment({ host, attachment }: { host: string; attachment: AttachmentMeta }) {
  const isImage = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mime);
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isImage || !box.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "300px" });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [isImage]);

  useEffect(() => {
    if (!isImage || !visible) return;
    let active = true;
    let objectUrl: string | null = null;
    void api<FileData>(host, "GET", `/api/attachments/${encodeURIComponent(attachment.id)}`).then((file) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(new Blob([bytesFromBase64(file.data)], { type: file.mime }));
      setUrl(objectUrl);
    }).catch((reason) => { if (active) setError(errorText(reason)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [host, attachment.id, isImage, visible]);

  async function download() {
    if (busy) return;
    if (url) { saveFile(url, attachment.name); return; }
    setBusy(true);
    setError("");
    try {
      const file = await api<FileData>(host, "GET", `/api/attachments/${encodeURIComponent(attachment.id)}`);
      const objectUrl = URL.createObjectURL(new Blob([bytesFromBase64(file.data)], { type: file.mime }));
      saveFile(objectUrl, attachment.name);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="message-attachment" ref={box}>
      {isImage && (url ? (
        <button className="attachment-image" type="button" onClick={() => void download()} title={`Скачать ${attachment.name}`}>
          <img src={url} alt={attachment.name} loading="lazy" />
        </button>
      ) : <div className="attachment-image-loading"><ImageIcon size={22} />{error ? "Не удалось открыть изображение" : "Загружаю изображение…"}</div>)}
      <button className="attachment-file" type="button" onClick={() => void download()} disabled={busy} title={`Скачать ${attachment.name}`}>
        <span className="attachment-file-icon">{isImage ? <ImageIcon size={19} /> : <FileIcon size={19} />}</span>
        <span className="attachment-file-label"><strong>{attachment.name}</strong><small>{sizeLabel(attachment.size)}</small></span>
        <Download size={17} />
      </button>
      {error && <small className="attachment-error">{error}</small>}
    </div>
  );
}
