//! Name style, status line and decoration. The app draws them; the server
//! only keeps them short and well-formed.

use crate::db::Profile;

const STATUS_MAX_CHARS: usize = 60;
const ID_MAX_CHARS: usize = 24;

/// A decoration image with some animation; Discord's are 288 px APNGs of
/// a few hundred KB, a picture of a crown needs far less.
pub const DECORATION_MAX_BYTES: usize = 1024 * 1024;

/// A display font with Latin and Cyrillic fits in 100–300 KB as WOFF2.
pub const FONT_MAX_BYTES: usize = 512 * 1024;

const GOOGLE_PREFIX: &str = "g:";
const FAMILY_MAX_CHARS: usize = 40;

/// Content type of a font file by its magic bytes; `None` for anything else.
pub fn sniff_font(data: &[u8]) -> Option<&'static str> {
    match data.get(..4)? {
        b"wOF2" => Some("font/woff2"),
        b"wOFF" => Some("font/woff"),
        b"OTTO" => Some("font/otf"),
        [0, 1, 0, 0] | b"true" => Some("font/ttf"),
        _ => None,
    }
}

fn blank_is_none(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn color(v: &Option<String>) -> Result<Option<String>, &'static str> {
    match blank_is_none(v) {
        None => Ok(None),
        Some(c) if c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit()) => {
            Ok(Some(c.to_ascii_lowercase()))
        }
        Some(_) => Err("colors must look like #rrggbb"),
    }
}

/// Font, effect and decoration ids: the app knows what they mean.
fn id(v: &Option<String>) -> Result<Option<String>, &'static str> {
    match blank_is_none(v) {
        None => Ok(None),
        Some(s) if s.len() <= ID_MAX_CHARS && s.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-') => {
            Ok(Some(s.to_owned()))
        }
        Some(_) => Err("font, effect and decoration must be short style ids"),
    }
}

/// A shipped font id, or a Google Fonts family as "g:Family Name".
fn font(v: &Option<String>) -> Result<Option<String>, &'static str> {
    match blank_is_none(v) {
        Some(s) if s.starts_with(GOOGLE_PREFIX) => {
            let family = s[GOOGLE_PREFIX.len()..].trim();
            let ok = !family.is_empty()
                && family.chars().count() <= FAMILY_MAX_CHARS
                && family.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == ' ');
            if ok {
                Ok(Some(format!("{GOOGLE_PREFIX}{family}")))
            } else {
                Err("a Google font must be a family name of letters, digits and spaces")
            }
        }
        _ => id(v),
    }
}

/// Trimmed and checked; blank fields become `None`.
pub fn clean(p: Profile) -> Result<Profile, &'static str> {
    let status = match blank_is_none(&p.status) {
        None => None,
        Some(s) if s.chars().count() <= STATUS_MAX_CHARS && !s.chars().any(char::is_control) => Some(s.to_owned()),
        Some(_) => return Err("status must be up to 60 printable characters"),
    };
    Ok(Profile {
        color: color(&p.color)?,
        color2: color(&p.color2)?,
        font: font(&p.font)?,
        effect: id(&p.effect)?,
        status_until: status.as_ref().and(p.status_until),
        status,
        decoration: id(&p.decoration)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full() -> Profile {
        Profile {
            color: Some(" #FFaa00 ".into()),
            color2: Some("#00ff88".into()),
            font: Some("press-start-2p".into()),
            effect: Some("neon".into()),
            status: Some("  катаю в дотку 🎮 ".into()),
            status_until: Some(100),
            decoration: Some("crown".into()),
        }
    }

    #[test]
    fn keeps_good_values_tidy() {
        let p = clean(full()).unwrap();
        assert_eq!(p.color.as_deref(), Some("#ffaa00"));
        assert_eq!(p.status.as_deref(), Some("катаю в дотку 🎮"));
        assert_eq!(p.status_until, Some(100));
        assert_eq!(p.font.as_deref(), Some("press-start-2p"));
        assert_eq!(p.decoration.as_deref(), Some("crown"));
    }

    #[test]
    fn blank_means_none_and_drops_the_expiry() {
        let blank = |_| Some("  ".to_owned());
        let p = Profile {
            color: blank(0),
            color2: blank(0),
            font: blank(0),
            effect: blank(0),
            status: blank(0),
            status_until: Some(100),
            decoration: blank(0),
        };
        assert_eq!(clean(p).unwrap(), Profile::default());
        assert_eq!(clean(Profile::default()).unwrap(), Profile::default());
    }

    #[test]
    fn google_fonts_by_family() {
        let with = |f: &str| clean(Profile { font: Some(f.into()), ..full() });
        assert_eq!(with("g: Rubik Wet Paint ").unwrap().font.as_deref(), Some("g:Rubik Wet Paint"));
        assert!(with("g:").is_err());
        assert!(with("g:Comic<Sans>").is_err());
        assert!(with(&format!("g:{}", "A".repeat(41))).is_err());
        assert_eq!(with("custom").unwrap().font.as_deref(), Some("custom"));
    }

    #[test]
    fn sniffs_only_fonts() {
        assert_eq!(sniff_font(b"wOF2...."), Some("font/woff2"));
        assert_eq!(sniff_font(b"wOFF...."), Some("font/woff"));
        assert_eq!(sniff_font(b"OTTO...."), Some("font/otf"));
        assert_eq!(sniff_font(&[0, 1, 0, 0, 9]), Some("font/ttf"));
        assert_eq!(sniff_font(b"GIF89a"), None);
        assert_eq!(sniff_font(b"wO"), None);
    }

    #[test]
    fn rejects_the_rest() {
        let bad = [
            Profile { color: Some("red".into()), ..full() },
            Profile { color2: Some("#12345".into()), ..full() },
            Profile { color: Some("#12345g".into()), ..full() },
            Profile { status: Some("x".repeat(61)), ..full() },
            Profile { status: Some("a\nb".into()), ..full() },
            Profile { font: Some("Caveat".into()), ..full() },
            Profile { effect: Some("x".repeat(25)), ..full() },
            Profile { decoration: Some("<script>".into()), ..full() },
        ];
        for p in bad {
            assert!(clean(p.clone()).is_err(), "{p:?}");
        }
        assert!(clean(Profile { status: Some("я".repeat(60)), ..full() }).is_ok());
    }
}
