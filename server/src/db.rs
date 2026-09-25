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
    /// Version of their own decoration image, for `/api/decorations/{id}?v=<version>`;
    /// shown when `profile.decoration` is "custom".
    pub decoration_file: Option<String>,
    /// Version of their own name font, for `/api/fonts/{id}?v=<version>`;
    /// used when `profile.font` is "custom".
    pub font_file: Option<String>,
    #[serde(flatten)]
    pub profile: Profile,
}

/// What a member shows besides the name and picture. All of it optional,
/// so an empty profile and a server without profiles look the same.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Profile {
    /// Name color, `#rrggbb`; also the glow while they talk.
    pub color: Option<String>,
    /// Second name color, for the effects that use two.
    pub color2: Option<String>,
    /// Name font: one the app ships, "g:<family>" from Google Fonts, or
    /// "custom" for `font_file`. Then the effect (gradient, neon…).
    pub font: Option<String>,
    pub effect: Option<String>,
    /// A line under the name: "afk", "playing dota".
    pub status: Option<String>,
    /// When the status stops showing, unix seconds; `None` keeps it.
    pub status_until: Option<i64>,
    /// Decoration over the picture: one the app ships, or "custom" for
    /// `decoration_file`. The app owns the lists of fonts, effects and
    /// decorations, so new ones need no server update; unknown ones show
    /// as the default.
    pub decoration: Option<String>,
}

impl Profile {
    /// Without a status that has run out.
    pub fn at(mut self, now: i64) -> Self {
        if self.status_until.is_some_and(|until| until <= now) {
            self.status = None;
            self.status_until = None;
        }
        self
    }
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
            decoration_file: r.get("decoration_file")?,
            font_file: r.get("font_file")?,
            profile: Profile {
                color: r.get("color")?,
                color2: r.get("color2")?,
                font: r.get("font")?,
                effect: r.get("effect")?,
                status: r.get("status")?,
                status_until: r.get("status_until")?,
                decoration: r.get("decoration")?,
            }
            .at(now()),
        })
    }
}

/// Members joined with their picture versions and profile, the shape `Member::from_row` reads.
const MEMBER_SELECT: &str = "SELECT m.*, a.version AS avatar, d.version AS decoration_file, f.version AS font_file,
    p.color, p.color2, p.font, p.effect, p.status, p.status_until, p.decoration
    FROM members m LEFT JOIN avatars a ON a.member_id = m.id LEFT JOIN decorations d ON d.member_id = m.id
    LEFT JOIN fonts f ON f.member_id = m.id LEFT JOIN profiles p ON p.member_id = m.id";

/// Files a member uploads, each kept like the avatar: one of a kind per member.
#[derive(Clone, Copy, Debug)]
pub enum UploadKind {
    Avatar,
    Decoration,
    Font,
}

impl UploadKind {
    fn table(self) -> &'static str {
        match self {
            UploadKind::Avatar => "avatars",
            UploadKind::Decoration => "decorations",
            UploadKind::Font => "fonts",
        }
    }
}

pub struct Upload {
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
CREATE TABLE IF NOT EXISTS decorations (
    member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    version   TEXT NOT NULL,
    mime      TEXT NOT NULL,
    data      BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS fonts (
    member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    version   TEXT NOT NULL,
    mime      TEXT NOT NULL,
    data      BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
    member_id    TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    color        TEXT,
    color2       TEXT,
    font         TEXT,
    effect       TEXT,
    status       TEXT,
    status_until INTEGER,
    decoration   TEXT
);
";

/// `created_by` of an owner invite made by a redeploy while an owner exists.
const RECOVERY: &str = "ssh-recovery";

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
            decoration_file: None,
            font_file: None,
            profile: Profile::default(),
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

    pub fn set_upload(&self, kind: UploadKind, id: &str, version: &str, mime: &str, data: &[u8]) -> Result<()> {
        self.conn().execute(
            &format!("INSERT OR REPLACE INTO {} (member_id, version, mime, data) VALUES (?1, ?2, ?3, ?4)", kind.table()),
            params![id, version, mime, data],
        )?;
        Ok(())
    }

    pub fn clear_upload(&self, kind: UploadKind, id: &str) -> Result<()> {
        self.conn().execute(&format!("DELETE FROM {} WHERE member_id = ?1", kind.table()), [id])?;
        Ok(())
    }

    pub fn upload(&self, kind: UploadKind, id: &str) -> Result<Option<Upload>> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT mime, data FROM {} WHERE member_id = ?1", kind.table()), [id], |r| {
                Ok(Upload { mime: r.get(0)?, data: r.get(1)? })
            })
            .optional()?)
    }

    pub fn set_profile(&self, id: &str, p: &Profile) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO profiles (member_id, color, color2, font, effect, status, status_until, decoration)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, p.color, p.color2, p.font, p.effect, p.status, p.status_until, p.decoration],
        )?;
        Ok(())
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
             DELETE FROM decorations;
             DELETE FROM fonts;
             DELETE FROM profiles;
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
    fn uploads_follow_their_member() {
        let db = db();
        db.ensure_owner_invite("code", 0).unwrap();
        let Redeem::Ok(m) = db.redeem_invite("code", "izzy", "s", 1).unwrap() else { panic!() };
        assert_eq!(db.member(&m.id).unwrap().unwrap().avatar, None);
        db.set_upload(UploadKind::Avatar, &m.id, "v1", "image/webp", b"a").unwrap();
        db.set_upload(UploadKind::Avatar, &m.id, "v2", "image/png", b"b").unwrap();
        db.set_upload(UploadKind::Decoration, &m.id, "d1", "image/gif", b"c").unwrap();
        let listed = &db.members().unwrap()[0];
        assert_eq!((listed.avatar.as_deref(), listed.decoration_file.as_deref()), (Some("v2"), Some("d1")));
        assert_eq!(db.upload(UploadKind::Avatar, &m.id).unwrap().unwrap().mime, "image/png");
        db.clear_upload(UploadKind::Decoration, &m.id).unwrap();
        assert_eq!(db.member(&m.id).unwrap().unwrap().decoration_file, None);
        db.set_upload(UploadKind::Decoration, &m.id, "d2", "image/png", b"d").unwrap();
        db.set_upload(UploadKind::Font, &m.id, "f1", "font/woff2", b"e").unwrap();
        assert_eq!(db.member(&m.id).unwrap().unwrap().font_file.as_deref(), Some("f1"));
        db.delete_member(&m.id).unwrap();
        assert!(db.upload(UploadKind::Font, &m.id).unwrap().is_none());
        assert!(db.upload(UploadKind::Avatar, &m.id).unwrap().is_none());
        assert!(db.upload(UploadKind::Decoration, &m.id).unwrap().is_none());
    }

    #[test]
    fn profiles_follow_their_member_and_statuses_run_out() {
        let db = db();
        db.ensure_owner_invite("code", 0).unwrap();
        let Redeem::Ok(m) = db.redeem_invite("code", "izzy", "s", 1).unwrap() else { panic!() };
        assert_eq!(db.member(&m.id).unwrap().unwrap().profile, Profile::default());
        let p = Profile {
            color: Some("#ff8800".into()),
            color2: Some("#00ff88".into()),
            font: Some("caveat".into()),
            effect: Some("gradient".into()),
            status: Some("afk".into()),
            status_until: Some(now() + 3600),
            decoration: Some("crown".into()),
        };
        db.set_profile(&m.id, &p).unwrap();
        assert_eq!(db.members().unwrap()[0].profile, p);
        db.set_profile(&m.id, &Profile { status_until: Some(now() - 1), ..p.clone() }).unwrap();
        let shown = db.member(&m.id).unwrap().unwrap().profile;
        assert_eq!(shown, Profile { status: None, status_until: None, ..p });
        db.delete_member(&m.id).unwrap();
        let left: i64 = db.conn().query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }
}
