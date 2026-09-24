//! Voice rooms appear and disappear on their own: every occupied room is
//! listed, plus exactly one empty room to walk into. Rooms are LiveKit rooms
//! named `r1`, `r2`, ...; the empty one is always the lowest free number.

use std::collections::BTreeMap;

use serde::Serialize;

/// Upper bound on room numbers, so a token can never name an arbitrary room.
pub const MAX_ROOMS: u32 = 20;

pub fn room_id(n: u32) -> String {
    format!("r{n}")
}

/// `r7` → 7. Rejects anything we would not have handed out ourselves.
pub fn parse_room(id: &str) -> Option<u32> {
    let n: u32 = id.strip_prefix('r')?.parse().ok()?;
    ((1..=MAX_ROOMS).contains(&n) && room_id(n) == id).then_some(n)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RoomPeer {
    pub id: String,
    pub name: String,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct RoomView {
    pub id: String,
    pub name: String,
    pub participants: Vec<RoomPeer>,
}

/// Occupied rooms plus the lowest-numbered empty one, in number order.
pub fn layout(mut occupied: BTreeMap<u32, Vec<RoomPeer>>) -> Vec<RoomView> {
    occupied.retain(|_, peers| !peers.is_empty());
    if let Some(free) = (1..=MAX_ROOMS).find(|n| !occupied.contains_key(n)) {
        occupied.insert(free, Vec::new());
    }
    occupied
        .into_iter()
        .map(|(n, participants)| RoomView { id: room_id(n), name: format!("Комната {n}"), participants })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str) -> RoomPeer {
        RoomPeer { id: id.into(), name: id.into() }
    }

    fn ids(rooms: &[RoomView]) -> Vec<(&str, usize)> {
        rooms.iter().map(|r| (r.id.as_str(), r.participants.len())).collect()
    }

    #[test]
    fn always_exactly_one_empty_room() {
        assert_eq!(ids(&layout(BTreeMap::new())), [("r1", 0)]);
        let one = BTreeMap::from([(1, vec![peer("a")])]);
        assert_eq!(ids(&layout(one)), [("r1", 1), ("r2", 0)]);
        // Room 1 emptied while room 2 is busy: room 1 is the empty one again.
        let gap = BTreeMap::from([(1, vec![]), (2, vec![peer("a")]), (3, vec![])]);
        assert_eq!(ids(&layout(gap)), [("r1", 0), ("r2", 1)]);
    }

    #[test]
    fn full_house_has_no_empty_room() {
        let all: BTreeMap<u32, Vec<RoomPeer>> = (1..=MAX_ROOMS).map(|n| (n, vec![peer(&n.to_string())])).collect();
        assert!(layout(all).iter().all(|r| !r.participants.is_empty()));
    }

    #[test]
    fn only_our_room_ids_parse() {
        assert_eq!(parse_room("r1"), Some(1));
        assert_eq!(parse_room("r20"), Some(20));
        for bad in ["r0", "r21", "r01", "main", "r", "rx", "r-1", " r1"] {
            assert_eq!(parse_room(bad), None, "{bad}");
        }
    }
}
