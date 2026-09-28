// Builds site/data/feed.json: latest Thai flood news (Google News RSS) and,
// when X_BEARER_TOKEN is set, recent posts for #น้ำท่วม from the X API.
// Runs in GitHub Actions on a schedule (and from the relay); the browser reads it.
// Google News sometimes refuses cloud IPs (503), so failed fetches are retried
// and, if everything fails, the previous news is kept instead of blanking it.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OUT = process.env.OUT_DIR
  ? pathToFileURL(join(process.env.OUT_DIR, "feed.json"))
  : new URL("../site/data/feed.json", import.meta.url);
const PREVIOUS = [
  "https://thai-flood-watch-api.vercel.app/api/snapshot?name=feed",
  "https://flood.digitalok.site/data/feed.json",
];
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

async function fetchWithRetry(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000 * i));
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
          "Accept-Language": "th-TH,th;q=0.9",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return await res.text();
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

// Newest previous feed that still has news (relay snapshot or deployed file)
async function previousFeed() {
  const found = [];
  for (const url of PREVIOUS) {
    try {
      const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) found.push(await res.json());
    } catch { /* try the next one */ }
  }
  try {
    found.push(JSON.parse(await readFile(OUT, "utf8")));
  } catch { /* no local copy */ }
  return found
    .filter((f) => f?.news?.length)
    .sort((a, b) => String(b.newsUpdated || b.generated).localeCompare(String(a.newsUpdated || a.generated)))[0];
}

async function fetchNews() {
  const seen = new Set();
  const items = [];
  for (const q of NEWS_QUERIES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=th&gl=TH&ceid=TH:th`;
    try {
      const xml = await fetchWithRetry(url);
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

let [news, x] = await Promise.all([fetchNews(), fetchX()]);
let newsUpdated = new Date().toISOString();
if (!news.length) {
  const prev = await previousFeed();
  if (prev) {
    news = prev.news;
    newsUpdated = prev.newsUpdated || prev.generated;
    console.warn(`news: all queries failed, kept ${news.length} items from ${newsUpdated}`);
  }
  if (!x.posts.length && prev?.x?.posts?.length) x = prev.x;
}
await mkdir(new URL(".", OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), newsUpdated, news, x }, null, 1));
console.log(`feed.json: ${news.length} news (as of ${newsUpdated}), ${x.posts.length} X posts${x.enabled ? "" : " (X disabled)"}`);
