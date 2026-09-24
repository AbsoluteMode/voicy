use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    auth::{hash, random_secret, AuthMember},
    db::{now, Invite, Member, Redeem, Role},
    error::{ApiError, ApiResult},
    livekit::ECHO_SUFFIX,
    SharedState, ROOM,
};

const DEFAULT_INVITE_HOURS: u32 = 72;
const MAX_INVITE_HOURS: u32 = 24 * 30;

pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/api/info", get(info))
        .route("/api/join", post(join))
        .route("/api/me", get(me).patch(update_me).delete(leave))
        .route("/api/token", post(token))
        .route("/api/members", get(members))
        .route("/api/members/{id}/kick", post(kick))
        .route("/api/members/{id}/role", post(set_role))
        .route("/api/invites", get(list_invites).post(create_invite))
        .route("/api/invites/{id}", delete(revoke_invite))
        .route("/api/server", delete(delete_server))
        .route("/api/rtc-auth", get(rtc_auth))
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
        "name": s.cfg.server_name,
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
            server_name: s.cfg.server_name.clone(),
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
    /// Token for the member's hidden echo-test listener instead.
    #[serde(default)]
    echo: bool,
}

async fn token(
    State(s): State<SharedState>,
    AuthMember(m): AuthMember,
    body: Option<Json<TokenReq>>,
) -> ApiResult<Json<Value>> {
    let echo = body.is_some_and(|Json(b)| b.echo);
    let token = if echo {
        s.lk.echo_token(ROOM, &m.id)?
    } else {
        let metadata = json!({ "role": m.role }).to_string();
        s.lk.join_token(ROOM, &m.id, &m.nickname, metadata)?
    };
    Ok(Json(json!({ "url": s.cfg.livekit_url(), "room": ROOM, "token": token })))
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
    for id in [identity.to_owned(), format!("{identity}{ECHO_SUFFIX}")] {
        if let Err(e) = s.lk.remove_participant(ROOM, &id).await {
            tracing::warn!("could not disconnect {id}: {e:#}");
        }
    }
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
    if let Err(e) = s.lk.update_metadata(ROOM, &target.id, &metadata).await {
        tracing::warn!("could not update {}'s metadata: {e:#}", target.id);
    }
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

async fn delete_server(State(s): State<SharedState>, auth: AuthMember) -> ApiResult<StatusCode> {
    auth.require(Role::Owner)?;
    s.db.wipe()?;
    if let Err(e) = s.lk.delete_room(ROOM).await {
        tracing::warn!("could not close room: {e:#}");
    }
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
