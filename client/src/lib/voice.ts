import { useSyncExternalStore } from "react";
import {
  AudioCaptureOptions,
  createLocalAudioTrack,
  DisconnectReason,
  LocalAudioTrack,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  TrackPublishOptions,
} from "livekit-client";

import { DFN_MAX_REALTIME_FACTOR, dfnRealtimeFactor, VoicyNoiseProcessor } from "./noise";
import { getSettings } from "./settings";
import { api, Role, saveRecording } from "./tauri";

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
}

export interface PeerNet {
  lossPct: number;
  jitterMs: number;
  /** Share of played audio the receiver had to invent or time-stretch:
   *  what "chewed" or robotic speech is made of. */
  repairPct: number;
  /** Measured receive jitter-buffer delay over the last sample, ms. */
  bufferMs?: number;
}

/** Above either, the peer's connection is audibly unstable. */
export const NET_BAD = { lossPct: 2, repairPct: 3 };

export interface VoiceSnapshot {
  host: string | null;
  /** Voice room id (r1, r2, ...) on that host. */
  room: string | null;
  state: ConnState;
  peers: Peer[];
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
  micMuted: false,
  deafened: false,
  audioBlocked: false,
  echo: false,
};

/** RMS above this (about -40 dBFS) counts as speech. */
const SPEAKING_RMS = 0.01;
/** Keeps the ring lit between words instead of flickering. */
const SPEAKING_HOLD_MS = 350;

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

/** Two short tones: rising when something turns on, falling when off. */
function cue(kind: "on" | "off") {
  try {
    const ctx = new AudioContext();
    const tones = kind === "on" ? [520, 780] : [640, 420];
    tones.forEach((hz, i) => {
      const osc = new OscillatorNode(ctx, { frequency: hz, type: "sine" });
      const gain = new GainNode(ctx, { gain: 0 });
      const t = ctx.currentTime + i * 0.07;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
    });
    setTimeout(() => void ctx.close(), 400);
  } catch {
    // Cues are a nicety.
  }
}

/** Mono 16-bit PCM WAV. */
function wav16(chunks: Float32Array[], rate: number): Uint8Array {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (const s of c) {
      v.setInt16(o, Math.max(-1, Math.min(1, s)) * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
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
    }));
    peers.sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name));
    this.set({ peers, audioBlocked: !room.canPlaybackAudio });
  };

  private applyVolume(p: RemoteParticipant) {
    const v = this.snap.deafened ? 0 : (getSettings().volumes[p.identity] ?? 1);
    p.setVolume(v);
  }

  /**
   * Bumped by every connect and disconnect. An attempt that finds it changed
   * after an await has been superseded and must not touch the mic or state.
   */
  private generation = 0;

  async connect(host: string, roomId: string) {
    const gen = ++this.generation;
    const stale = () => gen !== this.generation;
    this.teardown();
    // In push-to-talk mode the mic starts closed.
    if (getSettings().pushToTalk) this.micWanted = false;
    this.set({ ...IDLE, host, room: roomId, state: "connecting", micMuted: !this.micWanted });

    try {
      const { url, token } = await api<{ url: string; token: string }>(host, "POST", "/api/token", { room: roomId });
      if (stale()) return;

      // One 48 kHz context for all playback: no resampling, and gain nodes
      // let per-member volume go above 100%.
      const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
      this.ctx = ctx;
      const s = getSettings();
      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
        webAudioMix: { audioContext: ctx },
        audioCaptureDefaults: captureOptions(),
        audioOutput: s.outputDevice ? { deviceId: s.outputDevice } : undefined,
        publishDefaults: publishOptions(),
        disconnectOnPageLeave: true,
      });
      this.room = room;

      room
        .on(RoomEvent.ParticipantConnected, (p) => {
          this.applyVolume(p);
          this.refresh();
        })
        .on(RoomEvent.ParticipantDisconnected, this.refresh)
        .on(RoomEvent.ActiveSpeakersChanged, this.refresh)
        .on(RoomEvent.TrackMuted, this.refresh)
        .on(RoomEvent.TrackUnmuted, this.refresh)
        .on(RoomEvent.LocalTrackPublished, this.refresh)
        .on(RoomEvent.ParticipantNameChanged, this.refresh)
        .on(RoomEvent.ParticipantMetadataChanged, this.refresh)
        .on(RoomEvent.AudioPlaybackStatusChanged, this.refresh)
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
        .on(RoomEvent.Reconnecting, () => this.set({ state: "reconnecting" }))
        .on(RoomEvent.Reconnected, () => this.set({ state: "connected" }))
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
          this.teardown();
          this.set({ ...IDLE, host, room: roomId, endReason });
        });

      // Superseded attempts already had their room closed by teardown().
      await room.connect(url, token, { autoSubscribe: true });
      if (stale()) return;
      this.set({ state: "connected" });
      if (this.micWanted && !this.micTrack()) await this.publishMic(room);
      if (stale()) return;
      this.refresh();
      this.startStats();
      this.meterTimer = setInterval(this.tickMeters, 50);
    } catch (e) {
      // A newer session owns the state now; this failure is not its problem.
      if (stale()) return;
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
        const an = ctx.createAnalyser();
        an.fftSize = this.meterBuf.length;
        src.connect(an);
        meter = { track, src, an };
        this.meters.set(p.identity, meter);
      }
      if (meter) {
        meter.an.getFloatTimeDomainData(this.meterBuf);
        let sum = 0;
        for (const v of this.meterBuf) sum += v * v;
        if (Math.sqrt(sum / this.meterBuf.length) > SPEAKING_RMS) this.lastLoud.set(p.identity, now);
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
    if (changed) this.refresh();
  };

  private stopMeters() {
    clearInterval(this.meterTimer);
    this.meters.forEach((m) => m.src.disconnect());
    this.meters.clear();
    this.lastLoud.clear();
    this.speaking.clear();
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
    this.statsTimer = setInterval(() => void this.sampleStats(), 1000);
  }

  private peerNet = new Map<string, PeerNet>();
  private lastRecv = new Map<string, { lost: number; got: number; samples: number; repaired: number; bufferDelay?: number; bufferEmitted?: number }>();

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
          bufferDelay: r.jitterBufferDelay as number | undefined,
          bufferEmitted: r.jitterBufferEmittedCount as number | undefined,
        };
        const prev = this.lastRecv.get(p.identity);
        this.lastRecv.set(p.identity, now);
        if (!prev) return;
        const packets = now.got - prev.got + (now.lost - prev.lost);
        const samples = now.samples - prev.samples;
        const repairPct = samples > 0 ? Math.round(((now.repaired - prev.repaired) / samples) * 1000) / 10 : 0;
        // Concealment also comes from packet loss, which a deeper buffer
        // cannot fix. Leave playout adaptation to WebRTC and report its
        // measured delay instead of forcing a target from repairPct.
        const emitted = now.bufferEmitted !== undefined && prev.bufferEmitted !== undefined ? now.bufferEmitted - prev.bufferEmitted : 0;
        const delay = now.bufferDelay !== undefined && prev.bufferDelay !== undefined ? now.bufferDelay - prev.bufferDelay : -1;
        const bufferMs = emitted > 0 && delay >= 0
          ? Math.round((delay / emitted) * 1000)
          : undefined;
        this.peerNet.set(p.identity, {
          lossPct: packets > 0 ? Math.round(((now.lost - prev.lost) / packets) * 1000) / 10 : 0,
          jitterMs: Math.round((r.jitter ?? 0) * 1000),
          repairPct,
          bufferMs,
        });
      });
    }
    this.refresh();
  }

  /**
   * Records how a friend actually sounds here, after the network and the
   * receiver, to a WAV in Downloads with a per-second stats timeline.
   */
  async recordPeer(identity: string, seconds: number, onTick: (left: number) => void): Promise<string> {
    const p = this.room?.remoteParticipants.get(identity);
    const track = p?.getTrackPublication(Track.Source.Microphone)?.track;
    if (!p || !track) throw new Error("у участника сейчас нет звука");
    const ctx = new AudioContext({ sampleRate: 48000 });
    const worklet = `class R extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("voicy-recorder",R)`;
    const url = URL.createObjectURL(new Blob([worklet], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, "voicy-recorder", { numberOfOutputs: 0 });
    const chunks: Float32Array[] = [];
    node.port.onmessage = (e) => chunks.push(e.data as Float32Array);
    const src = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    src.connect(node);
    const timeline: unknown[] = [];
    for (let left = seconds; left > 0; left--) {
      onTick(left);
      await new Promise((r) => setTimeout(r, 1000));
      timeline.push({ t: seconds - left + 1, ...this.peerNet.get(identity) });
    }
    src.disconnect();
    await ctx.close();
    const stats = JSON.stringify({ name: p.name, identity, seconds, settings: getSettings(), timeline }, null, 1);
    return saveRecording(p.name || identity, wav16(chunks, 48000), stats);
  }

  private async sampleStats() {
    void this.sampleReceivers().catch(() => {});
    const sender = this.micTrack()?.sender;
    if (!sender) return this.set({ stats: undefined });
    const stats: AudioStats = {};
    (await sender.getStats()).forEach((r) => {
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
    void this.adaptSendBitrate(sender, stats.lossPct ?? 0);
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

  private teardown() {
    this.stopEcho();
    this.stopMeters();
    clearInterval(this.statsTimer);
    const room = this.room;
    this.room = null;
    this.micPublishing = null;
    this.micUpdate = Promise.resolve();
    room?.removeAllListeners();
    void room?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
  }

  async disconnect() {
    this.generation++;
    const { host, room } = this.snap;
    this.teardown();
    this.set({ ...IDLE, host, room });
  }

  async setMicMuted(muted: boolean) {
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

  /** Serialize mute/PTT changes, including toggles during first capture. */
  private syncMic(room: Room): Promise<void> {
    const pending = this.micUpdate.catch(() => {}).then(async () => {
      if (this.room !== room) return;
      if (this.micPublishing) await this.micPublishing.catch(() => {});
      if (this.room !== room) return;
      if (!this.micTrack()) {
        if (this.micWanted && !this.snap.deafened) await this.publishMic(room);
      } else {
        await room.localParticipant.setMicrophoneEnabled(this.micWanted && !this.snap.deafened);
      }
    });
    this.micUpdate = pending;
    return pending;
  }

  /** Process the captured mic before it can be sent to anyone in the room. */
  private publishMic(room: Room): Promise<void> {
    if (this.room === room && this.micTrack()) return Promise.resolve();
    if (this.micPublishing) return this.micPublishing;
    const gen = this.generation;
    const pending = (async () => {
      const track = await createLocalAudioTrack(captureOptions());
      let published = false;
      try {
        if (this.room !== room || gen !== this.generation) return;
        track.setAudioContext(this.ctx ?? undefined);
        // If every processor fails, applyNoise reports it in the UI. Keep
        // voice available with the captured track, as before this change.
        await this.applyNoise(track, () => this.room === room && gen === this.generation);
        if (this.room !== room || gen !== this.generation) return;
        // Publish closed, then apply the latest mute state. A toggle during
        // capture or negotiation cannot expose the mic before setup finishes.
        await track.mute();
        await room.localParticipant.publishTrack(track, publishOptions());
        published = true;
        if (this.room === room && gen === this.generation) {
          await room.localParticipant.setMicrophoneEnabled(this.micWanted && !this.snap.deafened);
        }
      } finally {
        if (!published) track.stop();
      }
    })();
    this.micPublishing = pending;
    void pending.finally(() => {
      if (this.micPublishing === pending) this.micPublishing = null;
    }).catch(() => {});
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
    this.set({ deafened });
    this.room?.remoteParticipants.forEach((p) => this.applyVolume(p));
    if (deafened) {
      this.set({ micMuted: true });
      if (this.room) await this.syncMic(this.room);
    } else {
      await this.setMicMuted(!this.micWanted);
    }
    this.refresh();
  }

  /** Mic toggle from the button or the hotkey, with a Discord-style cue. */
  async toggleMic() {
    const muted = !this.snap.micMuted;
    cue(muted ? "off" : "on");
    await this.setMicMuted(muted);
  }

  async toggleDeafen() {
    const deafened = !this.snap.deafened;
    cue(deafened ? "off" : "on");
    await this.setDeafened(deafened);
  }

  /** Switching push-to-talk on closes the mic; switching it off reopens it. */
  async setPushToTalkMode(on: boolean) {
    clearTimeout(this.pttRelease);
    await this.setMicMuted(on);
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
      if (this.snap.micMuted) await this.setMicMuted(false);
    } else {
      this.pttRelease = setTimeout(() => void this.setMicMuted(true), 250);
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
      if (this.micWanted && !this.snap.deafened) await this.publishMic(room);
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
