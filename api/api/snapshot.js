// Data snapshots that only a Thai IP can fetch (pumps.bangkok.go.th,
// now.bangkok.go.th). A relay on the owner's machine PUTs them here with the
// admin key; the dashboard GETs them. ?name=pumps | floodalert | feed | tmd | traffy
import { get, put } from "@vercel/blob";
import { isAdmin, HttpError } from "../lib/store.js";
import { json, cors, preflight, handle } from "../lib/http.js";

const NAMES = new Set(["pumps", "floodalert", "feed", "tmd", "traffy"]);
const MAX_BYTES = 3 * 1024 * 1024;

function nameOf(request) {
  const name = new URL(request.url).searchParams.get("name");
  if (!NAMES.has(name)) throw new HttpError(400, "unknown snapshot");
  return name;
}

export const OPTIONS = preflight;

export const GET = handle(async (request) => {
  const name = nameOf(request);
  const res = await get(`snapshots/${name}.json`, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) throw new HttpError(404, "ยังไม่มีข้อมูล");
  const body = await new Response(res.stream).text();
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors(request),
      "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=120",
    },
  });
});

export const PUT = handle(async (request) => {
  if (!isAdmin(request)) throw new HttpError(401, "รหัสผู้ดูแลไม่ถูกต้อง");
  const name = nameOf(request);
  const body = await request.text();
  if (body.length > MAX_BYTES) throw new HttpError(413, "too large");
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (!data.generated || !Array.isArray(data.stations ?? data.roads ?? data.news ?? data.provinces ?? data.points)) throw new HttpError(400, "unexpected shape");
  await put(`snapshots/${name}.json`, body, {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  });
  return json(request, { ok: true, generated: data.generated });
});
