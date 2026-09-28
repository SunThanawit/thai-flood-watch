// Builds site/data/pumps.json: Bangkok drainage pump stations (สำนักการระบายน้ำ กทม.)
// from the public dashboard at pumps.bangkok.go.th.
//
// The page itself refuses non-Thai IPs (GitHub runners get 403), so when that
// fails we start from the snapshot already deployed and roll it forward with
// the dashboard's live WebSocket feed, which sends whole station records.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extractTurbo } from "../api/lib/turbo.js";

const SOURCE = "https://pumps.bangkok.go.th/";
const DEPLOYED = "https://sunthanawit.github.io/thai-flood-watch/data/pumps.json";
const WS = "wss://pumps.bangkok.go.th/socket.io/?EIO=4&transport=websocket";
const NS = "/iot/devices";
const LISTEN_MS = 90 * 1000;
const OUT = new URL("../site/data/pumps.json", import.meta.url);

// The dashboard's own legend: green = ready, red = in progress, yellow = malfunction, grey/unknown = closed
const STATUS = { red: "running", green: "ready", yellow: "fault", grey: "off", unknown: "off" };

function normalize(s) {
  return {
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
  };
}
const usable = (s) => s.isActive && Number.isFinite(s.latitude) && Number.isFinite(s.longitude);

async function fromPage() {
  const res = await fetch(SOURCE, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      "Accept-Language": "th-TH,th;q=0.9",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`page HTTP ${res.status}`);
  const raw = extractTurbo(await res.text())?.loaderData?.["routes/index"]?.stationsData;
  if (!Array.isArray(raw)) throw new Error("page: unexpected payload shape");
  return raw.filter(usable).map(normalize);
}

// Newest of the deployed snapshot and the committed one (a fresh local run).
async function baseline() {
  const candidates = [];
  try {
    const res = await fetch(`${DEPLOYED}?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (res.ok) candidates.push(await res.json());
  } catch { /* not deployed yet */ }
  try {
    candidates.push(JSON.parse(await readFile(OUT, "utf8")));
  } catch { /* no committed copy */ }
  candidates.sort((a, b) => String(b.generated).localeCompare(String(a.generated)));
  return candidates[0]?.stations ?? [];
}

// Minimal socket.io v4 client over a native WebSocket.
function listen(ms) {
  return new Promise((resolve) => {
    const updates = new Map();
    let ws;
    const done = () => { try { ws?.close(); } catch { /* ignore */ } resolve(updates); };
    try {
      ws = new WebSocket(WS);
    } catch {
      return resolve(updates);
    }
    ws.onmessage = (e) => {
      const m = String(e.data);
      if (m.startsWith("0")) ws.send(`40${NS},{"token":""}`);
      else if (m === "2") ws.send("3");
      else if (m.startsWith(`40${NS},`)) ws.send(`42${NS},["dashboard:subscribe"]`);
      else if (m.startsWith(`42${NS},`)) {
        const [event, d] = JSON.parse(m.slice(NS.length + 3));
        if (event === "dashboard:event" && d?.id && usable(d)) updates.set(d.id, normalize(d));
      }
    };
    ws.onerror = done;
    ws.onclose = done;
    setTimeout(done, ms);
  });
}

let stations;
let method;
try {
  stations = await fromPage();
  method = "page";
} catch (err) {
  console.warn(`pumps: ${err.message}; using deployed snapshot + live feed`);
  const byId = new Map((await baseline()).map((s) => [s.id, s]));
  const updates = await listen(LISTEN_MS);
  for (const [id, s] of updates) byId.set(id, s);
  stations = [...byId.values()];
  method = `snapshot + ${updates.size} live updates`;
}

if (!stations.length) {
  console.error("pumps: no data available");
  process.exit(1);
}
await mkdir(new URL(".", OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), source: SOURCE, method, stations }));
console.log(`pumps.json: ${stations.length} stations, ${stations.reduce((n, s) => n + s.pumps.length, 0)} pumps (${method})`);
