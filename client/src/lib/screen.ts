import { ScreenSharePresets, type ScreenShareCaptureOptions, type TrackPublishOptions } from "livekit-client";

/**
 * Sound is always requested: the system picker has its own "share system
 * audio" switch, so the choice stays there. restrictOwnAudio captures
 * through "loopbackWithoutChrome", which leaves out everything this WebView
 * plays, so viewers never hear the room echoed back.
 */
export const SCREEN_CAPTURE: ScreenShareCaptureOptions = {
  audio: { restrictOwnAudio: true, channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  systemAudio: "include",
  contentHint: "detail",
  resolution: ScreenSharePresets.h1080fps30.resolution,
};

/**
 * 1080p30 plus 720p and 360p copies. Each viewer gets the one that fits their
 * connection and how large the stream is on their screen, and layers nobody
 * watches are not encoded at all (dynacast).
 */
export const SCREEN_PUBLISH: TrackPublishOptions = {
  videoCodec: "vp8",
  backupCodec: false,
  simulcast: true,
  screenShareEncoding: { maxBitrate: 6_000_000, maxFramerate: 30 },
  screenShareSimulcastLayers: [ScreenSharePresets.h360fps15, ScreenSharePresets.h720fps30],
  // Text stays sharp; when the CPU or network is short, frames drop instead.
  degradationPreference: "maintain-resolution",
  // Stereo Opus, loud enough for music and games whatever the voice setting.
  audioPreset: { maxBitrate: 128_000 },
};
