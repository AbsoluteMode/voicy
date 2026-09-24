// Client-side noise suppression. The server only forwards Opus packets,
// so cleaning happens here, before encoding:
//
//   mic → getUserMedia (Chromium AEC if enabled; its NS and AGC stay off)
//       → mono → [DeepFilterNet3 | RNNoise] → gate, in a 48 kHz AudioContext → Opus
//
// Strong mask-based suppression makes the voice itself waver, so
// DeepFilterNet only turns the background down gently while speaking, and
// the gate makes the pauses silent. RNNoise is the fallback for machines
// too slow for DeepFilterNet. Model files ship with the app, see
// scripts/fetch-ns-assets.mjs.

import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { AssetLoader, DeepFilterNet3Core } from "deepfilternet3-noise-filter";
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

import { log } from "./log";

/** `light` (RNNoise + gate) is only a fallback, not offered in settings. */
export type NoiseMode = "off" | "soft" | "standard" | "max" | "light";

export const NOISE_MODES: { mode: NoiseMode; label: string; desc: string }[] = [
  { mode: "off", label: "Выкл", desc: "Чистый сигнал микрофона, как есть." },
  {
    mode: "soft",
    label: "Мягкое",
    desc: "Голос не обрабатывается совсем. В паузах между словами микрофон закрывается: фон и щелчки клавиатуры не слышны.",
  },
  {
    mode: "standard",
    label: "Стандарт",
    desc: "Как «Мягкое», плюс DeepFilterNet бережно приглушает фон и во время речи. Голос остаётся ровным.",
  },
  {
    mode: "max",
    label: "Максимум",
    desc: "DeepFilterNet на полную: убирает даже громкий фон во время речи, но голос может «плавать».",
  },
];

/**
 * How far DeepFilterNet may push the background down, in dB. The deeper
 * it may cut, the more the voice wavers with it; 18 dB keeps it steady.
 */
const DFN_ATTENUATION_DB = { standard: 18, max: 100 } as const;

/**
 * Downward expander with lookahead. Opens only for sound that stays above
 * the noise floor for K blocks (about 13 ms), which speech does and a key
 * click does not; the D-block delay (21 ms) lets it open before the first
 * syllable instead of clipping it. Holds for H blocks (0.2 s) between
 * words, then fades the pause down by 30 dB. The floor adapts to the room.
 */
const GATE_WORKLET = `
class VoicyGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.D = 8; this.K = 5; this.H = 75;
    this.ring = new Float32Array(128 * (this.D + 1));
    this.zero = new Float32Array(128);
    this.blk = 0; this.streak = 0; this.last = -1e9;
    this.gain = 0; this.closed = 0.03;
    // Minimum statistics: the noise floor is the quietest smoothed level
    // over the last 1.5 s. Speech always dips between syllables, so it
    // cannot drag the floor up, and a louder room is learned in 1.5 s.
    this.hist = new Float32Array(560).fill(0);
    this.smooth = -90;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const x = (inputs[0] && inputs[0][0]) || this.zero;
    let e = 0;
    for (let n = 0; n < 128; n++) e += x[n] * x[n];
    const db = 10 * Math.log10(e / 128 + 1e-12);
    this.smooth += (db - this.smooth) * 0.25;
    this.hist[this.blk % this.hist.length] = this.smooth;
    let floor = 0;
    const filled = Math.min(this.blk + 1, this.hist.length);
    for (let i = 0; i < filled; i++) if (this.hist[i] < floor) floor = this.hist[i];
    floor = Math.min(Math.max(floor, -90), -38);
    this.streak = db > Math.max(floor + 10, -62) ? this.streak + 1 : 0;
    if (this.streak >= this.K) this.last = this.blk;
    const slots = this.D + 1;
    this.ring.set(x, (this.blk % slots) * 128);
    const j = this.blk - this.D;
    const open = j >= 0 && this.last >= j - this.H;
    const target = open ? 1 : this.closed;
    const k = target > this.gain ? 0.02 : 0.0012;
    const r = (((j % slots) + slots) % slots) * 128;
    const y = out[0];
    for (let n = 0; n < 128; n++) {
      this.gain += (target - this.gain) * k;
      y[n] = j >= 0 ? this.ring[r + n] * this.gain : 0;
    }
    for (let c = 1; c < out.length; c++) out[c].set(y);
    this.blk++;
    return true;
  }
}
registerProcessor("voicy-gate", VoicyGate);
`;
const gateUrl = URL.createObjectURL(new Blob([GATE_WORKLET], { type: "application/javascript" }));

// The package hardcodes CDN-style paths ending in .tar.gz; point it at the
// copies bundled with the app instead.
AssetLoader.prototype.getAssetUrls = () => ({
  wasm: `${location.origin}/ns/dfn3/df_bg.wasm`,
  model: `${location.origin}/ns/dfn3/DeepFilterNet3_onnx.tgz.bin`,
});
const fetchAsset = AssetLoader.prototype.fetchAsset;
AssetLoader.prototype.fetchAsset = async function (url: string) {
  const bytes = await fetchAsset.call(this, url);
  // libDF wants the gzip archive. If some server decoded it on the way
  // (Content-Encoding: gzip), pack it again.
  const head = new Uint8Array(bytes, 0, 2);
  if (url.endsWith(".tgz.bin") && !(head[0] === 0x1f && head[1] === 0x8b)) {
    const packed = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(packed).arrayBuffer();
  }
  return bytes;
};

let rnnoiseWasm: Promise<ArrayBuffer> | null = null;

/**
 * DeepFilterNet runs on the audio thread; if a frame takes longer than its
 * 10 ms the mic crackles. Measure once per machine: processing time divided
 * by audio time.
 */
let dfnBench: Promise<number> | null = null;
// v2: v1 counted model loading as processing and overstated the load about
// twofold, pushing capable machines to RNNoise.
const BENCH_KEY = "voicy.dfnRealtimeFactor.v2";

export function dfnRealtimeFactor(): Promise<number> {
  dfnBench ??= (async () => {
    try {
      localStorage.removeItem("voicy.dfnRealtimeFactor");
      const saved = Number(localStorage.getItem(BENCH_KEY));
      if (saved > 0) return saved;
    } catch {
      // Measure again.
    }
    const core = new DeepFilterNet3Core({ sampleRate: 48000, noiseReductionLevel: 100 });
    await core.initialize();
    // Each render builds a fresh node, which loads the model inside the
    // timed part. Two lengths with the same fixed cost: their difference is
    // pure processing.
    const render = async (secs: number) => {
      const off = new OfflineAudioContext(1, 48000 * secs, 48000);
      // Typed for AudioContext, but only uses the BaseAudioContext part.
      const node = await core.createAudioWorkletNode(off as unknown as AudioContext);
      const buf = off.createBuffer(1, 48000 * secs, 48000);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.1;
      const src = off.createBufferSource();
      src.buffer = buf;
      src.connect(node).connect(off.destination);
      src.start();
      const t0 = performance.now();
      await off.startRendering();
      return performance.now() - t0;
    };
    // The first run pays for wasm tier-up, which a live call pays only once.
    await render(0.5);
    const short = await render(1);
    const long = await render(4);
    const rtf = Math.max(0.001, (long - short) / 3000);
    core.destroy();
    try {
      localStorage.setItem(BENCH_KEY, String(rtf));
    } catch {
      // Measure again next time.
    }
    return rtf;
  })();
  return dfnBench;
}

/**
 * Above this the audio thread has too little headroom for DeepFilterNet:
 * half of each 10 ms frame, leaving room for load spikes.
 */
export const DFN_MAX_REALTIME_FACTOR = 0.5;

/**
 * Always on the mic, even with suppression off: besides cleaning noise it
 * guarantees a mono track. Many headsets and audio interfaces deliver
 * stereo with the voice in the left channel only, and Chromium sometimes
 * reopens the mic in stereo, which friends then hear in one ear.
 */
export class VoicyNoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "voicy-noise";
  processedTrack?: MediaStreamTrack;

  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private mono: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private current: AudioNode | null = null;
  private dfn: DeepFilterNet3Core | null = null;
  private dfnNode: AudioWorkletNode | null = null;
  private rnnoise: RnnoiseWorkletNode | null = null;
  private gate: AudioWorkletNode | null = null;
  private track?: MediaStreamTrack;

  constructor(private mode: NoiseMode) {}

  get activeMode(): NoiseMode {
    return this.mode;
  }

  get contextState(): string | undefined {
    return this.ctx?.state;
  }

  init = async (opts: { track: MediaStreamTrack }) => {
    this.track = opts.track;
    await this.build();
  };

  // LiveKit calls this when the mic device changes.
  restart = async (opts: { track: MediaStreamTrack }) => {
    this.track = opts.track;
    await this.build();
  };

  async setMode(mode: NoiseMode) {
    this.mode = mode;
    await this.build();
  }

  destroy = async () => {
    this.source?.disconnect();
    this.mono?.disconnect();
    this.current?.disconnect();
    this.gate?.disconnect();
    this.rnnoise?.destroy();
    this.dfn?.destroy();
    this.source = this.mono = this.current = this.gate = this.rnnoise = this.dfnNode = this.dfn = null;
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
  };

  private async context() {
    // Our own 48 kHz context: both models are trained at 48 kHz, and the
    // device rate (often 44.1 kHz) would add resampling.
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      // "discrete" keeps the first channel as is: the voice of a left-only
      // stereo mic at full level, where averaging would lose 6 dB.
      this.mono = new GainNode(this.ctx, { channelCount: 1, channelCountMode: "explicit", channelInterpretation: "discrete" });
      this.dest = new MediaStreamAudioDestinationNode(this.ctx, { channelCount: 1, channelCountMode: "explicit" });
      this.processedTrack = this.dest.stream.getAudioTracks()[0];
      watchTrack(this.processedTrack, "ns-out");
      const ctx = this.ctx;
      // Windows can suspend a context (device switch, audio service
      // restart); a suspended one sends silence without any mute showing.
      ctx.onstatechange = () => {
        log("ns-ctx", { state: ctx.state });
        if (ctx.state !== "running" && ctx.state !== "closed" && this.ctx === ctx) {
          setTimeout(() => void ctx.resume().then(() => log("ns-ctx-resumed", { state: ctx.state }), (e) => log("ns-ctx-resume-failed", { err: String(e) })), 200);
        }
      };
    }
    if (this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  private async gateFor(ctx: AudioContext): Promise<AudioWorkletNode> {
    if (!this.gate) {
      await ctx.audioWorklet.addModule(gateUrl);
      this.gate = new AudioWorkletNode(ctx, "voicy-gate", { outputChannelCount: [1] });
    }
    return this.gate;
  }

  /** The suppressor for a mode; `null` where only the gate (or nothing) runs. */
  private async nodeFor(ctx: AudioContext, mode: NoiseMode): Promise<AudioNode | null> {
    if (mode === "off" || mode === "soft") return null;
    if (mode === "light") {
      if (!this.rnnoise) {
        rnnoiseWasm ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdUrl });
        const wasmBinary = await rnnoiseWasm;
        await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
        this.rnnoise = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
      }
      return this.rnnoise;
    }
    if (!this.dfnNode || !this.dfn) {
      this.dfn = new DeepFilterNet3Core({
        sampleRate: 48000,
        noiseReductionLevel: DFN_ATTENUATION_DB[mode],
      });
      await this.dfn.initialize();
      this.dfnNode = await this.dfn.createAudioWorkletNode(ctx);
    }
    this.dfn.setSuppressionLevel(DFN_ATTENUATION_DB[mode]);
    return this.dfnNode;
  }

  private async build() {
    if (!this.track) throw new Error("no source track");
    watchTrack(this.track, "mic-raw");
    log("ns-build", { mode: this.mode, label: this.track.label, settings: this.track.getSettings() });
    const ctx = await this.context();
    const node = await this.nodeFor(ctx, this.mode);
    const gate = this.mode === "off" ? null : await this.gateFor(ctx);
    this.source?.disconnect();
    this.mono!.disconnect();
    this.current?.disconnect();
    this.gate?.disconnect();
    this.source = ctx.createMediaStreamSource(new MediaStream([this.track]));
    this.source.connect(this.mono!);
    // mic → mono → [suppressor] → [gate] → track
    let tail: AudioNode = this.mono!;
    for (const next of [node, gate]) {
      if (next) tail = tail.connect(next);
    }
    tail.connect(this.dest!);
    this.current = node;
  }
}

const watched = new WeakSet<MediaStreamTrack>();

/** Logs what the browser or Windows does to a track behind our back. */
export function watchTrack(track: MediaStreamTrack, what: string) {
  if (watched.has(track)) return;
  watched.add(track);
  for (const ev of ["mute", "unmute", "ended"]) {
    track.addEventListener(ev, () => log(`${what}-${ev}`, { label: track.label, state: track.readyState, enabled: track.enabled, muted: track.muted }));
  }
}
