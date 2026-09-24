//! Minimal LiveKit integration: access tokens and the two RoomService calls
//! we need, spoken over Twirp's JSON encoding.

use anyhow::{bail, Result};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::Serialize;
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
}

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

    pub async fn delete_room(&self, room: &str) -> Result<()> {
        self.room_service("DeleteRoom", room, json!({ "room": room })).await
    }
}
