// Builds site/data/pumps.json from the Bangkok drainage department's public
// pump dashboard (pumps.bangkok.go.th). It refuses non-Thai cloud IPs, so this
// runs where it can reach the site; the page reads the JSON same-origin.
import { writeFile, mkdir } from "node:fs/promises";
import { extractTurbo } from "../api/lib/turbo.js";

const SOURCE = "https://pumps.bangkok.go.th/";
const OUT = new URL("../site/data/pumps.json", import.meta.url);
const STALE_MS = 60 * 60 * 1000;

// The dashboard's own legend: green = ready, red = in progress, yellow = malfunction, grey/unknown = closed
const STATUS = { red: "running", green: "ready", yellow: "fault", grey: "off", unknown: "off" };

const res = await fetch(SOURCE, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    "Accept-Language": "th-TH,th;q=0.9",
  },
  signal: AbortSignal.timeout(20000),
});
if (!res.ok) {
  console.error(`pumps source HTTP ${res.status}`);
  process.exit(1);
}
const raw = extractTurbo(await res.text())?.loaderData?.["routes/index"]?.stationsData;
if (!Array.isArray(raw)) {
  console.error("pumps: unexpected payload shape");
  process.exit(1);
}

const now = Date.now();
const stations = raw
  .filter((s) => s.isActive && Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
  .map((s) => ({
    id: s.id,
    code: s.code,
    name: s.nameTH || s.nameEN || s.code,
    district: s.district || "",
    lat: s.latitude,
    lng: s.longitude,
    status: STATUS[s.status] || "off",
    pumps: (s.pumps || []).map((p) => ({ n: p.id, status: STATUS[p.status] || "off", kw: p.power || 0 })),
    levelPct: Number.isFinite(s.waterLevelPercent) ? Math.round(s.waterLevelPercent * 10) / 10 : null,
    lastSync: s.lastSync || null,
    stale: !s.lastSync || now - new Date(s.lastSync).getTime() > STALE_MS,
  }));

await mkdir(new URL(".", OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), source: SOURCE, stations }));
console.log(`pumps.json: ${stations.length} stations, ${stations.reduce((n, s) => n + s.pumps.length, 0)} pumps`);
