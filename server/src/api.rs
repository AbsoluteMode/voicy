use std::collections::BTreeMap;

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    auth::{hash, random_secret, AuthMember},
    avatar,
    db::{now, Invite, Member, Redeem, Role},
    error::{ApiError, ApiResult},
    livekit::ECHO_SUFFIX,
    rooms::{layout, parse_room, room_id, RoomPeer, RoomView},
    SharedState,
};

const DEFAULT_INVITE_HOURS: u32 = 72;
const MAX_INVITE_HOURS: u32 = 24 * 30;

pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/api/info", get(info))
        .route("/api/join", post(join))
        .route("/api/me", get(me).patch(update_me).delete(leave))
        .route("/api/me/avatar", put(set_avatar).delete(clear_avatar))
        .route("/api/avatars/{id}", get(avatar))
        .route("/api/token", post(token))
        .route("/api/rooms", get(rooms))
        .route("/api/messages", get(server_chat_messages).post(send_server_chat_message))
        .route("/api/dms", get(direct_threads))
        .route("/api/dms/{peer}", get(direct_messages).post(send_direct_message))
        .route("/api/rooms/{room}/messages", get(chat_messages).post(send_chat_message))
        .route("/api/members", get(members))
        .route("/api/members/{id}/kick", post(kick))
        .route("/api/members/{id}/role", post(set_role))
        .route("/api/members/{id}/move", post(move_member))
        .route("/api/invites", get(list_invites).post(create_invite))
        .route("/api/invites/{id}", delete(revoke_invite))
        .route("/api/server", delete(delete_server).patch(rename_server))
        .route("/api/rtc-auth", get(rtc_auth))
        .route("/api/logs", post(client_logs))
        .route("/join/{code}", get(crate::invite_page::page))
        .with_state(state)
}

fn clean_nickname(raw: &str) -> ApiResult<String> {
    let nick = raw.trim();
    let len = nick.chars().count();
    if len == 0 || len > 32 || nick.chars().any(char::is_control) {
        return Err(ApiError::BadRequest("nickname must be 1-32 printable characters"));
    }
    Ok(nick.to_owned())
}

async fn info(State(s): State<SharedState>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({
        "name": s.server_name(),
        "version": env!("CARGO_PKG_VERSION"),
        "max_participants": s.cfg.max_participants,
        "deleted": s.db.is_deleted()?,
    })))
}

#[derive(Deserialize)]
struct JoinReq {
    code: String,
    nickname: String,
}

#[derive(Serialize)]
struct JoinResp {
    /// Credential for all further requests: `Authorization: Bearer <token>`.
    token: String,
    member: Member,
    server_name: String,
}

async fn join(State(s): State<SharedState>, Json(req): Json<JoinReq>) -> ApiResult<Json<JoinResp>> {
    if s.db.is_deleted()? {
        return Err(ApiError::Gone);
    }
    let nickname = clean_nickname(&req.nickname)?;
    let secret = random_secret();
    match s.db.redeem_invite(&hash(req.code.trim()), &nickname, &hash(&secret), now())? {
        Redeem::Ok(member) => Ok(Json(JoinResp {
            token: format!("{}.{}", member.id, secret),
            member,
            server_name: s.server_name(),
        })),
        Redeem::InvalidCode => Err(ApiError::Forbidden("invite is invalid, used or expired")),
        Redeem::OwnerExists => Err(ApiError::Forbidden("server already has an owner")),
    }
}

async fn me(AuthMember(m): AuthMember) -> Json<Member> {
    Json(m)
}

#[derive(Deserialize)]
struct UpdateMeReq {
    nickname: String,
}

async fn update_me(
    State(s): State<SharedState>,
    AuthMember(mut m): AuthMember,
    Json(req): Json<UpdateMeReq>,
) -> ApiResult<Json<Member>> {
    m.nickname = clean_nickname(&req.nickname)?;
    s.db.set_nickname(&m.id, &m.nickname)?;
    Ok(Json(m))
}

#[derive(Deserialize)]
struct AvatarReq {
    /// The image file, base64.
    data: String,
}

async fn set_avatar(
    State(s): State<SharedState>,
    AuthMember(mut m): AuthMember,
    Json(req): Json<AvatarReq>,
) -> ApiResult<Json<Member>> {
    let data = STANDARD
        .decode(req.data.trim())
        .map_err(|_| ApiError::BadRequest("avatar must be base64"))?;
    if data.len() > avatar::MAX_BYTES {
        return Err(ApiError::BadRequest("avatar is too large"));
    }
    let mime = avatar::sniff(&data).ok_or(ApiError::BadRequest("avatar must be a PNG, JPEG, WebP or GIF image"))?;
    let version = avatar::version(&data);
    s.db.set_avatar(&m.id, &version, mime, &data)?;
    m.avatar = Some(version);
    Ok(Json(m))
}

async fn clear_avatar(State(s): State<SharedState>, AuthMember(mut m): AuthMember) -> ApiResult<Json<Member>> {
    s.db.clear_avatar(&m.id)?;
    m.avatar = None;
    Ok(Json(m))
}

/// Public, so the app can show it with a plain `<img>`: member ids are
/// random and only other members see them. Versioned URLs never change.
async fn avatar(State(s): State<SharedState>, Path(id): Path<String>) -> ApiResult<Response> {
    if s.db.is_deleted()? {
        return Err(ApiError::Gone);
    }
    let a = s.db.avatar(&id)?.ok_or(ApiError::NotFound)?;
    let headers = [
        (header::CONTENT_TYPE, a.mime),
        (header::CACHE_CONTROL, "public, max-age=31536000, immutable".to_owned()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
    ];
    Ok((headers, a.data).into_response())
}

async fn leave(State(s): State<SharedState>, AuthMember(m): AuthMember) -> ApiResult<StatusCode> {
    if m.role == Role::Owner {
        return Err(ApiError::Forbidden("the owner cannot leave; delete the server instead"));
    }
    s.db.delete_member(&m.id)?;
    disconnect(&s, &m.id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
struct TokenReq {
    /// Room id from `/api/rooms`; clients before rooms existed send none.
    #[serde(default)]
    room: Option<String>,
    /// Token for the member's hidden echo-test listener instead.
    #[serde(default)]
    echo: bool,
}

async fn token(
    State(s): State<SharedState>,
    AuthMember(m): AuthMember,
    body: Option<Json<TokenReq>>,
) -> ApiResult<Json<Value>> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let room = req.room.unwrap_or_else(|| room_id(1));
    if parse_room(&room).is_none() {
        return Err(ApiError::BadRequest("unknown room"));
    }
    let token = if req.echo {
        s.lk.echo_token(&room, &m.id)?
    } else {
        let metadata = json!({ "role": m.role }).to_string();
        s.lk.join_token(&room, &m.id, &m.nickname, metadata)?
    };
    Ok(Json(json!({ "url": s.cfg.livekit_url(), "room": room, "token": token })))
}

/// Voice rooms that exist now, with who is in them.
async fn live_rooms(s: &SharedState) -> anyhow::Result<BTreeMap<u32, Vec<RoomPeer>>> {
    let mut rooms = BTreeMap::new();
    for name in s.lk.list_rooms().await? {
        let Some(n) = parse_room(&name) else { continue };
        let peers = s.lk.list_participants(&name).await?;
        rooms.insert(n, peers.into_iter().map(|(id, name)| RoomPeer { id, name }).collect());
    }
    Ok(rooms)
}

async fn rooms(State(s): State<SharedState>, _auth: AuthMember) -> ApiResult<Json<Vec<RoomView>>> {
    Ok(Json(layout(live_rooms(&s).await?)))
}

#[derive(Deserialize, Default)]
struct ChatQuery {
    after: Option<i64>,
}

async fn server_chat_messages(
    State(s): State<SharedState>,
    AuthMember(_m): AuthMember,
    Query(query): Query<ChatQuery>,
) -> ApiResult<Json<Vec<crate::db::ChatMessage>>> {
    Ok(Json(s.db.chat_messages("server", query.after.unwrap_or(0).max(0))?))
}

async fn chat_messages(
    State(s): State<SharedState>,
    AuthMember(_m): AuthMember,
    Path(room): Path<String>,
    Query(query): Query<ChatQuery>,
) -> ApiResult<Json<Vec<crate::db::ChatMessage>>> {
    if parse_room(&room).is_none() {
        return Err(ApiError::BadRequest("unknown room"));
    }
    Ok(Json(s.db.chat_messages(&room, query.after.unwrap_or(0).max(0))?))
}

#[derive(Deserialize)]
struct ChatReq {
    text: String,
}

async fn send_server_chat_message(
    State(s): State<SharedState>,
    AuthMember(m): AuthMember,
    Json(req): Json<ChatReq>,
) -> ApiResult<Json<crate::db::ChatMessage>> {
    Ok(Json(s.db.add_chat_message("server", &m, clean_chat_text(&req.text)?)?))
}

async fn direct_threads(
    State(s): State<SharedState>,
    AuthMember(m): AuthMember,
) -> ApiResult<Json<Vec<crate::db::DirectThread>>> {
    Ok(Json(s.db.direct_threads(&m.id)?))
}

fn valid_direct_peer(s: &SharedState, member_id: &str, peer_id: &str) -> ApiResult<()> {
    if peer_id == member_id || s.db.member(peer_id)?.is_none() {
        return Err(ApiError::NotFound);
    }
    Ok(())
}

async fn direct_messages(
    State(s): State<SharedState>,
    AuthMember(m): AuthMember,
    Path(peer): Path<String>,
    Query(query): Query<ChatQuery>,
) -> ApiResult<Json<Vec<crate::db::DirectMessage>>> {
    valid_direct_peer(&s, &m.id, &peer)?;
    Ok(Json(s.db.direct_messages(&m.id, &peer, query.after.unwrap_or(0).max(0))?))
}

async fn send_direct_message(
    State(s): State<SharedState>,
    AuthMember(m): AuthMember,
    Path(peer): Path<String>,
    Json(req): Json<ChatReq>,
) -> ApiResult<Json<crate::db::DirectMessage>> {
    valid_direct_peer(&s, &m.id, &peer)?;
    Ok(Json(s.db.add_direct_message(&m, &peer, clean_chat_text(&req.text)?)?))
}

fn clean_chat_text(raw: &str) -> ApiResult<&str> {
    let text = raw.trim();
    if text.is_empty() || text.chars().count() > 2000 || text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(ApiError::BadRequest("message must be 1-2000 printable characters"));
    }
    Ok(text)
}

async fn send_chat_message(
    State(s): State<SharedState>,
    AuthMember(m): AuthMember,
    Path(room): Path<String>,
    Json(req): Json<ChatReq>,
) -> ApiResult<Json<crate::db::ChatMessage>> {
    if parse_room(&room).is_none() {
        return Err(ApiError::BadRequest("unknown room"));
    }
    Ok(Json(s.db.add_chat_message(&room, &m, clean_chat_text(&req.text)?)?))
}

/// Runs `f` for every live room (kicks, role updates, deletion).
async fn each_room<F, Fut>(s: &SharedState, what: &str, f: F)
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let rooms = match s.lk.list_rooms().await {
        Ok(rooms) => rooms,
        Err(e) => return tracing::warn!("could not list rooms to {what}: {e:#}"),
    };
    for room in rooms {
        if let Err(e) = f(room.clone()).await {
            tracing::warn!("could not {what} in {room}: {e:#}");
        }
    }
}

async fn members(State(s): State<SharedState>, _auth: AuthMember) -> ApiResult<Json<Vec<Member>>> {
    Ok(Json(s.db.members()?))
}

/// Admins may act on members; the owner may act on everyone else.
fn outranks(actor: &Member, target: &Member) -> ApiResult<()> {
    if actor.id == target.id {
        return Err(ApiError::BadRequest("cannot do that to yourself"));
    }
    if actor.role <= target.role {
        return Err(ApiError::Forbidden("insufficient role"));
    }
    Ok(())
}

async fn disconnect(s: &SharedState, identity: &str) {
    each_room(s, "disconnect", |room| async move {
        s.lk.remove_participant(&room, identity).await?;
        s.lk.remove_participant(&room, &format!("{identity}{ECHO_SUFFIX}")).await
    })
    .await;
}

async fn kick(
    State(s): State<SharedState>,
    auth: AuthMember,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    auth.require(Role::Admin)?;
    let target = s.db.member(&id)?.ok_or(ApiError::NotFound)?;
    outranks(&auth.0, &target)?;
    s.db.delete_member(&target.id)?;
    disconnect(&s, &target.id).await;
    tracing::info!("{} kicked {}", auth.0.nickname, target.nickname);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct LogsReq {
    #[serde(default)]
    version: String,
    entries: Vec<Value>,
}

/// Per-member diagnostic log files are rotated at this size.
const LOG_FILE_MAX: u64 = 4 << 20;
const LOG_BATCH_MAX: usize = 500;
const LOG_ENTRY_MAX: usize = 4096;

/// Apps send what happened to their mic and connection, so problems like
/// "my mic keeps cutting out" can be read afterwards on the server:
/// `logs/<member id>.log` next to the database, one JSON object per line.
async fn client_logs(
    State(s): State<SharedState>,
    AuthMember(m): AuthMember,
    Json(req): Json<LogsReq>,
) -> ApiResult<StatusCode> {
    if req.entries.len() > LOG_BATCH_MAX {
        return Err(ApiError::BadRequest("too many log entries"));
    }
    let dir = std::path::Path::new(&s.cfg.db_path).with_file_name("logs");
    let version: String = req.version.chars().take(32).collect();
    let mut out = String::new();
    for entry in req.entries {
        let line = json!({ "at": now(), "who": m.nickname, "v": version, "e": entry }).to_string();
        if line.len() <= LOG_ENTRY_MAX {
            out.push_str(&line);
            out.push('\n');
        }
    }
    let path = dir.join(format!("{}.log", m.id));
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        use std::io::Write;
        std::fs::create_dir_all(&dir)?;
        if std::fs::metadata(&path).map(|md| md.len() > LOG_FILE_MAX).unwrap_or(false) {
            std::fs::rename(&path, path.with_extension("old.log"))?;
        }
        std::fs::OpenOptions::new().create(true).append(true).open(&path)?.write_all(out.as_bytes())
    })
    .await??;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MoveReq {
    room: String,
}

/// Drags someone into another voice room. The server only tells their app
/// where to go; the app reconnects there with its own token.
async fn move_member(
    State(s): State<SharedState>,
    auth: AuthMember,
    Path(id): Path<String>,
    Json(req): Json<MoveReq>,
) -> ApiResult<StatusCode> {
    auth.require(Role::Admin)?;
    let to = parse_room(&req.room).ok_or(ApiError::BadRequest("unknown room"))?;
    let target = s.db.member(&id)?.ok_or(ApiError::NotFound)?;
    let rooms = live_rooms(&s).await?;
    let from = rooms
        .iter()
        .find(|(_, peers)| peers.iter().any(|p| p.id == target.id))
        .map(|(n, _)| *n)
        .ok_or(ApiError::BadRequest("not in voice"))?;
    if from == to {
        return Ok(StatusCode::NO_CONTENT);
    }
    if rooms.get(&to).map_or(0, Vec::len) >= MAX_PEERS {
        return Err(ApiError::BadRequest("room is full"));
    }
    s.lk.send_data(&room_id(from), &target.id, MOVE_TOPIC, &json!({ "room": room_id(to) })).await?;
    tracing::info!("{} moved {} to {}", auth.0.nickname, target.nickname, room_id(to));
    Ok(StatusCode::NO_CONTENT)
}

/// Must match LiveKit's `max_participants` in livekit.yaml.
const MAX_PEERS: usize = 10;
const MOVE_TOPIC: &str = "voicy.move";

#[derive(Deserialize)]
struct SetRoleReq {
    role: Role,
}

async fn set_role(
    State(s): State<SharedState>,
    auth: AuthMember,
    Path(id): Path<String>,
    Json(req): Json<SetRoleReq>,
) -> ApiResult<Json<Member>> {
    auth.require(Role::Owner)?;
    if req.role == Role::Owner {
        return Err(ApiError::BadRequest("ownership cannot be transferred yet"));
    }
    let mut target = s.db.member(&id)?.ok_or(ApiError::NotFound)?;
    outranks(&auth.0, &target)?;
    s.db.set_role(&target.id, req.role)?;
    target.role = req.role;
    // Tokens carry the role as metadata; update it for a live session too.
    let metadata = json!({ "role": target.role }).to_string();
    let (lk, id, metadata) = (&s.lk, &target.id, &metadata);
    each_room(&s, "update the role", |room| async move { lk.update_metadata(&room, id, metadata).await }).await;
    Ok(Json(target))
}

#[derive(Deserialize, Default)]
struct CreateInviteReq {
    /// 0 means the invite never expires.
    expires_in_hours: Option<u32>,
}

#[derive(Serialize)]
struct CreatedInvite {
    #[serde(flatten)]
    invite: Invite,
    link: String,
}

async fn create_invite(
    State(s): State<SharedState>,
    auth: AuthMember,
    body: Option<Json<CreateInviteReq>>,
) -> ApiResult<Json<CreatedInvite>> {
    auth.require(Role::Admin)?;
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let hours = req.expires_in_hours.unwrap_or(DEFAULT_INVITE_HOURS);
    if hours > MAX_INVITE_HOURS {
        return Err(ApiError::BadRequest("invite lifetime is too long"));
    }
    let now = now();
    let expires_at = (hours > 0).then(|| now + i64::from(hours) * 3600);
    let code = random_secret();
    let invite = s.db.create_invite(&hash(&code), &auth.0.id, now, expires_at)?;
    Ok(Json(CreatedInvite { invite, link: s.cfg.invite_link(&code) }))
}

async fn list_invites(State(s): State<SharedState>, auth: AuthMember) -> ApiResult<Json<Vec<Invite>>> {
    auth.require(Role::Admin)?;
    Ok(Json(s.db.active_invites(now())?))
}

async fn revoke_invite(
    State(s): State<SharedState>,
    auth: AuthMember,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    auth.require(Role::Admin)?;
    if s.db.revoke_invite(&id)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

/// `access_token` from a LiveKit signalling URL such as
/// `/rtc/v1?access_token=...&auto_subscribe=1`.
fn access_token(uri: &str) -> Option<&str> {
    let (_, query) = uri.split_once('?')?;
    query.split('&').find_map(|kv| kv.strip_prefix("access_token="))
}

/// Caddy asks this (`forward_auth`) before every LiveKit signalling
/// connection, including reconnects and resumes. Self-hosted LiveKit cannot
/// revoke tokens, so this is what keeps kicked members and deleted servers
/// out: their tokens stay cryptographically valid until they expire.
async fn rtc_auth(State(s): State<SharedState>, headers: axum::http::HeaderMap) -> ApiResult<StatusCode> {
    if s.db.is_deleted()? {
        return Err(ApiError::Gone);
    }
    let identity = headers
        .get("x-forwarded-uri")
        .and_then(|v| v.to_str().ok())
        .and_then(access_token)
        .and_then(|t| s.lk.verify_identity(t))
        .ok_or(ApiError::Unauthorized)?;
    let member_id = identity.strip_suffix(ECHO_SUFFIX).unwrap_or(&identity);
    if s.db.member(member_id)?.is_none() {
        return Err(ApiError::Forbidden("not a member"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RenameReq {
    name: String,
}

async fn rename_server(
    State(s): State<SharedState>,
    auth: AuthMember,
    Json(req): Json<RenameReq>,
) -> ApiResult<Json<Value>> {
    auth.require(Role::Admin)?;
    let name = req.name.trim();
    let len = name.chars().count();
    if len == 0 || len > 48 || name.chars().any(char::is_control) {
        return Err(ApiError::BadRequest("name must be 1-48 printable characters"));
    }
    s.db.set_name(name)?;
    tracing::info!("{} renamed the server to {name:?}", auth.0.nickname);
    Ok(Json(json!({ "name": name })))
}

async fn delete_server(State(s): State<SharedState>, auth: AuthMember) -> ApiResult<StatusCode> {
    auth.require(Role::Owner)?;
    s.db.wipe()?;
    // Everyone is gone from the database; close every room they are in.
    let lk = &s.lk;
    each_room(&s, "close the room", |room| async move { lk.delete_room(&room).await }).await;
    tracing::info!("server deleted by owner {}", auth.0.nickname);
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::access_token;

    #[test]
    fn access_token_from_signal_uri() {
        assert_eq!(access_token("/rtc/v1?auto_subscribe=1&access_token=a.b.c&sdk=js"), Some("a.b.c"));
        assert_eq!(access_token("/rtc?access_token=x"), Some("x"));
        assert_eq!(access_token("/rtc/v1?sdk=js"), None);
        assert_eq!(access_token("/rtc"), None);
    }
}
