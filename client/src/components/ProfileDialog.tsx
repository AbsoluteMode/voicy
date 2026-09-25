import { Check, Plus, Sparkles, Upload } from "lucide-react";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";

import { LocalAvatar, localAvatar, renderDecoration, syncPictureEverywhere } from "../lib/avatar";
import { DECORATIONS } from "../lib/decorations";
import { FONT_GROUPS, GOOGLE_PREFIX, googleFamily, googleFontExists, readFontFile, SHIPPED_FONTS } from "../lib/fonts";
import { cleanProfile, COLORS, EFFECTS, STATUS_IDEAS, STATUS_MAX, statusUntil, syncProfileEverywhere } from "../lib/profile";
import { updateSettings } from "../lib/settings";
import { errorText, Profile } from "../lib/tauri";
import { MicIcon, MicOffIcon } from "./icons";
import { Avatar, Modal, Nick } from "./ui";

type Tab = "nick" | "decoration" | "status";

/** How long a status stays, in minutes; "keep" is the end time it already had. */
const EXPIRY = [
  { value: "0", label: "Никогда" },
  { value: "30", label: "30 мин" },
  { value: "60", label: "Час" },
  { value: "240", label: "4 часа" },
  { value: "day", label: "Сегодня" },
];

const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

/** Voicy's segmented control (`.seg`). */
function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section">
      <h3>{title}</h3>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </section>
  );
}

function Swatches({ value, onChange, none }: { value: string | null; onChange: (c: string | null) => void; none?: boolean }) {
  const own = value && !COLORS.includes(value);
  return (
    <div className="swatches">
      {none && <button type="button" className={`swatch none${value === null ? " on" : ""}`} title="Без цвета" aria-label="Без цвета" onClick={() => onChange(null)} />}
      {COLORS.map((c) => (
        <button key={c} type="button" className={`swatch${value === c ? " on" : ""}`} style={{ background: c }} aria-label={c} onClick={() => onChange(c)} />
      ))}
      <label className={`swatch custom${own ? " on" : ""}`} title="Свой цвет" style={own ? { background: value } : undefined}>
        <input type="color" value={value ?? "#ffffff"} onChange={(e) => onChange(e.target.value)} aria-label="Свой цвет" />
      </label>
    </div>
  );
}

/** Pretends to talk while `on`, so the preview shows what the voice does. */
function useFakeVoice<T extends HTMLElement>(on: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return el?.style.setProperty("--level", "0");
    const t0 = performance.now();
    const tick = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      // Syllables on top of phrases, with pauses between them.
      const level = Math.sin(t * 9) * 0.3 + Math.sin(t * 2.3) * 0.35 + Math.sin(t * 0.8) * 0.45;
      el.style.setProperty("--level", Math.max(0, Math.min(1, level)).toFixed(2));
    }, 50);
    return () => clearInterval(tick);
  }, [on]);
  return ref;
}

/** Our name style, decoration and status, shown as friends see them; saved here and on every server. */
export function ProfileDialog(props: {
  id: string;
  name: string;
  avatar: string | null;
  /** URLs of our own decoration image and name font, if there are any. */
  decoration: string | null;
  font: string | null;
  profile?: Profile;
  onClose: () => void;
}) {
  const initial = cleanProfile(props.profile ?? {});
  const [tab, setTab] = useState<Tab>("nick");
  const [font, setFont] = useState(initial.font ?? null);
  const [effect, setEffect] = useState(initial.effect ?? null);
  const [color, setColor] = useState(initial.color ?? null);
  const [color2, setColor2] = useState(initial.color2 ?? null);
  const [decoration, setDecoration] = useState(initial.decoration ?? null);
  const [status, setStatus] = useState(initial.status ?? "");
  const [expiry, setExpiry] = useState(initial.status_until ? "keep" : "0");
  // Own files picked here; undefined while unchanged.
  const [ownDeco, setOwnDeco] = useState<LocalAvatar | undefined>();
  const [ownFont, setOwnFont] = useState<LocalAvatar | undefined>();
  const [google, setGoogle] = useState(googleFamily(initial.font) ?? "");
  const [busy, setBusy] = useState<"" | "deco" | "font" | "google">("");
  const [error, setError] = useState("");
  const [talking, setTalking] = useState(true);
  const preview = useFakeVoice<HTMLDivElement>(talking);
  const decoFile = useRef<HTMLInputElement>(null);
  const fontFile = useRef<HTMLInputElement>(null);

  const decoUrl = ownDeco?.url ?? props.decoration;
  const fontUrl = ownFont?.url ?? props.font;
  const two = EFFECTS.find((e) => e.id === effect)?.two;
  const draft: Profile = { font, effect, color, color2: two ? color2 : null, decoration, status: status.trim() || null };

  async function run(what: typeof busy, job: () => Promise<void>) {
    setBusy(what);
    setError("");
    try {
      await job();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }

  const pickDeco = (f: File) =>
    run("deco", async () => {
      setOwnDeco(await renderDecoration(f));
      setDecoration("custom");
    });

  const pickFont = (f: File) =>
    run("font", async () => {
      setOwnFont(await localAvatar(await readFontFile(f)));
      setFont("custom");
    });

  const useGoogle = (e: FormEvent) => {
    e.preventDefault();
    const family = google.trim().replace(/\s+/g, " ");
    if (!family) return;
    void run("google", async () => {
      if (!/^[A-Za-z0-9 ]{1,40}$/.test(family)) throw new Error("в названии только латиница, цифры и пробелы, как на fonts.google.com");
      if (!(await googleFontExists(family))) throw new Error(`в Google Fonts нет «${family}»`);
      setFont(GOOGLE_PREFIX + family);
    });
  };

  function save() {
    if (ownDeco) {
      updateSettings({ decorationFile: ownDeco });
      void syncPictureEverywhere("decoration");
    }
    if (ownFont) {
      updateSettings({ fontFile: ownFont });
      void syncPictureEverywhere("font");
    }
    const until = expiry === "keep" ? initial.status_until : statusUntil(expiry === "day" ? "day" : Number(expiry));
    updateSettings({ profile: cleanProfile({ ...draft, status_until: until }) });
    void syncProfileEverywhere();
    props.onClose();
  }

  const avatar = (p: Profile, className: string, still = false) => (
    <Avatar className={className} id={props.id} name={props.name} src={props.avatar} profile={p} decoration={decoUrl} still={still} />
  );

  const fontRow = (id: string | null, label: string) => (
    <button key={id ?? "ui"} type="button" className={`card-row font-row${font === id ? " on" : ""}`} onClick={() => setFont(id)}>
      <span className="font-sample">
        <Nick name={props.name} profile={{ ...draft, font: id }} font={fontUrl} />
      </span>
      <span className="font-name">{label}</span>
      {font === id && <Check size={16} className="font-check" />}
    </button>
  );

  return (
    <Modal title="Профиль" icon={<Sparkles size={20} />} sub="Так тебя видят друзья на всех твоих серверах." onClose={props.onClose}>
      <div className="pv" ref={preview}>
        <div className="pv-big">
          {avatar(draft, `av xl${talking ? " speaking" : ""}`)}
          <div className="pv-who">
            <Nick className="pv-name" name={props.name} profile={draft} font={fontUrl} />
            <div className="pv-status">{draft.status ?? "без статуса"}</div>
          </div>
          <button
            type="button"
            className={`icon-btn pv-mic${talking ? " on" : ""}`}
            onClick={() => setTalking(!talking)}
            title={talking ? "Остановить: так ты молчишь" : "Показать, как ты говоришь"}
            aria-label={talking ? "Молчать" : "Говорить"}
          >
            {talking ? <MicIcon size={16} /> : <MicOffIcon size={16} />}
          </button>
        </div>
        <div className="prow pv-row">
          {avatar(draft, `av${talking ? " speaking" : ""}`)}
          <div className="who">
            <div className="name">
              <Nick className="txt" name={props.name} profile={draft} font={fontUrl} />
              <span className="me">ты</span>
            </div>
            {draft.status && <div className="status">{draft.status}</div>}
          </div>
        </div>
      </div>

      <Seg<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "nick", label: "Ник" },
          { value: "decoration", label: "Декорация" },
          { value: "status", label: "Статус" },
        ]}
      />

      {tab === "nick" && (
        <>
          <Section title="Шрифт">
            <div className="card font-list">
              {fontRow(null, "Segoe UI")}
              {FONT_GROUPS.map((g) => (
                <div key={g.id} className="font-group">
                  <div className="font-group-label">{g.name}</div>
                  {SHIPPED_FONTS.filter((f) => f.group === g.id).map((f) => fontRow(f.id, f.family))}
                </div>
              ))}
            </div>
            <div className="card font-more">
              <form className="card-row" onSubmit={useGoogle}>
                <input type="text" placeholder="Любой из Google Fonts: Rubik Maze" value={google} maxLength={40} onChange={(e) => setGoogle(e.target.value)} />
                <button className={`btn${googleFamily(font) ? " green" : ""}`} disabled={!google.trim() || busy === "google"}>
                  {googleFamily(font) && googleFamily(font) === google.trim() && <Check size={15} />}
                  {busy === "google" ? "Ищу…" : "Взять"}
                </button>
              </form>
              <div className="card-row">
                <span className="row-label">Свой файл</span>
                <span className="font-file">{fontUrl ? (font === "custom" ? "выбран" : "загружен") : "TTF, OTF, WOFF2 до 512 КБ"}</span>
                {fontUrl && font !== "custom" && (
                  <button type="button" className="btn" onClick={() => setFont("custom")}>Выбрать</button>
                )}
                <button type="button" className="btn" disabled={busy === "font"} onClick={() => fontFile.current?.click()}>
                  <Upload size={15} /> {busy === "font" ? "Читаю…" : "Загрузить"}
                </button>
              </div>
            </div>
            <input
              ref={fontFile}
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void pickFont(f);
              }}
            />
          </Section>
          <Section title="Эффект">
            <Seg value={effect ?? ""} onChange={(v) => setEffect(v || null)} options={EFFECTS.map((e) => ({ value: e.id ?? "", label: e.name }))} />
          </Section>
          <Section title={two ? "Цвета" : "Цвет"}>
            <Swatches value={color} onChange={setColor} none />
            {two && <Swatches value={color2} onChange={setColor2} />}
          </Section>
        </>
      )}

      {tab === "decoration" && (
        <Section title="Декорация" hint="Своя — квадратная PNG, APNG, GIF или WebP до 1 МБ; аватарка занимает середину, как в Discord.">
          <div className="deco-grid">
            <button type="button" className={`deco-tile${decoration === null ? " on" : ""}`} onClick={() => setDecoration(null)}>
              {avatar({ ...draft, decoration: null }, "av lg", true)}
              <small>Нет</small>
            </button>
            {DECORATIONS.map((d) => (
              <button key={d.id} type="button" className={`deco-tile${decoration === d.id ? " on" : ""}`} onClick={() => setDecoration(d.id)}>
                {avatar({ ...draft, decoration: d.id }, "av lg", true)}
                <small>{d.name}</small>
              </button>
            ))}
            <button
              type="button"
              className={`deco-tile${decoration === "custom" ? " on" : ""}`}
              disabled={busy === "deco"}
              onClick={() => (decoUrl && decoration !== "custom" ? setDecoration("custom") : decoFile.current?.click())}
            >
              {decoUrl ? avatar({ ...draft, decoration: "custom" }, "av lg", true) : <span className="tile-add"><Plus size={18} /></span>}
              <small>{busy === "deco" ? "Читаю…" : decoUrl && decoration === "custom" ? "Заменить" : "Своя"}</small>
            </button>
          </div>
          <input
            ref={decoFile}
            type="file"
            accept="image/png,image/apng,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void pickDeco(f);
            }}
          />
        </Section>
      )}

      {tab === "status" && (
        <>
          <label className="field status-field">
            <span>Статус</span>
            <input type="text" autoFocus value={status} maxLength={STATUS_MAX} placeholder="Чем занят?" onChange={(e) => setStatus(e.target.value)} />
          </label>
          <div className="chips">
            {STATUS_IDEAS.map((idea) => (
              <button key={idea} type="button" className={`chip${status === idea ? " on" : ""}`} onClick={() => setStatus(idea)}>
                {idea}
              </button>
            ))}
            {status && (
              <button type="button" className="chip" onClick={() => setStatus("")}>Убрать</button>
            )}
          </div>
          {status.trim() && (
            <Section title="Сбросить">
              <Seg
                value={expiry}
                onChange={setExpiry}
                options={[...(initial.status_until ? [{ value: "keep", label: `в ${clock(initial.status_until)}` }] : []), ...EXPIRY]}
              />
            </Section>
          )}
        </>
      )}

      {error && <div className="error">{error}</div>}
      <div className="foot">
        <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
        <button type="button" className="btn primary" disabled={!!busy} onClick={save}>Сохранить</button>
      </div>
    </Modal>
  );
}
