import { Circle, LogOut, Pencil, Shield, ShieldOff, Trash2, UserMinus } from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState, WheelEvent } from "react";

import { updateSettings, useSettings } from "../lib/settings";
import { api, errorCode, errorText, forgetServer, Member, Role, RoomInfo, SavedServer } from "../lib/tauri";
import { AudioStats, EndReason, NET_BAD, Peer, useVoice, voice } from "../lib/voice";
import { DeleteDialog } from "./DeleteDialog";
import {
  HangUpIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  MicIcon,
  MicOffIcon,
  MoreIcon,
  PhoneIcon,
  PlusIcon,
  SlidersIcon,
  WeakSignalIcon,
} from "./icons";
import { InviteDialog } from "./InviteDialog";
import { SettingsDialog } from "./SettingsDialog";
import { colorFor, initials, Modal, RoleBadge } from "./ui";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

const END_TEXT: Record<EndReason, string> = {
  kicked: "Тебя выгнали с сервера.",
  deleted: "Владелец удалил этот сервер.",
  duplicate: "Ты подключился к этому серверу с другого устройства.",
  lost: "Связь с сервером потеряна.",
  full: "В комнате уже максимум участников (10).",
};

function statsTitle(s?: AudioStats) {
  if (!s) return "";
  return [
    s.sendKbps !== undefined && `${s.sendKbps} кбит/с`,
    s.rttMs !== undefined && `пинг ${s.rttMs} мс`,
    s.lossPct !== undefined && `потери ${s.lossPct}%`,
    s.jitterMs !== undefined && `джиттер ${s.jitterMs} мс`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Twelve segments; they only move while someone is actually talking. */
function Level({ live }: { live: boolean }) {
  return (
    <div className={`lvl${live ? " live" : ""}`} aria-hidden>
      {Array.from({ length: 12 }, (_, i) => <i key={i} />)}
    </div>
  );
}

/**
 * Saves 15 s of how this friend sounds here, with network stats, to
 * Downloads: something to send along when "it sounds off".
 */
function RecordButton({ identity }: { identity: string }) {
  const [left, setLeft] = useState(0);
  const [done, setDone] = useState("");
  const record = async () => {
    setDone("");
    try {
      setDone(`Сохранено: ${await voice.recordPeer(identity, 15, setLeft)}`);
    } catch (e) {
      setDone(`Не удалось записать: ${errorText(e)}`);
    } finally {
      setLeft(0);
    }
  };
  if (left > 0) return <span className="rec-live">● {left}</span>;
  return (
    <button className="icon-btn sm" onClick={record} title={done || "Записать 15 секунд, как этот человек звучит у тебя, в «Загрузки»"} aria-label="Записать звук">
      <Circle size={12} />
    </button>
  );
}

/**
 * One person in the call. Volume lives under the mouse wheel (right click
 * resets it) and is only shown when it is not 100% or while changing it.
 * Network numbers appear only when the connection is audibly bad.
 */
function PeerRow({ peer, actions }: { peer: Peer; actions?: ReactNode }) {
  const settings = useSettings();
  const volume = settings.volumes[peer.identity] ?? 1;
  const [touched, setTouched] = useState(false);
  const hide = useRef<ReturnType<typeof setTimeout>>(undefined);

  const setVolume = (v: number) => {
    const next = Math.round(Math.max(0, Math.min(2, v)) * 20) / 20;
    updateSettings({ volumes: { ...settings.volumes, [peer.identity]: next } });
    voice.setVolume(peer.identity);
    setTouched(true);
    clearTimeout(hide.current);
    hide.current = setTimeout(() => setTouched(false), 1200);
  };

  const onWheel = (e: WheelEvent) => {
    if (peer.isLocal) return;
    setVolume(volume + (e.deltaY < 0 ? 0.05 : -0.05));
  };

  const net = peer.net;
  const bad = !!net && (net.lossPct > NET_BAD.lossPct || net.repairPct > NET_BAD.repairPct);

  return (
    <div
      className="prow"
      onWheel={onWheel}
      onContextMenu={(e) => {
        if (peer.isLocal) return;
        e.preventDefault();
        setVolume(1);
      }}
      title={peer.isLocal ? undefined : `Громкость ${Math.round(volume * 100)}% · колесо мыши — изменить, правый клик — сбросить${net?.bufferMs !== undefined ? ` · буфер ${net.bufferMs} мс` : ""}`}
    >
      <div className={`av${peer.speaking ? " speaking" : ""}`} style={{ background: colorFor(peer.identity) }}>
        {initials(peer.name)}
      </div>
      <div className="who">
        <div className="name">
          {peer.name}
          {peer.isLocal && <span className="me"> · ты</span>}
        </div>
        {bad && net && (
          <div className="problem" title={`потери ${net.lossPct}% · рывки ${net.repairPct}% · джиттер ${net.jitterMs} мс${net.bufferMs !== undefined ? ` · буфер ${net.bufferMs} мс` : ""}`}>
            рвётся звук · потери {net.lossPct}%
          </div>
        )}
      </div>
      <div className="acts">
        {!peer.isLocal && <RecordButton identity={peer.identity} />}
        {actions}
      </div>
      <RoleBadge role={peer.role} />
      {!peer.isLocal && (volume !== 1 || touched) && (
        <span className={`vol${touched ? " show" : ""}`}>{Math.round(volume * 100)}%</span>
      )}
      {peer.muted ? (
        <span className="state-ico" aria-label="Микрофон выключен" title="Микрофон выключен">
          <MicOffIcon size={13} />
        </span>
      ) : bad ? (
        <span className="state-ico warn" aria-label="Нестабильная связь">
          <WeakSignalIcon size={13} />
        </span>
      ) : (
        <Level live={peer.speaking} />
      )}
    </div>
  );
}

export function ServerView({ server, onChanged, onRemoved }: { server: SavedServer; onChanged: () => void; onRemoved: () => void }) {
  const v = useVoice();
  const here = v.host === server.host;
  const connected = here && v.state !== "idle";
  const [members, setMembers] = useState<Member[]>([]);
  const [role, setRole] = useState<Role>(server.role);
  const [name, setName] = useState(server.name);
  const [fatal, setFatal] = useState<"unauthorized" | "gone" | null>(null);
  const [dialog, setDialog] = useState<null | "invite" | "settings" | "delete" | "rename">(null);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");

  const handleError = useCallback((e: unknown) => {
    const code = errorCode(e);
    if (code === "unauthorized" || code === "gone") setFatal(code);
    else setError(errorText(e));
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      const [me, list, info] = await Promise.all([
        api<Member>(server.host, "GET", "/api/me"),
        api<Member[]>(server.host, "GET", "/api/members"),
        api<{ name: string }>(server.host, "GET", "/api/info"),
      ]);
      setRole(me.role);
      setMembers(list);
      setName(info.name);
      // The backend refreshed its cache from these; update the sidebar.
      if (me.role !== server.role || me.nickname !== server.nickname || info.name !== server.name) onChanged();
    } catch (e) {
      handleError(e);
    }
  }, [server.host, server.role, server.nickname, server.name, onChanged, handleError]);

  useEffect(() => {
    setFatal(null);
    setError("");
    setMembers([]);
    setRole(server.role);
    setName(server.name);
    void loadMembers();
  }, [server.host]); // eslint-disable-line react-hooks/exhaustive-deps

  // Someone new in the room may be a brand-new member, and a role change
  // arrives as new participant metadata.
  const peerKey = here ? v.peers.map((p) => `${p.identity}:${p.role}`).sort().join() : "";
  useEffect(() => {
    if (peerKey) void loadMembers();
  }, [peerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback for changes made while this member is not in the room.
  useEffect(() => {
    const t = setInterval(() => void loadMembers(), 30_000);
    return () => clearInterval(t);
  }, [loadMembers]);

  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  useEffect(() => {
    if (!here || !v.endReason) return;
    if (v.endReason === "kicked") setFatal("unauthorized");
    if (v.endReason === "deleted") setFatal("gone");
  }, [here, v.endReason]);

  // Rooms come and go on the server: every occupied one plus one empty.
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const loadRooms = useCallback(async () => {
    try {
      setRooms(await api<RoomInfo[]>(server.host, "GET", "/api/rooms"));
    } catch {
      // Keep the last list; the next poll will try again.
    }
  }, [server.host]);
  useEffect(() => {
    setRooms([]);
    void loadRooms();
    const t = setInterval(() => void loadRooms(), 3000);
    return () => clearInterval(t);
  }, [loadRooms]);
  // Our own moves change the list right away; don't wait for the poll.
  const myRoom = here && v.state !== "idle" ? v.room : null;
  useEffect(() => {
    const t = setTimeout(() => void loadRooms(), 400);
    return () => clearTimeout(t);
  }, [myRoom, peerKey, loadRooms]);

  const inVoice = useMemo(() => {
    const ids = new Set(rooms.flatMap((r) => r.participants.map((p) => p.id)));
    if (here) v.peers.forEach((p) => ids.add(p.identity));
    return ids;
  }, [rooms, here, v.peers]);
  const away = members.filter((m) => !inVoice.has(m.id));

  async function join(roomId: string) {
    setError("");
    voice.clearEnd();
    try {
      await voice.connect(server.host, roomId);
    } catch (e) {
      handleError(e);
    }
  }

  /** The dock button: where people already are, else the empty room. */
  const joinBest = () => {
    const target = rooms.find((r) => r.participants.length > 0) ?? rooms[0];
    if (target) void join(target.id);
  };

  async function act(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
      await loadMembers();
    } catch (e) {
      handleError(e);
    }
  }

  async function forget() {
    if (here) await voice.disconnect();
    await forgetServer(server.host);
    onRemoved();
  }

  async function leave() {
    setMenu(false);
    if (!confirm(`Выйти с сервера «${name}»? Вернуться можно будет только по новой ссылке.`)) return;
    try {
      await api(server.host, "DELETE", "/api/me");
    } catch (e) {
      if (!["unauthorized", "gone"].includes(errorCode(e) ?? "")) return handleError(e);
    }
    await forget();
  }

  const canManage = (m: Member) => m.id !== server.member_id && RANK[role] > RANK[m.role] && RANK[role] >= RANK.admin;

  if (fatal) {
    return (
      <div className="welcome">
        <div>
          <h1>{fatal === "gone" ? "Сервер удалён" : "Доступ закрыт"}</h1>
          <p>
            {fatal === "gone"
              ? `Владелец удалил «${name}».`
              : `Тебя больше нет среди участников «${name}». Чтобы вернуться, попроси новую ссылку.`}
          </p>
          <div className="actions">
            <button className="btn primary" onClick={forget}>Убрать из списка</button>
          </div>
        </div>
      </div>
    );
  }

  const bad = (v.stats?.lossPct ?? 0) > 2 || (v.stats?.rttMs ?? 0) > 150;
  const pingText =
    v.state === "connected" ? (v.stats?.rttMs !== undefined ? `${v.stats.rttMs} мс` : "в сети") : v.state === "connecting" ? "подключаюсь" : "переподключаюсь";

  return (
    <div className="server">
      <header className="server-head">
        <h1>{name}</h1>
        {RANK[role] >= RANK.admin && (
          <button className="btn primary pill" onClick={() => setDialog("invite")}>
            <PlusIcon size={14} /> Пригласить
          </button>
        )}
        <div className="menu">
          <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="Меню сервера">
            <MoreIcon />
          </button>
          {menu && (
            <div className="menu-pop" onMouseLeave={() => setMenu(false)}>
              {RANK[role] >= RANK.admin && (
                <button onClick={() => { setMenu(false); setDialog("rename"); }}>
                  <Pencil size={16} /> Переименовать
                </button>
              )}
              {role !== "owner" && (
                <button onClick={leave}><LogOut size={16} /> Выйти с сервера</button>
              )}
              {role === "owner" && (
                <button className="danger" onClick={() => { setMenu(false); setDialog("delete"); }}>
                  <Trash2 size={16} /> Удалить сервер
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <section className="list">
        {here && v.endReason && !connected && <div className="notice">{END_TEXT[v.endReason]}</div>}
        {error && <div className="error">{error}</div>}
        {connected && v.audioBlocked && (
          <div className="notice">
            Звук заблокирован. <button className="btn" onClick={() => voice.startAudio()}>Включить звук</button>
          </div>
        )}
        {connected && v.noiseError && <div className="notice">{v.noiseError}</div>}

        {rooms.map((r) => {
          const mine = r.id === myRoom;
          // Our own room is live from LiveKit; the others come from the poll.
          const count = mine ? v.peers.length : r.participants.length;
          return (
            <div key={r.id} className={`room${mine ? " mine" : ""}`}>
              <button
                className="room-head"
                onClick={() => !mine && join(r.id)}
                disabled={mine || (here && v.state === "connecting")}
                title={mine ? "Ты здесь" : `Зайти в «${r.name}»`}
              >
                <span className="sec-label">{r.name}</span>
                <span className="room-count">{count === 0 ? "пусто · зайти" : mine ? `${count}` : `${count} · зайти`}</span>
              </button>
              {mine
                ? v.peers.map((p) => {
                    const m = byId.get(p.identity);
                    return (
                      <PeerRow
                        key={p.identity}
                        peer={{ ...p, role: m?.role ?? p.role }}
                        actions={m && canManage(m) ? memberActions(m) : undefined}
                      />
                    );
                  })
                : r.participants.map((p) => (
                    <div className="mrow" key={p.id}>
                      <div className="av off" style={{ background: colorFor(p.id) }}>{initials(p.name)}</div>
                      <div className="name">{p.name}</div>
                      <RoleBadge role={byId.get(p.id)?.role} />
                    </div>
                  ))}
            </div>
          );
        })}

        {away.length > 0 && (
          <>
            <div className="sec-label" style={{ marginTop: 6 }}>Не в голосе · {away.length}</div>
            {away.map((m) => (
              <div className="mrow" key={m.id}>
                <div className="av off">{initials(m.nickname)}</div>
                <div className="name">
                  {m.nickname}
                  {m.id === server.member_id && <span style={{ color: "var(--faint)" }}> · ты</span>}
                </div>
                {canManage(m) && memberActions(m)}
                <RoleBadge role={m.role} />
              </div>
            ))}
          </>
        )}
      </section>

      <footer className="dock-wrap">
        <div className="dock">
          {connected && (
            <div className={`ping${v.state !== "connected" ? " wait" : bad ? " warn" : ""}`} title={statsTitle(v.stats)}>
              <i /> {pingText}
            </div>
          )}
          <button
            className={`dbtn${v.micMuted ? " off" : ""}`}
            onClick={() => voice.toggleMic()}
            aria-label={v.micMuted ? "Включить микрофон" : "Выключить микрофон"}
            title={v.micMuted ? "Включить микрофон" : "Выключить микрофон"}
          >
            {v.micMuted ? <MicOffIcon /> : <MicIcon />}
          </button>
          <button
            className={`dbtn${v.deafened ? " off" : ""}`}
            onClick={() => voice.toggleDeafen()}
            aria-label={v.deafened ? "Включить звук" : "Выключить звук"}
            title={v.deafened ? "Включить звук" : "Выключить звук"}
          >
            {v.deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
          </button>
          <button className="dbtn ghost" onClick={() => setDialog("settings")} aria-label="Настройки" title="Настройки">
            <SlidersIcon />
          </button>
          {connected ? (
            <button className="dbtn hang" onClick={() => voice.disconnect()} aria-label="Отключиться" title="Отключиться">
              <HangUpIcon />
            </button>
          ) : (
            <button className="dbtn join" onClick={joinBest} disabled={(here && v.state === "connecting") || rooms.length === 0}>
              <PhoneIcon size={18} /> Подключиться
            </button>
          )}
        </div>
      </footer>

      {dialog === "invite" && <InviteDialog host={server.host} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog server={server} onClose={() => setDialog(null)} onDeleted={forget} />}
      {dialog === "rename" && (
        <RenameDialog
          host={server.host}
          current={name}
          onClose={() => setDialog(null)}
          onRenamed={(n) => {
            setName(n);
            setDialog(null);
            void loadMembers();
          }}
        />
      )}
    </div>
  );

  function memberActions(m: Member) {
    return (
      <div className="acts">
        {role === "owner" &&
          (m.role === "admin" ? (
            <button className="icon-btn sm" title="Снять админа" aria-label="Снять админа" onClick={() => act(() => api(server.host, "POST", `/api/members/${m.id}/role`, { role: "member" }))}>
              <ShieldOff size={14} />
            </button>
          ) : (
            <button className="icon-btn sm" title="Сделать админом" aria-label="Сделать админом" onClick={() => act(() => api(server.host, "POST", `/api/members/${m.id}/role`, { role: "admin" }))}>
              <Shield size={14} />
            </button>
          ))}
        <button
          className="icon-btn sm"
          title="Выгнать"
          aria-label="Выгнать"
          onClick={() => confirm(`Выгнать ${m.nickname}? Вернуться можно будет только по новой ссылке.`) && act(() => api(server.host, "POST", `/api/members/${m.id}/kick`))}
        >
          <UserMinus size={14} />
        </button>
      </div>
    );
  }
}

function RenameDialog(props: { host: string; current: string; onClose: () => void; onRenamed: (name: string) => void }) {
  const [value, setValue] = useState(props.current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ name: string }>(props.host, "PATCH", "/api/server", { name: value.trim() });
      props.onRenamed(res.name);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <Modal title="Название сервера" onClose={props.onClose}>
      <form onSubmit={save}>
        <label className="field">
          <span>Как назовём?</span>
          <input type="text" autoFocus maxLength={48} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="foot">
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button className="btn primary" disabled={busy || !value.trim() || value.trim() === props.current}>Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}
