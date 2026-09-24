import { useSyncExternalStore } from "react";
import {
  AudioCaptureOptions,
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
}

export interface VoiceSnapshot {
  host: string | null;
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

  async connect(host: string) {
    const gen = ++this.generation;
    const stale = () => gen !== this.generation;
    this.teardown();
    this.set({ ...IDLE, host, state: "connecting", micMuted: !this.micWanted });

    try {
      const { url, token } = await api<{ url: string; token: string }>(host, "POST", "/api/token");
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
          this.set({ ...IDLE, host, endReason });
        });

      // Superseded attempts already had their room closed by teardown().
      await room.connect(url, token, { autoSubscribe: true });
      if (stale()) return;
      this.set({ state: "connected" });
      await room.localParticipant.setMicrophoneEnabled(this.micWanted);
      if (stale()) return;
      await this.applyNoise();
      this.refresh();
      this.startStats();
      this.meterTimer = setInterval(this.tickMeters, 50);
    } catch (e) {
      // A newer session owns the state now; this failure is not its problem.
      if (stale()) return;
      this.teardown();
      const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String(e.message) : String(e);
      this.set({ ...IDLE, host, error: msg, endReason: /full|max/i.test(msg) ? "full" : undefined });
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
    this.statsTimer = setInterval(() => void this.sampleStats(), 1000);
  }

  private async sampleStats() {
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
    const { url, token } = await api<{ url: string; token: string }>(host, "POST", "/api/token", { echo: true });
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
    room?.removeAllListeners();
    void room?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
  }

  async disconnect() {
    this.generation++;
    const host = this.snap.host;
    this.teardown();
    this.set({ ...IDLE, host });
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
    await this.room?.localParticipant.setMicrophoneEnabled(!muted);
    // The first unmute of a session creates the track.
    if (!muted) await this.applyNoise();
    this.refresh();
  }

  private micTrack(): LocalAudioTrack | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
  }

  /** Puts the configured noise suppressor on the mic track, or removes it. */
  private async applyNoise() {
    const track = this.micTrack();
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
      if (mode === "off") {
        if (current) await track.stopProcessor();
      } else if (current instanceof VoicyNoiseProcessor) {
        if (current.activeMode !== mode) await current.setMode(mode);
      } else {
        await track.setProcessor(new VoicyNoiseProcessor(mode));
      }
      this.set({ noiseError: notice });
    } catch (e) {
      console.error("noise suppression failed", e);
      // DeepFilterNet is the heavy one; RNNoise is the safe fallback.
      if (mode !== "light") {
        await track.stopProcessor().catch(() => {});
        await track.setProcessor(new VoicyNoiseProcessor("light")).catch(() => {});
      }
      this.set({ noiseError: `Шумоподавление «${mode}» не запустилось, включено лёгкое.` });
    }
  }

  /** Deafen also mutes the mic, and undeafen restores what it was. */
  async setDeafened(deafened: boolean) {
    this.set({ deafened });
    this.room?.remoteParticipants.forEach((p) => this.applyVolume(p));
    if (deafened) {
      await this.room?.localParticipant.setMicrophoneEnabled(false);
      this.set({ micMuted: true });
    } else {
      await this.setMicMuted(!this.micWanted);
    }
    this.refresh();
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
      await room.localParticipant.setMicrophoneEnabled(this.micWanted && !this.snap.deafened, captureOptions(), publishOptions());
    } else {
      await track.restartTrack(captureOptions());
    }
    await this.applyNoise();
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
