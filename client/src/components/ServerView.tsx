import {
  Ear,
  EarOff,
  Headphones,
  HeadphoneOff,
  LogOut,
  Mic,
  MicOff,
  MoreVertical,
  PhoneOff,
  Settings,
  Shield,
  ShieldOff,
  Trash2,
  UserMinus,
  UserPlus,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { updateSettings, useSettings } from "../lib/settings";
import { api, errorCode, errorText, forgetServer, Member, Role, RoomInfo, SavedServer } from "../lib/tauri";
import { AudioStats, EndReason, NET_BAD, Peer, PeerNet, useVoice, voice } from "../lib/voice";
import { DeleteDialog } from "./DeleteDialog";
import { InviteDialog } from "./InviteDialog";
import { SettingsDialog } from "./SettingsDialog";
import { colorFor, initials, RoleBadge } from "./ui";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

const END_TEXT: Record<EndReason, string> = {
  kicked: "Тебя выгнали с сервера.",
  deleted: "Владелец удалил этот сервер.",
  duplicate: "Ты подключился к этому серверу с другого устройства.",
  lost: "Связь с сервером потеряна.",
  full: "На сервере уже максимум участников (10).",
};

function StatsLine({ s }: { s: AudioStats }) {
  const parts = [
    s.sendKbps !== undefined && `${s.sendKbps} кбит/с`,
    s.rttMs !== undefined && `пинг ${s.rttMs} мс`,
    s.lossPct !== undefined && `потери ${s.lossPct}%`,
    s.jitterMs !== undefined && `джиттер ${s.jitterMs} мс`,
  ].filter(Boolean);
  if (!parts.length) return null;
  const bad = (s.lossPct ?? 0) > 2 || (s.rttMs ?? 0) > 150;
  return (
    <span
      style={{ color: bad ? "var(--warn)" : "var(--faint)" }}
      title="Реальные цифры твоего микрофона до сервера. Битрейт примерно вдвое выше настроенного: каждый пакет несёт копию предыдущего (RED), чтобы потери не были слышны."
    >
      · {parts.join(" · ")}
    </span>
  );
}

/** How a friend's audio reaches you; warns when it is audibly unstable. */
function NetLine({ net }: { net: PeerNet }) {
  const bad = net.lossPct > NET_BAD.lossPct || net.repairPct > NET_BAD.repairPct;
  return (
    <div
      className="peer-net"
      style={{ color: bad ? "var(--warn)" : "var(--faint)" }}
      title="Как звук этого человека доходит до тебя. «Рывки» — доля звука, которую пришлось восстановить или растянуть из-за потерь и неровной доставки: это и слышно как «жёваный» голос."
    >
      {bad ? "⚠ нестабильная связь · " : ""}потери {net.lossPct}% · рывки {net.repairPct}% · джиттер {net.jitterMs} мс
    </div>
  );
}

function PeerTile({ peer }: { peer: Peer }) {
  const settings = useSettings();
  const volume = settings.volumes[peer.identity] ?? 1;
  const setVolume = (v: number) => {
    updateSettings({ volumes: { ...settings.volumes, [peer.identity]: v } });
    voice.setVolume(peer.identity);
  };
  return (
    <div className={`peer${peer.speaking ? " speaking" : ""}`}>
      <div className="avatar" style={{ background: colorFor(peer.identity) }}>{initials(peer.name)}</div>
      <div className="peer-name" title={peer.name}>{peer.name}{peer.isLocal && " (ты)"}</div>
      <div className="peer-meta">
        <RoleBadge role={peer.role} />
        {peer.muted && <MicOff size={14} className="muted-ico" />}
      </div>
      {peer.net && <NetLine net={peer.net} />}
      {!peer.isLocal && (
        <label className="row vol" style={{ alignItems: "center", gap: 6 }} title={`Громкость: ${Math.round(volume * 100)}%`}>
          <Volume2 size={14} style={{ flex: "none", color: "var(--faint)" }} />
          <input type="range" min={0} max={2} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
        </label>
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
  const [fatal, setFatal] = useState<"unauthorized" | "gone" | null>(null);
  const [dialog, setDialog] = useState<null | "invite" | "settings" | "delete">(null);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");

  const handleError = useCallback((e: unknown) => {
    const code = errorCode(e);
    if (code === "unauthorized" || code === "gone") setFatal(code);
    else setError(errorText(e));
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      const [me, list] = await Promise.all([
        api<Member>(server.host, "GET", "/api/me"),
        api<Member[]>(server.host, "GET", "/api/members"),
      ]);
      setRole(me.role);
      setMembers(list);
      if (me.role !== server.role || me.nickname !== server.nickname) onChanged();
    } catch (e) {
      handleError(e);
    }
  }, [server.host, server.role, server.nickname, onChanged, handleError]);

  useEffect(() => {
    setFatal(null);
    setError("");
    setMembers([]);
    setRole(server.role);
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

  const roleById = useMemo(() => new Map(members.map((m) => [m.id, m.role])), [members]);

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

  const online = useMemo(() => {
    const ids = new Set(rooms.flatMap((r) => r.participants.map((p) => p.id)));
    if (here) v.peers.forEach((p) => ids.add(p.identity));
    return ids;
  }, [rooms, here, v.peers]);

  async function join(roomId: string) {
    setError("");
    voice.clearEnd();
    try {
      await voice.connect(server.host, roomId);
    } catch (e) {
      handleError(e);
    }
  }

  const roomName = (id: string | null) => rooms.find((r) => r.id === id)?.name ?? (id ? `Комната ${id.slice(1)}` : "");

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
    if (!confirm(`Выйти с сервера «${server.name}»? Вернуться можно будет только по новой ссылке.`)) return;
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
              ? `Владелец удалил «${server.name}».`
              : `Тебя больше нет среди участников «${server.name}». Чтобы вернуться, попроси новую ссылку.`}
          </p>
          <div className="actions">
            <button className="btn primary" onClick={forget}>Убрать из списка</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="server">
      <header className="server-head">
        <div>
          <h2>{server.name}</h2>
          <div className="host selectable">{server.host}</div>
        </div>
        <RoleBadge role={role} />
        <div className="spacer" />
        {RANK[role] >= RANK.admin && (
          <button className="btn primary" onClick={() => setDialog("invite")}>
            <UserPlus size={16} /> Пригласить
          </button>
        )}
        <div className="menu">
          <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="Меню сервера">
            <MoreVertical size={18} />
          </button>
          {menu && (
            <div className="menu-pop" onMouseLeave={() => setMenu(false)}>
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

      <section className="stage">
        {here && v.endReason && !connected && <div className="notice">{END_TEXT[v.endReason]}</div>}
        {error && <div className="error" style={{ marginTop: 0, marginBottom: 16 }}>{error}</div>}
        {connected ? (
          <>
            {v.audioBlocked && (
              <div className="notice">
                Звук заблокирован. <button className="btn" onClick={() => voice.startAudio()}>Включить звук</button>
              </div>
            )}
            <h2 className="stage-title">
              <Volume2 size={18} /> {roomName(v.room)}
            </h2>
            <div className="peers">
              {v.peers.map((p) => <PeerTile key={p.identity} peer={{ ...p, role: roleById.get(p.identity) ?? p.role }} />)}
            </div>
          </>
        ) : (
          <div className="stage-empty">
            <div className="big">Куда зайдём?</div>
            <div className="hint">Пустая комната всегда есть: зайди в неё, и появится следующая.</div>
            <div className="room-cards">
              {rooms.map((r) => (
                <button key={r.id} className="room-card" onClick={() => join(r.id)} disabled={here && v.state === "connecting"}>
                  <div className="room-card-name">
                    <Volume2 size={16} /> {r.name}
                  </div>
                  <div className="room-card-who">
                    {r.participants.length ? r.participants.map((p) => p.name).join(", ") : "пусто"}
                  </div>
                  <span className="btn green">
                    <Mic size={16} /> Зайти
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <aside className="members">
        <h3>Комнаты</h3>
        {rooms.map((r) => {
          const mine = r.id === myRoom;
          // Our own room is live from LiveKit; others come from the poll.
          const people = mine ? v.peers.map((p) => ({ id: p.identity, name: p.name, speaking: p.speaking })) : r.participants;
          return (
            <div key={r.id} className={`room${mine ? " mine" : ""}`}>
              <button className="room-head" onClick={() => !mine && join(r.id)} title={mine ? "Ты здесь" : `Зайти в «${r.name}»`}>
                <Volume2 size={15} />
                <span>{r.name}</span>
                {people.length === 0 && <small>пусто</small>}
              </button>
              {people.map((p) => (
                <div key={p.id} className={`room-peer${"speaking" in p && p.speaking ? " speaking" : ""}`}>
                  <span className="mini" style={{ background: colorFor(p.id) }}>{initials(p.name)}</span>
                  {p.name}
                </div>
              ))}
            </div>
          );
        })}
        <h3 style={{ marginTop: 18 }}>Участники: {members.length}</h3>
        {members.map((m) => memberRow(m, online.has(m.id)))}
      </aside>

      <footer className="controls">
        <div className="status">
          {connected ? (
            <>
              <span className={`pulse${v.state === "connected" ? "" : " warn"}`} />
              {v.state === "connected" ? "Голос подключён" : v.state === "connecting" ? "Подключаюсь…" : "Переподключаюсь…"}
              {v.stats && <StatsLine s={v.stats} />}
            </>
          ) : (
            <span>Не в голосе · {server.nickname}</span>
          )}
        </div>
        <button className={`icon-btn${v.micMuted ? " off" : ""}`} onClick={() => voice.setMicMuted(!v.micMuted)} title={v.micMuted ? "Включить микрофон" : "Выключить микрофон"}>
          {v.micMuted ? <MicOff size={18} /> : <Mic size={18} />}
        </button>
        <button className={`icon-btn${v.deafened ? " off" : ""}`} onClick={() => voice.setDeafened(!v.deafened)} title={v.deafened ? "Включить звук" : "Выключить звук"}>
          {v.deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
        </button>
        {connected && (
          <button
            className={`icon-btn${v.echo ? " on" : ""}`}
            onClick={() => void voice.setEcho(!v.echo).catch(handleError)}
            title={v.echo ? "Выключить эхо-тест" : "Эхо-тест: услышать себя так, как слышат друзья (только в наушниках)"}
          >
            {v.echo ? <EarOff size={18} /> : <Ear size={18} />}
          </button>
        )}
        <button className="icon-btn" onClick={() => setDialog("settings")} title="Настройки звука">
          <Settings size={18} />
        </button>
        {connected && (
          <button className="icon-btn hang" onClick={() => voice.disconnect()} title="Отключиться">
            <PhoneOff size={18} />
          </button>
        )}
      </footer>

      {dialog === "invite" && <InviteDialog host={server.host} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog server={server} onClose={() => setDialog(null)} onDeleted={forget} />}
    </div>
  );

  function memberRow(m: Member, online: boolean) {
    return (
      <div className="member" key={m.id}>
        <div className="mini" style={{ background: colorFor(m.id) }}>
          {initials(m.nickname)}
          {online && <span className="dot" />}
        </div>
        <div className="who">
          <div>{m.nickname}{m.id === server.member_id && " (ты)"}</div>
        </div>
        <RoleBadge role={m.role} />
        {canManage(m) && (
          <div className="acts">
            {role === "owner" &&
              (m.role === "admin" ? (
                <button className="icon-btn sm" title="Снять админа" onClick={() => act(() => api(server.host, "POST", `/api/members/${m.id}/role`, { role: "member" }))}>
                  <ShieldOff size={15} />
                </button>
              ) : (
                <button className="icon-btn sm" title="Сделать админом" onClick={() => act(() => api(server.host, "POST", `/api/members/${m.id}/role`, { role: "admin" }))}>
                  <Shield size={15} />
                </button>
              ))}
            <button
              className="icon-btn sm"
              title="Выгнать"
              onClick={() => confirm(`Выгнать ${m.nickname}? Вернуться можно будет только по новой ссылке.`) && act(() => api(server.host, "POST", `/api/members/${m.id}/kick`))}
            >
              <UserMinus size={15} />
            </button>
          </div>
        )}
      </div>
    );
  }
}
