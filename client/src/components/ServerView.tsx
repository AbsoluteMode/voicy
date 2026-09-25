import { ImagePlus, LogOut, Maximize2, MessageCircle, MonitorPlay, Pencil, Search, Shield, ShieldOff, Trash2, Upload, UserMinus, X } from "lucide-react";
import { FormEvent, PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState, WheelEvent } from "react";

import { syncAvatar } from "../lib/avatar";
import { ask } from "../lib/confirm";
import { updateSettings, useSettings } from "../lib/settings";
import { api, avatarUrl, errorCode, errorText, forgetServer, Member, Role, RoomInfo, SavedServer } from "../lib/tauri";
import { EndReason, Peer, ScreenShare, useVoice, voice } from "../lib/voice";
import { AvatarDialog, removeAvatar } from "./AvatarDialog";
import { ChannelChat } from "./ChannelChat";
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
  ScreenIcon,
  SlidersIcon,
} from "./icons";
import { InviteDialog } from "./InviteDialog";
import { SettingsDialog } from "./SettingsDialog";
import { Avatar, Modal, RoleBadge } from "./ui";

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

const END_TEXT: Record<EndReason, string> = {
  kicked: "Тебя выгнали с сервера.",
  deleted: "Владелец удалил этот сервер.",
  duplicate: "Ты подключился к этому серверу с другого устройства.",
  lost: "Связь с сервером потеряна.",
  full: "В комнате уже максимум участников (10).",
};

const BARS_TITLE = ["Подключаюсь…", "Плохая связь", "Связь так себе", "Хорошая связь"];

/** Connection bars next to a name: 1 red, 2 yellow, 3 green. */
function SignalBars({ q }: { q: Peer["quality"] }) {
  return (
    <span className={`bars q${q}`} title={BARS_TITLE[q]} aria-label={BARS_TITLE[q]}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** Pressing on a person and dragging them onto another room moves them. */
type Grab = { id: string; name: string; from: string };
type OnGrab = (e: ReactPointerEvent, g: Grab) => void;

/** Feeds `--level` (voice loudness, 0..1) to the element's CSS, outside React renders. */
function useVoiceLevel<T extends HTMLElement>(identity: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const show = () => ref.current?.style.setProperty("--level", (voice.levels.get(identity) ?? 0).toFixed(2));
    show();
    return voice.onLevels(show);
  }, [identity]);
  return ref;
}

const LEVEL_SEGMENTS = 12;

/** Twelve segments lit by how loud this person's voice is right now. */
function Level({ identity }: { identity: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const show = () => {
      const lit = Math.round((voice.levels.get(identity) ?? 0) * LEVEL_SEGMENTS);
      ref.current?.querySelectorAll("i").forEach((seg, i) => seg.classList.toggle("on", i < lit));
    };
    show();
    return voice.onLevels(show);
  }, [identity]);
  return (
    <div ref={ref} className="lvl" aria-hidden>
      {Array.from({ length: LEVEL_SEGMENTS }, (_, i) => <i key={i} />)}
    </div>
  );
}

function ScreenTile({ screen, track, onLeave }: { screen: ScreenShare; track: NonNullable<ScreenShare["track"]>; onLeave: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    track.attach(element);
    return () => void track.detach(element);
  }, [track]);
  const fullscreen = () => void video.current?.requestFullscreen();
  return (
    <div className="screen-tile">
      <video ref={video} autoPlay playsInline muted onDoubleClick={fullscreen} />
      <div className="screen-bar">
        <span className="screen-who">{screen.name}{screen.isLocal && " · ты"}</span>
        <button className="screen-leave" onClick={onLeave} title={screen.isLocal ? "Остановить демонстрацию" : "Выйти из просмотра"}>
          <X size={14} /> {screen.isLocal ? "Остановить" : "Выйти из просмотра"}
        </button>
        <button className="icon-btn sm" title="На весь экран (двойной клик)" aria-label="На весь экран" onClick={fullscreen}>
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * Opens under our own row: "change avatar", then a file or Pinterest.
 * Clicks on the row itself are left to the row, which toggles the menu.
 */
function MeMenu({ onClose, onFile, onPinterest }: { onClose: () => void; onFile: (f: File) => void; onPinterest: () => void }) {
  const s = useSettings();
  const [choosing, setChoosing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  return (
    <div className="menu-pop me-pop" ref={ref} onClick={(e) => e.stopPropagation()}>
      {!choosing ? (
        <button onClick={() => setChoosing(true)}>
          <ImagePlus size={16} /> Изменить аватар
        </button>
      ) : (
        <>
          <button onClick={() => file.current?.click()}>
            <Upload size={16} /> Загрузить картинку
          </button>
          <button onClick={onPinterest}>
            <Search size={16} /> Найти на Pinterest
          </button>
          {s.avatar && (
            <button
              className="danger"
              onClick={() => {
                removeAvatar();
                onClose();
              }}
            >
              <Trash2 size={16} /> Убрать аватар
            </button>
          )}
        </>
      )}
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
    </div>
  );
}

/**
 * One person in the call. Volume lives under the mouse wheel (right click
 * resets it) and is only shown when it is not 100% or while changing it.
 * Our own row opens the avatar menu (`children`) on click.
 */
function PeerRow(props: {
  peer: Peer;
  avatar: string | null;
  actions?: ReactNode;
  onClick?: () => void;
  onGrab?: (e: ReactPointerEvent) => void;
  children?: ReactNode;
}) {
  const { peer, actions } = props;
  const level = useVoiceLevel<HTMLDivElement>(peer.identity);
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

  return (
    <div
      ref={level}
      className={`prow${props.onClick ? " self" : ""}${props.onGrab ? " grab" : ""}`}
      onClick={props.onClick}
      onPointerDown={props.onGrab}
      onWheel={onWheel}
      onContextMenu={(e) => {
        if (peer.isLocal) return;
        e.preventDefault();
        setVolume(1);
      }}
      title={peer.isLocal ? (props.onClick ? "Нажми, чтобы сменить аватар" : undefined) : `Громкость ${Math.round(volume * 100)}% · колесо мыши — изменить, правый клик — сбросить`}
    >
      <Avatar className={`av${peer.speaking ? " speaking" : ""}`} id={peer.identity} name={peer.name} src={props.avatar} />
      <div className="who">
        <div className="name">
          <span className="txt">{peer.name}</span>
          {peer.isLocal && <span className="me">ты</span>}
          <SignalBars q={peer.quality} />
        </div>
      </div>
      {actions}
      <RoleBadge role={peer.role} />
      {!peer.isLocal && (volume !== 1 || touched) && (
        <span className={`vol${touched ? " show" : ""}`}>{Math.round(volume * 100)}%</span>
      )}
      {peer.muted ? (
        <span className="state-ico" aria-label="Микрофон выключен" title="Микрофон выключен">
          <MicOffIcon size={13} />
        </span>
      ) : (
        <Level identity={peer.identity} />
      )}
      {props.children}
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
  const [dialog, setDialog] = useState<null | "invite" | "settings" | "delete" | "rename" | "avatar">(null);
  const [meMenu, setMeMenu] = useState(false);
  const closeMeMenu = useCallback(() => setMeMenu(false), []);
  // Set when the avatar comes from disk: the dialog starts at framing it.
  const [avatarFile, setAvatarFile] = useState<File>();
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [chatRoom, setChatRoom] = useState<{ id: string; name: string } | null>(null);

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
      // A picture chosen while this server was offline, or on first visit.
      setMembers((await syncAvatar(server.host, me)) ? await api<Member[]>(server.host, "GET", "/api/members") : list);
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
  const settings = useSettings();
  // Our own picture shows from here right away; everyone else's from the server.
  const avatarFor = (id: string) => {
    if (id === server.member_id && settings.avatar !== undefined) return settings.avatar?.url ?? null;
    const version = byId.get(id)?.avatar;
    return version ? avatarUrl(server.host, id, version) : null;
  };

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

  // Drag and drop between rooms, with pointer events: WebView2's native
  // drag and drop belongs to Tauri's file drop handling.
  const [drag, setDrag] = useState<(Grab & { x: number; y: number; over: string | null }) | null>(null);
  const canMove = RANK[role] >= RANK.admin;

  const grab: OnGrab = (e, g) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, .menu-pop")) return;
    const start = { x: e.clientX, y: e.clientY };
    let moving = false;
    const roomAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest("[data-room]") as HTMLElement | null)?.dataset.room ?? null;
    const onMove = (ev: PointerEvent) => {
      if (!moving && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      moving = true;
      setDrag({ ...g, x: ev.clientX, y: ev.clientY, over: roomAt(ev.clientX, ev.clientY) });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (!moving) return;
      // The drop is not a click on the row (our own row opens a menu). The
      // click, if any, comes right after this pointerup; when there is none
      // (the row moved to another room), the trap must not eat a later one.
      const eat = (c: MouseEvent) => c.stopPropagation();
      window.addEventListener("click", eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", eat, { capture: true }));
      setTimeout(() => setDrag(null));
      const to = roomAt(ev.clientX, ev.clientY);
      if (to && to !== g.from) void moveTo(g.id, to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  async function moveTo(id: string, to: string) {
    if (id === server.member_id) return join(to);
    setError("");
    try {
      await api(server.host, "POST", `/api/members/${id}/move`, { room: to });
      setTimeout(() => void loadRooms(), 1200);
    } catch (e) {
      handleError(e);
    }
  }

  async function toggleShare() {
    setError("");
    setShareBusy(true);
    try {
      await voice.setScreenShare(!v.screenSharing);
    } catch (e) {
      // Closing the system picker is not an error.
      if (!(e instanceof DOMException && e.name === "NotAllowedError")) handleError(e);
    } finally {
      setShareBusy(false);
    }
  }

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
    const yes = await ask({ title: `Выйти с «${name}»?`, text: "Вернуться можно будет только по новой ссылке.", confirm: "Выйти", danger: true });
    if (!yes) return;
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
          {fatal === "unauthorized" && server.role === "owner" && (
            <p>Это твой сервер? Нажми «+» → «Создать свой» и введи данные того же VPS: права владельца вернутся, люди и комнаты останутся.</p>
          )}
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

      <div className="server-content">
      <section className="list">
        {here && v.endReason && !connected && <div className="notice">{END_TEXT[v.endReason]}</div>}
        {error && <div className="error">{error}</div>}
        {connected && v.audioBlocked && (
          <div className="notice">
            Звук заблокирован. <button className="btn" onClick={() => voice.startAudio()}>Включить звук</button>
          </div>
        )}
        {connected && v.screens.length > 0 && (
          <div className="screens-block">
            <div className="sec-label">Демонстрации в комнате</div>
            <div className="screens">
              {v.screens.map((s) => s.watching && s.track
                ? <ScreenTile key={s.identity} screen={s} track={s.track} onLeave={() => s.isLocal ? void toggleShare() : voice.watchScreen(s.identity, false)} />
                : s.watching
                  ? <div key={s.identity} className="screen-pending"><MonitorPlay size={20} /> Подключаю демонстрацию {s.name}… <button className="linklike" onClick={() => voice.watchScreen(s.identity, false)}>Отмена</button></div>
                  : <button key={s.identity} className="screen-join" onClick={() => voice.watchScreen(s.identity, true)}>
                      <MonitorPlay size={21} /><span><strong>{s.name} показывает экран</strong><small>Нажми, чтобы смотреть со звуком</small></span><span>Смотреть</span>
                    </button>)}
            </div>
          </div>
        )}

        {rooms.map((r) => {
          const mine = r.id === myRoom;
          // Our own room is live from LiveKit; the others come from the poll.
          const count = mine ? v.peers.length : r.participants.length;
          return (
            <div key={r.id} data-room={r.id} className={`room${mine ? " mine" : ""}${drag && drag.over === r.id && drag.from !== r.id ? " drop" : ""}`}>
              <div className="room-top">
                <button
                  className="room-head"
                  onClick={() => !mine && join(r.id)}
                  disabled={mine || (here && v.state === "connecting")}
                  title={mine ? "Ты здесь" : `Зайти в «${r.name}»`}
                >
                  <span className="sec-label">{r.name}</span>
                  <span className="room-count">{count === 0 ? "пусто · зайти" : mine ? `${count}` : `${count} · зайти`}</span>
                </button>
                <button className="icon-btn sm room-chat-btn" onClick={() => setChatRoom({ id: r.id, name: r.name })} title={`Чат «${r.name}»`} aria-label={`Чат «${r.name}»`}>
                  <MessageCircle size={17} />
                </button>
              </div>
              {mine
                ? v.peers.map((p) => {
                    const m = byId.get(p.identity);
                    return (
                      <PeerRow
                        key={p.identity}
                        peer={{ ...p, role: m?.role ?? p.role }}
                        avatar={avatarFor(p.identity)}
                        actions={m && canManage(m) ? memberActions(m) : undefined}
                        onClick={p.isLocal ? () => setMeMenu(!meMenu) : undefined}
                        onGrab={canMove || p.isLocal ? (e) => grab(e, { id: p.identity, name: p.name, from: r.id }) : undefined}
                      >
                        {p.isLocal && meMenu && meMenuPop()}
                      </PeerRow>
                    );
                  })
                : r.participants.map((p) => (
                    <div
                      className={`mrow${canMove || p.id === server.member_id ? " grab" : ""}`}
                      key={p.id}
                      onPointerDown={canMove || p.id === server.member_id ? (e) => grab(e, { id: p.id, name: p.name, from: r.id }) : undefined}
                    >
                      <Avatar className="av sm" id={p.id} name={p.name} src={avatarFor(p.id)} />
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
            {away.map((m) => {
              const self = m.id === server.member_id;
              return (
              <div
                className={`mrow${self ? " self" : ""}`}
                key={m.id}
                onClick={self ? () => setMeMenu(!meMenu) : undefined}
                title={self ? "Нажми, чтобы сменить аватар" : undefined}
              >
                <Avatar className="av off" id={m.id} name={m.nickname} src={avatarFor(m.id)} plain />
                <div className="name">
                  {m.nickname}
                  {m.id === server.member_id && <span style={{ color: "var(--faint)" }}> · ты</span>}
                </div>
                {canManage(m) && memberActions(m)}
                <RoleBadge role={m.role} />
                {self && meMenu && meMenuPop()}
              </div>
              );
            })}
          </>
        )}
      </section>
      <ChannelChat host={server.host} memberId={server.member_id} />
      </div>

      <footer className="dock-wrap">
        <div className="dock">
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
          {connected && (
            <button
              className={`dbtn${v.screenSharing ? " on" : ""}`}
              onClick={() => void toggleShare()}
              disabled={v.state !== "connected" || shareBusy}
              aria-label={v.screenSharing ? "Остановить демонстрацию" : "Показать экран"}
              title={v.screenSharing ? "Остановить демонстрацию" : "Показать экран"}
            >
              <ScreenIcon />
            </button>
          )}
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

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
          <Avatar className="av" id={drag.id} name={drag.name} src={avatarFor(drag.id)} />
          {drag.name}
        </div>
      )}

      {dialog === "invite" && <InviteDialog host={server.host} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === "avatar" && <AvatarDialog file={avatarFile} onClose={() => setDialog(null)} />}
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
      {chatRoom && (
        <ChannelChat host={server.host} room={chatRoom.id} roomName={chatRoom.name} memberId={server.member_id} onClose={() => setChatRoom(null)} />
      )}
    </div>
  );

  function meMenuPop() {
    const open = (file?: File) => {
      setMeMenu(false);
      setAvatarFile(file);
      setDialog("avatar");
    };
    return <MeMenu onClose={closeMeMenu} onFile={open} onPinterest={() => open()} />;
  }

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
          onClick={async () => {
            const yes = await ask({ title: `Выгнать ${m.nickname}?`, text: "Вернуться можно будет только по новой ссылке.", confirm: "Выгнать", danger: true });
            if (yes) await act(() => api(server.host, "POST", `/api/members/${m.id}/kick`));
          }}
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
    <Modal title="Название сервера" icon={<Pencil size={20} />} onClose={props.onClose}>
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
