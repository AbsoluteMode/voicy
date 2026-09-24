import { getVersion } from "@tauri-apps/api/app";
import { Play, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { accelFrom, accelFromMouse, applyHotkeys, HotkeyErrors, prettyAccel } from "../lib/hotkeys";
import { VoicyNoiseProcessor } from "../lib/noise";
import { AudioSettings, getSettings, Hotkeys, updateSettings, useSettings } from "../lib/settings";
import { checkForUpdate, confirmAndInstall, useUpdater } from "../lib/updater";
import { useVoice, voice } from "../lib/voice";
import { Modal, Toggle } from "./ui";

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {});
    load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener("devicechange", load);
  }, []);
  return devices;
}

/**
 * Live input level for the chosen mic through the chosen processing, with
 * an optional loopback to hear exactly what friends will hear.
 */
function MicMeter({ s }: { s: AudioSettings }) {
  const [level, setLevel] = useState(0);
  // Playing = hearing yourself through the call's processing, with the meter.
  const [on, setOn] = useState(false);
  const [status, setStatus] = useState("");
  const raf = useRef(0);

  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | undefined;
    let ctx: AudioContext | undefined;
    let noise: VoicyNoiseProcessor | undefined;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          deviceId: s.inputDevice ? { exact: s.inputDevice } : undefined,
          echoCancellation: s.echoCancellation,
          noiseSuppression: false,
          autoGainControl: s.autoGainControl,
          channelCount: 1,
          sampleRate: 48000,
        },
      })
      .then(async (st) => {
        if (cancelled) return st.getTracks().forEach((t) => t.stop());
        stream = st;
        // The same processor as in a call, so this is exactly what is sent.
        let track = st.getAudioTracks()[0];
        if (s.noise !== "off") setStatus("Загружаю шумоподавление…");
        noise = new VoicyNoiseProcessor(s.noise);
        await noise.init({ track });
        if (cancelled) return;
        track = noise.processedTrack ?? track;
        setStatus("");
        ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        src.connect(analyser);
        src.connect(ctx.destination);
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v));
          // dBFS mapped so that -60 dB is empty and 0 dB is full.
          const db = 20 * Math.log10(peak || 1e-6);
          setLevel(Math.max(0, Math.min(1, (db + 60) / 60)));
          raf.current = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch((e) => {
        console.error(e);
        setStatus("Не удалось открыть микрофон или шумоподавление");
        setOn(false);
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf.current);
      stream?.getTracks().forEach((t) => t.stop());
      void noise?.destroy();
      void ctx?.close();
      setLevel(0);
    };
  }, [on, s.inputDevice, s.echoCancellation, s.noise, s.autoGainControl]);

  return (
    <div className="field">
      <span>Проверка микрофона</span>
      <div className="row" style={{ alignItems: "center" }}>
        <button
          type="button"
          className={`icon-btn${on ? " on" : ""}`}
          style={{ flex: "none" }}
          onClick={() => setOn(!on)}
          aria-label={on ? "Остановить" : "Послушать себя"}
          title={on ? "Остановить" : "Послушать себя так, как тебя слышат друзья (в наушниках)"}
        >
          {on ? <Square size={14} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <div className="meter" style={{ flex: 1 }}>
          <i style={{ width: `${level * 100}%` }} />
        </div>
      </div>
      {status && <small>{status}</small>}
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const v = useVoice();
  const devices = useDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "communications");
  const outputs = devices.filter((d) => d.kind === "audiooutput" && d.deviceId !== "communications");

  const apply = (patch: Partial<AudioSettings>) => {
    updateSettings(patch);
    void voice.applyAudioSettings();
  };

  return (
    <Modal title="Настройки" onClose={onClose}>
      <label className="field">
        <span>Микрофон</span>
        <select value={s.inputDevice} onChange={(e) => apply({ inputDevice: e.target.value })}>
          <option value="">По умолчанию</option>
          {inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || "Микрофон"}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Вывод звука</span>
        <select value={s.outputDevice} onChange={(e) => apply({ outputDevice: e.target.value })}>
          <option value="">По умолчанию</option>
          {outputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || "Динамики"}</option>
          ))}
        </select>
      </label>
      <MicMeter s={s} />
      <div className="field">
        <Toggle
          title="Шумоподавление"
          desc="Убирает фон, клавиатуру и щелчки. Голос остаётся естественным."
          checked={s.noise !== "off"}
          onChange={(on) => apply({ noise: on ? "standard" : "off" })}
        />
      </div>
      {v.state !== "idle" && (
        <div className="field">
          <span>В звонке</span>
          <div>
            <Toggle
              title="Эхо-тест"
              desc="Слышать себя через сервер так, как тебя слышат друзья. Только в наушниках."
              checked={v.echo}
              onChange={(on) => void voice.setEcho(on).catch(() => {})}
            />
          </div>
        </div>
      )}
      <HotkeysSection />
      <AboutRow />
      <div className="foot">
        <button className="btn primary" onClick={onClose}>Готово</button>
      </div>
    </Modal>
  );
}

function AboutRow() {
  const [version, setVersion] = useState("");
  const update = useUpdater();
  const v = useVoice();
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const status =
    update.kind === "checking"
      ? "Проверяю…"
      : update.kind === "latest"
        ? "Это последняя версия"
        : update.kind === "available"
          ? update.error
            ? `Не удалось обновиться: ${update.error}`
            : `Доступна версия ${update.version}`
          : update.kind === "installing"
            ? `Обновляю${update.percent === null ? "…" : ` ${update.percent}%`}`
            : update.kind === "error"
              ? `Не удалось проверить: ${update.message}`
              : "";

  return (
    <div className="toggle" style={{ borderTop: "1px solid var(--line)", marginTop: 6 }}>
      <div>
        <div className="t">Voicy {version && `v${version}`}</div>
        <div className="d">{status || "Обновления проверяются сами каждые полчаса"}</div>
      </div>
      {update.kind === "available" ? (
        <button className="btn green" onClick={() => confirmAndInstall(v.state !== "idle")}>Обновить</button>
      ) : (
        <button className="btn" disabled={update.kind === "checking" || update.kind === "installing"} onClick={() => void checkForUpdate(true)}>
          Проверить обновления
        </button>
      )}
    </div>
  );
}

/** A binding shown as a button: click, then press keys or a mouse side button. */
function HotkeyButton(props: { value: string | null; editing: boolean; onEdit: () => void; onClear: () => void }) {
  return (
    <div className="row" style={{ flex: "none", gap: 6, alignItems: "center" }}>
      <button
        type="button"
        className={`btn hotkey${props.editing ? " primary" : ""}`}
        onClick={props.onEdit}
        title="Нажми и введи клавиши или кнопку мыши. Esc — отмена"
      >
        {props.editing ? "Нажми клавишу или кнопку мыши…" : prettyAccel(props.value)}
      </button>
      {props.value && !props.editing && (
        <button type="button" className="icon-btn sm" onClick={props.onClear} title="Убрать">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Global hotkeys and push-to-talk. Keys and mouse side buttons both work. */
function HotkeysSection() {
  const s = useSettings();
  const [editing, setEditing] = useState<keyof Hotkeys | null>(null);
  const [errors, setErrors] = useState<HotkeyErrors>({});

  useEffect(() => {
    void applyHotkeys().then(setErrors);
  }, [s.hotkeys, s.pushToTalk]);

  const bind = (key: keyof Hotkeys, accel: string | null) => {
    updateSettings({ hotkeys: { ...getSettings().hotkeys, [key]: accel } });
    setEditing(null);
  };

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setEditing(null);
      const accel = accelFrom(e);
      if (accel) bind(editing, accel); // a lone modifier: keep waiting
    };
    const onMouse = (e: MouseEvent) => {
      const accel = accelFromMouse(e);
      if (!accel) return;
      e.preventDefault();
      e.stopPropagation();
      bind(editing, accel);
    };
    // Capture phase, so Esc does not also close the dialog and a side
    // button does not navigate.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    window.addEventListener("auxclick", onMouse, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
      window.removeEventListener("auxclick", onMouse, true);
    };
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const row = (key: keyof Hotkeys, title: string, desc?: string) => (
    <div className="toggle" key={key}>
      <div>
        <div className="t">{title}</div>
        {errors[key] ? <div className="d" style={{ color: "var(--warn)" }}>Эту клавишу назначить нельзя</div> : desc && <div className="d">{desc}</div>}
      </div>
      <HotkeyButton
        value={s.hotkeys[key]}
        editing={editing === key}
        onEdit={() => setEditing(editing === key ? null : key)}
        onClear={() => bind(key, null)}
      />
    </div>
  );

  const setPtt = (on: boolean) => {
    updateSettings({ pushToTalk: on });
    void voice.setPushToTalkMode(on);
    // Turning it on without a key asks for one right away.
    if (on && !getSettings().hotkeys.ptt) setEditing("ptt");
  };

  return (
    <div className="field">
      <span>Горячие клавиши</span>
      <small>Работают, даже когда Voicy свёрнут или ты в игре. Можно назначить боковые кнопки мыши.</small>
      <div>
        {row("mute", "Микрофон вкл/выкл")}
        {row("deafen", "Звук вкл/выкл")}
        <Toggle
          title="Режим рации"
          desc="Микрофон включается, только пока держишь клавишу"
          checked={s.pushToTalk}
          onChange={setPtt}
        />
        {s.pushToTalk && row("ptt", "Клавиша рации")}
      </div>
    </div>
  );
}
