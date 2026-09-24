/**
 * Voicy's own glyphs: filled shapes with cut-out details, so the main
 * controls read at a glance. Colors come from `currentColor`; the cut-outs
 * use `--cut`, which should match the surface the icon sits on.
 */
type P = { size?: number };

const cut = "var(--cut, #18181c)";

export function Logo({ size = 22 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" aria-hidden>
      <path d="M4 12.2C5.4 10.6 6.6 9.6 8.4 9.6C11.6 9.6 12.6 22.6 16 22.6C19.4 22.6 20.4 9.6 23.6 9.6C25.4 9.6 26.6 10.6 28 12.2" />
    </svg>
  );
}

export function MicIcon({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="8" y="2.5" width="8" height="12.5" rx="4" fill="currentColor" />
      <path d="M9.8 6.8h4.4M9.8 9.6h4.4" stroke={cut} strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5 11.5a7 7 0 0 0 14 0M12 18.5v3M9 21.5h6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function MicOffIcon({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="8" y="2.5" width="8" height="12.5" rx="4" fill="currentColor" />
      <path d="M5 11.5a7 7 0 0 0 11.2 5.6M19 11.5a7 7 0 0 1-.6 2.8M12 18.5v3M9 21.5h6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M3.5 3.5l17 17" stroke={cut} strokeWidth="5" strokeLinecap="round" />
      <path d="M3.5 3.5l17 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function HeadphonesIcon({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M4.2 15.5V12a7.8 7.8 0 0 1 15.6 0v3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <rect x="2.5" y="12.8" width="6" height="8.7" rx="2.6" fill="currentColor" />
      <rect x="15.5" y="12.8" width="6" height="8.7" rx="2.6" fill="currentColor" />
      <path d="M5.5 15.3v3.7M18.5 15.3v3.7" stroke={cut} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function HeadphonesOffIcon({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M4.2 15.5V12a7.8 7.8 0 0 1 15.6 0v3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <rect x="2.5" y="12.8" width="6" height="8.7" rx="2.6" fill="currentColor" />
      <rect x="15.5" y="12.8" width="6" height="8.7" rx="2.6" fill="currentColor" />
      <path d="M3.5 3.5l17 17" stroke={cut} strokeWidth="5" strokeLinecap="round" />
      <path d="M3.5 3.5l17 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function SlidersIcon({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M4 7.5h16M4 16.5h16" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" opacity=".55" />
      <circle cx="15" cy="7.5" r="3" fill="currentColor" />
      <circle cx="9" cy="16.5" r="3" fill="currentColor" />
    </svg>
  );
}

export function HangUpIcon({ size = 22 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M2.6 14.2a1.3 1.3 0 0 1 0-1.8C5.5 9.6 8.6 8.2 12 8.2s6.5 1.4 9.4 4.2a1.3 1.3 0 0 1 0 1.8l-2 2a1.3 1.3 0 0 1-1.7.1l-2.3-1.8a1.3 1.3 0 0 1-.5-1v-2.2a9 9 0 0 0-5.8 0v2.2c0 .4-.2.8-.5 1l-2.3 1.8a1.3 1.3 0 0 1-1.7-.1z" />
    </svg>
  );
}

/** Rotated handset: joining a call. */
export function PhoneIcon({ size = 20 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M2.6 14.2a1.3 1.3 0 0 1 0-1.8C5.5 9.6 8.6 8.2 12 8.2s6.5 1.4 9.4 4.2a1.3 1.3 0 0 1 0 1.8l-2 2a1.3 1.3 0 0 1-1.7.1l-2.3-1.8a1.3 1.3 0 0 1-.5-1v-2.2a9 9 0 0 0-5.8 0v2.2c0 .4-.2.8-.5 1l-2.3 1.8a1.3 1.3 0 0 1-1.7-.1z" transform="rotate(135 12 12)" />
    </svg>
  );
}

export function WeakSignalIcon({ size = 13 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="3" y="15" width="4" height="6" rx="1.5" />
      <rect x="10" y="10" width="4" height="11" rx="1.5" opacity=".35" />
      <rect x="17" y="4" width="4" height="17" rx="1.5" opacity=".35" />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MoreIcon({ size = 17 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

export function DownloadIcon({ size = 18 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
    </svg>
  );
}
