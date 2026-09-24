// Client-side noise suppression. The server only forwards Opus packets,
// so cleaning happens here, before encoding:
//
//   mic → getUserMedia (Chromium AEC if enabled; its NS and AGC stay off)
//       → [RNNoise | DeepFilterNet3] in a 48 kHz AudioWorklet → Opus
//
// DeepFilterNet3 keeps the voice fullband and natural while removing
// non-stationary noise (keyboard, TV, kids). RNNoise is the light mode for
// weak CPUs. Model files ship with the app, see scripts/fetch-ns-assets.mjs.

import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import { AssetLoader, DeepFilterNet3Core } from "deepfilternet3-noise-filter";
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

export type NoiseMode = "off" | "light" | "standard" | "max";

export const NOISE_MODES: { mode: NoiseMode; label: string; desc: string }[] = [
  { mode: "off", label: "Выкл", desc: "Чистый сигнал микрофона. Лучше всего для хорошего микрофона в тихой комнате." },
  { mode: "light", label: "Лёгкое", desc: "RNNoise: убирает ровный фон (гул, вентилятор), почти не грузит процессор." },
  { mode: "standard", label: "Стандарт", desc: "DeepFilterNet: убирает клавиатуру, ТВ, улицу, голос остаётся естественным." },
  { mode: "max", label: "Максимум", desc: "DeepFilterNet без ограничений: между фразами полная тишина. Может резать смех и шёпот." },
];

/**
 * How far DeepFilterNet may push the background down, in dB. A little
 * residual ambience in "standard" masks artifacts and sounds more natural.
 */
const DFN_ATTENUATION_DB = { standard: 35, max: 100 } as const;

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
  private track?: MediaStreamTrack;

  constructor(private mode: NoiseMode) {}

  get activeMode(): NoiseMode {
    return this.mode;
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
    this.rnnoise?.destroy();
    this.dfn?.destroy();
    this.source = this.mono = this.current = this.rnnoise = this.dfnNode = this.dfn = null;
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
    }
    if (this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  private async nodeFor(ctx: AudioContext, mode: NoiseMode): Promise<AudioNode | null> {
    if (mode === "off") return null;
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
    const ctx = await this.context();
    const node = await this.nodeFor(ctx, this.mode);
    this.source?.disconnect();
    this.mono!.disconnect();
    this.current?.disconnect();
    this.source = ctx.createMediaStreamSource(new MediaStream([this.track]));
    this.source.connect(this.mono!);
    if (node) this.mono!.connect(node).connect(this.dest!);
    else this.mono!.connect(this.dest!);
    this.current = node;
  }
}
