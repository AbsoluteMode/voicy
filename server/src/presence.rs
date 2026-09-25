//! Who has Voicy open. Every authenticated request is a sign of life, and
//! running apps send a heartbeat every 30 s, also while minimized. Kept in
//! memory only: after a restart everyone is back within one heartbeat.

use std::{collections::HashMap, sync::Mutex};

/// Seen within this many seconds counts as online: two missed heartbeats.
pub const ONLINE_SECS: i64 = 75;

#[derive(Default)]
pub struct Presence {
    seen: Mutex<HashMap<String, i64>>,
}

impl Presence {
    pub fn touch(&self, member_id: &str, now: i64) {
        self.seen.lock().unwrap().insert(member_id.to_owned(), now);
    }

    pub fn is_online(&self, member_id: &str, now: i64) -> bool {
        self.seen.lock().unwrap().get(member_id).is_some_and(|&at| now - at <= ONLINE_SECS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn online_until_two_heartbeats_are_missed() {
        let p = Presence::default();
        assert!(!p.is_online("a", 100));
        p.touch("a", 100);
        assert!(p.is_online("a", 100 + ONLINE_SECS));
        assert!(!p.is_online("a", 101 + ONLINE_SECS));
    }
}
