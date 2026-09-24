import type { ScreenShareCaptureOptions, TrackPublishOptions } from "livekit-client";

export const SCREEN_QUALITIES = {
  "720p": { width: 1280, height: 720, bitrate: 3_000_000 },
  "1080p": { width: 1920, height: 1080, bitrate: 5_000_000 },
  "2K": { width: 2560, height: 1440, bitrate: 10_000_000 },
  "4K": { width: 3840, height: 2160, bitrate: 18_000_000 },
} as const;

export type ScreenQuality = keyof typeof SCREEN_QUALITIES;
export type ScreenSource = "monitor" | "window";

export function screenOptions(quality: ScreenQuality, source: ScreenSource, audio: boolean): {
  capture: ScreenShareCaptureOptions;
  publish: TrackPublishOptions;
} {
  const { width, height, bitrate } = SCREEN_QUALITIES[quality];
  return {
    capture: {
      audio: audio ? { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      systemAudio: audio ? "include" : "exclude",
      video: { displaySurface: source },
      contentHint: "detail",
      resolution: { width, height, frameRate: 30 },
    },
    publish: {
      screenShareEncoding: { maxBitrate: bitrate, maxFramerate: 30 },
      simulcast: false,
      degradationPreference: "maintain-resolution",
    },
  };
}
