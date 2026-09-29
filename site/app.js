"use strict";

const THAIWATER = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/thailand_main";
const GDACS = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=FL&country=Thailand";
// The deployed file (GitHub Actions) and the relayed copy (owner's machine);
// whichever has the newer news wins
const FEEDS = ["data/feed.json", "https://thai-flood-watch-api.vercel.app/api/snapshot?name=feed"];
const HASHTAG = "#น้ำท่วม";
const WATER_REFRESH_MS = 5 * 60 * 1000;
const FEED_REFRESH_MS = 2 * 60 * 1000;
const STALE_HOURS = 36;

// ThaiWater situation_level: % of channel capacity at the station
const LEVELS = {
  5: { label: "ล้นตลิ่ง", css: "--lv5" },
  4: { label: "น้ำมาก", css: "--lv4" },
  3: { label: "ปกติ", css: "--lv3" },
  2: { label: "น้ำน้อย", css: "--lv2" },
  1: { label: "น้อยวิกฤต", css: "--lv1" },
};

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const fmt = (v, d = 0) => (v === null || Number.isNaN(v) ? "–" : v.toLocaleString("th-TH", { maximumFractionDigits: d, minimumFractionDigits: d }));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const th = (o) => (o && (o.th || o.en)) || "";

// ThaiWater times are Bangkok local ("YYYY-MM-DD HH:mm")
const parseBkk = (s) => (s ? new Date(s.replace(" ", "T") + (s.length <= 10 ? "T00:00" : "") + ":00+07:00") : null);

function ago(date) {
  if (!date || Number.isNaN(date.getTime())) return "";
  const m = Math.round((Date.now() - date.getTime()) / 60000);
  if (m < 1) return "เมื่อสักครู่";
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ชม.ที่แล้ว`;
  return `${Math.round(h / 24)} วันที่แล้ว`;
}
const clock = (d) => d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

/* ---------------- map ---------------- */

const map = L.map("map", { preferCanvas: true, zoomControl: true, minZoom: 5, maxZoom: 16 }).setView([13.2, 101.0], 6);
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : darkQuery.matches;
};
let tiles;
function setTiles() {
  if (tiles) map.removeLayer(tiles);
  const style = isDark() ? "Dark_Gray" : "Light_Gray";
  tiles = L.layerGroup([
    L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style}_Base/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 16,
      attribution: 'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    }),
    L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style}_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16 }),
  ]).addTo(map);
}
setTiles();
darkQuery.addEventListener("change", () => { setTiles(); renderMap(); });

const layers = {
  wl: L.layerGroup().addTo(map),
  rain: L.layerGroup().addTo(map),
  dam: L.layerGroup().addTo(map),
  gdacs: L.layerGroup().addTo(map),
};
const markerById = new Map();

/* ---------------- state ---------------- */

const state = { stations: [], rain: [], dams: [], gdacs: [], feed: null, updated: null, error: null };

function normalizeStations(list) {
  const cutoff = Date.now() - STALE_HOURS * 3600e3;
  return (list || [])
    .map((w) => {
      const st = w.station || {};
      const time = parseBkk(w.waterlevel_datetime);
      const msl = num(w.waterlevel_msl);
      const prev = num(w.waterlevel_msl_previous);
      return {
        id: `wl-${st.id ?? w.id}`,
        name: th(st.tele_station_name),
        lat: num(st.tele_station_lat),
        lng: num(st.tele_station_long),
        level: w.situation_level,
        pct: num(w.storage_percent),
        msl,
        delta: msl !== null && prev !== null ? msl - prev : null,
        bank: num(st.min_bank),
        diffBank: num(w.diff_wl_bank),
        diffBankText: w.diff_wl_bank_text || "",
        province: th(w.geocode?.province_name),
        amphoe: th(w.geocode?.amphoe_name),
        basin: th(w.basin?.basin_name),
        agency: th(w.agency?.agency_shortname),
        time,
      };
    })
    .filter((s) => s.lat && s.lng && s.level && s.time && s.time.getTime() > cutoff);
}

function normalizeRain(list) {
  const cutoff = Date.now() - STALE_HOURS * 3600e3;
  return (list || [])
    .map((r) => ({
      id: `rain-${r.station?.id ?? r.id}`,
      name: th(r.station?.tele_station_name),
      lat: num(r.station?.tele_station_lat),
      lng: num(r.station?.tele_station_long),
      mm: num(r.rain_24h),
      mm1h: num(r.rain_1h),
      province: th(r.geocode?.province_name),
      amphoe: th(r.geocode?.amphoe_name),
      agency: th(r.agency?.agency_shortname),
      time: parseBkk(r.rainfall_datetime),
    }))
    .filter((r) => r.lat && r.lng && r.mm !== null && r.time && r.time.getTime() > cutoff);
}

function normalizeDams(list) {
  return (list || [])
    .map((d) => ({
      id: `dam-${d.dam?.id ?? d.id}`,
      name: th(d.dam?.dam_name),
      lat: num(d.dam?.dam_lat),
      lng: num(d.dam?.dam_long),
      pct: num(d.dam_storage_percent),
      storage: num(d.dam_storage),
      inflow: num(d.dam_inflow),
      released: num(d.dam_released),
      normal: num(d.dam?.normal_storage),
      province: th(d.geocode?.province_name),
      date: d.dam_date,
    }))
    .filter((d) => d.lat && d.lng && d.pct !== null);
}

async function loadWater() {
  const res = await fetch(THAIWATER, { cache: "no-store" });
  if (!res.ok) throw new Error(`ThaiWater HTTP ${res.status}`);
  const j = await res.json();
  // Shared with outlook.js (gauge discharge, forecast maps, radar); image tokens
  // are only valid for a while, so consumers always read the latest response.
  window.__thaiwater = j;
  window.dispatchEvent(new Event("thaiwater"));
  state.stations = normalizeStations(j.waterlevel?.data?.data);
  state.rain = normalizeRain(j.rain?.data?.data);
  state.dams = normalizeDams(j.dam?.data?.data);
}

async function loadGdacs() {
  try {
    const res = await fetch(GDACS, { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    const cutoff = Date.now() - 45 * 864e5;
    state.gdacs = (j.features || [])
      .map((f) => ({ ...f.properties, lat: f.geometry?.coordinates?.[1], lng: f.geometry?.coordinates?.[0] }))
      .filter((e) => new Date(e.todate).getTime() > cutoff);
  } catch { /* GDACS is optional */ }
}

async function loadFeed() {
  const got = await Promise.all(FEEDS.map(async (url) => {
    try {
      const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 60000)}`, { cache: "no-store" });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }));
  const asOf = (f) => String(f.newsUpdated || f.generated || "");
  const best = got.filter((f) => f?.news?.length).sort((a, b) => asOf(b).localeCompare(asOf(a)))[0];
  if (best) {
    const withX = got.find((f) => f?.x?.posts?.length);
    state.feed = { ...best, x: best.x?.posts?.length ? best.x : withX?.x || best.x };
  } else if (!state.feed) {
    state.feed = got.find(Boolean) || null;
  }
  renderFeed();
}

/* ---------------- rendering ---------------- */

function levelColor(level) {
  return cssVar(LEVELS[level]?.css || "--muted");
}

function stationPopup(s) {
  const lv = LEVELS[s.level] || { label: "–" };
  const trend = s.delta === null ? "–" : `${s.delta > 0 ? "▲" : s.delta < 0 ? "▼" : "■"} ${fmt(Math.abs(s.delta), 2)} ม.`;
  return `<div class="pop">
    <span class="tag" style="background:${levelColor(s.level)}">${esc(lv.label)}</span>
    <h4>${esc(s.name)}</h4>
    <div class="sub">อ.${esc(s.amphoe)} จ.${esc(s.province)} · ${esc(s.basin)}</div>
    <table>
      <tr><td>ความจุลำน้ำ</td><td>${fmt(s.pct, 1)}%</td></tr>
      <tr><td>ระดับน้ำ</td><td>${fmt(s.msl, 2)} ม.รทก.</td></tr>
      ${s.bank !== null ? `<tr><td>ตลิ่งต่ำสุด</td><td>${fmt(s.bank, 2)} ม.รทก.</td></tr>` : ""}
      ${s.diffBank !== null ? `<tr><td>${esc(s.diffBankText || "ต่างจากตลิ่ง")}</td><td>${fmt(s.diffBank, 2)} ม.</td></tr>` : ""}
      <tr><td>แนวโน้ม</td><td>${trend}</td></tr>
      <tr><td>เวลา</td><td>${clock(s.time)} (${ago(s.time)})</td></tr>
    </table>
    <div class="sub" style="margin:6px 0 0">แหล่งข้อมูล: ${esc(s.agency)} ผ่าน ThaiWater</div>
  </div>`;
}

function rainCategory(mm) {
  if (mm > 90) return "ฝนหนักมาก";
  if (mm > 35) return "ฝนหนัก";
  if (mm > 10) return "ฝนปานกลาง";
  return "ฝนเล็กน้อย";
}

function renderMap() {
  Object.values(layers).forEach((g) => g.clearLayers());
  markerById.clear();
  const onlyCrit = $("only-crit").checked;
  const rainColor = cssVar("--rain");

  // Heavy rain first, so station dots draw on top
  for (const r of state.rain) {
    if (r.mm <= 35) continue;
    const m = L.circleMarker([r.lat, r.lng], {
      radius: Math.min(2 + Math.sqrt(r.mm) * 0.6, 14),
      color: rainColor, weight: 1, opacity: r.mm > 90 ? 0.9 : 0.5,
      fillColor: rainColor, fillOpacity: r.mm > 90 ? 0.3 : 0.08,
    }).bindPopup(`<div class="pop">
      <span class="tag" style="background:${rainColor}">${rainCategory(r.mm)}</span>
      <h4>${esc(r.name)}</h4>
      <div class="sub">อ.${esc(r.amphoe)} จ.${esc(r.province)}</div>
      <table>
        <tr><td>ฝนสะสม 24 ชม.</td><td>${fmt(r.mm, 1)} มม.</td></tr>
        <tr><td>ฝน 1 ชม. ล่าสุด</td><td>${fmt(r.mm1h, 1)} มม.</td></tr>
        <tr><td>เวลา</td><td>${clock(r.time)} (${ago(r.time)})</td></tr>
      </table></div>`);
    layers.rain.addLayer(m);
    markerById.set(r.id, m);
  }

  const sorted = [...state.stations].sort((a, b) => a.level - b.level);
  for (const s of sorted) {
    if (onlyCrit && s.level < 4) continue;
    const big = s.level >= 4;
    const m = L.circleMarker([s.lat, s.lng], {
      radius: s.level === 5 ? 8 : big ? 6 : 4,
      color: s.level === 5 ? cssVar("--surface") : levelColor(s.level),
      weight: s.level === 5 ? 2 : 1,
      fillColor: levelColor(s.level),
      fillOpacity: big ? 0.95 : 0.7,
    }).bindPopup(stationPopup(s));
    layers.wl.addLayer(m);
    markerById.set(s.id, m);
  }

  for (const d of state.dams) {
    const color = d.pct >= 100 ? cssVar("--lv5") : d.pct >= 80 ? cssVar("--lv4") : cssVar("--dam");
    const icon = L.divIcon({ className: "", html: `<div class="dam-icon" style="background:${color}"></div>`, iconSize: [14, 14] });
    const m = L.marker([d.lat, d.lng], { icon, title: d.name }).bindPopup(`<div class="pop">
      <h4>เขื่อน${esc(d.name)}</h4><div class="sub">จ.${esc(d.province)} · ข้อมูลวันที่ ${esc(d.date)}</div>
      <table>
        <tr><td>ปริมาณน้ำ (% รนก.)</td><td>${fmt(d.pct, 1)}%</td></tr>
        <tr><td>ปริมาณน้ำ</td><td>${fmt(d.storage, 0)} ล้าน ลบ.ม.</td></tr>
        <tr><td>น้ำไหลเข้า</td><td>${fmt(d.inflow, 2)} ล้าน ลบ.ม./วัน</td></tr>
        <tr><td>ระบายออก</td><td>${fmt(d.released, 2)} ล้าน ลบ.ม./วัน</td></tr>
      </table></div>`);
    layers.dam.addLayer(m);
    markerById.set(d.id, m);
  }

  for (const e of state.gdacs) {
    if (!e.lat || !e.lng) continue;
    const icon = L.divIcon({ className: "", html: '<div class="gdacs-icon"></div>', iconSize: [16, 16] });
    L.marker([e.lat, e.lng], { icon }).bindPopup(`<div class="pop">
      <span class="tag" style="background:${cssVar("--gdacs")}">GDACS ${esc(e.alertlevel)}</span>
      <h4>${esc(e.name)}</h4>
      <div class="sub">${esc(e.fromdate?.slice(0, 10))} ถึง ${esc(e.todate?.slice(0, 10))}</div>
      <a href="${esc(e.url?.report)}" target="_blank" rel="noopener">ดูรายงาน GDACS</a></div>`).addTo(layers.gdacs);
  }
  applyLayerToggles();
}

function applyLayerToggles() {
  for (const [key, group] of Object.entries(layers)) {
    const on = $(`lyr-${key}`).checked;
    if (on && !map.hasLayer(group)) map.addLayer(group);
    if (!on && map.hasLayer(group)) map.removeLayer(group);
  }
}

function renderKpis() {
  const lv5 = state.stations.filter((s) => s.level === 5);
  const lv4 = state.stations.filter((s) => s.level === 4);
  const rising = [...lv5, ...lv4].filter((s) => s.delta > 0).length;
  $("k-overflow").textContent = fmt(lv5.length);
  $("k-overflow-foot").textContent = `จาก ${fmt(state.stations.length)} สถานีที่รายงานล่าสุด`;
  $("k-high").textContent = fmt(lv4.length);
  $("k-rising").textContent = `${fmt(rising)} สถานี (มาก+ล้นตลิ่ง) ระดับน้ำกำลังขึ้น`;

  const top = state.rain.reduce((a, b) => (b.mm > (a?.mm ?? -1) ? b : a), null);
  $("k-rainmax").textContent = top ? fmt(top.mm, 1) : "–";
  $("k-rainmax-foot").textContent = top ? `${top.name} อ.${top.amphoe} จ.${top.province}` : "–";
  $("k-rain90").textContent = fmt(state.rain.filter((r) => r.mm > 90).length);
  $("k-rain35").textContent = `ฝนหนัก 35–90 มม. อีก ${fmt(state.rain.filter((r) => r.mm > 35 && r.mm <= 90).length)} สถานี`;

  const hiDams = state.dams.filter((d) => d.pct >= 80);
  $("k-dam").textContent = `${fmt(hiDams.length)}/${fmt(state.dams.length)}`;
  const topDam = [...state.dams].sort((a, b) => b.pct - a.pct)[0];
  $("k-dam-foot").textContent = topDam ? `สูงสุด: ${topDam.name} ${fmt(topDam.pct, 1)}%` : "–";
}

function renderCritList() {
  const q = $("crit-filter").value.trim();
  const crit = state.stations
    .filter((s) => s.level >= 4)
    .filter((s) => !q || `${s.name} ${s.province} ${s.amphoe} ${s.basin}`.includes(q))
    .sort((a, b) => b.level - a.level || (b.pct ?? 0) - (a.pct ?? 0));
  $("crit-count").textContent = state.stations.filter((s) => s.level === 5).length || "";
  const list = $("crit-list");
  if (!crit.length) {
    list.innerHTML = `<li class="empty"><p>${q ? "ไม่พบสถานีที่ตรงกับคำค้น" : "ไม่มีสถานีน้ำมากหรือล้นตลิ่งในขณะนี้"}</p></li>`;
    return;
  }
  list.innerHTML = crit.slice(0, 250).map((s) => {
    const d = s.delta === null ? "" : s.delta > 0 ? `<span class="up">▲ ${fmt(s.delta, 2)} ม.</span>` : s.delta < 0 ? `<span class="down">▼ ${fmt(-s.delta, 2)} ม.</span>` : "ทรงตัว";
    return `<li><button type="button" data-id="${esc(s.id)}">
      <span class="name">${esc(s.name)}</span><span class="pct lv${s.level}">${fmt(s.pct, 0)}%</span>
      <span class="where">อ.${esc(s.amphoe)} จ.${esc(s.province)} · ${clock(s.time)}</span><span class="delta">${d}</span>
    </button></li>`;
  }).join("");
}

function renderProvinces() {
  const agg = new Map();
  const get = (p) => {
    if (!agg.has(p)) agg.set(p, { name: p, lv5: 0, lv4: 0, rain90: 0, points: [] });
    return agg.get(p);
  };
  for (const s of state.stations) {
    if (s.level < 4 || !s.province) continue;
    const a = get(s.province);
    s.level === 5 ? a.lv5++ : a.lv4++;
    a.points.push([s.lat, s.lng]);
  }
  for (const r of state.rain) {
    if (r.mm <= 90 || !r.province) continue;
    const a = get(r.province);
    a.rain90++;
    a.points.push([r.lat, r.lng]);
  }
  const score = (a) => a.lv5 * 3 + a.lv4 + a.rain90 * 2;
  const rows = [...agg.values()].sort((a, b) => score(b) - score(a)).slice(0, 15);
  const max = Math.max(1, ...rows.map((a) => a.lv5 + a.lv4 + a.rain90));
  const list = $("prov-list");
  if (!rows.length) {
    list.innerHTML = '<li class="empty"><p>ยังไม่มีจังหวัดที่มีสถานีน้ำมากหรือฝนหนักมาก</p></li>';
    return;
  }
  list.innerHTML = rows.map((a, i) => {
    const w = (n) => `${(n / max) * 100}%`;
    return `<li><button type="button" data-prov="${esc(a.name)}" title="ล้นตลิ่ง ${a.lv5} · น้ำมาก ${a.lv4} · ฝนหนักมาก ${a.rain90}">
      <span class="rank">${i + 1}</span><span class="pname">${esc(a.name)}</span>
      <span class="bar"><i style="width:${w(a.lv5)};background:var(--lv5)"></i><i style="width:${w(a.lv4)};background:var(--lv4)"></i><i style="width:${w(a.rain90)};background:var(--rain)"></i></span>
      <span class="pnum">${a.lv5}/${a.lv4}/${a.rain90}</span>
    </button></li>`;
  }).join("") + '<li class="hint" style="margin:8px 0 0">ตัวเลข: <b class="lv5">ล้นตลิ่ง</b> / <b class="lv4">น้ำมาก</b> / <b style="color:var(--rain)">ฝน &gt;90 มม.</b></li>';
  state.provPoints = new Map(rows.map((a) => [a.name, a.points]));
}

function renderDams() {
  const rows = [...state.dams].sort((a, b) => b.pct - a.pct);
  $("dam-list").innerHTML = rows.map((d) => {
    const cls = d.pct >= 100 ? "over" : d.pct >= 80 ? "hi" : "";
    return `<li><span class="dname" title="${esc(d.name)} จ.${esc(d.province)}">${esc(d.name)}</span>
      <span class="gauge"><i class="${cls}" style="width:${Math.min(d.pct, 100)}%"></i></span>
      <span class="dpct ${d.pct >= 80 ? "lv4" : ""}">${fmt(d.pct, 0)}%</span></li>`;
  }).join("") || '<li class="empty"><p>ไม่มีข้อมูลเขื่อน</p></li>';
}

function renderFeed() {
  const feed = state.feed;
  const news = feed?.news || [];
  const x = feed?.x || { enabled: false, posts: [] };
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(HASHTAG)}&src=trend_click&f=live&vertical=trends`;
  const recent = Date.now() - 3 * 3600e3;

  $("news-count").textContent = news.length || "";
  const newsAt = feed?.newsUpdated ? new Date(feed.newsUpdated) : null;
  const staleNote = newsAt && Date.now() - newsAt.getTime() > 60 * 60 * 1000
    ? `<p class="hint" style="margin:10px 16px 0">ดึงข่าวใหม่ไม่ได้ชั่วคราว แสดงรายการล่าสุดเมื่อ ${ago(newsAt)}</p>`
    : "";
  $("pane-news").innerHTML = news.length
    ? staleNote + news.map((n) => {
        const d = new Date(n.published);
        return `<article class="news">
          <a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>
          <div class="meta">${d.getTime() > recent ? '<span class="new-badge">ใหม่</span>' : ""}<span>${esc(n.source)}</span><span>${ago(d)}</span></div>
        </article>`;
      }).join("")
    : '<div class="empty"><p>ยังไม่มีข่าว ระบบจะดึงข่าวใหม่ทุกประมาณ 10 นาที</p></div>';

  const chips = [HASHTAG, "#น้ำท่วมกรุงเทพ", "#ขอความช่วยเหลือ", "#น้ำป่า", "#ฝนตกหนัก"]
    .map((h) => `<a class="chip" href="https://x.com/search?q=${encodeURIComponent(h)}&f=live" target="_blank" rel="noopener">${esc(h)}</a>`).join("");

  if (x.posts?.length) {
    $("pane-x").innerHTML = x.posts.map((p) => {
      const d = new Date(p.created);
      return `<article class="post">
        <div class="post-head">
          ${p.avatar ? `<img src="${esc(p.avatar)}" alt="" loading="lazy">` : ""}
          <b>${esc(p.name)}</b><span class="handle">@${esc(p.username)} · ${ago(d)}</span>
        </div>
        <p class="post-text">${esc(p.text)}</p>
        ${p.image ? `<img class="post-img" src="${esc(p.image)}" alt="รูปประกอบโพสต์" loading="lazy">` : ""}
        <div class="meta"><span>♥ ${fmt(p.likes)}</span><span>⟲ ${fmt(p.reposts)}</span><a class="more" href="${esc(p.url)}" target="_blank" rel="noopener">เปิดใน X</a></div>
      </article>`;
    }).join("") + `<div class="empty"><a class="btn" href="${searchUrl}" target="_blank" rel="noopener">ดูโพสต์ทั้งหมดบน X</a></div>`;
  } else {
    $("pane-x").innerHTML = `<div class="empty">
      <h3>โพสต์ล่าสุด ${esc(HASHTAG)} บน X</h3>
      <p>${x.enabled && x.error
        ? `ดึงโพสต์จาก X ไม่สำเร็จ (${esc(x.error)}) กดปุ่มด้านล่างเพื่อดูบน X โดยตรง`
        : "X ไม่อนุญาตให้ฝังผลการค้นหาบนเว็บอื่น กดปุ่มด้านล่างเพื่อเปิดฟีดสดเรียงตามล่าสุดบน X"}</p>
      <a class="btn" href="${searchUrl}" target="_blank" rel="noopener">เปิดฟีด ${esc(HASHTAG)} ล่าสุดบน X</a>
      <p>แฮชแท็กที่เกี่ยวข้อง</p>
      <div class="chips">${chips}</div>
    </div>`;
  }
}

function renderAll() {
  renderKpis();
  renderMap();
  renderCritList();
  renderProvinces();
  renderDams();
}

function setStatus() {
  const dot = $("live-dot");
  dot.className = `live-dot ${state.error ? "err" : state.updated ? "ok" : ""}`;
  if (state.error) {
    $("status-text").textContent = `โหลดข้อมูลไม่สำเร็จ (${state.error}) จะลองใหม่อัตโนมัติ`;
  } else if (state.updated) {
    const latest = state.stations.reduce((m, s) => (s.time > m ? s.time : m), new Date(0));
    $("status-text").textContent = `อัปเดต ${clock(state.updated)} · ข้อมูลสถานีล่าสุด ${clock(latest)}`;
  }
}

/* ---------------- interactions ---------------- */

function selectTab(name) {
  for (const t of ["x", "news", "crit"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`pane-${t}`).hidden = t !== name;
  }
}
for (const t of ["x", "news", "crit"]) $(`tab-${t}`).addEventListener("click", () => selectTab(t));

for (const k of Object.keys(layers)) $(`lyr-${k}`).addEventListener("change", applyLayerToggles);
$("only-crit").addEventListener("change", renderMap);
$("crit-filter").addEventListener("input", renderCritList);

$("crit-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const m = markerById.get(btn.dataset.id);
  if (!m) return;
  if (!$("lyr-wl").checked) { $("lyr-wl").checked = true; applyLayerToggles(); }
  map.flyTo(m.getLatLng(), 12, { duration: 0.8 });
  m.openPopup();
  if (matchMedia("(max-width: 1180px)").matches) $("map").scrollIntoView({ behavior: "smooth", block: "center" });
});

$("prov-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-prov]");
  const pts = btn && state.provPoints?.get(btn.dataset.prov);
  if (!pts?.length) return;
  map.flyToBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 11, duration: 0.8 });
  $("crit-filter").value = btn.dataset.prov;
  renderCritList();
  selectTab("crit");
  $("map").scrollIntoView({ behavior: "smooth", block: "center" });
});

/* ---------------- windy embed ---------------- */

const WINDY_VIEWS = {
  east: { lat: 13.1, lon: 101.2, zoom: 8, detailLat: 13.75, detailLon: 100.5 },
  focus: { lat: 13.749, lon: 99.742, zoom: 9 },
  thailand: { lat: 13.2, lon: 101.0, zoom: 5 },
};
const windy = { overlay: "rain", view: "east" };

function updateWindy() {
  const v = WINDY_VIEWS[windy.view];
  const p = new URLSearchParams({
    lat: v.lat, lon: v.lon, detailLat: v.detailLat ?? v.lat, detailLon: v.detailLon ?? v.lon, zoom: v.zoom,
    level: "surface", overlay: windy.overlay, product: windy.overlay === "radar" ? "radar" : "ecmwf",
    menu: "", message: "true", marker: "", calendar: "now", pressure: "", type: "map",
    location: "coordinates", detail: "", metricWind: "km/h", metricTemp: "°C", radarRange: "-1",
  });
  $("windy").src = `https://embed.windy.com/embed2.html?${p}`;
  $("windy-link").href = `https://www.windy.com/?${windy.overlay},${v.lat},${v.lon},${v.zoom}`;
}

function segGroup(id, key, attr) {
  $(id).addEventListener("click", (e) => {
    const btn = e.target.closest(`button[data-${attr}]`);
    if (!btn || btn.dataset[attr] === windy[key]) return;
    windy[key] = btn.dataset[attr];
    for (const b of $(id).querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
    updateWindy();
  });
}
segGroup("windy-overlay", "overlay", "overlay");
segGroup("windy-view", "view", "view");

async function refreshWater() {
  try {
    await Promise.all([loadWater(), loadGdacs()]);
    state.error = null;
    state.updated = new Date();
    renderAll();
  } catch (err) {
    state.error = err.message || "เครือข่ายขัดข้อง";
  }
  setStatus();
}

$("refresh-btn").addEventListener("click", () => {
  $("status-text").textContent = "กำลังโหลดข้อมูล…";
  refreshWater();
  loadFeed();
});

// Default to the X tab only when there are posts to show
loadFeed().then(() => { if (!state.feed?.x?.posts?.length && state.feed?.news?.length) selectTab("news"); });
refreshWater();
setInterval(refreshWater, WATER_REFRESH_MS);
setInterval(loadFeed, FEED_REFRESH_MS);
setInterval(setStatus, 60 * 1000);
