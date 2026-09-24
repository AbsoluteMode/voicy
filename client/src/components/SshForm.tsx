import { useEffect, useRef, useState } from "react";

import { defaultSshKey, SshCreds } from "../lib/tauri";

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

  const creds = (): SshCreds => ({
    host: state.host.trim(),
    port: Number(state.port) || 22,
    user: state.user.trim(),
    auth:
      state.method === "password"
        ? { kind: "password", password: state.password }
        : { kind: "key", path: state.keyPath.trim(), passphrase: state.passphrase || undefined },
  });

  return { state, setState, valid, creds };
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
