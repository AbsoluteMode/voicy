import { Search } from "lucide-react";
import { FormEvent, PointerEvent, useEffect, useRef, useState } from "react";

import { Crop, renderAvatar, syncAvatarEverywhere } from "../lib/avatar";
import { updateSettings } from "../lib/settings";
import { errorText, Pin, pinterestImage, pinterestSearch } from "../lib/tauri";
import { Modal } from "./ui";

const IDEAS = ["аниме аватарки", "котики", "aesthetic pfp", "капибара", "мемные аватарки", "y2k pfp"];

/**
 * Frames a picture in a circle and saves it as our avatar. With `file` it
 * starts at framing that file; without, it first searches Pinterest.
 */
export function AvatarDialog({ file, onClose }: { file?: File; onClose: () => void }) {
  const [source, setSource] = useState<string | null>(() => (file ? URL.createObjectURL(file) : null));
  // Object URLs hold the whole image in memory until revoked.
  useEffect(() => () => void (source && URL.revokeObjectURL(source)), [source]);

  if (source) return <CropStep src={source} back={file ? "Отмена" : "Назад"} onBack={file ? onClose : () => setSource(null)} onDone={onClose} />;
  return <PickStep onPicked={setSource} onClose={onClose} />;
}

/** Removes our avatar here and on every server. */
export function removeAvatar() {
  updateSettings({ avatar: null });
  void syncAvatarEverywhere();
}

function PickStep({ onPicked, onClose }: { onPicked: (url: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState(() => IDEAS[Math.floor(Math.random() * IDEAS.length)]);
  const [searched, setSearched] = useState("");
  const [pins, setPins] = useState<Pin[]>([]);
  const [bookmark, setBookmark] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const run = useRef(0);

  async function search(q: string, more = false) {
    q = q.trim();
    if (!q || (busy && more)) return;
    const id = ++run.current;
    setBusy(true);
    setError("");
    if (!more) {
      setQuery(q);
      setSearched(q);
      setPins([]);
    }
    try {
      const page = await pinterestSearch(q, more ? bookmark : null);
      if (id !== run.current) return;
      setPins((old) => {
        const seen = new Set(more ? old.map((p) => p.id) : []);
        return [...(more ? old : []), ...page.pins.filter((p) => !seen.has(p.id))];
      });
      setBookmark(page.bookmark);
    } catch (e) {
      if (id === run.current) setError(errorText(e));
    } finally {
      if (id === run.current) setBusy(false);
    }
  }

  useEffect(() => {
    void search(query);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(pin: Pin) {
    setOpening(pin.id);
    setError("");
    try {
      const bytes = await pinterestImage(pin.full);
      onPicked(URL.createObjectURL(new Blob([bytes])));
    } catch (e) {
      setError(errorText(e));
      setOpening(null);
    }
  }

  return (
    <Modal title="Pinterest" sub="Найди картинку для аватара и нажми на неё." onClose={onClose} wide>
      <form
        className="row pin-search"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void search(query);
        }}
      >
        <input type="text" autoFocus value={query} maxLength={100} placeholder="Что ищем? котики, аниме, мемы…" onChange={(e) => setQuery(e.target.value)} />
        <button className="btn primary" disabled={!query.trim()}>
          <Search size={16} /> Найти
        </button>
      </form>
      <div className="chips">
        {IDEAS.map((idea) => (
          <button key={idea} type="button" className={`chip${idea === searched ? " on" : ""}`} onClick={() => void search(idea)}>
            {idea}
          </button>
        ))}
      </div>
      <div
        className="pin-grid"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (bookmark && el.scrollTop + el.clientHeight > el.scrollHeight - 200) void search(searched, true);
        }}
      >
        {pins.map((p) => (
          <button key={p.id} type="button" className={`pin${opening === p.id ? " opening" : ""}`} disabled={!!opening} onClick={() => void pick(p)}>
            <img src={p.thumb} alt="" loading="lazy" draggable={false} />
          </button>
        ))}
        {!pins.length && <div className="pin-empty">{busy ? "Ищу…" : error ? "" : "Ничего не нашлось, попробуй другие слова"}</div>}
        {pins.length > 0 && busy && <div className="pin-more">Ещё…</div>}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="foot">
        <button type="button" className="btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}

/** Crop window size, px; the saved picture is what shows inside the circle. */
const VIEW = 240;
const MAX_ZOOM = 5;
// The preview circle is as big as a person in a call (34 px).
const PREVIEW_K = 34 / VIEW;

function CropStep({ src, back, onBack, onDone }: { src: string; back: string; onBack: () => void; onDone: () => void }) {
  const img = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  // Center of the visible square, in image pixels.
  const [center, setCenter] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const side = size ? Math.min(size.w, size.h) / zoom : 1;
  const scale = VIEW / side;
  const clamp = (c: { x: number; y: number }, sd = side) =>
    size
      ? {
          x: Math.min(Math.max(c.x, sd / 2), size.w - sd / 2),
          y: Math.min(Math.max(c.y, sd / 2), size.h - sd / 2),
        }
      : c;

  function setZoomKeepingCenter(z: number) {
    if (!size) return;
    z = Math.min(Math.max(z, 1), MAX_ZOOM);
    setZoom(z);
    setCenter((c) => clamp(c, Math.min(size.w, size.h) / z));
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setCenter((c) => clamp({ x: c.x - dx / scale, y: c.y - dy / scale }));
  }

  async function save() {
    if (!img.current || !size) return;
    setBusy(true);
    setError("");
    try {
      const crop: Crop = { x: center.x - side / 2, y: center.y - side / 2, size: side };
      updateSettings({ avatar: await renderAvatar(img.current, crop) });
      void syncAvatarEverywhere();
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="Кадрируем" sub="Двигай картинку и приближай колёсиком: сохранится то, что в круге." onClose={onBack}>
      <div className="crop-wrap">
        <div
          className="cropper"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) => setZoomKeepingCenter(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))}
        >
          <img
            ref={img}
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              setSize({ w, h });
              setCenter({ x: w / 2, y: h / 2 });
            }}
            onError={() => setError("Эту картинку не получается открыть")}
            style={
              size
                ? {
                    width: size.w * scale,
                    height: size.h * scale,
                    transform: `translate(${VIEW / 2 - center.x * scale}px, ${VIEW / 2 - center.y * scale}px)`,
                  }
                : { visibility: "hidden" }
            }
          />
        </div>
        <div className="crop-side">
          {/* The same picture at the size friends will see it. */}
          <div className="crop-preview">
            {size && (
              <img
                src={src}
                alt=""
                draggable={false}
                style={{
                  width: size.w * scale * PREVIEW_K,
                  height: size.h * scale * PREVIEW_K,
                  transform: `translate(${(VIEW / 2 - center.x * scale) * PREVIEW_K}px, ${(VIEW / 2 - center.y * scale) * PREVIEW_K}px)`,
                }}
              />
            )}
          </div>
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoomKeepingCenter(Number(e.target.value))}
            aria-label="Масштаб"
          />
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="foot">
        <button type="button" className="btn" onClick={onBack}>{back}</button>
        <button type="button" className="btn primary" disabled={!size || busy} onClick={() => void save()}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}
