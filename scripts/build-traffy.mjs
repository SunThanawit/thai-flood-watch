// Builds traffy.json: citizens' flood reports in Bangkok from Traffy Fondue
// (bangkok.traffy.in.th), via Traffy's public geojson API.
//
// Privacy: the API returns free text, photos and exact coordinates. Only what
// the dashboard needs is kept: location rounded to ~100 m, district, status and
// time. No description, photos, ticket ids or names.
//
// The API is heavy (about 5 MB per 1,000 reports) and caches for 30 minutes, so
// a fresh-enough previous copy is reused instead of fetching again.
//
// Output: site/data/traffy.json, or $OUT_DIR/traffy.json when set (the relay).
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://publicapi.traffy.in.th/teamchadchart-stat-api/geojson/v1";
const PREVIOUS = [
  "https://thai-flood-watch-api.vercel.app/api/snapshot?name=traffy",
  "https://flood.digitalok.site/data/traffy.json",
];
const OUT = process.env.OUT_DIR
  ? pathToFileURL(join(process.env.OUT_DIR, "traffy.json"))
  : new URL("../site/data/traffy.json", import.meta.url);
const REUSE_MS = 25 * 60 * 1000;
const LIMIT = 1000; // the API caps a request at 1,000 records
const MAX_POINTS = 900;

const bkkDate = (d) => d.toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" });
const round = (n) => Math.round(Number(n) * 1000) / 1000;

async function previous() {
  const found = [];
  for (const u of PREVIOUS) {
    try {
      const res = await fetch(`${u}${u.includes("?") ? "&" : "?"}t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) found.push(await res.json());
    } catch { /* try the next one */ }
  }
  return found.filter((f) => f?.points?.length).sort((a, b) => String(b.generated).localeCompare(String(a.generated)))[0];
}

async function fetchReports() {
  const q = new URLSearchParams({
    limit: String(LIMIT),
    start_date: bkkDate(new Date(Date.now() - 24 * 3600e3)),
    end_date: bkkDate(new Date()),
    problem_type_fondue: "น้ำท่วม",
  });
  let last;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 5000 * i));
    try {
      const res = await fetch(`${API}?${q}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" },
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!Array.isArray(j.features)) throw new Error("unexpected payload");
      return j.features;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

export function summarise(features) {
  const stamps = features.map((f) => f.properties.timestamp).filter(Boolean).sort();
  // The API also returns unrelated reports; keep those Traffy tagged as flooding
  const flood = features.filter((f) => (f.properties.problem_type_fondue || []).includes("น้ำท่วม"));
  const at = (s) => `${String(s).replace(" ", "T")}+07:00`; // timestamps are Bangkok time

  const points = flood
    .filter((f) => Array.isArray(f.geometry?.coordinates))
    .sort((a, b) => String(b.properties.timestamp).localeCompare(String(a.properties.timestamp)))
    .slice(0, MAX_POINTS)
    .map((f) => ({
      lat: round(f.geometry.coordinates[1]),
      lng: round(f.geometry.coordinates[0]),
      d: f.properties.district || "",
      s: f.properties.subdistrict || "",
      st: f.properties.state_type_latest || "start",
      at: at(f.properties.timestamp),
    }));

  const byState = {};
  const districts = new Map();
  for (const f of flood) {
    const p = f.properties;
    const st = p.state_type_latest || "start";
    byState[st] = (byState[st] || 0) + 1;
    const name = p.district || "ไม่ระบุเขต";
    const d = districts.get(name) || { name, n: 0, start: 0, inprogress: 0, forward: 0, finish: 0, irrelevant: 0 };
    d.n++;
    d[st] = (d[st] || 0) + 1;
    districts.set(name, d);
  }

  return {
    generated: new Date().toISOString(),
    source: "https://bangkok.traffy.in.th/",
    // Newest-first fetch: the window is what the fetched slice actually covers
    since: stamps.length ? at(stamps[0]) : null,
    until: stamps.length ? at(stamps.at(-1)) : null,
    total: flood.length,
    byState,
    districts: [...districts.values()].sort((a, b) => b.n - a.n),
    points,
  };
}

export async function buildTraffy() {
  const prev = await previous();
  if (prev && Date.now() - new Date(prev.generated).getTime() < REUSE_MS) {
    console.log("traffy: previous copy is fresh, reusing");
    return prev;
  }
  return summarise(await fetchReports());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const data = await buildTraffy();
    await mkdir(new URL(".", OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify(data));
    console.log(`traffy.json: ${data.total} flood reports (${data.since} to ${data.until}), ${data.points.length} points, ${data.districts.length} districts`);
  } catch (err) {
    console.error(`traffy: ${err.message}`);
    process.exit(1);
  }
}
