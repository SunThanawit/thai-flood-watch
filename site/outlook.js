"use strict";
// "พยากรณ์ทั่วประเทศ": river-flow outlook (GloFAS via Open-Meteo), TMD's 7-day
// rain outlook per province, and ThaiWater's forecast maps / radar / satellite.
// Nothing here loads until its tab is on screen, so the page stays light.
(() => {
  const OPEN_METEO = "https://flood-api.open-meteo.com/v1/flood";
  const TMD_SOURCES = ["data/tmd.json", "https://thai-flood-watch-api.vercel.app/api/snapshot?name=tmd"];
  const IMG = "https://api-v3.thaiwater.net/api/v1/thaiwater30/shared/image?image=";
  const TZ = "Asia/Bangkok";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const nf = (n, d = 0) => n.toLocaleString("th-TH", { maximumFractionDigits: d });
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const day = (iso, opts) => new Date(`${iso}T12:00:00+07:00`).toLocaleDateString("th-TH", { timeZone: TZ, ...opts });
  const clock = (d) => d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  const stamp = (d) => `${d.toLocaleDateString("th-TH", { day: "numeric", month: "short", timeZone: TZ })} ${clock(d)} น.`;
  const ago = (d) => {
    const m = Math.round((Date.now() - d.getTime()) / 60000);
    return m < 1 ? "เมื่อสักครู่" : m < 60 ? `${m} นาทีที่แล้ว` : m < 1440 ? `${Math.round(m / 60)} ชม.ที่แล้ว` : `${Math.round(m / 1440)} วันที่แล้ว`;
  };
  const thaiwater = () => window.__thaiwater || null;
  const rows = (k) => {
    const v = thaiwater()?.[k];
    const inner = v?.data ?? v;
    const list = inner?.data ?? inner;
    return Array.isArray(list) ? list : [];
  };

  /* ---------------- tabs, loaded on first view ---------------- */

  const loaded = {};
  const loaders = { rivers: loadRivers, tmd: loadTmd, maps: loadMaps };
  function showTab(name) {
    for (const t of Object.keys(loaders)) {
      $(`ot-${t}`).setAttribute("aria-selected", String(t === name));
      $(`op-${t}`).hidden = t !== name;
    }
    if (!loaded[name]) { loaded[name] = true; loaders[name](); }
  }
  for (const t of Object.keys(loaders)) $(`ot-${t}`).addEventListener("click", () => showTab(t));

  /* ---------------- 1. rivers ---------------- */

  // Cells of Open-Meteo's ~5 km GloFAS grid that sit on the main channel
  // (a point at the town itself often falls on a dry cell with ~2 m³/s).
  // `gauge` is the ThaiWater station whose measured discharge we show beside it.
  const RIVERS = [
    { name: "แม่น้ำปิง", place: "เชียงใหม่", lat: 18.675, lng: 98.925, gauge: 3226 },
    { name: "แม่น้ำยม", place: "สุโขทัย", lat: 16.925, lng: 99.875, gauge: 2986 },
    { name: "แม่น้ำน่าน", place: "พิษณุโลก", lat: 16.725, lng: 100.225, gauge: 2953 },
    { name: "แม่น้ำเจ้าพระยา", place: "นครสวรรค์", lat: 15.575, lng: 100.025, gauge: 2795 },
    { name: "แม่น้ำเจ้าพระยา", place: "ชัยนาท (ท้ายเขื่อน)", lat: 15.175, lng: 100.125, gauge: 2744 },
    { name: "แม่น้ำเจ้าพระยา", place: "พระนครศรีอยุธยา", lat: 14.275, lng: 100.525, gauge: 2609 },
    { name: "แม่น้ำมูล", place: "อุบลราชธานี", lat: 15.225, lng: 104.875, gauge: 3543 },
    { name: "แม่น้ำโขง", place: "หนองคาย", lat: 17.925, lng: 102.725, gauge: null },
  ];
  const PAST = 14;

  async function fetchRivers() {
    const cached = store.get("outlook-rivers-v1");
    if (cached && Date.now() - cached.t < 60 * 60 * 1000) return cached.data;
    const q = new URLSearchParams({
      latitude: RIVERS.map((r) => r.lat).join(","),
      longitude: RIVERS.map((r) => r.lng).join(","),
      daily: "river_discharge,river_discharge_p25,river_discharge_p75",
      past_days: String(PAST),
      forecast_days: "16",
      timezone: TZ,
    });
    const res = await fetch(`${OPEN_METEO}?${q}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    store.set("outlook-rivers-v1", { t: Date.now(), data });
    return data;
  }

  function gaugeFor(id) {
    if (!id) return null;
    const w = rows("waterlevel").find((x) => x.station?.id === id);
    const q = Number.parseFloat(w?.discharge);
    if (!w || !Number.isFinite(q)) return null;
    const t = w.waterlevel_datetime ? new Date(`${w.waterlevel_datetime.replace(" ", "T")}:00+07:00`) : null;
    return { q, name: (w.station.tele_station_name?.th || "").trim(), code: w.station.tele_station_oldcode, at: t };
  }

  function river(rv, series) {
    const d = series.daily;
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
    const ti = d.time.indexOf(today);
    if (ti < 0 || !d.river_discharge[ti]) return null;
    const now = d.river_discharge[ti];
    const rel = (v) => (v / now) * 100;
    const from = Math.max(0, ti - PAST);
    const idx = d.time.map((_, i) => i).filter((i) => i >= from);
    const line = idx.map((i) => ({ i, t: d.time[i], v: rel(d.river_discharge[i]) }));
    const band = idx.filter((i) => i >= ti).map((i) => ({ i, lo: rel(d.river_discharge_p25[i] ?? d.river_discharge[i]), hi: rel(d.river_discharge_p75[i] ?? d.river_discharge[i]) }));
    const fut = line.filter((p) => p.i >= ti);
    const peak = fut.reduce((a, b) => (b.v > a.v ? b : a));
    const end = fut.at(-1);
    return { rv, ti, line, band, peak, end, gauge: gaugeFor(rv.gauge) };
  }

  function spark(r) {
    const W = 260, H = 96, PX = 6, PT = 14, PB = 16;
    const all = [...r.line.map((p) => p.v), ...r.band.flatMap((b) => [b.lo, b.hi]), 100];
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = Math.max(4, (hi - lo) * 0.12);
    lo -= pad; hi += pad;
    const n = r.line.length;
    const x = (k) => PX + (k * (W - 2 * PX)) / (n - 1);
    const y = (v) => PT + ((hi - v) / (hi - lo)) * (H - PT - PB);
    const k0 = r.line.findIndex((p) => p.i === r.ti);
    const past = r.line.slice(0, k0 + 1).map((p, k) => `${x(k).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const fut = r.line.slice(k0).map((p, k) => `${x(k0 + k).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const bandPts = [
      ...r.band.map((b, k) => `${x(k0 + k).toFixed(1)},${y(b.hi).toFixed(1)}`),
      ...r.band.map((b, k) => [r.band.length - 1 - k, r.band[r.band.length - 1 - k]]).map(([k, b]) => `${x(k0 + k).toFixed(1)},${y(b.lo).toFixed(1)}`),
    ].join(" ");
    const pk = r.line.findIndex((p) => p.i === r.peak.i);
    const showPeak = r.peak.i !== r.ti;
    return `<svg viewBox="0 0 ${W} ${H}" class="spark" role="img" aria-label="แนวโน้มปริมาณน้ำ ${esc(r.rv.name)} ${esc(r.rv.place)} เทียบวันนี้ ${nf(r.end.v - 100)}% ในอีก 15 วัน ยอดสูงสุด ${nf(r.peak.v - 100)}% วันที่ ${esc(day(r.peak.t, { day: "numeric", month: "short" }))}">
      <line x1="${PX}" x2="${W - PX}" y1="${y(100).toFixed(1)}" y2="${y(100).toFixed(1)}" class="s-base"></line>
      <line x1="${x(k0).toFixed(1)}" x2="${x(k0).toFixed(1)}" y1="${PT - 6}" y2="${H - PB}" class="s-today"></line>
      <polygon points="${bandPts}" class="s-band"></polygon>
      <polyline points="${past}" class="s-past"></polyline>
      <polyline points="${fut}" class="s-fut"></polyline>
      <circle cx="${x(k0).toFixed(1)}" cy="${y(100).toFixed(1)}" r="3.5" class="s-dot"></circle>
      ${showPeak ? `<circle cx="${x(pk).toFixed(1)}" cy="${y(r.peak.v).toFixed(1)}" r="3.5" class="s-peak"></circle>
      <text x="${Math.min(x(pk), W - 30).toFixed(1)}" y="${(y(r.peak.v) - 7).toFixed(1)}" class="s-txt" text-anchor="middle">${r.peak.v >= 100 ? "+" : "−"}${nf(Math.abs(r.peak.v - 100))}%</text>` : ""}
      <text x="${x(k0).toFixed(1)}" y="${H - 3}" class="s-txt" text-anchor="middle">วันนี้</text>
      <text x="${PX}" y="${H - 3}" class="s-txt">−${PAST} วัน</text>
      <text x="${W - PX}" y="${H - 3}" class="s-txt" text-anchor="end">+15 วัน</text>
    </svg>`;
  }

  function verdict(r) {
    const up = r.peak.v - 100;
    const end = r.end.v - 100;
    const pd = day(r.peak.t, { day: "numeric", month: "short" });
    const left = r.peak.i - r.ti;
    if (up >= 5 && left > 0) return { cls: up >= 15 ? "up hi" : "up", text: `▲ คาดว่าเพิ่มขึ้นสูงสุด +${nf(up)}% วันที่ ${pd} (อีก ${left} วัน)` };
    if (end <= -5) return { cls: "down", text: `▼ คาดว่าลดลง ${nf(Math.abs(end))}% ภายใน 15 วัน` };
    return { cls: "flat", text: "■ ค่อนข้างทรงตัว (ไม่เกิน ±5%)" };
  }

  function riverCard(r) {
    const v = verdict(r);
    const g = r.gauge;
    return `<article class="river">
      <header><b>${esc(r.rv.name)}</b><span>${esc(r.rv.place)}</span></header>
      <div class="river-now">${g
        ? `<strong>${nf(g.q)}</strong><small>ลบ.ม./วินาที · วัดจริง</small>
           <span class="river-src">สถานี${esc(g.name)}${/[(（]/.test(g.name) ? "" : ` (${esc(g.code)})`}${g.at ? ` · ${clock(g.at)} น.` : ""}</span>`
        : `<strong class="na">–</strong><small>ไม่มีเครื่องวัดคู่เทียบในระบบ</small>`}</div>
      ${spark(r)}
      <p class="river-verdict ${v.cls}">${v.text}</p>
    </article>`;
  }

  async function loadRivers() {
    const box = $("rivers");
    try {
      const data = await fetchRivers();
      const list = Array.isArray(data) ? data : [data];
      const cards = RIVERS.map((rv, i) => (list[i]?.daily ? river(rv, list[i]) : null));
      box.innerHTML = cards.filter(Boolean).map(riverCard).join("") || '<p class="op-empty">ยังไม่มีข้อมูลแนวโน้มแม่น้ำ</p>';
    } catch {
      loaded.rivers = false;
      box.innerHTML = '<p class="op-empty">โหลดแนวโน้มแม่น้ำไม่สำเร็จ <button type="button" class="btn-ghost" id="rivers-retry">ลองใหม่</button></p>';
      $("rivers-retry").addEventListener("click", () => { loaded.rivers = true; loadRivers(); });
    }
  }
  // gauge numbers arrive with the ThaiWater response; refresh the cards once it is here
  window.addEventListener("thaiwater", () => { if (loaded.rivers && $("rivers").querySelector(".river")) loadRivers(); }, { once: true });

  /* ---------------- 2. TMD 7-day province outlook ---------------- */

  const tmd = { data: null, all: false };

  async function loadTmd() {
    const got = await Promise.all(TMD_SOURCES.map(async (u) => {
      try {
        const res = await fetch(`${u}${u.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 60000)}`);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    }));
    const newest = (f) => String(f.issued || f.generated || "");
    tmd.data = got.filter((f) => f?.provinces?.length).sort((a, b) => newest(b).localeCompare(newest(a)))[0] || null;
    if (!tmd.data) {
      $("tmd-table").innerHTML = "";
      $("tmd-meta").textContent = "โหลดพยากรณ์รายจังหวัดไม่สำเร็จ";
      loaded.tmd = false;
      return;
    }
    renderTmd();
  }

  const mean = (a) => a.filter((x) => x !== null).reduce((s, x, _, arr) => s + x / arr.length, 0);

  function renderTmd() {
    const d = tmd.data;
    const q = $("tmd-search").value.trim();
    let list = [...d.provinces].sort((a, b) => mean(b.rain) - mean(a.rain) || a.name.localeCompare(b.name, "th"));
    const total = list.length;
    if (q) list = list.filter((p) => p.name.includes(q) || p.en?.toLowerCase().includes(q.toLowerCase()));
    else if (!tmd.all) list = list.slice(0, 15);

    const head = d.dates.map((iso) => `<th scope="col"><span>${esc(day(iso, { weekday: "short" }))}</span>${esc(day(iso, { day: "numeric" }))}</th>`).join("");
    const body = list.map((p) => {
      const cells = p.rain.map((v, i) => {
        const t = `${p.name} ${day(d.dates[i], { day: "numeric", month: "short" })}: ฝนครอบคลุม ${v ?? "–"}% ของพื้นที่${p.storm[i] ? " (พายุฝนฟ้าคะนอง)" : ""}`;
        return `<td class="rc${p.storm[i] ? " storm" : ""}" style="--v:${((v ?? 0) / 100).toFixed(2)}" title="${esc(t)}">${v ?? "–"}</td>`;
      }).join("");
      const hi = p.hi.filter((x) => x !== null);
      return `<tr><th scope="row">${esc(p.name)}</th>${cells}<td class="tc">${hi.length ? `${Math.min(...hi)}–${Math.max(...hi)}°` : "–"}</td></tr>`;
    }).join("") || `<tr><td colspan="${d.dates.length + 2}" class="op-empty">ไม่พบจังหวัดที่ค้นหา</td></tr>`;
    $("tmd-table").innerHTML = `<caption class="visually-hidden">ร้อยละพื้นที่ที่คาดว่ามีฝน รายจังหวัด 7 วัน</caption><thead><tr><th scope="col">จังหวัด</th>${head}<th scope="col">สูงสุด °C</th></tr></thead><tbody>${body}</tbody>`;

    const more = $("tmd-more");
    more.hidden = Boolean(q) || total <= 15;
    more.textContent = tmd.all ? "แสดงเฉพาะ 15 จังหวัดแรก" : `แสดงทั้งหมด ${total} จังหวัด`;
    $("tmd-meta").textContent = d.issued ? `กรมอุตุนิยมวิทยา ประกาศ ${stamp(new Date(d.issued))}` : "กรมอุตุนิยมวิทยา";
  }
  $("tmd-search").addEventListener("input", () => tmd.data && renderTmd());
  $("tmd-more").addEventListener("click", () => { tmd.all = !tmd.all; renderTmd(); });

  /* ---------------- 3. forecast maps / radar / satellite ---------------- */

  const maps = { kind: "forecast", day: 0, scope: "country", radar: null };
  const RADAR_MAX_AGE_MS = 3 * 60 * 60 * 1000;

  // Radar timestamps are UTC (the feed also tags the Bangkok city radars "TST",
  // but their times match the UTC ones, so all are read as UTC). Old images
  // stay in the list for years, so only recently updated radars are offered.
  function freshRadars() {
    return rows("radar")
      .map((r) => ({ ...r, at: r.media_datetime ? new Date(`${r.media_datetime.replace(" ", "T")}:00Z`) : null }))
      .filter((r) => r.at && Date.now() - r.at.getTime() < RADAR_MAX_AGE_MS && !/error/.test(r.filename))
      .sort((a, b) => a.radar_name.localeCompare(b.radar_name, "th"));
  }

  function pick() {
    if (maps.kind === "forecast") {
      const r = rows(maps.scope === "basin" ? "pre_rain_basin" : "pre_rain")[maps.day];
      if (!r) return null;
      const end = new Date(`${r.media_datetime.replace(" ", "T")}:00+07:00`);
      return { r, alt: `แผนที่พยากรณ์ฝนสะสม 24 ชั่วโมง วัน ${maps.day + 1}`, cap: `ฝนสะสม 24 ชม. สิ้นสุด ${stamp(end)} · แบบจำลอง WRF-ROMS โดย สถาบันสารสนเทศทรัพยากรน้ำ (HAII)` };
    }
    if (maps.kind === "radar") {
      const list = freshRadars();
      const r = list.find((x) => x.radar_name === maps.radar) || list.find((x) => /สุวรรณภูมิ.*120/.test(x.radar_name)) || list[0];
      if (!r) return null;
      maps.radar = r.radar_name;
      return { r, alt: `ภาพ${r.radar_name}`, cap: `${r.radar_name} · ภาพเวลา ${stamp(r.at)} (${ago(r.at)})` };
    }
    const r = thaiwater()?.storm?.data?.data?.typhoon?.[0];
    if (!r) return null;
    const at = new Date(`${r.media_datetime.replace(" ", "T")}:00+07:00`);
    return { r, alt: "ภาพถ่ายดาวเทียมฮิมาวาริ", cap: `ภาพถ่ายดาวเทียมฮิมาวาริ ภาพเวลา ${stamp(at)} (${ago(at)}) · ผ่าน ThaiWater` };
  }

  function drawMaps() {
    $("maps-day").hidden = maps.kind !== "forecast";
    $("maps-scope").hidden = maps.kind !== "forecast";
    const sel = $("radar-select");
    sel.hidden = maps.kind !== "radar";
    if (maps.kind === "radar") {
      const list = freshRadars();
      sel.innerHTML = list.map((r) => `<option value="${esc(r.radar_name)}">${esc(r.radar_name)}</option>`).join("");
      if (maps.radar) sel.value = maps.radar;
    }
    const img = $("maps-img");
    const p = pick();
    $("maps-fail").hidden = true;
    if (!p) {
      img.removeAttribute("src");
      img.hidden = true;
      $("maps-cap").textContent = thaiwater() ? "ยังไม่มีภาพในหมวดนี้" : "กำลังโหลดข้อมูลภาพ…";
      return;
    }
    const url = IMG + encodeURIComponent(p.r.media_path);
    img.hidden = false;
    img.alt = p.alt;
    $("maps-cap").textContent = p.cap;
    if (img.dataset.src !== url) {
      img.dataset.src = url;
      img.src = url;
    }
  }
  $("maps-img").addEventListener("error", () => { $("maps-img").hidden = true; $("maps-fail").hidden = false; });

  function loadMaps() { drawMaps(); }
  // Image links carry short-lived tokens, so follow every fresh ThaiWater response
  window.addEventListener("thaiwater", () => { if (loaded.maps && !$("op-maps").hidden) drawMaps(); });

  function seg(id, key, attr, parse = (v) => v) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest(`button[data-${attr}]`);
      if (!b) return;
      maps[key] = parse(b.dataset[attr]);
      for (const x of $(id).querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
      drawMaps();
    });
  }
  seg("maps-kind", "kind", "k");
  seg("maps-day", "day", "d", Number);
  seg("maps-scope", "scope", "s");
  $("radar-select").addEventListener("change", (e) => { maps.radar = e.target.value; drawMaps(); });

  /* ---------------- start: load the first tab when the section nears the screen ---------------- */

  const start = () => showTab("rivers");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
    }, { rootMargin: "600px 0px" });
    io.observe($("outlook"));
  } else {
    start();
  }
})();
