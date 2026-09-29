// Builds tmd.json: กรมอุตุนิยมวิทยา 7-day forecast for every province
// (data.tmd.go.th WeatherForecast7Days/v2), trimmed to what the page draws.
//
// The API's CORS is locked to wxmap.tmd.go.th, so it is fetched here and
// served as a static file. `api` / `api12345` is TMD's published shared demo key.
//
// Output: site/data/tmd.json, or $OUT_DIR/tmd.json when set (the relay).
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE = "https://data.tmd.go.th/api/WeatherForecast7Days/v2/?uid=api&ukey=api12345&format=json";
const OUT = process.env.OUT_DIR
  ? pathToFileURL(join(process.env.OUT_DIR, "tmd.json"))
  : new URL("../site/data/tmd.json", import.meta.url);

const num = (s) => {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};
// ForecastDate is "dd/mm/yyyy" and listed newest first
const isoDate = (s) => {
  const [d, m, y] = String(s).split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
};

async function fetchJson(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000 * i));
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

export async function buildTmd() {
  const raw = await fetchJson(SOURCE);
  let list = raw?.Provinces?.Province;
  if (list && !Array.isArray(list)) list = [list];
  if (!Array.isArray(list) || !list.length) throw new Error("unexpected TMD payload");

  const rows = [];
  for (const p of list) {
    const f = p.SevenDaysForecast;
    const dates = (f?.ForecastDate || []).map(isoDate);
    if (dates.length < 2) continue;
    const order = dates.map((d, i) => [d, i]).sort((a, b) => a[0].localeCompare(b[0]));
    const pick = (arr) => order.map(([, i]) => arr?.[i]);
    rows.push({
      name: p.ProvinceNameThai,
      en: p.ProvinceNameEnglish,
      dates: order.map(([d]) => d),
      hi: pick(f.MaximumTemperature).map(num),
      lo: pick(f.MinimumTemperature).map(num),
      rain: pick(f.PercentRainCover).map(num),
      storm: pick(f.DescriptionThai).map((d) => String(d).includes("พายุ")),
    });
  }

  // Keep the dates every province shares so the table columns line up
  const dates = rows[0].dates;
  const ok = rows.filter((r) => r.dates.join() === dates.join());
  if (ok.length < rows.length) console.warn(`tmd: dropped ${rows.length - ok.length} provinces with different dates`);

  const built = String(raw.header?.LastBuildDate || "").replace(" ", "T");
  return {
    generated: new Date().toISOString(),
    source: "https://data.tmd.go.th/",
    issued: built ? `${built}+07:00` : null,
    dates,
    provinces: ok.map(({ dates: _d, ...r }) => r),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const data = await buildTmd();
    await mkdir(new URL(".", OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify(data));
    console.log(`tmd.json: ${data.provinces.length} provinces, ${data.dates[0]} to ${data.dates.at(-1)} (issued ${data.issued})`);
  } catch (err) {
    console.error(`tmd: ${err.message}`);
    process.exit(1);
  }
}
