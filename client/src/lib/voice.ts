import { useSyncExternalStore } from "react";
import {
  AudioCaptureOptions,
  ConnectionQuality,
  createLocalAudioTrack,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  TrackEventCallbacks,
  TrackPublishOptions,
} from "livekit-client";

import { flushLogs, log, logTo } from "./log";
import { DFN_MAX_REALTIME_FACTOR, dfnRealtimeFactor, VoicyNoiseProcessor, watchTrack } from "./noise";
import { SCREEN_CAPTURE, SCREEN_PUBLISH } from "./screen";
import { getSettings } from "./settings";
import { api, Role } from "./tauri";

export type ConnState = "idle" | "connecting" | "connected" | "reconnecting";

/** Why the last session ended, when it was not the user's choice. */
export type EndReason = "kicked" | "deleted" | "duplicate" | "lost" | "full";

export interface Peer {
  identity: string;
  name: string;
  role?: Role;
  isLocal: boolean;
  speaking: boolean;
  muted: boolean;
  /** How their audio actually arrives here, for remote peers. */
  net?: PeerNet;
  /** Connection bars: 3 good, 2 so-so, 1 bad, 0 not known yet. */
  quality: 0 | 1 | 2 | 3;
}

export interface PeerNet {
  lossPct: number;
  jitterMs: number;
  /** Share of played audio the receiver had to invent or time-stretch:
   *  what "chewed" or robotic speech is made of. */
  repairPct: number;
  /** Extra receive buffer we asked for because of repairs, ms. */
  bufferMs: number;
}

const MOVE_TOPIC = "voicy.move";

/** The mic itself: LiveKit's `mediaStreamTrack` is the processed one once a processor is on. */
function rawTrack(track: LocalAudioTrack): MediaStreamTrack {
  return (track as unknown as { _mediaStreamTrack?: MediaStreamTrack })._mediaStreamTrack ?? track.mediaStreamTrack;
}

/** Above either, the peer's connection is audibly unstable. */
export const NET_BAD = { lossPct: 2, repairPct: 3 };

/** Seconds of stats in one `audio` log event. */
const STATS_LOG_SECS = 10;
/** A second of received audio louder than this, dBFS, had someone talking in it. */
const TALK_DB = -50;

interface PeerWindow {
  name: string;
  n: number;
  loss: number;
  lossMax: number;
  repair: number;
  repairMax: number;
  jitterMax: number;
  jb: number;
  jbN: number;
  talk: number;
  talkN: number;
  peakDb: number;
}

function newWindow() {
  return {
    n: 0,
    kbps: 0,
    kbpsN: 0,
    rtt: 0,
    rttN: 0,
    lossMax: 0,
    jitterMax: 0,
    low: 0,
    path: undefined as string | undefined,
    peers: new Map<string, PeerWindow>(),
  };
}

export interface ScreenShare {
  identity: string;
  name: string;
  isLocal: boolean;
  watching: boolean;
  track?: LocalVideoTrack | RemoteVideoTrack;
}

export interface VoiceSnapshot {
  host: string | null;
  /** Voice room id (r1, r2, ...) on that host. */
  room: string | null;
  state: ConnState;
  peers: Peer[];
  screens: ScreenShare[];
  screenSharing: boolean;
  micMuted: boolean;
  deafened: boolean;
  /** WebView blocked autoplay; a click must call `startAudio`. */
  audioBlocked: boolean;
  /** Set when the chosen noise suppression could not start. */
  noiseError?: string;
  /** Hearing yourself back through the server. */
  echo: boolean;
  /** Measured, not configured: what the mic stream actually does. */
  stats?: AudioStats;
  endReason?: EndReason;
  error?: string;
}

export interface AudioStats {
  /** Outgoing Opus bitrate, kbit/s. */
  sendKbps?: number;
  /** Round trip to the server, ms. */
  rttMs?: number;
  /** Packets the server did not get, %. */
  lossPct?: number;
  jitterMs?: number;
}

const IDLE: VoiceSnapshot = {
  host: null,
  room: null,
  state: "idle",
  peers: [],
  screens: [],
  screenSharing: false,
  micMuted: false,
  deafened: false,
  audioBlocked: false,
  echo: false,
};

/** RMS above this (about -40 dBFS) counts as speech. */
const SPEAKING_RMS = 0.01;
/** Keeps the ring lit between words instead of flickering. */
const SPEAKING_HOLD_MS = 350;
/** Voice level shown by the ring: quiet speech to shouting, in dBFS RMS. */
const LEVEL_FLOOR_DB = -42;
const LEVEL_TOP_DB = -12;
/** Per 50 ms tick: the ring jumps up with the voice and eases back down. */
const LEVEL_RELEASE = 0.8;

function captureOptions(): AudioCaptureOptions {
  const s = getSettings();
  return {
    deviceId: s.inputDevice || undefined,
    echoCancellation: s.echoCancellation,
    // Our own suppressor runs after capture; stacking Chromium's on top
    // only adds artifacts.
    noiseSuppression: false,
    autoGainControl: s.autoGainControl,
    channelCount: 1,
    sampleRate: 48000,
  };
}

function publishOptions(): TrackPublishOptions {
  return {
    audioPreset: { maxBitrate: getSettings().bitrate * 1000 },
    // DTX clips word onsets; RED resends previous frames so lost packets
    // are recovered instead of concealed.
    dtx: false,
    red: true,
    stopMicTrackOnMute: false,
  };
}

/**
 * Short tones, rising when something starts and falling when it ends:
 * mic/sound on and off, we join or leave a room, someone joins or leaves ours.
 */
const CUES = {
  on: { tones: [520, 780], gap: 0.07, len: 0.09, level: 0.12 },
  off: { tones: [640, 420], gap: 0.07, len: 0.09, level: 0.12 },
  join: { tones: [440, 554, 659], gap: 0.08, len: 0.16, level: 0.1 },
  leave: { tones: [659, 554, 440], gap: 0.08, len: 0.16, level: 0.1 },
  peerJoin: { tones: [587, 880], gap: 0.09, len: 0.14, level: 0.07 },
  peerLeave: { tones: [880, 587], gap: 0.09, len: 0.14, level: 0.07 },
};

let cueCtx: AudioContext | null = null;

/**
 * Plays on the call's own audio context when there is one, else on a shared
 * one: every new context opens another stream to the headset, and wireless
 * ones click or hiss when that happens.
 */
function cue(kind: keyof typeof CUES, callCtx?: AudioContext | null) {
  const { tones, gap, len, level } = CUES[kind];
  try {
    let ctx = callCtx && callCtx.state === "running" ? callCtx : cueCtx;
    if (!ctx || ctx.state === "closed") ctx = cueCtx = new AudioContext({ latencyHint: "interactive" });
    void ctx.resume();
    tones.forEach((hz, i) => {
      const osc = new OscillatorNode(ctx, { frequency: hz, type: "sine" });
      const gain = new GainNode(ctx, { gain: 0 });
      // A short lead-in: the first samples on a just-woken stream can glitch.
      const t = ctx.currentTime + 0.05 + i * gap;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(level, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + len + 0.01);
      osc.onended = () => gain.disconnect();
    });
  } catch {
    // Cues are a nicety.
  }
}

function roleOf(p: Participant): Role | undefined {
  try {
    return p.metadata ? (JSON.parse(p.metadata).role as Role) : undefined;
  } catch {
    return undefined;
  }
}

class VoiceSession {
  private room: Room | null = null;
  private ctx: AudioContext | null = null;
  private listeners = new Set<() => void>();
  private snap: VoiceSnapshot = IDLE;
  private micWanted = true;
  private micPublishing: Promise<void> | null = null;
  private micUpdate: Promise<void> = Promise.resolve();
  private watchedScreens = new Set<string>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  private set(patch: Partial<VoiceSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private refresh = () => {
    const room = this.room;
    if (!room) return;
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    const peers = all.map((p) => ({
      identity: p.identity,
      name: p.name || p.identity,
      role: roleOf(p),
      isLocal: p === room.localParticipant,
      speaking: this.speaking.has(p.identity),
      muted: !p.isMicrophoneEnabled,
      net: this.peerNet.get(p.identity),
      quality: this.quality(p),
    }));
    peers.sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name));
    const screens: ScreenShare[] = [];
    for (const p of all) {
      const publication = p.getTrackPublication(Track.Source.ScreenShare);
      if (publication && !publication.isMuted) {
        const watching = p === room.localParticipant || this.watchedScreens.has(p.identity);
        const track = watching && publication.track?.kind === Track.Kind.Video
          ? publication.track as LocalVideoTrack | RemoteVideoTrack : undefined;
        screens.push({
          identity: p.identity,
          name: p.name || p.identity,
          isLocal: p === room.localParticipant,
          watching,
          track,
        });
      }
    }
    this.set({
      peers,
      screens,
      screenSharing: room.localParticipant.isScreenShareEnabled,
      audioBlocked: !room.canPlaybackAudio,
    });
  };

  /**
   * LiveKit scores every participant's own link to the server, so a friend's
   * bars show their internet, not ours. For ourselves the measured uplink
   * counts too: it reacts faster than the server's score.
   */
  private quality(p: Participant): Peer["quality"] {
    if (p === this.room?.localParticipant && this.snap.state !== "connected") return 0;
    const lk = ({ [ConnectionQuality.Excellent]: 3, [ConnectionQuality.Good]: 2, [ConnectionQuality.Poor]: 1, [ConnectionQuality.Lost]: 1 } as Record<string, 1 | 2 | 3>)[p.connectionQuality];
    if (p !== this.room?.localParticipant) return lk ?? 0;
    const st = this.snap.stats;
    const own = !st ? 3 : (st.lossPct ?? 0) > 5 || (st.rttMs ?? 0) > 300 ? 1 : (st.lossPct ?? 0) > 1.5 || (st.rttMs ?? 0) > 150 ? 2 : 3;
    return Math.min(lk ?? 3, own) as 1 | 2 | 3;
  }

  private applyVolume(p: RemoteParticipant) {
    const deaf = this.snap.deafened;
    p.setVolume(deaf ? 0 : (getSettings().volumes[p.identity] ?? 1));
    // The member's slider is for their voice; stream sound only follows deafen.
    p.setVolume(deaf ? 0 : 1, Track.Source.ScreenShareAudio);
  }

  /**
   * Bumped by every connect and disconnect. An attempt that finds it changed
   * after an await has been superseded and must not touch the mic or state.
   */
  private generation = 0;

  async connect(host: string, roomId: string) {
    const gen = ++this.generation;
    const stale = () => gen !== this.generation;
    // Switching rooms keeps the mic, noise suppression and playback running:
    // restarting them glitches the headset and stalls the UI.
    this.teardown(true);
    logTo(host);
    log("connect", { room: roomId, ptt: getSettings().pushToTalk, noise: getSettings().noise });
    // In push-to-talk mode the mic starts closed.
    if (getSettings().pushToTalk) this.micWanted = false;
    const deafened = this.snap.deafened;
    this.set({ ...IDLE, host, room: roomId, state: "connecting", micMuted: !this.micWanted || deafened, deafened });

    try {
      const { url, token } = await api<{ url: string; token: string }>(host, "POST", "/api/token", { room: roomId });
      if (stale()) return;

      // One 48 kHz context for all playback: no resampling, and gain nodes
      // let per-member volume go above 100%.
      let ctx = this.ctx;
      if (!ctx || ctx.state === "closed") {
        const fresh = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
        fresh.onstatechange = () => log("play-ctx", { state: fresh.state });
        ctx = this.ctx = fresh;
      }
      const s = getSettings();
      const room = new Room({
        // Video only: each viewer gets the stream layer that fits its tile
        // (nothing while hidden), and layers nobody watches are not encoded.
        adaptiveStream: { pixelDensity: "screen" },
        dynacast: true,
        webAudioMix: { audioContext: ctx },
        audioCaptureDefaults: captureOptions(),
        audioOutput: s.outputDevice ? { deviceId: s.outputDevice } : undefined,
        publishDefaults: publishOptions(),
        disconnectOnPageLeave: true,
      });
      this.room = room;

      room
        .on(RoomEvent.ParticipantConnected, (p) => {
          if (!this.snap.deafened) cue("peerJoin", this.ctx);
          this.applyVolume(p);
          this.refresh();
        })
        .on(RoomEvent.ParticipantDisconnected, () => {
          if (!this.snap.deafened) cue("peerLeave", this.ctx);
          this.refresh();
        })
        .on(RoomEvent.ActiveSpeakersChanged, this.refresh)
        .on(RoomEvent.TrackMuted, this.refresh)
        .on(RoomEvent.TrackUnmuted, this.refresh)
        .on(RoomEvent.LocalTrackPublished, this.refresh)
        .on(RoomEvent.LocalTrackUnpublished, this.refresh)
        .on(RoomEvent.TrackPublished, (pub, p) => {
          if (p && (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio)
            && !this.watchedScreens.has(p.identity)) pub.setSubscribed(false);
          this.refresh();
        })
        .on(RoomEvent.TrackUnpublished, (pub, p) => {
          if (pub.source === Track.Source.ScreenShare && p) this.watchedScreens.delete(p.identity);
          this.refresh();
        })
        .on(RoomEvent.ParticipantNameChanged, this.refresh)
        .on(RoomEvent.ParticipantMetadataChanged, this.refresh)
        .on(RoomEvent.AudioPlaybackStatusChanged, this.refresh)
        .on(RoomEvent.ConnectionQualityChanged, (q, p) => {
          if (p === room.localParticipant) log("quality", { q });
          this.refresh();
        })
        .on(RoomEvent.TrackMuted, (pub, p) => p === room.localParticipant && log("lk-track-muted", { source: pub.source }))
        .on(RoomEvent.TrackUnmuted, (pub, p) => p === room.localParticipant && log("lk-track-unmuted", { source: pub.source }))
        .on(RoomEvent.LocalTrackUnpublished, (pub) => log("lk-unpublished", { source: pub.source }))
        .on(RoomEvent.MediaDevicesError, (e) => log("media-error", { msg: String(e?.message ?? e) }))
        .on(RoomEvent.ActiveDeviceChanged, (kind, id) => log("active-device", { kind, id: id.slice(0, 12) }))
        .on(RoomEvent.DataReceived, (payload, from, _kind, topic) => {
          // An admin dragged us to another room. Only the server can send
          // data (members may not publish it), and it has no participant.
          if (from || topic !== MOVE_TOPIC || this.room !== room) return;
          try {
            const to = JSON.parse(new TextDecoder().decode(payload)).room;
            if (typeof to === "string" && to !== this.snap.room) void this.connect(host, to).catch(() => {});
          } catch {
            // Not ours to act on.
          }
        })
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
          if (track.kind === Track.Kind.Audio) {
            track.attach();
            this.applyVolume(p);
          }
          this.refresh();
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          track.detach();
          this.refresh();
        })
        .on(RoomEvent.Reconnecting, () => {
          log("reconnecting");
          this.set({ state: "reconnecting" });
          this.refresh();
        })
        .on(RoomEvent.Reconnected, () => {
          log("reconnected");
          this.set({ state: "connected" });
          this.refresh();
        })
        .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
          if (this.room !== room) return;
          const endReason: EndReason | undefined =
            reason === DisconnectReason.PARTICIPANT_REMOVED
              ? "kicked"
              : reason === DisconnectReason.ROOM_DELETED
                ? "deleted"
                : reason === DisconnectReason.DUPLICATE_IDENTITY
                  ? "duplicate"
                  : reason === DisconnectReason.CLIENT_INITIATED
                    ? undefined
                    : "lost";
          log("disconnected", { reason, endReason });
          if (endReason) cue("leave", this.ctx);
          this.teardown();
          this.set({ ...IDLE, host, room: roomId, endReason });
        });

      // Superseded attempts already had their room closed by teardown().
      await room.connect(url, token, { autoSubscribe: true });
      if (stale()) return;
      for (const p of room.remoteParticipants.values()) {
        for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
          p.getTrackPublication(source)?.setSubscribed(false);
        }
      }
      log("connected");
      this.set({ state: "connected" });
      // Published closed even in push-to-talk mode, so the first press
      // does not wait for the mic and the noise model to start.
      await this.publishMic(room);
      if (stale()) return;
      // After the noise model is up: starting it loads the CPU hard enough
      // to make a cue played meanwhile crackle.
      cue("join", this.ctx);
      this.refresh();
      this.startStats();
      this.meterTimer = setInterval(this.tickMeters, 50);
    } catch (e) {
      // A newer session owns the state now; this failure is not its problem.
      if (stale()) return;
      log("connect-failed", { msg: String((e as Error)?.message ?? e) });
      this.teardown();
      const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String(e.message) : String(e);
      this.set({ ...IDLE, host, room: roomId, error: msg, endReason: /full|max/i.test(msg) ? "full" : undefined });
      throw e;
    }
  }

  // Speaking indicator, measured here on the actual audio. LiveKit's own
  // active-speaker events come from the server, lag, and miss quiet speech.
  private meters = new Map<string, { track: MediaStreamTrack; src: MediaStreamAudioSourceNode; an: AnalyserNode }>();
  private lastLoud = new Map<string, number>();
  private speaking = new Set<string>();
  private meterTimer: ReturnType<typeof setInterval> | undefined;
  private meterBuf = new Float32Array(512);

  /**
   * How loud each participant's voice is right now, 0..1. It changes 20 times
   * a second, so it stays out of the snapshot: the UI subscribes with
   * `onLevels` and moves the ring without re-rendering.
   */
  readonly levels = new Map<string, number>();
  private levelListeners = new Set<() => void>();

  onLevels(fn: () => void) {
    this.levelListeners.add(fn);
    return () => void this.levelListeners.delete(fn);
  }

  /** The audio a participant actually sends: after noise suppression for us. */
  private audibleTrack(p: Participant): MediaStreamTrack | undefined {
    const pub = p.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track;
    if (!track || pub.isMuted) return undefined;
    if (p === this.room?.localParticipant) {
      return (track as LocalAudioTrack).getProcessor()?.processedTrack ?? track.mediaStreamTrack;
    }
    return track.mediaStreamTrack;
  }

  private tickMeters = () => {
    const room = this.room;
    const ctx = this.ctx;
    if (!room || !ctx) return;
    const now = performance.now();
    const present = new Set<string>();
    let changed = false;
    let levelsMoved = false;
    for (const p of [room.localParticipant, ...room.remoteParticipants.values()]) {
      present.add(p.identity);
      const track = this.audibleTrack(p);
      let meter = this.meters.get(p.identity);
      if (meter && meter.track !== track) {
        meter.src.disconnect();
        this.meters.delete(p.identity);
        meter = undefined;
      }
      if (!meter && track) {
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        // Only the voice band counts: rumble and hiss don't move the ring.
        const low = new BiquadFilterNode(ctx, { type: "highpass", frequency: 150 });
        const high = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 4000 });
        const an = ctx.createAnalyser();
        an.fftSize = this.meterBuf.length;
        src.connect(low).connect(high).connect(an);
        meter = { track, src, an };
        this.meters.set(p.identity, meter);
      }
      let target = 0;
      if (meter) {
        meter.an.getFloatTimeDomainData(this.meterBuf);
        let sum = 0;
        for (const v of this.meterBuf) sum += v * v;
        const rms = Math.sqrt(sum / this.meterBuf.length);
        if (rms > SPEAKING_RMS) this.lastLoud.set(p.identity, now);
        const db = 20 * Math.log10(rms || 1e-9);
        target = Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / (LEVEL_TOP_DB - LEVEL_FLOOR_DB)));
      }
      const prev = this.levels.get(p.identity) ?? 0;
      const level = target > prev ? target : prev * LEVEL_RELEASE < 0.01 ? 0 : prev * LEVEL_RELEASE;
      if (level !== prev) {
        this.levels.set(p.identity, level);
        levelsMoved = true;
      }
      const on = now - (this.lastLoud.get(p.identity) ?? -Infinity) < SPEAKING_HOLD_MS;
      if (on !== this.speaking.has(p.identity)) {
        if (on) this.speaking.add(p.identity);
        else this.speaking.delete(p.identity);
        changed = true;
      }
    }
    for (const [id, meter] of this.meters) {
      if (!present.has(id)) {
        meter.src.disconnect();
        this.meters.delete(id);
        this.speaking.delete(id);
      }
    }
    for (const id of this.levels.keys()) {
      if (!present.has(id)) this.levels.delete(id);
    }
    if (changed) this.refresh();
    if (levelsMoved) this.levelListeners.forEach((fn) => fn());
    this.sampleLevels(ctx);
  };

  // Our own mic before and after noise suppression, loudest 50 ms of every
  // 10 s, for the logs: voice in and silence out means the processing.
  private levelMeters = new Map<string, { track: MediaStreamTrack; src: MediaStreamAudioSourceNode; an: AnalyserNode }>();
  private levelPeak = { raw: 0, out: 0, ticks: 0 };

  private sampleLevels(ctx: AudioContext) {
    const track = this.micTrack();
    if (!track) return;
    const taps = { raw: rawTrack(track), out: track.mediaStreamTrack };
    for (const [key, t] of Object.entries(taps) as ["raw" | "out", MediaStreamTrack][]) {
      let m = this.levelMeters.get(key);
      if (m && m.track !== t) {
        m.src.disconnect();
        m = undefined;
      }
      if (!m) {
        const src = ctx.createMediaStreamSource(new MediaStream([t]));
        const an = ctx.createAnalyser();
        an.fftSize = this.meterBuf.length;
        src.connect(an);
        m = { track: t, src, an };
        this.levelMeters.set(key, m);
      }
      m.an.getFloatTimeDomainData(this.meterBuf);
      let sum = 0;
      for (const v of this.meterBuf) sum += v * v;
      this.levelPeak[key] = Math.max(this.levelPeak[key], Math.sqrt(sum / this.meterBuf.length));
    }
    if (++this.levelPeak.ticks < 200) return;
    const db = (v: number) => (v > 0 ? Math.round(20 * Math.log10(v)) : -120);
    log("level", {
      raw: db(this.levelPeak.raw),
      out: db(this.levelPeak.out),
      muted: this.snap.micMuted,
      published: !this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.isMuted,
      rawOn: taps.raw.enabled && taps.raw.readyState === "live" && !taps.raw.muted,
      nsCtx: (track.getProcessor() as VoicyNoiseProcessor | undefined)?.contextState,
    });
    this.levelPeak = { raw: 0, out: 0, ticks: 0 };
  }

  private stopMeters() {
    clearInterval(this.meterTimer);
    this.levelMeters.forEach((m) => m.src.disconnect());
    this.levelMeters.clear();
    this.levelPeak = { raw: 0, out: 0, ticks: 0 };
    this.meters.forEach((m) => m.src.disconnect());
    this.meters.clear();
    this.lastLoud.clear();
    this.speaking.clear();
    this.levels.clear();
    this.levelListeners.forEach((fn) => fn());
  }

  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private lastSent: { bytes: number; at: number } | null = null;

  private startStats() {
    clearInterval(this.statsTimer);
    this.lastSent = null;
    this.sendLow = false;
    this.lossy = this.clean = 0;
    this.peerNet.clear();
    this.lastRecv.clear();
    this.win = newWindow();
    const proc = this.micTrack()?.getProcessor();
    if (proc instanceof VoicyNoiseProcessor) proc.takeStats();
    this.statsTimer = setInterval(() => void this.sampleStats(), 1000);
  }

  private peerNet = new Map<string, PeerNet>();
  private lastRecv = new Map<string, { lost: number; got: number; samples: number; repaired: number; energy: number; dur: number; jbDelay: number; jbOut: number }>();

  /** Receive-side quality per remote peer, from WebRTC inbound stats. */
  private async sampleReceivers() {
    const room = this.room;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) {
      const receiver = p.getTrackPublication(Track.Source.Microphone)?.track?.receiver;
      if (!receiver) continue;
      (await receiver.getStats()).forEach((r) => {
        if (r.type !== "inbound-rtp" || r.kind !== "audio") return;
        const now = {
          lost: r.packetsLost ?? 0,
          got: r.packetsReceived ?? 0,
          samples: r.totalSamplesReceived ?? 0,
          repaired: (r.concealedSamples ?? 0) + (r.insertedSamplesForDeceleration ?? 0) + (r.removedSamplesForAcceleration ?? 0),
          energy: r.totalAudioEnergy ?? 0,
          dur: r.totalSamplesDuration ?? 0,
          jbDelay: r.jitterBufferDelay ?? 0,
          jbOut: r.jitterBufferEmittedCount ?? 0,
        };
        const prev = this.lastRecv.get(p.identity);
        this.lastRecv.set(p.identity, now);
        if (!prev) return;
        const packets = now.got - prev.got + (now.lost - prev.lost);
        const samples = now.samples - prev.samples;
        const repairPct = samples > 0 ? Math.round(((now.repaired - prev.repaired) / samples) * 1000) / 10 : 0;
        const net: PeerNet = {
          lossPct: packets > 0 ? Math.round(((now.lost - prev.lost) / packets) * 1000) / 10 : 0,
          jitterMs: Math.round((r.jitter ?? 0) * 1000),
          repairPct,
          bufferMs: this.adaptBuffer(p.identity, receiver, repairPct),
        };
        this.peerNet.set(p.identity, net);
        // How loud they arrive (average power of the second, before our
        // volume slider) and how long audio waits in the jitter buffer.
        const dur = now.dur - prev.dur;
        const db = dur > 0 ? 10 * Math.log10((now.energy - prev.energy) / dur + 1e-12) : undefined;
        const jbMs = now.jbOut > prev.jbOut ? ((now.jbDelay - prev.jbDelay) / (now.jbOut - prev.jbOut)) * 1000 : undefined;
        let w = this.win.peers.get(p.identity);
        if (!w) this.win.peers.set(p.identity, (w = { name: p.name || p.identity, n: 0, loss: 0, lossMax: 0, repair: 0, repairMax: 0, jitterMax: 0, jb: 0, jbN: 0, talk: 0, talkN: 0, peakDb: -120 }));
        w.n++;
        w.loss += net.lossPct;
        w.lossMax = Math.max(w.lossMax, net.lossPct);
        w.repair += repairPct;
        w.repairMax = Math.max(w.repairMax, repairPct);
        w.jitterMax = Math.max(w.jitterMax, net.jitterMs);
        if (jbMs !== undefined) {
          w.jb += jbMs;
          w.jbN++;
        }
        if (db !== undefined) {
          w.peakDb = Math.max(w.peakDb, db);
          if (db > TALK_DB) {
            w.talk += db;
            w.talkN++;
          }
        }
      });
    }
    this.refresh();
  }

  private bufferTarget = new Map<string, { ms: number; calm: number }>();

  /**
   * A jittery link makes the receiver speed speech up and slow it down to
   * keep playing, which sounds unsteady. When that happens, ask for a deeper
   * buffer: a little more delay, steady speech. Back off after calm spells.
   */
  private adaptBuffer(identity: string, receiver: RTCRtpReceiver, repairPct: number): number {
    const r = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null };
    if (!("jitterBufferTarget" in r)) return 0;
    const cur = this.bufferTarget.get(identity) ?? { ms: 0, calm: 0 };
    let ms = cur.ms;
    let calm = cur.calm;
    if (repairPct > NET_BAD.repairPct) {
      ms = Math.min(ms + 40, 240);
      calm = 0;
    } else if (repairPct < 0.5 && ms > 0 && ++calm >= 20) {
      ms = Math.max(0, ms - 20);
      calm = 0;
    }
    if (ms !== cur.ms) r.jitterBufferTarget = ms || null;
    this.bufferTarget.set(identity, { ms, calm });
    return ms;
  }

  private async sampleStats() {
    void this.sampleReceivers().catch(() => {});
    const sender = this.micTrack()?.sender;
    if (!sender) return this.set({ stats: undefined });
    const stats: AudioStats = {};
    const pairs: { local: string; ok: boolean }[] = [];
    const locals = new Map<string, string>();
    (await sender.getStats()).forEach((r) => {
      if (r.type === "candidate-pair") pairs.push({ local: r.localCandidateId, ok: r.state === "succeeded" && r.nominated });
      else if (r.type === "local-candidate") locals.set(r.id, r.candidateType === "relay" ? `relay-${r.relayProtocol ?? "?"}` : r.protocol);
      if (r.type === "outbound-rtp") {
        const now = r.timestamp as number;
        const bytes = r.bytesSent as number;
        if (this.lastSent && now > this.lastSent.at) {
          stats.sendKbps = Math.round(((bytes - this.lastSent.bytes) * 8) / (now - this.lastSent.at));
        }
        this.lastSent = { bytes, at: now };
      } else if (r.type === "remote-inbound-rtp") {
        if (typeof r.roundTripTime === "number") stats.rttMs = Math.round(r.roundTripTime * 1000);
        if (typeof r.fractionLost === "number") stats.lossPct = Math.round(r.fractionLost * 1000) / 10;
        if (typeof r.jitter === "number") stats.jitterMs = Math.round(r.jitter * 1000);
      }
    });
    this.set({ stats });
    this.refresh();
    void this.adaptSendBitrate(sender, stats.lossPct ?? 0);
    const w = this.win;
    w.n++;
    const pair = pairs.find((c) => c.ok);
    if (pair) w.path = locals.get(pair.local);
    if (stats.sendKbps !== undefined) {
      w.kbps += stats.sendKbps;
      w.kbpsN++;
    }
    if (stats.rttMs !== undefined) {
      w.rtt += stats.rttMs;
      w.rttN++;
    }
    w.lossMax = Math.max(w.lossMax, stats.lossPct ?? 0);
    w.jitterMax = Math.max(w.jitterMax, stats.jitterMs ?? 0);
    if (this.sendLow) w.low++;
    if (w.n >= STATS_LOG_SECS) this.logWindow();
  }

  private win = newWindow();

  /**
   * One `audio` event per ten seconds: how our voice leaves (mic chain and
   * uplink) and how everyone else arrives here. Read together with the
   * same event from the others to see where a voice gets lost.
   */
  private logWindow() {
    const w = this.win;
    this.win = newWindow();
    const avg = (sum: number, n: number) => (n ? Math.round(sum / n) : undefined);
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const proc = this.micTrack()?.getProcessor();
    const ctx = this.ctx;
    const volumes = getSettings().volumes;
    log("audio", {
      send: {
        kbps: avg(w.kbps, w.kbpsN),
        rtt: avg(w.rtt, w.rttN),
        lossMax: r1(w.lossMax),
        jitterMax: w.jitterMax,
        low: w.low || undefined,
        path: w.path,
      },
      mic: proc instanceof VoicyNoiseProcessor ? proc.takeStats() : undefined,
      micOn: !this.snap.micMuted,
      outMs: ctx ? Math.round(((ctx.outputLatency || 0) + ctx.baseLatency) * 1000) : undefined,
      peers: [...w.peers.entries()].map(([id, p]) => ({
        who: p.name,
        loss: r1(p.loss / p.n),
        lossMax: r1(p.lossMax),
        repair: r1(p.repair / p.n),
        repairMax: r1(p.repairMax),
        jitterMax: p.jitterMax,
        jbMs: avg(p.jb, p.jbN),
        bufferMs: this.bufferTarget.get(id)?.ms || undefined,
        talkDb: avg(p.talk, p.talkN),
        talkSecs: p.talkN,
        peakDb: Math.round(p.peakDb),
        vol: volumes[id] !== undefined && volumes[id] !== 1 ? volumes[id] : undefined,
      })),
    });
  }

  private sendLow = false;
  private lossy = 0;
  private clean = 0;

  /**
   * On a lossy uplink (weak Wi-Fi, a busy line) halve the Opus bitrate so
   * fewer packets are lost; RED stays on. Back to full quality after 20 s
   * of a clean line. Changes the live sender, no republish.
   */
  private async adaptSendBitrate(sender: RTCRtpSender, lossPct: number) {
    if (lossPct > 3) {
      this.lossy++;
      this.clean = 0;
    } else if (lossPct < 0.5) {
      this.clean++;
      this.lossy = 0;
    }
    const low = this.sendLow ? this.clean < 20 : this.lossy >= 3;
    if (low === this.sendLow) return;
    this.sendLow = low;
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    params.encodings[0].maxBitrate = (low ? 64 : getSettings().bitrate) * 1000;
    await sender.setParameters(params).catch((e) => console.warn("bitrate change failed", e));
  }

  private echoRoom: Room | null = null;

  /**
   * Echo test: a hidden second connection subscribes to your own mic, so you
   * hear yourself after Opus, noise suppression, the network and the SFU,
   * exactly like friends do.
   */
  async setEcho(on: boolean) {
    this.stopEcho();
    const room = this.room;
    const host = this.snap.host;
    if (!on || !room || !host || !this.ctx) return;
    const gen = this.generation;
    const { url, token } = await api<{ url: string; token: string }>(host, "POST", "/api/token", { echo: true, room: this.snap.room });
    if (gen !== this.generation || this.room !== room) return;
    const s = getSettings();
    const echo = new Room({
      adaptiveStream: false,
      webAudioMix: { audioContext: this.ctx },
      audioOutput: s.outputDevice ? { deviceId: s.outputDevice } : undefined,
    });
    const me = room.localParticipant.identity;
    const listen = (p: RemoteParticipant) => {
      if (p.identity === me) p.getTrackPublication(Track.Source.Microphone)?.setSubscribed(true);
    };
    echo
      .on(RoomEvent.TrackPublished, (_pub, p) => listen(p))
      .on(RoomEvent.ParticipantConnected, listen)
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => void track.attach())
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => void track.detach());
    this.echoRoom = echo;
    await echo.connect(url, token, { autoSubscribe: false });
    if (this.echoRoom !== echo) return void echo.disconnect();
    echo.remoteParticipants.forEach(listen);
    this.set({ echo: true });
  }

  private stopEcho() {
    const echo = this.echoRoom;
    this.echoRoom = null;
    echo?.removeAllListeners();
    void echo?.disconnect();
    if (this.snap.echo) this.set({ echo: false });
  }

  /** Mic track carried over from the previous room, with its processor. */
  private keptMic: LocalAudioTrack | undefined;

  /** `keepAudio`: leaving for another room, so the mic and playback stay up. */
  private teardown(keepAudio = false) {
    this.stopEcho();
    this.stopMeters();
    clearInterval(this.statsTimer);
    const room = this.room;
    this.room = null;
    this.watchedScreens.clear();
    this.micPublishing = null;
    this.micUpdate = Promise.resolve();
    room?.removeAllListeners();
    const mic = keepAudio ? (room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined) : undefined;
    if (mic) {
      if (this.keptMic !== mic) this.keptMic?.stop();
      this.keptMic = mic;
      // Everything but the mic ends with the room (e.g. a screen share).
      room?.localParticipant.trackPublications.forEach((pub) => pub.track !== mic && pub.track?.stop());
    }
    void room?.disconnect(!mic);
    if (!keepAudio) {
      this.keptMic?.stop();
      this.keptMic = undefined;
      // Closed a moment later, so a leave cue on it can finish.
      const ctx = this.ctx;
      setTimeout(() => void ctx?.close(), 800);
      this.ctx = null;
    }
  }

  async disconnect() {
    log("leave");
    if (this.room) cue("leave", this.ctx);
    void flushLogs();
    this.generation++;
    const { host, room } = this.snap;
    this.teardown();
    this.set({ ...IDLE, host, room });
  }

  /** Starting opens the system picker; what to show is chosen there. */
  async setScreenShare(enabled: boolean) {
    const room = this.room;
    if (!room || this.snap.state !== "connected") return;
    try {
      await room.localParticipant.setScreenShareEnabled(enabled, SCREEN_CAPTURE, SCREEN_PUBLISH);
    } catch (e) {
      // Left the room while the picker was open: nothing to report.
      if (this.room === room) throw e;
    }
    if (this.room === room) this.refresh();
  }

  /** Subscribe to a participant's shared video and sound only while viewing it. */
  watchScreen(identity: string, watching: boolean) {
    const participant = this.room?.remoteParticipants.get(identity);
    if (!participant) return;
    if (watching && !participant.getTrackPublication(Track.Source.ScreenShare)) return;
    if (watching) this.watchedScreens.add(identity);
    else this.watchedScreens.delete(identity);
    for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
      participant.getTrackPublication(source)?.setSubscribed(watching);
    }
    this.refresh();
  }

  async setMicMuted(muted: boolean, why = "?") {
    log("mic", { muted, why, deafened: this.snap.deafened });
    // Unmuting while deafened undeafens too: talking into a room you
    // cannot hear is never what the click meant.
    if (!muted && this.snap.deafened) {
      this.set({ deafened: false });
      this.room?.remoteParticipants.forEach((p) => this.applyVolume(p));
    }
    this.micWanted = !muted;
    this.set({ micMuted: muted });
    const room = this.room;
    if (room) await this.syncMic(room);
    this.refresh();
  }

  private micTrack(): LocalAudioTrack | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
  }

  /** Everything LiveKit, the browser or Windows does to our mic. */
  private watchMic(track: LocalAudioTrack) {
    watchTrack(rawTrack(track), "mic");
    for (const ev of [TrackEvent.Muted, TrackEvent.Unmuted, TrackEvent.Ended, TrackEvent.Restarted, TrackEvent.UpstreamPaused, TrackEvent.UpstreamResumed, TrackEvent.AudioSilenceDetected]) {
      track.on(ev as keyof TrackEventCallbacks, () => {
        const raw = rawTrack(track);
        log(`track-${ev}`, { label: raw.label, state: raw.readyState });
        if (ev === TrackEvent.Restarted) watchTrack(raw, "mic");
      });
    }
    track.on(TrackEvent.Ended, () => void this.recoverMic(track));
  }

  private recovering = false;

  /**
   * A USB mic that drops off the bus for a moment ends the track. LiveKit
   * tries to reopen it at once, while Windows still lists no device, and
   * then leaves it muted: friends hear nothing until a mute toggle. Keep
   * trying until the mic is back, then open it again as wanted.
   */
  private async recoverMic(track: LocalAudioTrack) {
    if (this.recovering) return;
    this.recovering = true;
    const room = this.room;
    const started = Date.now();
    const back = async () => {
      if (rawTrack(track).readyState !== "live") return false;
      if (track.isMuted && this.micWanted && !this.snap.deafened) await this.syncMic(room!);
      log("mic-recovered", { ms: Date.now() - started });
      return true;
    };
    try {
      for (let i = 0; i < 170; i++) {
        await new Promise((r) => setTimeout(r, 700));
        if (!room || this.room !== room || this.micTrack() !== track) return;
        if (await back()) return;
        await track.restartTrack(captureOptions()).catch((e) => {
          if (i % 10 === 0) log("mic-recover-failed", { msg: String(e?.message ?? e) });
        });
        if (this.room === room && this.micTrack() === track && (await back())) return;
      }
      log("mic-recover-gave-up");
    } finally {
      this.recovering = false;
    }
  }

  /** Serializes mute, push-to-talk and deafen, also during the first capture. */
  private syncMic(room: Room): Promise<void> {
    const pending = this.micUpdate
      .catch(() => {})
      .then(async () => {
        if (this.room !== room) return;
        if (this.micPublishing) await this.micPublishing.catch(() => {});
        if (this.room !== room) return;
        if (!this.micTrack()) {
          if (this.micWanted && !this.snap.deafened) await this.publishMic(room);
        } else {
          log("mic-sync", { on: this.micWanted && !this.snap.deafened });
          await room.localParticipant.setMicrophoneEnabled(this.micWanted && !this.snap.deafened);
        }
      });
    this.micUpdate = pending;
    return pending;
  }

  /**
   * Captures the mic and puts noise suppression on it before it is
   * published, so nobody ever hears the raw mic while the model loads.
   */
  private publishMic(room: Room): Promise<void> {
    if (this.room === room && this.micTrack()) return Promise.resolve();
    if (this.micPublishing) return this.micPublishing;
    const gen = this.generation;
    const current = () => this.room === room && gen === this.generation;
    const kept = this.keptMic;
    this.keptMic = undefined;
    const pending = (async () => {
      const reuse = kept && rawTrack(kept).readyState === "live" ? kept : undefined;
      if (kept && !reuse) kept.stop();
      log(reuse ? "mic-reuse" : "mic-capture");
      const track = reuse ?? (await createLocalAudioTrack(captureOptions()));
      if (!reuse) this.watchMic(track);
      let published = false;
      try {
        if (!current()) return;
        track.setAudioContext(this.ctx ?? undefined);
        await this.applyNoise(track, current);
        if (!current()) return;
        // Published closed, then opened to the latest wanted state: a toggle
        // during capture or negotiation cannot expose the mic early.
        await track.mute();
        await room.localParticipant.publishTrack(track, publishOptions());
        published = true;
        log("mic-published", { label: rawTrack(track).label, settings: track.getSourceTrackSettings() });
        if (current()) await room.localParticipant.setMicrophoneEnabled(this.micWanted && !this.snap.deafened);
      } finally {
        if (!published) track.stop();
      }
    })();
    this.micPublishing = pending;
    pending.catch((e) => log("mic-publish-failed", { msg: String(e?.message ?? e) }));
    void pending
      .finally(() => {
        if (this.micPublishing === pending) this.micPublishing = null;
      })
      .catch(() => {});
    return pending;
  }

  /**
   * Puts our processor on the mic track in the configured mode. It stays on
   * with suppression off too, because it also forces the track to mono.
   */
  private async applyNoise(track = this.micTrack(), report = () => true) {
    if (!track) return;
    let mode = getSettings().noise;
    const current = track.getProcessor();
    let notice: string | undefined;
    if (mode === "standard" || mode === "max") {
      const rtf = await dfnRealtimeFactor().catch(() => Infinity);
      if (rtf > DFN_MAX_REALTIME_FACTOR) {
        mode = "light";
        notice = "Процессор не тянет DeepFilterNet без треска, включено лёгкое шумоподавление.";
      }
    }
    try {
      if (current instanceof VoicyNoiseProcessor) {
        if (current.activeMode !== mode) await current.setMode(mode);
      } else {
        await track.setProcessor(new VoicyNoiseProcessor(mode));
      }
      if (report()) this.set({ noiseError: notice });
    } catch (e) {
      console.error("noise suppression failed", e);
      // DeepFilterNet is the heavy one; RNNoise is the safe fallback, and a
      // plain mono passthrough the last resort.
      await track.stopProcessor().catch(() => {});
      const fallback = mode === "standard" || mode === "max" ? "light" : "off";
      const ok = await track.setProcessor(new VoicyNoiseProcessor(fallback)).then(
        () => true,
        () => false,
      );
      if (report()) {
        this.set({
          noiseError: ok && fallback === "light" ? "DeepFilterNet не запустился, включено лёгкое шумоподавление." : "Шумоподавление не запустилось.",
        });
      }
    }
  }

  /** Deafen also mutes the mic, and undeafen restores what it was. */
  async setDeafened(deafened: boolean) {
    log("deafen", { deafened });
    this.set({ deafened });
    this.room?.remoteParticipants.forEach((p) => this.applyVolume(p));
    if (deafened) {
      this.set({ micMuted: true });
      if (this.room) await this.syncMic(this.room);
    } else {
      await this.setMicMuted(!this.micWanted, "undeafen");
    }
    this.refresh();
  }

  /** Mic toggle from the button or the hotkey, with a Discord-style cue. */
  async toggleMic(source = "button") {
    const muted = !this.snap.micMuted;
    cue(muted ? "off" : "on", this.ctx);
    await this.setMicMuted(muted, source);
  }

  async toggleDeafen(source = "button") {
    const deafened = !this.snap.deafened;
    log("deafen-toggle", { source });
    cue(deafened ? "off" : "on", this.ctx);
    await this.setDeafened(deafened);
  }

  /** Switching push-to-talk on closes the mic; switching it off reopens it. */
  async setPushToTalkMode(on: boolean) {
    clearTimeout(this.pttRelease);
    await this.setMicMuted(on, "ptt-mode");
  }

  private pttRelease: ReturnType<typeof setTimeout> | undefined;

  /**
   * Push-to-talk: live while held. The mic closes a moment after release so
   * the last word is not cut off, and key repeat does nothing.
   */
  async pushToTalk(held: boolean) {
    clearTimeout(this.pttRelease);
    if (!this.room || !getSettings().pushToTalk) return;
    if (held) {
      if (this.snap.micMuted) await this.setMicMuted(false, "ptt-down");
    } else {
      this.pttRelease = setTimeout(() => void this.setMicMuted(true, "ptt-up"), 250);
    }
  }

  setVolume(identity: string) {
    const p = this.room?.remoteParticipants.get(identity);
    if (p) this.applyVolume(p);
  }

  async startAudio() {
    await this.room?.startAudio();
    await this.ctx?.resume();
    this.refresh();
  }

  /** Re-applies device and processing settings to a live session. */
  async applyAudioSettings(opts: { republish?: boolean } = {}) {
    const room = this.room;
    if (!room) return;
    const s = getSettings();
    // "" is the system default and has to be applied explicitly too, or a
    // call stays on the previously chosen device.
    await room.switchActiveDevice("audiooutput", s.outputDevice || "default").catch((e) => console.warn("output switch failed", e));
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    if (!track) return;
    if (opts.republish) {
      // Bitrate is negotiated at publish time.
      await room.localParticipant.unpublishTrack(track, true);
      await this.publishMic(room);
    } else {
      await track.restartTrack(captureOptions());
      await this.applyNoise();
    }
    this.refresh();
  }

  clearEnd() {
    this.set({ endReason: undefined, error: undefined });
  }
}

export const voice = new VoiceSession();

export function useVoice(): VoiceSnapshot {
  return useSyncExternalStore(voice.subscribe, voice.getSnapshot);
}
