//! Minimal LiveKit integration: access tokens and the two RoomService calls
//! we need, spoken over Twirp's JSON encoding.

use anyhow::{bail, Result};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db::now;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct VideoGrant {
    room: String,
    room_join: bool,
    room_admin: bool,
    room_create: bool,
    // LiveKit treats a missing canPublish/canSubscribe as "allowed", so they
    // are always sent explicitly.
    can_publish: bool,
    can_subscribe: bool,
    can_publish_data: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    can_publish_sources: Vec<&'static str>,
    can_update_own_metadata: bool,
    /// Invisible to other participants.
    hidden: bool,
}

/// Suffix of the hidden listener identity used by a member's echo test.
pub const ECHO_SUFFIX: &str = "#echo";

#[derive(Serialize)]
struct Claims {
    iss: String,
    sub: String,
    nbf: i64,
    exp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<String>,
    video: VideoGrant,
}

pub struct LiveKit {
    http: reqwest::Client,
    api_url: String,
    key: String,
    secret: String,
}

impl LiveKit {
    pub fn new(api_url: &str, key: &str, secret: &str) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_url: api_url.trim_end_matches('/').to_owned(),
            key: key.to_owned(),
            secret: secret.to_owned(),
        }
    }

    fn sign(&self, sub: &str, ttl_secs: i64, name: Option<String>, metadata: Option<String>, video: VideoGrant) -> Result<String> {
        let now = now();
        let claims = Claims {
            iss: self.key.clone(),
            sub: sub.to_owned(),
            nbf: now - 10,
            exp: now + ttl_secs,
            name,
            metadata,
            video,
        };
        Ok(encode(&Header::default(), &claims, &EncodingKey::from_secret(self.secret.as_bytes()))?)
    }

    /// Token that lets a member join `room` and speak. It only needs to live
    /// long enough to connect: LiveKit refreshes tokens for live sessions.
    pub fn join_token(&self, room: &str, identity: &str, name: &str, metadata: String) -> Result<String> {
        self.sign(
            identity,
            120,
            Some(name.to_owned()),
            Some(metadata),
            VideoGrant {
                room: room.to_owned(),
                room_join: true,
                can_publish: true,
                can_subscribe: true,
                can_publish_sources: vec!["microphone"],
                ..Default::default()
            },
        )
    }

    /// Hidden, listen-only participant that lets a member hear their own
    /// track back through the SFU.
    pub fn echo_token(&self, room: &str, identity: &str) -> Result<String> {
        self.sign(
            &format!("{identity}{ECHO_SUFFIX}"),
            120,
            Some("echo".to_owned()),
            None,
            VideoGrant {
                room: room.to_owned(),
                room_join: true,
                can_subscribe: true,
                hidden: true,
                ..Default::default()
            },
        )
    }

    /// Identity of a valid token signed with our key. That includes the
    /// tokens LiveKit itself refreshes for connected participants.
    pub fn verify_identity(&self, token: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct Sub {
            sub: String,
        }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_required_spec_claims(&["exp", "sub"]);
        validation.leeway = 10;
        decode::<Sub>(token, &DecodingKey::from_secret(self.secret.as_bytes()), &validation)
            .ok()
            .map(|t| t.claims.sub)
    }

    async fn room_service(&self, method: &str, room: &str, body: serde_json::Value) -> Result<()> {
        let token = self.sign(
            "voicy-server",
            60,
            None,
            None,
            VideoGrant {
                room: room.to_owned(),
                room_admin: true,
                room_create: true,
                ..Default::default()
            },
        )?;
        let res = self
            .http
            .post(format!("{}/twirp/livekit.RoomService/{method}", self.api_url))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await?;
        let status = res.status();
        if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
            // Not found: the participant or room is already gone.
            return Ok(());
        }
        bail!("LiveKit {method} failed: {status} {}", res.text().await.unwrap_or_default())
    }

    pub async fn remove_participant(&self, room: &str, identity: &str) -> Result<()> {
        self.room_service("RemoveParticipant", room, json!({ "room": room, "identity": identity }))
            .await
    }

    /// Pushes new metadata (e.g. a role change) to everyone in the room,
    /// the participant included.
    pub async fn update_metadata(&self, room: &str, identity: &str, metadata: &str) -> Result<()> {
        self.room_service(
            "UpdateParticipant",
            room,
            json!({ "room": room, "identity": identity, "metadata": metadata }),
        )
        .await
    }

    pub async fn delete_room(&self, room: &str) -> Result<()> {
        self.room_service("DeleteRoom", room, json!({ "room": room })).await
    }
}

#[cfg(test)]
mod tests {
    use super::LiveKit;

    #[test]
    fn join_tokens_verify_only_with_our_secret() {
        let lk = LiveKit::new("http://127.0.0.1:7880", "key", "secret");
        let token = lk.join_token("main", "member-1", "izzy", "{}".into()).unwrap();
        assert_eq!(lk.verify_identity(&token).as_deref(), Some("member-1"));
        let other = LiveKit::new("http://127.0.0.1:7880", "key", "other-secret");
        assert_eq!(other.verify_identity(&token), None);
        assert_eq!(lk.verify_identity("garbage"), None);
    }
}
