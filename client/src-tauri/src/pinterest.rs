//! Avatar search on Pinterest through the endpoint its own web app uses.
//! There is no public search API; this one needs no account, and running it
//! here (not in the page) avoids CORS and keeps the canvas untainted.

use std::{sync::OnceLock, time::Duration};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};

/// Pinterest serves its JSON only to something that looks like a browser.
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const IMAGE_HOST: &str = "https://i.pinimg.com/";
const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(UA)
            .build()
            .expect("http client")
    })
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Pin {
    pub id: String,
    /// ~236 px wide, for the grid.
    pub thumb: String,
    /// ~736 px wide, plenty for a 256 px avatar.
    pub full: String,
}

#[derive(Debug, Serialize)]
pub struct Page {
    pub pins: Vec<Pin>,
    /// Pass back for the next page; `None` at the end.
    pub bookmark: Option<String>,
}

pub async fn search(query: &str, bookmark: Option<&str>) -> Result<Page> {
    let mut options = json!({ "query": query, "scope": "pins", "page_size": 30 });
    if let Some(b) = bookmark {
        options["bookmarks"] = json!([b]);
    }
    let data = json!({ "options": options, "context": {} }).to_string();
    let source = format!("/search/pins/?q={}", urlencode(query));
    let body: Value = client()
        .get("https://www.pinterest.com/resource/BaseSearchResource/get/")
        .query(&[("source_url", source.as_str()), ("data", data.as_str())])
        .header("Accept", "application/json")
        .header("X-Pinterest-PWS-Handler", "www/search/[scope].js")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    parse(&body)
}

fn parse(body: &Value) -> Result<Page> {
    let res = &body["resource_response"];
    let results = res["data"]["results"]
        .as_array()
        .ok_or_else(|| anyhow!("unexpected Pinterest response"))?;
    let pins = results
        .iter()
        .filter(|p| p["type"] == "pin" && p["is_promoted"] != true)
        .filter_map(|p| {
            let img = |size: &str| p["images"][size]["url"].as_str().filter(|u| u.starts_with(IMAGE_HOST));
            Some(Pin {
                id: p["id"].as_str()?.to_owned(),
                thumb: img("236x")?.to_owned(),
                full: img("736x").or_else(|| img("orig"))?.to_owned(),
            })
        })
        .collect();
    let bookmark = res["bookmark"].as_str().filter(|b| !b.is_empty() && *b != "-end-").map(str::to_owned);
    Ok(Page { pins, bookmark })
}

/// The picture behind a pin, for cropping. Only Pinterest's image host.
pub async fn image(url: &str) -> Result<Vec<u8>> {
    if !url.starts_with(IMAGE_HOST) || url.contains("..") {
        return Err(anyhow!("not a Pinterest image"));
    }
    let res = client().get(url).send().await?.error_for_status()?;
    if res.content_length().is_some_and(|n| n as usize > MAX_IMAGE_BYTES) {
        return Err(anyhow!("image is too large"));
    }
    let bytes = res.bytes().await.context("download")?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(anyhow!("image is too large"));
    }
    Ok(bytes.to_vec())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_organic_pins_with_images() {
        let body = json!({ "resource_response": { "bookmark": "-end-", "data": { "results": [
            { "type": "pin", "id": "1", "images": {
                "236x": { "url": "https://i.pinimg.com/236x/a.jpg" },
                "736x": { "url": "https://i.pinimg.com/736x/a.jpg" } } },
            { "type": "pin", "id": "2", "is_promoted": true, "images": {
                "236x": { "url": "https://i.pinimg.com/236x/b.jpg" },
                "736x": { "url": "https://i.pinimg.com/736x/b.jpg" } } },
            { "type": "story", "id": "3" },
            { "type": "pin", "id": "4", "images": {
                "236x": { "url": "https://evil.example/c.jpg" },
                "orig": { "url": "https://i.pinimg.com/originals/c.jpg" } } },
            { "type": "pin", "id": "5", "images": {
                "236x": { "url": "https://i.pinimg.com/236x/d.jpg" },
                "orig": { "url": "https://i.pinimg.com/originals/d.jpg" } } },
        ] } } });
        let page = parse(&body).unwrap();
        let ids: Vec<_> = page.pins.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["1", "5"]);
        assert_eq!(page.pins[1].full, "https://i.pinimg.com/originals/d.jpg");
        assert_eq!(page.bookmark, None);
    }

    #[test]
    fn encodes_queries() {
        assert_eq!(urlencode("cat pfp"), "cat%20pfp");
        assert_eq!(urlencode("кот"), "%D0%BA%D0%BE%D1%82");
    }

    #[tokio::test]
    async fn only_fetches_from_pinterest() {
        assert!(image("https://example.com/a.jpg").await.is_err());
        assert!(image("https://i.pinimg.com.evil/a.jpg").await.is_err());
    }
}

/// Hits the real Pinterest: `cargo test -- --ignored pinterest`.
#[cfg(test)]
mod live_tests {
    #[tokio::test]
    #[ignore]
    async fn real_search_pages_and_images() {
        let first = super::search("котики аватарки", None).await.unwrap();
        assert!(first.pins.len() >= 10, "{}", first.pins.len());
        let next = super::search("котики аватарки", first.bookmark.as_deref()).await.unwrap();
        assert!(!next.pins.is_empty());
        assert_ne!(first.pins[0].id, next.pins[0].id);
        let img = super::image(&first.pins[0].full).await.unwrap();
        assert!(img.len() > 1000);
    }
}
