// Community posts: GET list, POST submit, PATCH/DELETE for the admin.
import { randomBytes } from "node:crypto";
import { load, update, clientKey, takeRate, isAdmin, HttpError } from "../lib/store.js";
import { parsePostUrl, resolveFacebookShare, fetchXPreview } from "../lib/links.js";
import { json, preflight, readBody, handle } from "../lib/http.js";

function publicPost(p, admin) {
  const out = {
    id: p.id, platform: p.platform, kind: p.kind, url: p.url, postId: p.postId,
    author: p.author, authorName: p.authorName, text: p.text, note: p.note, created: p.created,
  };
  if (admin) Object.assign(out, { reports: p.reports.length, hidden: p.hidden });
  return out;
}

function cleanNote(s) {
  return String(s || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

export const OPTIONS = preflight;

export const GET = handle(async (request) => {
  const admin = isAdmin(request);
  if (!admin && request.headers.has("x-admin-key")) throw new HttpError(401, "รหัสผู้ดูแลไม่ถูกต้อง");
  const { data } = await load();
  const posts = data.posts.filter((p) => admin || !p.hidden).map((p) => publicPost(p, admin));
  return json(request, { posts, updated: new Date().toISOString() }, 200, {
    "Cache-Control": admin ? "no-store" : "public, max-age=0, s-maxage=15, stale-while-revalidate=60",
  });
});

export const POST = handle(async (request) => {
  const body = await readBody(request);
  if (body.website) throw new HttpError(400, "ไม่สามารถส่งได้"); // honeypot field
  let post = parsePostUrl(body.url);
  if (!post) {
    throw new HttpError(400, "ลิงก์ไม่ถูกต้อง ใช้ลิงก์ของโพสต์เดียวบน X (x.com/…/status/…) หรือ Facebook (โพสต์ วิดีโอ หรือรีล)");
  }

  // Network lookups happen before taking the write lock.
  let preview = {};
  if (post.platform === "x") {
    preview = await fetchXPreview(post);
    if (preview.missing) throw new HttpError(404, "ไม่พบโพสต์นี้บน X อาจถูกลบหรือเป็นบัญชีส่วนตัว");
  } else {
    post = await resolveFacebookShare(post);
  }

  const key = clientKey(request);
  const created = await update((data) => {
    const dup = data.posts.find((p) => p.url === post.url);
    if (dup) {
      throw new HttpError(409, dup.hidden ? "โพสต์นี้ถูกซ่อนแล้วจากการรายงาน" : "มีคนแชร์โพสต์นี้ไว้แล้ว");
    }
    takeRate(data, key, "post", [
      { max: 5, windowMs: 10 * 60e3 },
      { max: 20, windowMs: 24 * 3600e3 },
    ]);
    const item = {
      id: randomBytes(6).toString("base64url"),
      ...post,
      authorName: preview.authorName || "",
      text: preview.text || "",
      note: cleanNote(body.note),
      created: new Date().toISOString(),
      by: key,
      reports: [],
      hidden: false,
    };
    data.posts.unshift(item);
    return item;
  });
  return json(request, { post: publicPost(created, false) }, 201);
});

export const PATCH = handle(async (request) => {
  if (!isAdmin(request)) throw new HttpError(401, "รหัสผู้ดูแลไม่ถูกต้อง");
  const { id, hidden } = await readBody(request);
  const post = await update((data) => {
    const p = data.posts.find((x) => x.id === id);
    if (!p) throw new HttpError(404, "ไม่พบโพสต์");
    p.hidden = Boolean(hidden);
    if (!p.hidden) p.reports = [];
    return p;
  });
  return json(request, { post: publicPost(post, true) });
});

export const DELETE = handle(async (request) => {
  if (!isAdmin(request)) throw new HttpError(401, "รหัสผู้ดูแลไม่ถูกต้อง");
  const id = new URL(request.url).searchParams.get("id");
  await update((data) => {
    const before = data.posts.length;
    data.posts = data.posts.filter((p) => p.id !== id);
    if (data.posts.length === before) throw new HttpError(404, "ไม่พบโพสต์");
  });
  return json(request, { ok: true });
});
