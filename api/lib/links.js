// Validates and canonicalises X / Facebook post links submitted by visitors.
// Returns null for anything that is not a single public post.

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);
const FB_HOSTS = new Set(["facebook.com", "m.facebook.com", "web.facebook.com", "mbasic.facebook.com", "fb.com"]);
const FB_KEEP_PARAMS = ["story_fbid", "fbid", "id", "v", "set"];

const X_PATH = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/|$)/;
const FB_POST_PATHS = [
  /^\/[^/]+\/posts\/[^/]+\/?$/,
  /^\/groups\/[^/]+\/(posts|permalink)\/\d+\/?$/,
  /^\/permalink\.php$/,
  /^\/story\.php$/,
  /^\/photo(\.php|\/)?$/,
  /^\/[^/]+\/photos\/[^/]+(\/[^/]+)?\/?$/,
  /^\/share\/p\/[A-Za-z0-9]+\/?$/,
];
const FB_VIDEO_PATHS = [
  /^\/[^/]+\/videos\/[^/]+(\/\d+)?\/?$/,
  /^\/watch\/?$/,
  /^\/reel\/\d+\/?$/,
  /^\/share\/(v|r)\/[A-Za-z0-9]+\/?$/,
];

export function parsePostUrl(input) {
  let u;
  try {
    u = new URL(String(input || "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  if (X_HOSTS.has(host)) {
    const m = u.pathname.match(X_PATH);
    if (!m) return null;
    return {
      platform: "x",
      kind: "post",
      postId: m[2],
      author: m[1],
      url: `https://x.com/${m[1]}/status/${m[2]}`,
    };
  }

  if (host === "fb.watch") {
    const slug = u.pathname.replace(/\//g, "");
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(slug)) return null;
    return { platform: "facebook", kind: "video", url: `https://fb.watch/${slug}/`, author: "" };
  }

  if (FB_HOSTS.has(host)) {
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const isVideo = FB_VIDEO_PATHS.some((re) => re.test(path + "/") || re.test(path));
    const isPost = !isVideo && FB_POST_PATHS.some((re) => re.test(path + "/") || re.test(path));
    if (!isVideo && !isPost) return null;
    const params = new URLSearchParams();
    for (const k of FB_KEEP_PARAMS) if (u.searchParams.get(k)) params.set(k, u.searchParams.get(k));
    if ((path === "/permalink.php" || path === "/story.php") && !params.get("story_fbid")) return null;
    if (path === "/watch" && !params.get("v")) return null;
    const qs = params.toString();
    const first = path.split("/")[1] || "";
    const author = ["groups", "permalink.php", "story.php", "photo.php", "photo", "share", "watch", "reel"].includes(first) ? "" : first;
    return {
      platform: "facebook",
      kind: isVideo ? "video" : "post",
      url: `https://www.facebook.com${path}${qs ? `?${qs}` : ""}`,
      author: decodeURIComponent(author).slice(0, 60),
    };
  }
  return null;
}

// Share links (/share/p/…, fb.watch) redirect to the real post; the embed
// plugin only understands the real one, so follow the redirect when we can.
export async function resolveFacebookShare(post) {
  if (!/\/share\/|fb\.watch/.test(post.url)) return post;
  try {
    const res = await fetch(post.url, {
      redirect: "manual",
      headers: { "User-Agent": "facebookexternalhit/1.1" },
      signal: AbortSignal.timeout(4000),
    });
    const loc = res.headers.get("location");
    const resolved = loc && parsePostUrl(new URL(loc, post.url).href);
    if (resolved && !/\/share\/|fb\.watch/.test(resolved.url)) return resolved;
  } catch { /* keep the share link */ }
  return post;
}

// X oEmbed is public and tells us the post exists, who wrote it and its text,
// so the page can show a light preview card before loading X's widget script.
export async function fetchXPreview(post) {
  try {
    const res = await fetch(
      `https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(post.url)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.status === 404) return { missing: true };
    if (!res.ok) return {};
    const j = await res.json();
    const text = (j.html?.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "")
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim();
    return { authorName: String(j.author_name || "").slice(0, 80), text: text.slice(0, 600) };
  } catch {
    return {};
  }
}
