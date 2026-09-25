// Client-side noise suppression. The server only forwards Opus packets,
// so cleaning happens here, before encoding:
//
//   mic → getUserMedia (Chromium AEC if enabled; its NS and AGC stay off)
//       → mono → level → [DeepFilterNet3 | RNNoise] → gate, in a 48 kHz AudioContext → Opus
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
    desc: "Голос не очищается, только выравнивается по громкости. В паузах между словами микрофон закрывается: фон и щелчки клавиатуры не слышны.",
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
 * For a voice that is close to the floor, the threshold comes down towards
 * it, so quiet syllables are not swallowed. Reports how often it is open.
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
    // Typical level of clear speech, learned over a few seconds of talk.
    this.speech = -30;
    this.open = 0;
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
    const thr = Math.max(floor + 4, Math.min(Math.max(floor + 10, -62), this.speech - 20));
    this.streak = db > thr ? this.streak + 1 : 0;
    if (this.streak >= this.K) {
      this.last = this.blk;
      this.speech += (db - this.speech) * 0.002;
    }
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
    if (open) this.open++;
    this.blk++;
    if (this.blk % 375 === 0) {
      this.port.postMessage({ open: this.open, blocks: 375 });
      this.open = 0;
    }
    return true;
  }
}
registerProcessor("voicy-gate", VoicyGate);
`;

/** Everything sent is brought to this speech level, in dBFS (RMS of 2.7 ms blocks while talking). */
const LEVEL_TARGET_DB = -30;
const LEVEL_MAX_BOOST_DB = 18;
const LEVEL_MAX_CUT_DB = 6;

/**
 * Automatic level, before the suppressor: brings speech to the same
 * loudness for everyone, so a quiet mic is not half-heard and a loud one
 * does not blast. Unlike Chromium's AGC it learns the level only while
 * someone talks and moves slowly (3 dB/s up), so pauses do not pump and
 * words do not swell. It starts from the level learned for this mic last
 * time and adapts faster for the first seconds of speech. A limiter
 * catches peaks the boost would clip. Reports the measured speech level,
 * noise floor, gain and clipping once a second (375 blocks of 128 samples).
 */
const LEVEL_WORKLET = `
class VoicyLevel extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.zero = new Float32Array(128);
    this.blk = 0; this.talk = 0;
    const known = options && options.processorOptions && options.processorOptions.speech;
    this.speech = typeof known === "number" ? known : ${LEVEL_TARGET_DB};
    this.gainDb = this.want();
    this.g = Math.pow(10, this.gainDb / 20); this.lim = 1;
    this.hist = new Float32Array(560).fill(0);
    this.smooth = -90;
    this.st = { talk: 0, sum: 0, floor: 0, clip: 0, limited: 0 };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const x = (inputs[0] && inputs[0][0]) || this.zero;
    let e = 0;
    let clip = 0;
    for (let n = 0; n < 128; n++) {
      e += x[n] * x[n];
      if (x[n] >= 0.985 || x[n] <= -0.985) clip++;
    }
    const db = 10 * Math.log10(e / 128 + 1e-12);
    this.smooth += (db - this.smooth) * 0.25;
    this.hist[this.blk % this.hist.length] = this.smooth;
    let floor = 0;
    const filled = Math.min(this.blk + 1, this.hist.length);
    for (let i = 0; i < filled; i++) if (this.hist[i] < floor) floor = this.hist[i];
    floor = Math.max(floor, -100);
    const talking = db > Math.max(floor + 12, -60);
    if (talking) {
      // Fast for the first few seconds of speech, then about 3 s of memory.
      const early = ++this.talk < 1200;
      this.speech += (db - this.speech) * (early ? 0.005 : 0.001);
      this.gainDb += Math.min(early ? 0.03 : 0.008, Math.max(-0.016, this.want() - this.gainDb));
    }
    const g = Math.pow(10, this.gainDb / 20);
    const y = out[0];
    let limited = false;
    for (let n = 0; n < 128; n++) {
      this.g += (g - this.g) * 0.01;
      const v = x[n] * this.g;
      this.lim += (1 - this.lim) * 0.0005;
      if (Math.abs(v * this.lim) > 0.89) {
        this.lim = 0.89 / Math.abs(v);
        limited = true;
      }
      y[n] = v * this.lim;
    }
    for (let c = 1; c < out.length; c++) out[c].set(y);
    const st = this.st;
    if (talking) { st.talk++; st.sum += db; }
    st.floor += floor;
    st.clip += clip;
    if (limited) st.limited++;
    if (++this.blk % 375 === 0) {
      this.port.postMessage({ blocks: 375, talk: st.talk, speechDb: st.talk ? st.sum / st.talk : null, floorDb: st.floor / 375, clip: st.clip, limited: st.limited, gainDb: this.gainDb, level: this.talk > 1200 ? this.speech : null });
      this.st = { talk: 0, sum: 0, floor: 0, clip: 0, limited: 0 };
    }
    return true;
  }
}
VoicyLevel.prototype.want = function () {
  return Math.min(${LEVEL_MAX_BOOST_DB}, Math.max(${-LEVEL_MAX_CUT_DB}, ${LEVEL_TARGET_DB} - this.speech));
};
registerProcessor("voicy-level", VoicyLevel);
`;
const workletUrl = URL.createObjectURL(new Blob([GATE_WORKLET, LEVEL_WORKLET], { type: "application/javascript" }));

/** What the mic chain did over a stretch of time, for the logs. */
export interface MicChainStats {
  /** Seconds covered. */
  secs: number;
  /** Share of time with speech, %. */
  talkPct: number;
  /** Raw mic while talking and in the pauses, dBFS. */
  speechDb?: number;
  floorDb?: number;
  /** Automatic level at the end of the stretch, dB. */
  gainDb?: number;
  /** Samples at full scale in the raw mic: the mic or Windows gain is too high. */
  clip: number;
  /** Share of time the limiter caught a peak, %. */
  limitedPct: number;
  /** Share of time the gate let sound through, %. */
  gateOpenPct?: number;
}

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
  private level: AudioWorkletNode | null = null;
  private track?: MediaStreamTrack;
  private chain = { blocks: 0, talk: 0, speechSum: 0, floorSum: 0, clip: 0, limited: 0, gainDb: undefined as number | undefined, gateBlocks: 0, gateOpen: 0 };

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
    this.level?.disconnect();
    this.rnnoise?.destroy();
    this.dfn?.destroy();
    this.source = this.mono = this.current = this.gate = this.level = this.rnnoise = this.dfnNode = this.dfn = null;
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
      await ctx.audioWorklet.addModule(workletUrl);
      const gate = (this.gate = new AudioWorkletNode(ctx, "voicy-gate", { outputChannelCount: [1] }));
      gate.port.onmessage = (e: MessageEvent<{ open: number; blocks: number }>) => {
        if (this.gate !== gate) return;
        this.chain.gateOpen += e.data.open;
        this.chain.gateBlocks += e.data.blocks;
      };
    }
    return this.gate;
  }

  private async levelFor(ctx: AudioContext): Promise<AudioWorkletNode> {
    if (!this.level) {
      await ctx.audioWorklet.addModule(workletUrl);
      const key = `voicy.micSpeechDb:${this.track?.label ?? ""}`;
      let speech: number | undefined;
      try {
        speech = Number(localStorage.getItem(key)) || undefined;
      } catch {
        // Learn it again.
      }
      const level = (this.level = new AudioWorkletNode(ctx, "voicy-level", { outputChannelCount: [1], processorOptions: { speech } }));
      type Report = { blocks: number; talk: number; speechDb: number | null; floorDb: number; clip: number; limited: number; gainDb: number; level: number | null };
      level.port.onmessage = ({ data: r }: MessageEvent<Report>) => {
        if (this.level !== level) return;
        if (r.level !== null && r.talk > 0) {
          try {
            localStorage.setItem(key, r.level.toFixed(1));
          } catch {
            // Only a head start for next time.
          }
        }
        const c = this.chain;
        c.blocks += r.blocks;
        c.talk += r.talk;
        if (r.speechDb !== null) c.speechSum += r.speechDb * r.talk;
        c.floorSum += r.floorDb * r.blocks;
        c.clip += r.clip;
        c.limited += r.limited;
        c.gainDb = r.gainDb;
      };
    }
    return this.level;
  }

  /** What the chain did since the last call, then starts over. */
  takeStats(): MicChainStats | undefined {
    const c = this.chain;
    this.chain = { blocks: 0, talk: 0, speechSum: 0, floorSum: 0, clip: 0, limited: 0, gainDb: undefined, gateBlocks: 0, gateOpen: 0 };
    if (!c.blocks && !c.gateBlocks) return undefined;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const blocks = c.blocks || c.gateBlocks;
    return {
      secs: r1((blocks * 128) / 48000),
      talkPct: c.blocks ? r1((c.talk / c.blocks) * 100) : 0,
      speechDb: c.talk ? r1(c.speechSum / c.talk) : undefined,
      floorDb: c.blocks ? r1(c.floorSum / c.blocks) : undefined,
      gainDb: c.gainDb === undefined ? undefined : r1(c.gainDb),
      clip: c.clip,
      limitedPct: c.blocks ? r1((c.limited / c.blocks) * 100) : 0,
      gateOpenPct: c.gateBlocks ? r1((c.gateOpen / c.gateBlocks) * 100) : undefined,
    };
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
    const level = this.mode === "off" ? null : await this.levelFor(ctx);
    this.source?.disconnect();
    this.mono!.disconnect();
    this.current?.disconnect();
    this.gate?.disconnect();
    this.level?.disconnect();
    this.source = ctx.createMediaStreamSource(new MediaStream([this.track]));
    this.source.connect(this.mono!);
    // mic → mono → [level] → [suppressor] → [gate] → track
    let tail: AudioNode = this.mono!;
    for (const next of [level, node, gate]) {
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
