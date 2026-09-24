import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState } from "react";

import { accelFrom, applyHotkeys, HotkeyErrors, prettyAccel } from "../lib/hotkeys";
import { VoicyNoiseProcessor } from "../lib/noise";
import { AudioSettings, Hotkeys, updateSettings, useSettings } from "../lib/settings";
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
  const [on, setOn] = useState(false);
  const [listen, setListen] = useState(false);
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
        if (listen) src.connect(ctx.destination);
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
  }, [on, listen, s.inputDevice, s.echoCancellation, s.noise, s.autoGainControl]);

  return (
    <div className="field">
      <span>Проверка микрофона</span>
      <div className="row" style={{ alignItems: "center" }}>
        <div className="meter" style={{ flex: 4 }}>
          <i style={{ width: `${level * 100}%` }} />
        </div>
        <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setOn(!on)}>
          {on ? "Стоп" : "Тест"}
        </button>
        <button
          type="button"
          className={`btn${listen ? " primary" : ""}`}
          style={{ flex: 2 }}
          title="Только в наушниках, иначе будет эхо"
          onClick={() => {
            setListen(!listen);
            setOn(true);
          }}
        >
          {listen ? "Не слушать" : "Слушать себя"}
        </button>
      </div>
      <small>{status || "«Слушать себя» проигрывает твой голос так, как его услышат друзья. Только в наушниках."}</small>
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings();
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

const HOTKEY_ROWS: { key: keyof Hotkeys; title: string; desc?: string }[] = [
  { key: "mute", title: "Микрофон вкл/выкл" },
  { key: "deafen", title: "Звук вкл/выкл" },
  { key: "ptt", title: "Рация", desc: "Говоришь, только пока держишь клавишу" },
];

/** Global shortcuts: click a key, press the combo; Esc cancels, Backspace clears. */
function HotkeysSection() {
  const s = useSettings();
  const [editing, setEditing] = useState<keyof Hotkeys | null>(null);
  const [errors, setErrors] = useState<HotkeyErrors>({});

  useEffect(() => {
    void applyHotkeys().then(setErrors);
  }, [s.hotkeys]);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setEditing(null);
      const accel = e.key === "Backspace" ? null : accelFrom(e);
      if (accel === null && e.key !== "Backspace") return; // a lone modifier: keep waiting
      updateSettings({ hotkeys: { ...s.hotkeys, [editing]: accel } });
      setEditing(null);
    };
    // Capture phase, so Esc does not also close the dialog.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing, s.hotkeys]);

  return (
    <div className="field">
      <span>Горячие клавиши</span>
      <small>Работают, даже когда Voicy свёрнут или ты в игре.</small>
      <div>
        {HOTKEY_ROWS.map((row) => (
          <div className="toggle" key={row.key}>
            <div>
              <div className="t">{row.title}</div>
              {errors[row.key] ? (
                <div className="d" style={{ color: "var(--warn)" }}>Это сочетание уже занято другой программой</div>
              ) : (
                row.desc && <div className="d">{row.desc}</div>
              )}
            </div>
            <button
              type="button"
              className={`btn hotkey${editing === row.key ? " primary" : ""}`}
              onClick={() => setEditing(editing === row.key ? null : row.key)}
              title="Нажми и введи сочетание. Esc — отмена, Backspace — убрать"
            >
              {editing === row.key ? "Нажми клавиши…" : prettyAccel(s.hotkeys[row.key])}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
