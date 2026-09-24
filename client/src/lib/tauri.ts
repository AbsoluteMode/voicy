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
}

/** Shape of every rejected command, see src-tauri/src/error.rs. */
export interface CmdError {
  code: "unauthorized" | "gone" | "forbidden" | "network" | "ssh" | "invalid" | "other";
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

export function api<T>(host: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) {
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

export function uninstallServer(ssh: SshCreds, onLog: (line: string) => void) {
  return invoke<void>("uninstall_server", { ssh, onLog: logChannel(onLog) });
}
