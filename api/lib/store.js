// All community posts live in one private JSON blob. Writes use the blob's
// ETag (ifMatch) so two simultaneous submissions never overwrite each other.
import { get, put, BlobPreconditionFailedError } from "@vercel/blob";
import { createHash } from "node:crypto";

const PATH = "community/posts.json";
const MAX_POSTS = 600;
export const HIDE_AT_REPORTS = 3;
const EMPTY = { posts: [], rate: {} };

export async function load() {
  const res = await get(PATH, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) return { data: structuredClone(EMPTY), etag: null };
  const text = await new Response(res.stream).text();
  // A compressed response carries a weak ETag (W/"…"); conditional writes
  // compare against the strong form, so drop the prefix.
  return { data: { ...EMPTY, ...JSON.parse(text) }, etag: res.blob.etag.replace(/^W\//, "") };
}

// Runs mutate(data) and saves; retries on a concurrent write.
// mutate may throw an HttpError to abort without saving.
export async function update(mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, etag } = await load();
    const result = await mutate(data);
    data.posts = data.posts.slice(0, MAX_POSTS);
    try {
      await put(PATH, JSON.stringify(data), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        ...(etag ? { ifMatch: etag } : {}),
      });
      return result;
    } catch (err) {
      if (!(err instanceof BlobPreconditionFailedError)) throw err;
      console.warn(`posts.json write conflict, retry ${attempt + 1}`);
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150 * (attempt + 1)));
    }
  }
  throw new HttpError(503, "ระบบกำลังยุ่ง กรุณาลองใหม่อีกครั้ง");
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function clientKey(request) {
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  return createHash("sha256").update(`${process.env.IP_SALT || ""}:${ip}`).digest("hex").slice(0, 16);
}

// Sliding-window limit stored alongside the posts (pruned on every write).
export function takeRate(data, key, action, limits) {
  const now = Date.now();
  const longest = Math.max(...limits.map((l) => l.windowMs));
  for (const [k, times] of Object.entries(data.rate)) {
    const kept = times.filter((t) => now - t.at < longest);
    if (kept.length) data.rate[k] = kept; else delete data.rate[k];
  }
  const mine = (data.rate[key] ||= []);
  for (const { max, windowMs } of limits) {
    if (mine.filter((t) => t.a === action && now - t.at < windowMs).length >= max) {
      throw new HttpError(429, "ส่งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่");
    }
  }
  mine.push({ a: action, at: now });
}

export function isAdmin(request) {
  const key = process.env.ADMIN_KEY;
  return Boolean(key) && request.headers.get("x-admin-key") === key;
}
