import { useEffect, useRef, useState } from "react";

import { defaultSshKey, errorCode, errorText, SshCreds } from "../lib/tauri";

export interface SshFormState {
  host: string;
  port: string;
  user: string;
  method: "password" | "key";
  password: string;
  keyPath: string;
  passphrase: string;
}

export function useSshForm() {
  const [state, setState] = useState<SshFormState>({
    host: "",
    port: "22",
    user: "root",
    method: "password",
    password: "",
    keyPath: "",
    passphrase: "",
  });
  const probed = useRef(false);
  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    defaultSshKey()
      .then((path) => path && setState((s) => ({ ...s, method: "key", keyPath: path })))
      .catch(() => {});
  }, []);

  const valid =
    state.host.trim() !== "" &&
    state.user.trim() !== "" &&
    Number(state.port) > 0 &&
    (state.method === "password" ? state.password !== "" : state.keyPath.trim() !== "");

  // SSH host key trust: the backend refuses unknown or changed server keys
  // before sending any credential, and the user decides here.
  const [hostKey, setHostKey] = useState<{ kind: "unknown" | "changed"; fingerprint: string } | null>(null);
  const [trust, setTrust] = useState<{ fingerprint: string; replace: boolean } | null>(null);
  const endpoint = `${state.host.trim().toLowerCase()}:${state.port}`;
  useEffect(() => {
    setHostKey(null);
    setTrust(null);
  }, [endpoint]);

  const creds = (override = trust): SshCreds => ({
    host: state.host.trim(),
    port: Number(state.port) || 22,
    user: state.user.trim(),
    auth:
      state.method === "password"
        ? { kind: "password", password: state.password }
        : { kind: "key", path: state.keyPath.trim(), passphrase: state.passphrase || undefined },
    trust_fingerprint: override?.fingerprint,
    replace_known: override?.replace ?? false,
  });

  /** True if `e` was a host key question, which is now shown to the user. */
  const catchHostKey = (e: unknown) => {
    const code = errorCode(e);
    if (code !== "hostkey_unknown" && code !== "hostkey_changed") return false;
    setHostKey({ kind: code === "hostkey_unknown" ? "unknown" : "changed", fingerprint: errorText(e) });
    return true;
  };

  /** Trusts the shown key and returns credentials to retry with. */
  const approveHostKey = (): SshCreds => {
    const next = hostKey ? { fingerprint: hostKey.fingerprint, replace: hostKey.kind === "changed" } : trust;
    setTrust(next);
    setHostKey(null);
    return creds(next);
  };

  const dismissHostKey = () => setHostKey(null);

  return { state, setState, valid, creds, hostKey, catchHostKey, approveHostKey, dismissHostKey };
}

/** Asks the user to trust a first-seen (or changed) SSH server key. */
export function HostKeyPrompt({ form, onApprove }: { form: ReturnType<typeof useSshForm>; onApprove: () => void }) {
  const k = form.hostKey;
  if (!k) return null;
  const changed = k.kind === "changed";
  return (
    <div className={changed ? "error" : "notice"} style={{ marginTop: 0 }}>
      {changed ? (
        <>
          <b>Ключ сервера изменился.</b> Так бывает, если ты переустановил систему на VPS. Если нет, кто-то может перехватывать подключение: ничего не отправляй.
        </>
      ) : (
        <>
          <b>Первое подключение к {form.state.host.trim()}.</b> Сверь отпечаток ключа сервера с панелью хостера или с выводом команды{" "}
          <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> на сервере.
        </>
      )}
      <div className="selectable" style={{ fontFamily: "Cascadia Mono, Consolas, monospace", margin: "8px 0", wordBreak: "break-all" }}>
        {k.fingerprint}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn" onClick={form.dismissHostKey}>Отмена</button>
        <button type="button" className={`btn ${changed ? "danger" : "primary"}`} onClick={onApprove}>
          {changed ? "Я переустанавливал VPS, доверять" : "Доверять и продолжить"}
        </button>
      </div>
    </div>
  );
}

export function SshForm({ form, disabled }: { form: ReturnType<typeof useSshForm>; disabled?: boolean }) {
  const { state: s, setState } = form;
  const set = (patch: Partial<SshFormState>) => setState((prev) => ({ ...prev, ...patch }));
  return (
    <fieldset disabled={disabled} style={{ border: "none", padding: 0, margin: 0 }}>
      <div className="row">
        <label className="field" style={{ flex: 3 }}>
          <span>IP или адрес VPS</span>
          <input type="text" autoFocus placeholder="203.0.113.10" value={s.host} onChange={(e) => set({ host: e.target.value })} />
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>SSH-порт</span>
          <input type="number" min={1} max={65535} value={s.port} onChange={(e) => set({ port: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>Пользователь</span>
        <input type="text" value={s.user} onChange={(e) => set({ user: e.target.value })} />
        {s.user.trim() !== "root" && <small>Нужен sudo. С ключом sudo должен работать без пароля.</small>}
      </label>
      <div className="field">
        <span>Вход</span>
        <div className="seg">
          <button type="button" className={s.method === "password" ? "on" : ""} onClick={() => set({ method: "password" })}>Пароль</button>
          <button type="button" className={s.method === "key" ? "on" : ""} onClick={() => set({ method: "key" })}>SSH-ключ</button>
        </div>
      </div>
      {s.method === "password" ? (
        <label className="field">
          <span>Пароль</span>
          <input type="password" value={s.password} onChange={(e) => set({ password: e.target.value })} />
          <small>Используется только для этой установки и нигде не сохраняется.</small>
        </label>
      ) : (
        <>
          <label className="field">
            <span>Путь к приватному ключу</span>
            <input type="text" placeholder="C:\Users\you\.ssh\id_ed25519" value={s.keyPath} onChange={(e) => set({ keyPath: e.target.value })} />
          </label>
          <label className="field">
            <span>Пароль от ключа (если есть)</span>
            <input type="password" value={s.passphrase} onChange={(e) => set({ passphrase: e.target.value })} />
          </label>
        </>
      )}
    </fieldset>
  );
}

export function LogView({ lines }: { lines: { text: string; kind?: "ok" | "err" }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);
  return (
    <div className="log selectable" ref={ref}>
      {lines.map((l, i) => (
        <div key={i} className={l.kind}>{l.text}</div>
      ))}
    </div>
  );
}
