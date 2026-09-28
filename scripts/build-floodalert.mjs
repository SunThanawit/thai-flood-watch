// Builds floodalert.json from กทม.'s "เลี่ยงถนนน้ำท่วม" page (now.bangkok.go.th/flood-alert.html):
// road flood sensors, flooded roads, the drainage department's road report and
// the per-round history. The page embeds its data as JS literals; we lift them
// out and parse them as JSON (never evaluate the page's code).
//
// Output: site/data/floodalert.json, or $OUT_DIR/floodalert.json when set.
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://now.bangkok.go.th/flood-alert.html";
const OUT_DIR = process.env.OUT_DIR || fileURLToPath(new URL("../site/data/", import.meta.url));

// Returns the literal assigned to `name`, with // comments removed.
function literal(js, name) {
  const m = js.match(new RegExp(String.raw`(?:const|let|var)\s+${name}\s*=\s*`));
  if (!m) throw new Error(`missing ${name}`);
  let out = "";
  let depth = 0;
  let str = null;
  for (let i = m.index + m[0].length; i < js.length; i++) {
    const c = js[i];
    if (str) {
      out += c;
      if (c === "\\") out += js[++i];
      else if (c === str) str = null;
      continue;
    }
    if (c === "/" && js[i + 1] === "/") { i = js.indexOf("\n", i) - 1; continue; }
    if (c === '"') str = c;
    out += c;
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") { depth--; if (depth === 0) break; }
  }
  return JSON.parse(out.replace(/,\s*([\]}])/g, "$1"));
}

const text = (html) => html.replace(/<[^>]+>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const LEVEL = { R: "high", r: "flood", a: "minor" };

export async function buildFloodAlert() {
  const res = await fetch(SOURCE, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      "Accept-Language": "th-TH,th;q=0.9",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`flood-alert HTTP ${res.status}`);
  const html = await res.text();
  const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "";
  const ROADS = literal(js, "ROADS");
  const GEO = literal(js, "GEO");
  const REPORTS = literal(js, "REPORTS");
  const HIST = literal(js, "HIST");

  const counts = Object.fromEntries([...html.matchAll(/<b class="s([drag])">(\d+)<\/b>/g)].map(([, k, n]) => [k, Number(n)]));

  // Round-by-round history table (time, roads, points, >10cm, 10cm, <10cm, normal)
  const rounds = [];
  const now = html.indexOf('<tr class="now">');
  if (now > 0) {
    const t0 = html.lastIndexOf("<table", now);
    const t1 = html.indexOf("</table>", now);
    for (const [, row] of html.slice(t0, t1).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, c]) => text(c));
      if (cells.length < 7) continue;
      const n = (c) => Number.parseInt(c, 10);
      rounds.push({ time: cells[0].replace(/\s*·.*$/, "").replace(/\s*น\.$/, ""), roads: n(cells[1]), points: n(cells[2]), high: n(cells[3]), flood: n(cells[4]), minor: n(cells[5]), normal: n(cells[6]) });
    }
  }

  const roads = ROADS.map((r) => ({
    name: r.n,
    section: r.s,
    district: r.d,
    zone: r.z,
    level: LEVEL[r.l] || "minor",
    maxCm: r.m,
    sensors: r.k.map(([code, loc, cm, l, peak, , near]) => ({ code, loc, cm, level: LEVEL[l] || "minor", peak, near })),
    geom: GEO[r.n] || [],
  }));

  const points = HIST.pts.map((p) => ({
    code: p.c,
    road: p.n,
    section: p.s,
    geom: p.g,
    before: p.b ? { cm: p.b[0], level: LEVEL[p.b[1]] || "minor" } : null,
    now: p.x ? { cm: p.x[0], level: LEVEL[p.x[1]] || "minor" } : null,
    change: p.k,
  }));

  const reports = {
    title: REPORTS.title,
    time: REPORTS.time,
    items: (REPORTS.items || []).map((it) => ({ name: it.n, level: { H: "high", M: "medium", L: "low" }[it.lv] || "unknown", geom: it.g || [], exact: it.u !== 1 })),
  };

  return {
    generated: new Date().toISOString(),
    source: SOURCE,
    sensorTime: HIST.nl,
    compareTime: HIST.bl,
    counts: { high: counts.d ?? null, flood: counts.r ?? null, minor: counts.a ?? null, normal: counts.g ?? null },
    rounds,
    roads,
    points,
    reports,
  };
}

// Run directly: write the file
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const data = await buildFloodAlert();
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(join(OUT_DIR, "floodalert.json"), JSON.stringify(data));
    console.log(`floodalert.json: ${data.roads.length} roads, ${data.points.length} points, report ${data.reports.items.length} items (sensors ${data.sensorTime})`);
  } catch (err) {
    console.error(`floodalert: ${err.message}`);
    process.exit(1);
  }
}
