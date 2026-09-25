use axum::{extract::FromRequestParts, http::request::Parts};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::{
    db::{Member, Role},
    error::ApiError,
    SharedState,
};

/// 256-bit random token, URL-safe.
pub fn random_secret() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Secrets and invite codes are high-entropy, so a plain SHA-256 is enough to
/// keep them out of the database in usable form.
pub fn hash(secret: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()))
}

/// A member authenticated by `Authorization: Bearer <member_id>.<secret>`.
pub struct AuthMember(pub Member);

impl AuthMember {
    pub fn require(&self, role: Role) -> Result<(), ApiError> {
        if self.0.role >= role {
            Ok(())
        } else {
            Err(ApiError::Forbidden("insufficient role"))
        }
    }
}

impl FromRequestParts<SharedState> for AuthMember {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &SharedState) -> Result<Self, ApiError> {
        if state.db.is_deleted()? {
            return Err(ApiError::Gone);
        }
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(ApiError::Unauthorized)?;
        let token = header.strip_prefix("Bearer ").ok_or(ApiError::Unauthorized)?;
        let (id, secret) = token.split_once('.').ok_or(ApiError::Unauthorized)?;
        let member = state.db.member(id)?.ok_or(ApiError::Unauthorized)?;
        if member.secret_hash != hash(secret) {
            return Err(ApiError::Unauthorized);
        }
        state.presence.touch(&member.id, crate::db::now());
        Ok(AuthMember(member))
    }
}
