use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Normalized news article displayed in `home.js` across both CentralPanel JSON and Azuriom RSS 2.0 XML.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewsItem {
    pub title: String,
    pub content: String,
    pub author: String,
    pub publish_date: String,
    pub image: Option<String>,
    pub badge: Option<String>,
    pub external_url: Option<String>,
    #[serde(default)]
    pub is_pinned: bool,
}

/// Parses an Azuriom `/api/rss` RSS 2.0 XML document into normalized [`NewsItem`] entries.
pub fn parse_azuriom_rss(xml: &str) -> Result<Vec<NewsItem>, String> {
    let trimmed = xml.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let doc = roxmltree::Document::parse(trimmed)
        .map_err(|e| format!("Failed to parse RSS XML feed: {e}"))?;

    let mut items = Vec::new();

    for node in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("item"))
    {
        let mut title = String::new();
        let mut description = String::new();
        let mut content_encoded = String::new();
        let mut author = String::new();
        let mut pub_date = String::new();
        let mut image: Option<String> = None;
        let mut badge: Option<String> = None;
        let mut link: Option<String> = None;

        for child in node.children().filter(|c| c.is_element()) {
            let tag = child.tag_name().name();
            match tag {
                "title" => {
                    if let Some(t) = child.text() {
                        title = t.trim().to_string();
                    }
                }
                "description" => {
                    if let Some(d) = child.text() {
                        description = d.trim().to_string();
                    }
                }
                "encoded" => {
                    // <content:encoded>
                    if let Some(c) = child.text() {
                        content_encoded = c.trim().to_string();
                    }
                }
                "creator" | "author" if author.is_empty() => {
                    // <dc:creator> or <author>
                    if let Some(a) = child.text() {
                        author = a.trim().to_string();
                    }
                }
                "pubDate" | "date" | "published" if pub_date.is_empty() => {
                    if let Some(p) = child.text() {
                        pub_date = normalize_date_string(p.trim());
                    }
                }
                "enclosure" | "content" | "thumbnail" if image.is_none() => {
                    if let Some(url_attr) = child.attribute("url") {
                        let mime = child.attribute("type").unwrap_or("image/");
                        if mime.starts_with("image/") || tag != "enclosure" {
                            let clean = url_attr.trim();
                            if is_http_url(clean) {
                                image = Some(clean.to_string());
                            }
                        }
                    }
                }
                "image" if image.is_none() => {
                    if let Some(u) = child.text().map(str::trim).filter(|s| is_http_url(s)) {
                        image = Some(u.to_string());
                    }
                }
                "category" if badge.is_none() => {
                    if let Some(cat) = child.text().map(str::trim).filter(|s| !s.is_empty()) {
                        badge = Some(cat.to_string());
                    }
                }
                "link" if link.is_none() => {
                    let candidate = child
                        .text()
                        .map(str::trim)
                        .or_else(|| child.attribute("href").map(str::trim));
                    if let Some(u) = candidate.filter(|s| is_http_url(s)) {
                        link = Some(u.to_string());
                    }
                }
                _ => {}
            }
        }

        let content = if !content_encoded.is_empty() {
            content_encoded
        } else {
            description
        };

        if title.is_empty() && content.is_empty() {
            continue;
        }

        items.push(NewsItem {
            title,
            content,
            author,
            publish_date: pub_date,
            image,
            badge,
            external_url: link,
            is_pinned: false,
        });
    }

    Ok(items)
}

/// Normalizes JSON news returned by CentralPanel `GET /utils/news`.
pub fn normalize_panel_news(raw: Value) -> Vec<NewsItem> {
    let arr = match raw {
        Value::Array(items) => items,
        Value::Object(mut map) => match map.remove("data").or_else(|| map.remove("news")) {
            Some(Value::Array(items)) => items,
            _ => return Vec::new(),
        },
        _ => return Vec::new(),
    };

    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };

        let title = obj
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();

        let content = obj
            .get("content")
            .or_else(|| obj.get("body"))
            .or_else(|| obj.get("description"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        if title.is_empty() && content.is_empty() {
            continue;
        }

        let author = obj
            .get("author")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();

        let raw_date = obj
            .get("publish_date")
            .or_else(|| obj.get("published_at"))
            .or_else(|| obj.get("created_at"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim();
        let publish_date = normalize_date_string(raw_date);

        let image = obj
            .get("image")
            .or_else(|| obj.get("image_url"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| is_http_url(s))
            .map(str::to_string);

        let badge = obj
            .get("badge")
            .or_else(|| obj.get("category"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let external_url = obj
            .get("external_url")
            .or_else(|| obj.get("url"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| is_http_url(s))
            .map(str::to_string);

        let is_pinned = obj
            .get("is_pinned")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        out.push(NewsItem {
            title,
            content,
            author,
            publish_date,
            image,
            badge,
            external_url,
            is_pinned,
        });
    }

    out
}

/// Merges Panel and Azuriom RSS news lists, placing pinned articles first and sorting
/// chronologically descending (`newest -> oldest`).
pub fn merge_and_sort_news(mut a: Vec<NewsItem>, b: Vec<NewsItem>) -> Vec<NewsItem> {
    a.extend(b);
    a.sort_by(|left, right| {
        right
            .is_pinned
            .cmp(&left.is_pinned)
            .then_with(|| parse_epoch_secs(&right.publish_date).cmp(&parse_epoch_secs(&left.publish_date)))
    });
    a
}

fn normalize_date_string(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    if let Ok(dt) = DateTime::parse_from_rfc2822(raw) {
        return dt.to_rfc3339();
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return dt.to_rfc3339();
    }
    raw.to_string()
}

fn parse_epoch_secs(raw: &str) -> i64 {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return dt.timestamp();
    }
    if let Ok(dt) = DateTime::parse_from_rfc2822(raw) {
        return dt.timestamp();
    }
    0
}

fn is_http_url(s: &str) -> bool {
    s.starts_with("https://") || s.starts_with("http://")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_parse_azuriom_rss_feed() {
        let rss = r#"<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"
             xmlns:content="http://purl.org/rss/1.0/modules/content/"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
            <channel>
                <title>Conflictura</title>
                <item>
                    <title>Ouverture Saison 3</title>
                    <link>https://conflictura.eu/news/saison-3</link>
                    <description><![CDATA[<p>Résumé court</p>]]></description>
                    <content:encoded><![CDATA[<p>Contenu complet HTML</p>]]></content:encoded>
                    <dc:creator>Riptiaz</dc:creator>
                    <pubDate>Tue, 17 Nov 2026 18:00:00 +0000</pubDate>
                    <enclosure url="https://conflictura.eu/storage/posts/s3.png" type="image/png" length="12345" />
                    <category>Annonce</category>
                </item>
            </channel>
        </rss>"#;

        let parsed = parse_azuriom_rss(rss).expect("RSS should parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].title, "Ouverture Saison 3");
        assert_eq!(parsed[0].content, "<p>Contenu complet HTML</p>");
        assert_eq!(parsed[0].author, "Riptiaz");
        assert_eq!(
            parsed[0].image.as_deref(),
            Some("https://conflictura.eu/storage/posts/s3.png")
        );
        assert_eq!(parsed[0].badge.as_deref(), Some("Annonce"));
        assert_eq!(
            parsed[0].external_url.as_deref(),
            Some("https://conflictura.eu/news/saison-3")
        );
        assert!(parsed[0].publish_date.starts_with("2026-11-17T18:00:00"));
    }

    #[test]
    fn test_merge_and_sort_panel_and_rss_news() {
        let panel = normalize_panel_news(json!([
            {
                "title": "Article Ancien Épinglé",
                "content": "<p>Pinned</p>",
                "author": "Admin",
                "publish_date": "2026-01-01T10:00:00+00:00",
                "is_pinned": true
            },
            {
                "title": "Article Intermédiaire",
                "content": "<p>Mid</p>",
                "author": "Admin",
                "publish_date": "2026-06-01T10:00:00+00:00",
                "is_pinned": false
            }
        ]));

        let rss = vec![NewsItem {
            title: "Article Récent RSS".to_string(),
            content: "<p>Recent</p>".to_string(),
            author: "Mod".to_string(),
            publish_date: "2026-11-17T19:00:00+00:00".to_string(),
            image: None,
            badge: None,
            external_url: None,
            is_pinned: false,
        }];

        let merged = merge_and_sort_news(panel, rss);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].title, "Article Ancien Épinglé");
        assert_eq!(merged[1].title, "Article Récent RSS");
        assert_eq!(merged[2].title, "Article Intermédiaire");
    }
}
