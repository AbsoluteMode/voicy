use std::{
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

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
";

impl Db {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Db(Mutex::new(conn)))
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
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
    pub fn ensure_owner_invite(&self, code_hash: &str, now: i64) -> Result<bool> {
        if self.is_deleted()? {
            return Ok(false);
        }
        let conn = self.conn();
        let owners: i64 = conn.query_row("SELECT COUNT(*) FROM members WHERE role = 'owner'", [], |r| r.get(0))?;
        if owners > 0 {
            return Ok(false);
        }
        let n = conn.execute(
            "INSERT OR IGNORE INTO invites (id, code_hash, role, created_at) VALUES (?1, ?2, 'owner', ?3)",
            params![uuid::Uuid::new_v4().to_string(), code_hash, now],
        )?;
        Ok(n > 0)
    }

    pub fn redeem_invite(&self, code_hash: &str, nickname: &str, secret_hash: &str, now: i64) -> Result<Redeem> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let invite: Option<(String, String)> = tx
            .query_row(
                "SELECT id, role FROM invites
                 WHERE code_hash = ?1 AND used_by IS NULL AND (expires_at IS NULL OR expires_at > ?2)",
                params![code_hash, now],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((invite_id, role)) = invite else {
            return Ok(Redeem::InvalidCode);
        };
        let role = Role::parse(&role)?;
        if role == Role::Owner {
            let owners: i64 = tx.query_row("SELECT COUNT(*) FROM members WHERE role = 'owner'", [], |r| r.get(0))?;
            if owners > 0 {
                return Ok(Redeem::OwnerExists);
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
            "DELETE FROM avatars;
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
        // A new bootstrap code cannot mint a second owner.
        assert!(!db.ensure_owner_invite("another", 3).unwrap());
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
}
