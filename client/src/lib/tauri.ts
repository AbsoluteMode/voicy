import { Channel, invoke } from "@tauri-apps/api/core";

export type Role = "owner" | "admin" | "member";

export interface SavedServer {
  host: string;
  name: string;
  member_id: string;
  nickname: string;
  role: Role;
}

export interface Member {
  id: string;
  nickname: string;
  role: Role;
  created_at: number;
  /** Picture version, see `avatarUrl`; null when there is none. */
  avatar?: string | null;
  /** Has Voicy open right now; absent on servers from before presence. */
  online?: boolean;
}

/** A voice room from `/api/rooms`: all occupied rooms plus one empty. */
export interface RoomInfo {
  id: string;
  name: string;
  participants: { id: string; name: string }[];
}

export interface ChatMessage {
  id: number;
  room?: string;
  member_id: string;
  nickname: string;
  text: string;
  created_at: number;
}

export interface DirectThread {
  peer_id: string;
  nickname: string;
  message_id: number;
  member_id: string;
  text: string;
  created_at: number;
}

export interface Invite {
  id: string;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  link?: string;
}

export type SshAuth =
  | { kind: "password"; password: string }
  | { kind: "key"; path: string; passphrase?: string };

export interface SshCreds {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  /** Server key fingerprint the user approved. */
  trust_fingerprint?: string;
  /** The user confirmed a changed server key is expected. */
  replace_known?: boolean;
}

/**
 * Shape of every rejected command, see src-tauri/src/error.rs. For the
 * hostkey codes the message is the server's key fingerprint.
 */
export interface CmdError {
  code:
    | "unauthorized"
    | "gone"
    | "forbidden"
    | "network"
    | "ssh"
    | "hostkey_unknown"
    | "hostkey_changed"
    | "invalid"
    | "other";
  message: string;
}

export function errorCode(e: unknown): CmdError["code"] | undefined {
  return typeof e === "object" && e !== null && "code" in e ? (e as CmdError).code : undefined;
}

export function errorText(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) return String((e as CmdError).message);
  return String(e);
}

export const listServers = () => invoke<SavedServer[]>("list_servers");
export const joinServer = (link: string, nickname: string) =>
  invoke<SavedServer>("join_server", { link, nickname });
export const forgetServer = (host: string) => invoke<void>("forget_server", { host });
export const defaultSshKey = () => invoke<string | null>("default_ssh_key");
export const inviteFromClipboard = () => invoke<string | null>("invite_from_clipboard");
export const inviteInfo = (link: string) => invoke<{ name: string; host: string; deleted: boolean }>("invite_info", { link });
export const osUsername = () => invoke<string | null>("os_username");

export function api<T>(host: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) {
  return invoke<T>("api_request", { host, method, path, body: body ?? null });
}

function logChannel(onLog: (line: string) => void) {
  const ch = new Channel<string>();
  ch.onmessage = onLog;
  return ch;
}

export function deployServer(
  req: { ssh: SshCreds; server_name: string; nickname: string },
  onLog: (line: string) => void,
) {
  return invoke<SavedServer>("deploy_server", { req, onLog: logChannel(onLog) });
}

export function createLocalServer(serverName: string, nickname: string, onLog: (line: string) => void) {
  return invoke<SavedServer>("create_local_server", { serverName, nickname, onLog: logChannel(onLog) });
}

export function uninstallServer(ssh: SshCreds, onLog: (line: string) => void) {
  return invoke<void>("uninstall_server", { ssh, onLog: logChannel(onLog) });
}

/** Members' pictures are public by id, so a plain `<img>` can show them. */
export const avatarUrl = (host: string, memberId: string, version: string) =>
  `${host === "127.0.0.1:8080" ? "http" : "https"}://${host}/api/avatars/${encodeURIComponent(memberId)}?v=${encodeURIComponent(version)}`;

export interface Pin {
  id: string;
  thumb: string;
  full: string;
}

export const pinterestSearch = (query: string, bookmark?: string | null) =>
  invoke<{ pins: Pin[]; bookmark: string | null }>("pinterest_search", { query, bookmark: bookmark ?? null });
export const pinterestImage = (url: string) => invoke<ArrayBuffer>("pinterest_image", { url });
