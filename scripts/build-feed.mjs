// Builds site/data/feed.json: latest Thai flood news (Google News RSS) and,
// when X_BEARER_TOKEN is set, recent posts for #น้ำท่วม from the X API.
// Runs in GitHub Actions on a schedule; the browser reads the JSON same-origin.
import { writeFile, mkdir } from "node:fs/promises";

const OUT = new URL("../site/data/feed.json", import.meta.url);
const HASHTAG = "#น้ำท่วม";

const NEWS_QUERIES = [
  "น้ำท่วม when:1d",
  "ระดับน้ำ ล้นตลิ่ง when:1d",
  "ปภ. อุทกภัย when:2d",
];

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : "";
}

async function fetchNews() {
  const seen = new Set();
  const items = [];
  for (const q of NEWS_QUERIES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=th&gl=TH&ceid=TH:th`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 flood-dashboard" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      for (const raw of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
        const source = tag(raw, "source");
        let title = tag(raw, "title");
        if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
        const key = title.replace(/\s+/g, "");
        if (!title || seen.has(key)) continue;
        seen.add(key);
        items.push({
          title,
          source,
          link: tag(raw, "link"),
          published: new Date(tag(raw, "pubDate")).toISOString(),
        });
      }
    } catch (err) {
      console.warn(`news query failed (${q}):`, err.message);
    }
  }
  items.sort((a, b) => b.published.localeCompare(a.published));
  return items.slice(0, 80);
}

async function fetchX() {
  const token = process.env.X_BEARER_TOKEN;
  const search = `https://x.com/search?q=${encodeURIComponent(HASHTAG)}&f=live`;
  if (!token) return { enabled: false, search, posts: [] };

  const params = new URLSearchParams({
    query: `${HASHTAG} -is:retweet`,
    max_results: "50",
    sort_order: "recency",
    "tweet.fields": "created_at,public_metrics,author_id,attachments",
    expansions: "author_id,attachments.media_keys",
    "user.fields": "name,username,profile_image_url,verified",
    "media.fields": "url,preview_image_url,type",
  });
  try {
    const res = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.title || body?.detail || `HTTP ${res.status}`);
    const users = new Map((body.includes?.users ?? []).map((u) => [u.id, u]));
    const media = new Map((body.includes?.media ?? []).map((m) => [m.media_key, m]));
    const posts = (body.data ?? []).map((t) => {
      const u = users.get(t.author_id) ?? {};
      const img = (t.attachments?.media_keys ?? [])
        .map((k) => media.get(k))
        .map((m) => m && (m.url || m.preview_image_url))
        .find(Boolean);
      return {
        id: t.id,
        text: t.text,
        created: t.created_at,
        name: u.name ?? "",
        username: u.username ?? "",
        avatar: u.profile_image_url ?? "",
        image: img ?? "",
        likes: t.public_metrics?.like_count ?? 0,
        reposts: t.public_metrics?.retweet_count ?? 0,
        url: `https://x.com/${u.username ?? "i"}/status/${t.id}`,
      };
    });
    return { enabled: true, search, posts };
  } catch (err) {
    console.warn("X fetch failed:", err.message);
    return { enabled: true, search, posts: [], error: err.message };
  }
}

const [news, x] = await Promise.all([fetchNews(), fetchX()]);
await mkdir(new URL(".", OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), news, x }, null, 1));
console.log(`feed.json: ${news.length} news, ${x.posts.length} X posts${x.enabled ? "" : " (X disabled)"}`);
