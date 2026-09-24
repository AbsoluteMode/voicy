//! Member pictures. The app crops and shrinks them before upload, so the
//! server only checks that it got a small image of a kind it will serve.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

/// A 256 px WebP is 10-40 KB; this leaves room without letting the
/// database fill up with wallpapers.
pub const MAX_BYTES: usize = 512 * 1024;

/// Content type by magic bytes; `None` for anything we do not serve.
pub fn sniff(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

/// Short content hash: a new picture gets a new URL, so clients may cache
/// each one forever.
pub fn version(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(&Sha256::digest(data)[..9])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_only_images() {
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a"), Some("image/gif"));
        assert_eq!(sniff(b"<svg xmlns="), None);
        assert_eq!(sniff(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn version_changes_with_content() {
        assert_eq!(version(b"a").len(), 12);
        assert_ne!(version(b"a"), version(b"b"));
    }
}
