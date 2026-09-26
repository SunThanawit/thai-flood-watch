// A visitor flags a post as spam / misleading. Enough distinct reports hide it.
import { update, clientKey, takeRate, HttpError, HIDE_AT_REPORTS } from "../lib/store.js";
import { json, preflight, readBody, handle } from "../lib/http.js";

export const OPTIONS = preflight;

export const POST = handle(async (request) => {
  const { id } = await readBody(request);
  const key = clientKey(request);
  const hidden = await update((data) => {
    const p = data.posts.find((x) => x.id === id);
    if (!p) throw new HttpError(404, "ไม่พบโพสต์");
    if (p.reports.includes(key)) throw new HttpError(409, "คุณรายงานโพสต์นี้ไปแล้ว");
    takeRate(data, key, "report", [{ max: 30, windowMs: 3600e3 }]);
    p.reports.push(key);
    // Whoever shared the post can take it down with a single report
    if (p.by === key || p.reports.length >= HIDE_AT_REPORTS) p.hidden = true;
    return p.hidden;
  });
  return json(request, { ok: true, hidden });
});
