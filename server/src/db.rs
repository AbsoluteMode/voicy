use std::{
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

/// Ordered so that `role >= Role::Admin` reads naturally.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Member,
    Admin,
    Owner,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Member => "member",
            Role::Admin => "admin",
            Role::Owner => "owner",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        match s {
            "member" => Ok(Role::Member),
            "admin" => Ok(Role::Admin),
            "owner" => Ok(Role::Owner),
            _ => Err(anyhow!("unknown role {s:?}")),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Member {
    pub id: String,
    pub nickname: String,
    pub role: Role,
    #[serde(skip)]
    pub secret_hash: String,
    pub created_at: i64,
    /// Version of the member's picture, for `/api/avatars/{id}?v=<version>`.
    pub avatar: Option<String>,
}

impl Member {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        let role: String = r.get("role")?;
        Ok(Member {
            id: r.get("id")?,
            nickname: r.get("nickname")?,
            role: Role::parse(&role)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into()))?,
            secret_hash: r.get("secret_hash")?,
            created_at: r.get("created_at")?,
            avatar: r.get("avatar")?,
        })
    }
}

/// Members joined with their avatar version, the shape `Member::from_row` reads.
const MEMBER_SELECT: &str = "SELECT m.*, a.version AS avatar FROM members m LEFT JOIN avatars a ON a.member_id = m.id";

pub struct Avatar {
    pub mime: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Invite {
    pub id: String,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatMessage {
    pub id: i64,
    pub room: String,
    pub member_id: String,
    pub nickname: String,
    pub text: String,
    pub created_at: i64,
    pub attachment: Option<AttachmentMeta>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DirectMessage {
    pub id: i64,
    pub member_id: String,
    pub nickname: String,
    pub text: String,
    pub created_at: i64,
    pub attachment: Option<AttachmentMeta>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AttachmentMeta {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
}

pub struct NewAttachment {
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
}

pub struct StoredAttachment {
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DirectThread {
    pub peer_id: String,
    pub nickname: String,
    pub message_id: i64,
    pub member_id: String,
    pub text: String,
    pub created_at: i64,
}

pub enum Redeem {
    Ok(Member),
    InvalidCode,
    OwnerExists,
}

pub struct Db(Mutex<Connection>);

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
    id          TEXT PRIMARY KEY,
    nickname    TEXT NOT NULL,
    role        TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
    id         TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL UNIQUE,
    role       TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    used_by    TEXT,
    used_at    INTEGER
);
CREATE TABLE IF NOT EXISTS avatars (
    member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    version   TEXT NOT NULL,
    mime      TEXT NOT NULL,
    data      BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    room       TEXT NOT NULL,
    member_id  TEXT NOT NULL,
    nickname   TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_room_id ON chat_messages(room, id);
CREATE TABLE IF NOT EXISTS direct_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    nickname     TEXT NOT NULL,
    text         TEXT NOT NULL,
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS direct_messages_sender_id ON direct_messages(sender_id, id);
CREATE INDEX IF NOT EXISTS direct_messages_recipient_id ON direct_messages(recipient_id, id);
CREATE TABLE IF NOT EXISTS attachments (
    id                TEXT PRIMARY KEY,
    chat_message_id   INTEGER UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE,
    direct_message_id INTEGER UNIQUE REFERENCES direct_messages(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    mime              TEXT NOT NULL,
    data              BLOB NOT NULL,
    CHECK ((chat_message_id IS NOT NULL) != (direct_message_id IS NOT NULL))
);
";

/// `created_by` of an owner invite made by a redeploy while an owner exists.
const RECOVERY: &str = "ssh-recovery";

fn attachment_from_row(row: &Row, offset: usize) -> rusqlite::Result<Option<AttachmentMeta>> {
    let Some(id) = row.get(offset)? else { return Ok(None) };
    Ok(Some(AttachmentMeta {
        id,
        name: row.get(offset + 1)?,
        mime: row.get(offset + 2)?,
        size: row.get(offset + 3)?,
    }))
}

fn save_attachment(tx: &rusqlite::Transaction<'_>, chat_id: Option<i64>, direct_id: Option<i64>, a: &NewAttachment) -> Result<AttachmentMeta> {
    let id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO attachments (id, chat_message_id, direct_message_id, name, mime, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![&id, chat_id, direct_id, &a.name, &a.mime, &a.data],
    )?;
    Ok(AttachmentMeta { id, name: a.name.clone(), mime: a.mime.clone(), size: a.data.len() as i64 })
}

impl Db {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db(Mutex::new(conn)))
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn chat_messages(&self, room: &str, after: i64) -> Result<Vec<ChatMessage>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.room, c.member_id, c.nickname, c.text, c.created_at,
                    a.id, a.name, a.mime, length(a.data)
             FROM (SELECT * FROM chat_messages WHERE room = ?1 AND id > ?2 ORDER BY id DESC LIMIT 100) c
             LEFT JOIN attachments a ON a.chat_message_id = c.id ORDER BY c.id ASC",
        )?;
        let rows = stmt.query_map(params![room, after], |r| {
            Ok(ChatMessage {
                id: r.get(0)?, room: r.get(1)?, member_id: r.get(2)?,
                nickname: r.get(3)?, text: r.get(4)?, created_at: r.get(5)?, attachment: attachment_from_row(r, 6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_chat_message(&self, room: &str, member: &Member, text: &str, file: Option<&NewAttachment>) -> Result<ChatMessage> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let created_at = now();
        tx.execute(
            "INSERT INTO chat_messages (room, member_id, nickname, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![room, member.id, member.nickname, text, created_at],
        )?;
        let id = tx.last_insert_rowid();
        let attachment = file.map(|a| save_attachment(&tx, Some(id), None, a)).transpose()?;
        tx.execute(
            "DELETE FROM chat_messages WHERE room = ?1 AND id <=
             COALESCE((SELECT id FROM chat_messages WHERE room = ?1 ORDER BY id DESC LIMIT 1 OFFSET 999), 0) - 1",
            [room],
        )?;
        tx.commit()?;
        Ok(ChatMessage {
            id, room: room.to_owned(), member_id: member.id.clone(),
            nickname: member.nickname.clone(), text: text.to_owned(), created_at, attachment,
        })
    }

    pub fn direct_messages(&self, member_id: &str, peer_id: &str, after: i64) -> Result<Vec<DirectMessage>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT d.id, d.sender_id, d.nickname, d.text, d.created_at,
                    a.id, a.name, a.mime, length(a.data)
             FROM (SELECT * FROM direct_messages
              WHERE ((sender_id = ?1 AND recipient_id = ?2) OR (sender_id = ?2 AND recipient_id = ?1))
                AND id > ?3 ORDER BY id DESC LIMIT 100) d
             LEFT JOIN attachments a ON a.direct_message_id = d.id ORDER BY d.id ASC",
        )?;
        let rows = stmt.query_map(params![member_id, peer_id, after], |r| {
            Ok(DirectMessage { id: r.get(0)?, member_id: r.get(1)?, nickname: r.get(2)?, text: r.get(3)?, created_at: r.get(4)?, attachment: attachment_from_row(r, 5)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn direct_threads(&self, member_id: &str) -> Result<Vec<DirectThread>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "WITH conversations AS (
               SELECT CASE WHEN sender_id = ?1 THEN recipient_id ELSE sender_id END AS peer_id, MAX(id) AS message_id
               FROM direct_messages WHERE sender_id = ?1 OR recipient_id = ?1 GROUP BY peer_id
             )
             SELECT m.id, m.nickname, d.id, d.sender_id, d.text, d.created_at, a.name
             FROM conversations c JOIN members m ON m.id = c.peer_id JOIN direct_messages d ON d.id = c.message_id
             LEFT JOIN attachments a ON a.direct_message_id = d.id
             ORDER BY d.id DESC LIMIT 100",
        )?;
        let rows = stmt.query_map([member_id], |r| {
            let text: String = r.get(4)?;
            let file_name: Option<String> = r.get(6)?;
            Ok(DirectThread {
                peer_id: r.get(0)?, nickname: r.get(1)?, message_id: r.get(2)?,
                member_id: r.get(3)?, text: if text.is_empty() { file_name.map(|name| format!("Файл: {name}")).unwrap_or_default() } else { text }, created_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_direct_message(&self, sender: &Member, recipient_id: &str, text: &str, file: Option<&NewAttachment>) -> Result<DirectMessage> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let created_at = now();
        tx.execute(
            "INSERT INTO direct_messages (sender_id, recipient_id, nickname, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![sender.id, recipient_id, sender.nickname, text, created_at],
        )?;
        let id = tx.last_insert_rowid();
        let attachment = file.map(|a| save_attachment(&tx, None, Some(id), a)).transpose()?;
        tx.execute(
            "DELETE FROM direct_messages WHERE
              ((sender_id = ?1 AND recipient_id = ?2) OR (sender_id = ?2 AND recipient_id = ?1))
              AND id < (SELECT id FROM direct_messages WHERE
                (sender_id = ?1 AND recipient_id = ?2) OR (sender_id = ?2 AND recipient_id = ?1)
                ORDER BY id DESC LIMIT 1 OFFSET 999)",
            params![sender.id, recipient_id],
        )?;
        tx.commit()?;
        Ok(DirectMessage { id, member_id: sender.id.clone(), nickname: sender.nickname.clone(), text: text.to_owned(), created_at, attachment })
    }

    pub fn attachment(&self, id: &str, viewer_id: &str) -> Result<Option<StoredAttachment>> {
        Ok(self.conn().query_row(
            "SELECT a.name, a.mime, a.data FROM attachments a
             LEFT JOIN direct_messages d ON d.id = a.direct_message_id
             WHERE a.id = ?1 AND (a.chat_message_id IS NOT NULL OR d.sender_id = ?2 OR d.recipient_id = ?2)",
            params![id, viewer_id],
            |r| Ok(StoredAttachment { name: r.get(0)?, mime: r.get(1)?, data: r.get(2)? }),
        ).optional()?)
    }

    /// Name set in the app; the install-time name applies until then.
    pub fn name(&self) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM meta WHERE key = 'name'", [], |r| r.get(0))
            .optional()?)
    }

    pub fn set_name(&self, name: &str) -> Result<()> {
        self.conn()
            .execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('name', ?1)", [name])?;
        Ok(())
    }

    pub fn is_deleted(&self) -> Result<bool> {
        let v: Option<String> = self
            .conn()
            .query_row("SELECT value FROM meta WHERE key = 'deleted'", [], |r| r.get(0))
            .optional()?;
        Ok(v.is_some())
    }

    /// Creates the owner invite for a fresh install. Returns false when an
    /// owner already exists or the server was deleted.
    /// Owner invite for the code the deploying app passed in. While there
    /// is no owner it simply creates one. With an owner it is a recovery
    /// invite: whoever can redeploy over SSH controls the server anyway, so
    /// a fresh code from a redeploy hands ownership back (for a lost login).
    /// A code seen before, used or not, is never reissued.
    pub fn ensure_owner_invite(&self, code_hash: &str, now: i64) -> Result<bool> {
        if self.is_deleted()? {
            return Ok(false);
        }
        let conn = self.conn();
        let owners: i64 = conn.query_row("SELECT COUNT(*) FROM members WHERE role = 'owner'", [], |r| r.get(0))?;
        let (created_by, expires_at) = if owners > 0 { (Some(RECOVERY), Some(now + 24 * 3600)) } else { (None, None) };
        let n = conn.execute(
            "INSERT OR IGNORE INTO invites (id, code_hash, role, created_by, created_at, expires_at) VALUES (?1, ?2, 'owner', ?3, ?4, ?5)",
            params![uuid::Uuid::new_v4().to_string(), code_hash, created_by, now, expires_at],
        )?;
        Ok(n > 0)
    }

    pub fn redeem_invite(&self, code_hash: &str, nickname: &str, secret_hash: &str, now: i64) -> Result<Redeem> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let invite: Option<(String, String, Option<String>)> = tx
            .query_row(
                "SELECT id, role, created_by FROM invites
                 WHERE code_hash = ?1 AND used_by IS NULL AND (expires_at IS NULL OR expires_at > ?2)",
                params![code_hash, now],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((invite_id, role, created_by)) = invite else {
            return Ok(Redeem::InvalidCode);
        };
        let role = Role::parse(&role)?;
        if role == Role::Owner {
            let owners: i64 = tx.query_row("SELECT COUNT(*) FROM members WHERE role = 'owner'", [], |r| r.get(0))?;
            if owners > 0 {
                if created_by.as_deref() != Some(RECOVERY) {
                    return Ok(Redeem::OwnerExists);
                }
                // The previous owner stays, as an admin.
                tx.execute("UPDATE members SET role = 'admin' WHERE role = 'owner'", [])?;
            }
        }
        let member = Member {
            id: uuid::Uuid::new_v4().to_string(),
            nickname: nickname.to_owned(),
            role,
            secret_hash: secret_hash.to_owned(),
            created_at: now,
            avatar: None,
        };
        tx.execute(
            "INSERT INTO members (id, nickname, role, secret_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![member.id, member.nickname, role.as_str(), member.secret_hash, now],
        )?;
        tx.execute(
            "UPDATE invites SET used_by = ?1, used_at = ?2 WHERE id = ?3",
            params![member.id, now, invite_id],
        )?;
        tx.commit()?;
        Ok(Redeem::Ok(member))
    }

    pub fn member(&self, id: &str) -> Result<Option<Member>> {
        Ok(self
            .conn()
            .query_row(&format!("{MEMBER_SELECT} WHERE m.id = ?1"), [id], Member::from_row)
            .optional()?)
    }

    pub fn members(&self) -> Result<Vec<Member>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("{MEMBER_SELECT} ORDER BY m.created_at"))?;
        let rows = stmt.query_map([], Member::from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn set_nickname(&self, id: &str, nickname: &str) -> Result<()> {
        self.conn()
            .execute("UPDATE members SET nickname = ?1 WHERE id = ?2", params![nickname, id])?;
        Ok(())
    }

    pub fn set_role(&self, id: &str, role: Role) -> Result<()> {
        self.conn()
            .execute("UPDATE members SET role = ?1 WHERE id = ?2", params![role.as_str(), id])?;
        Ok(())
    }

    pub fn set_avatar(&self, id: &str, version: &str, mime: &str, data: &[u8]) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO avatars (member_id, version, mime, data) VALUES (?1, ?2, ?3, ?4)",
            params![id, version, mime, data],
        )?;
        Ok(())
    }

    pub fn clear_avatar(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM avatars WHERE member_id = ?1", [id])?;
        Ok(())
    }

    pub fn avatar(&self, id: &str) -> Result<Option<Avatar>> {
        Ok(self
            .conn()
            .query_row("SELECT mime, data FROM avatars WHERE member_id = ?1", [id], |r| {
                Ok(Avatar { mime: r.get(0)?, data: r.get(1)? })
            })
            .optional()?)
    }

    pub fn delete_member(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM members WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn create_invite(&self, code_hash: &str, created_by: &str, now: i64, expires_at: Option<i64>) -> Result<Invite> {
        let invite = Invite {
            id: uuid::Uuid::new_v4().to_string(),
            created_by: Some(created_by.to_owned()),
            created_at: now,
            expires_at,
        };
        self.conn().execute(
            "INSERT INTO invites (id, code_hash, role, created_by, created_at, expires_at)
             VALUES (?1, ?2, 'member', ?3, ?4, ?5)",
            params![invite.id, code_hash, created_by, now, expires_at],
        )?;
        Ok(invite)
    }

    /// Unused, unexpired member invites.
    pub fn active_invites(&self, now: i64) -> Result<Vec<Invite>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, created_by, created_at, expires_at FROM invites
             WHERE role != 'owner' AND used_by IS NULL AND (expires_at IS NULL OR expires_at > ?1)
             ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([now], |r| {
            Ok(Invite {
                id: r.get(0)?,
                created_by: r.get(1)?,
                created_at: r.get(2)?,
                expires_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Returns false if there was no such unused invite.
    pub fn revoke_invite(&self, id: &str) -> Result<bool> {
        let n = self.conn().execute(
            "DELETE FROM invites WHERE id = ?1 AND role != 'owner' AND used_by IS NULL",
            [id],
        )?;
        Ok(n > 0)
    }

    /// Forgets every member and invite and marks the server as deleted, so
    /// that the bootstrap code cannot resurrect it.
    pub fn wipe(&self) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute_batch(
            "DELETE FROM direct_messages;
             DELETE FROM chat_messages;
             DELETE FROM avatars;
             DELETE FROM members;
             DELETE FROM invites;
             INSERT OR REPLACE INTO meta (key, value) VALUES ('deleted', '1');",
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::open(":memory:").unwrap()
    }

    #[test]
    fn owner_invite_is_single_use_and_only_while_ownerless() {
        let db = db();
        assert!(db.ensure_owner_invite("owner-code", 0).unwrap());
        let Redeem::Ok(owner) = db.redeem_invite("owner-code", "izzy", "s1", 1).unwrap() else { panic!() };
        assert_eq!(owner.role, Role::Owner);
        assert!(matches!(db.redeem_invite("owner-code", "x", "s2", 2).unwrap(), Redeem::InvalidCode));
    }

    #[test]
    fn a_redeploy_hands_ownership_back() {
        let db = db();
        db.ensure_owner_invite("first", 0).unwrap();
        let Redeem::Ok(old) = db.redeem_invite("first", "izzy", "s1", 1).unwrap() else { panic!() };
        // Restarting with the used code changes nothing.
        assert!(!db.ensure_owner_invite("first", 2).unwrap());
        // A redeploy brings a new code: its holder becomes the owner.
        assert!(db.ensure_owner_invite("second", 3).unwrap());
        let Redeem::Ok(new) = db.redeem_invite("second", "izzy", "s2", 4).unwrap() else { panic!() };
        assert_eq!(new.role, Role::Owner);
        assert_eq!(db.member(&old.id).unwrap().unwrap().role, Role::Admin);
        assert!(matches!(db.redeem_invite("second", "x", "s3", 5).unwrap(), Redeem::InvalidCode));
        // It expires if nobody finishes the redeploy.
        assert!(db.ensure_owner_invite("third", 10).unwrap());
        assert!(matches!(db.redeem_invite("third", "x", "s4", 10 + 24 * 3600 + 1).unwrap(), Redeem::InvalidCode));
    }

    #[test]
    fn member_invites_expire_and_can_be_revoked() {
        let db = db();
        db.create_invite("fresh", "owner", 100, Some(200)).unwrap();
        db.create_invite("stale", "owner", 100, Some(150)).unwrap();
        let revoked = db.create_invite("revoked", "owner", 100, None).unwrap();
        assert_eq!(db.active_invites(160).unwrap().len(), 2);
        assert!(db.revoke_invite(&revoked.id).unwrap());
        assert!(matches!(db.redeem_invite("revoked", "a", "s", 160).unwrap(), Redeem::InvalidCode));
        assert!(matches!(db.redeem_invite("stale", "a", "s", 160).unwrap(), Redeem::InvalidCode));
        let Redeem::Ok(m) = db.redeem_invite("fresh", "a", "s", 160).unwrap() else { panic!() };
        assert_eq!(m.role, Role::Member);
    }

    #[test]
    fn wipe_forgets_everyone_and_blocks_bootstrap() {
        let db = db();
        db.ensure_owner_invite("code", 0).unwrap();
        db.redeem_invite("code", "izzy", "s", 1).unwrap();
        db.wipe().unwrap();
        assert!(db.is_deleted().unwrap());
        assert!(db.members().unwrap().is_empty());
        assert!(!db.ensure_owner_invite("code2", 2).unwrap());
    }

    #[test]
    fn avatars_follow_their_member() {
        let db = db();
        db.ensure_owner_invite("code", 0).unwrap();
        let Redeem::Ok(m) = db.redeem_invite("code", "izzy", "s", 1).unwrap() else { panic!() };
        assert_eq!(db.member(&m.id).unwrap().unwrap().avatar, None);
        db.set_avatar(&m.id, "v1", "image/webp", b"a").unwrap();
        db.set_avatar(&m.id, "v2", "image/png", b"b").unwrap();
        assert_eq!(db.members().unwrap()[0].avatar.as_deref(), Some("v2"));
        assert_eq!(db.avatar(&m.id).unwrap().unwrap().mime, "image/png");
        db.delete_member(&m.id).unwrap();
        assert!(db.avatar(&m.id).unwrap().is_none());
    }

    #[test]
    fn chat_is_ordered_and_separate_for_each_room() {
        let db = db();
        db.ensure_owner_invite("code", 0).unwrap();
        let Redeem::Ok(member) = db.redeem_invite("code", "izzy", "secret", 1).unwrap() else { panic!() };
        let first = db.add_chat_message("r1", &member, "hello", None).unwrap();
        db.add_chat_message("r2", &member, "elsewhere", None).unwrap();
        db.add_chat_message("server", &member, "everyone", None).unwrap();
        let second = db.add_chat_message("r1", &member, "again", None).unwrap();
        assert_eq!(db.chat_messages("r1", 0).unwrap().iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["hello", "again"]);
        assert_eq!(db.chat_messages("r1", first.id).unwrap()[0].id, second.id);
        assert_eq!(db.chat_messages("r2", 0).unwrap()[0].text, "elsewhere");
        assert_eq!(db.chat_messages("server", 0).unwrap()[0].text, "everyone");
        db.wipe().unwrap();
        assert!(db.chat_messages("r1", 0).unwrap().is_empty());
    }

    #[test]
    fn direct_messages_stay_between_the_two_members() {
        let db = db();
        db.ensure_owner_invite("owner", 0).unwrap();
        let Redeem::Ok(alice) = db.redeem_invite("owner", "Alice", "s1", 1).unwrap() else { panic!() };
        db.create_invite("bob", &alice.id, 1, None).unwrap();
        db.create_invite("cara", &alice.id, 1, None).unwrap();
        let Redeem::Ok(bob) = db.redeem_invite("bob", "Bob", "s2", 2).unwrap() else { panic!() };
        let Redeem::Ok(cara) = db.redeem_invite("cara", "Cara", "s3", 3).unwrap() else { panic!() };
        let first = db.add_direct_message(&alice, &bob.id, "hi", None).unwrap();
        db.add_direct_message(&bob, &alice.id, "hello", None).unwrap();
        db.add_direct_message(&alice, &cara.id, "private", None).unwrap();
        assert_eq!(db.direct_messages(&alice.id, &bob.id, 0).unwrap().iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["hi", "hello"]);
        assert_eq!(db.direct_messages(&bob.id, &alice.id, first.id).unwrap()[0].text, "hello");
        assert_eq!(db.direct_messages(&bob.id, &cara.id, 0).unwrap().len(), 0);
        assert_eq!(db.direct_threads(&bob.id).unwrap().iter().map(|t| t.peer_id.as_str()).collect::<Vec<_>>(), [alice.id.as_str()]);
        db.delete_member(&alice.id).unwrap();
        assert!(db.direct_messages(&bob.id, &alice.id, 0).unwrap().is_empty());
    }

    #[test]
    fn attachments_follow_message_access_and_deletion() {
        let db = db();
        db.ensure_owner_invite("owner", 0).unwrap();
        let Redeem::Ok(alice) = db.redeem_invite("owner", "Alice", "s1", 1).unwrap() else { panic!() };
        db.create_invite("bob", &alice.id, 1, None).unwrap();
        db.create_invite("cara", &alice.id, 1, None).unwrap();
        let Redeem::Ok(bob) = db.redeem_invite("bob", "Bob", "s2", 2).unwrap() else { panic!() };
        let Redeem::Ok(cara) = db.redeem_invite("cara", "Cara", "s3", 3).unwrap() else { panic!() };
        let file = NewAttachment { name: "example.pdf".into(), mime: "application/octet-stream".into(), data: b"file bytes".to_vec() };

        let public = db.add_chat_message("server", &alice, "", Some(&file)).unwrap();
        let public_id = public.attachment.unwrap().id;
        assert_eq!(db.chat_messages("server", 0).unwrap()[0].attachment.as_ref().unwrap().name, "example.pdf");
        assert_eq!(db.attachment(&public_id, &cara.id).unwrap().unwrap().data, b"file bytes");

        let private = db.add_direct_message(&alice, &bob.id, "", Some(&file)).unwrap();
        let private_id = private.attachment.unwrap().id;
        assert_eq!(db.direct_messages(&bob.id, &alice.id, 0).unwrap()[0].attachment.as_ref().unwrap().size, 10);
        assert!(db.attachment(&private_id, &alice.id).unwrap().is_some());
        assert!(db.attachment(&private_id, &bob.id).unwrap().is_some());
        assert!(db.attachment(&private_id, &cara.id).unwrap().is_none());
        assert_eq!(db.direct_threads(&bob.id).unwrap()[0].text, "Файл: example.pdf");

        db.delete_member(&alice.id).unwrap();
        assert!(db.attachment(&private_id, &bob.id).unwrap().is_none());
        db.wipe().unwrap();
        assert!(db.attachment(&public_id, &cara.id).unwrap().is_none());
    }
}
