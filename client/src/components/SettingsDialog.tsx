import { useEffect, useRef, useState } from "react";

import { AudioSettings, BITRATES, updateSettings, useSettings } from "../lib/settings";
import { voice } from "../lib/voice";
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

/** Live input level for the chosen mic with the chosen processing. */
function MicMeter({ s }: { s: AudioSettings }) {
  const [level, setLevel] = useState(0);
  const [on, setOn] = useState(false);
  const raf = useRef(0);

  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | undefined;
    let ctx: AudioContext | undefined;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          deviceId: s.inputDevice ? { exact: s.inputDevice } : undefined,
          echoCancellation: s.echoCancellation,
          noiseSuppression: s.noiseSuppression,
          autoGainControl: s.autoGainControl,
          channelCount: 1,
          sampleRate: 48000,
        },
      })
      .then((st) => {
        if (cancelled) return st.getTracks().forEach((t) => t.stop());
        stream = st;
        ctx = new AudioContext({ sampleRate: 48000 });
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(st).connect(analyser);
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
      .catch(() => setOn(false));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf.current);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      setLevel(0);
    };
  }, [on, s.inputDevice, s.echoCancellation, s.noiseSuppression, s.autoGainControl]);

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
      </div>
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const devices = useDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "communications");
  const outputs = devices.filter((d) => d.kind === "audiooutput" && d.deviceId !== "communications");

  const apply = (patch: Partial<AudioSettings>, republish = false) => {
    updateSettings(patch);
    void voice.applyAudioSettings({ republish });
  };

  return (
    <Modal title="Настройки звука" onClose={onClose}>
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
        <span>Качество голоса (битрейт Opus)</span>
        <div className="seg">
          {BITRATES.map((b) => (
            <button key={b} type="button" className={s.bitrate === b ? "on" : ""} onClick={() => apply({ bitrate: b }, true)}>
              {b}
            </button>
          ))}
        </div>
        <small>кбит/с. У Дискорда по умолчанию 64. Выше 128 разница слышна в основном на хороших микрофонах.</small>
      </div>
      <div className="field">
        <span>Обработка</span>
        <div>
          <Toggle
            title="Шумоподавление"
            desc="Убирает гул, вентилятор, клавиатуру. Немного окрашивает голос."
            checked={s.noiseSuppression}
            onChange={(v) => apply({ noiseSuppression: v })}
          />
          <Toggle
            title="Эхоподавление"
            desc="Нужно, только если говоришь через колонки, а не наушники."
            checked={s.echoCancellation}
            onChange={(v) => apply({ echoCancellation: v })}
          />
          <Toggle
            title="Автогромкость"
            desc="Выравнивает громкость, если говоришь то тихо, то громко."
            checked={s.autoGainControl}
            onChange={(v) => apply({ autoGainControl: v })}
          />
        </div>
      </div>
      <div className="foot">
        <button className="btn primary" onClick={onClose}>Готово</button>
      </div>
    </Modal>
  );
}
