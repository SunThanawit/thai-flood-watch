"use strict";
// Bangkok drainage pump stations (สำนักการระบายน้ำ กทม.).
// Starts from data/pumps.json, then listens to the department's live feed
// (socket.io over a plain WebSocket, no library) for per-station updates.
(() => {
  // Relayed from a Thai IP every ~10 min (fresher); the static file is the fallback
  const SNAPSHOTS = [
    "https://thai-flood-watch-api.vercel.app/api/snapshot?name=pumps",
    "data/pumps.json",
  ];
  const WS_URL = "wss://pumps.bangkok.go.th/socket.io/?EIO=4&transport=websocket";
  const NS = "/iot/devices";
  const STALE_MS = 30 * 60 * 1000;
  const SOURCE_STATUS = { red: "running", green: "ready", yellow: "fault", grey: "off", unknown: "off" };

  const STATUS = {
    running: { label: "กำลังสูบ", color: "var(--pump-run)" },
    ready: { label: "พร้อมใช้งาน", color: "var(--pump-ready)" },
    fault: { label: "ชำรุด", color: "var(--pump-fault)" },
    off: { label: "ปิด", color: "var(--pump-off)" },
    stale: { label: "ขาดการติดต่อ", color: "var(--pump-stale)" },
  };
  const ORDER = ["running", "ready", "fault", "off", "stale"];

  const DISTRICTS = {
    "bang-bon": "บางบอน", "bang-kapi": "บางกะปิ", "bang-khae": "บางแค", "bang-kho-laem": "บางคอแหลม",
    "bang-khun-thian": "บางขุนเทียน", "bang-na": "บางนา", "bang-phlat": "บางพลัด", "bang-rak": "บางรัก",
    "bangkok-noi": "บางกอกน้อย", "bangkok-yai": "บางกอกใหญ่", "bang-sue": "บางซื่อ", "bueng-kum": "บึงกุ่ม",
    "chatuchak": "จตุจักร", "chom-thong": "จอมทอง", "din-daeng": "ดินแดง", "don-mueang": "ดอนเมือง",
    "dusit": "ดุสิต", "huai-khwang": "ห้วยขวาง", "khan-na-yao": "คันนายาว", "khlong-san": "คลองสาน",
    "khlong-sam-wa": "คลองสามวา", "khlong-toei": "คลองเตย", "lak-si": "หลักสี่", "lat-krabang": "ลาดกระบัง",
    "lat-phrao": "ลาดพร้าว", "min-buri": "มีนบุรี", "nong-chok": "หนองจอก", "nong-khaem": "หนองแขม",
    "pathum-wan": "ปทุมวัน", "phasi-charoen": "ภาษีเจริญ", "phaya-thai": "พญาไท", "phra-khanong": "พระโขนง",
    "phra-nakhon": "พระนคร", "pom-prap-sattru-phai": "ป้อมปราบศัตรูพ่าย", "prawet": "ประเวศ",
    "rat-burana": "ราษฎร์บูรณะ", "ratchathewi": "ราชเทวี", "sai-mai": "สายไหม", "samphanthawong": "สัมพันธวงศ์",
    "saphan-sung": "สะพานสูง", "sathon": "สาทร", "suan-luang": "สวนหลวง", "taling-chan": "ตลิ่งชัน",
    "thawi-watthana": "ทวีวัฒนา", "thon-buri": "ธนบุรี", "thung-khru": "ทุ่งครุ", "wang-thonglang": "วังทองหลาง",
    "watthana": "วัฒนา", "yan-nawa": "ยานนาวา",
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const nf = (n) => n.toLocaleString("th-TH");
  const district = (slug) => DISTRICTS[slug] || slug || "–";

  function ago(iso) {
    if (!iso) return "ไม่ทราบเวลา";
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "เมื่อสักครู่";
    if (m < 60) return `${m} นาทีที่แล้ว`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ชม.ที่แล้ว`;
    return `${Math.round(h / 24)} วันที่แล้ว`;
  }

  const state = { stations: new Map(), filter: "fault", live: "connecting", liveCount: 0, snapshotAt: null };
  const isStale = (s) => !s.lastSync || Date.now() - new Date(s.lastSync).getTime() > STALE_MS;
  const eff = (s, status) => (isStale(s) ? "stale" : status);

  // Same shape as scripts/build-pumps.mjs
  function normalize(s) {
    return {
      id: s.id,
      code: s.code,
      name: s.nameTH || s.nameEN || s.code,
      district: s.district || "",
      lat: s.latitude,
      lng: s.longitude,
      status: SOURCE_STATUS[s.status] || "off",
      pumps: (s.pumps || []).map((p) => ({ n: p.id, status: SOURCE_STATUS[p.status] || "off", kw: p.power || 0 })),
      levelPct: Number.isFinite(s.waterLevelPercent) ? Math.round(s.waterLevelPercent * 10) / 10 : null,
      lastSync: s.lastSync || null,
    };
  }

  function merge(s) {
    const prev = state.stations.get(s.id);
    if (prev && prev.lastSync && s.lastSync && prev.lastSync > s.lastSync) return false;
    state.stations.set(s.id, s);
    return true;
  }

  /* ---------- map ---------- */

  const layer = L.layerGroup();
  const markers = new Map();

  function iconFor(s) {
    const st = eff(s, s.status);
    return L.divIcon({
      className: "",
      html: `<div class="pump-icon ${st}" style="background:${STATUS[st].color}"></div>`,
      iconSize: [16, 16],
    });
  }

  function popupFor(s) {
    const st = eff(s, s.status);
    const chips = s.pumps.map((p) => {
      const ps = eff(s, p.status);
      return `<span style="background:${STATUS[ps].color}">#${p.n} ${STATUS[ps].label}${p.kw ? ` · ${p.kw} kW` : ""}</span>`;
    }).join("");
    const kw = s.pumps.reduce((n, p) => n + p.kw, 0);
    return `<div class="pop">
      <span class="tag" style="background:${STATUS[st].color}">${STATUS[st].label}</span>
      <h4>${esc(s.name)}</h4>
      <div class="sub">เขต${esc(district(s.district))} · รหัส ${esc(s.code)}</div>
      <div class="pumprow">${chips || '<span style="background:var(--pump-off)">ไม่มีข้อมูลเครื่องสูบ</span>'}</div>
      <table>
        <tr><td>เครื่องสูบน้ำ</td><td>${s.pumps.length} เครื่อง</td></tr>
        ${kw ? `<tr><td>กำลังมอเตอร์รวม</td><td>${nf(kw)} kW</td></tr>` : ""}
        ${s.levelPct !== null ? `<tr><td>ระดับน้ำในบ่อ</td><td>${s.levelPct}%</td></tr>` : ""}
        <tr><td>อัปเดตล่าสุด</td><td>${ago(s.lastSync)}</td></tr>
      </table>
      ${isStale(s) ? `<div class="sub" style="margin:6px 0 0">ไม่ได้รับข้อมูลเกิน 30 นาที สถานะล่าสุดที่ทราบ: ${STATUS[s.status].label}</div>` : ""}
    </div>`;
  }

  function upsertMarker(s) {
    let m = markers.get(s.id);
    if (!m) {
      m = L.marker([s.lat, s.lng], { icon: iconFor(s), title: s.name, zIndexOffset: 500 }).bindPopup(() => popupFor(state.stations.get(s.id)));
      markers.set(s.id, m);
      layer.addLayer(m);
    } else {
      m.setIcon(iconFor(s));
      if (m.isPopupOpen()) m.setPopupContent(popupFor(s));
    }
  }

  function syncLayer() {
    const on = $("lyr-pump").checked;
    if (on && !map.hasLayer(layer)) map.addLayer(layer);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }
  $("lyr-pump").addEventListener("change", syncLayer);
  syncLayer();

  /* ---------- summary + list ---------- */

  function counts() {
    const pumps = Object.fromEntries(ORDER.map((k) => [k, 0]));
    const stations = Object.fromEntries(ORDER.map((k) => [k, 0]));
    let kw = 0;
    let kwKnown = 0;
    let total = 0;
    for (const s of state.stations.values()) {
      stations[eff(s, s.status)]++;
      for (const p of s.pumps) {
        pumps[eff(s, p.status)]++;
        total++;
        if (p.kw) { kw += p.kw; kwKnown++; }
      }
    }
    return { pumps, stations, kw, kwKnown, total };
  }

  function bar(el, legendEl, byStatus, unit) {
    const total = ORDER.reduce((n, k) => n + byStatus[k], 0) || 1;
    el.innerHTML = ORDER.filter((k) => byStatus[k])
      .map((k) => `<i style="flex:${byStatus[k]};background:${STATUS[k].color}" title="${STATUS[k].label} ${byStatus[k]}"></i>`).join("");
    legendEl.innerHTML = ORDER.map((k) => `<li><i class="dot" style="background:${STATUS[k].color}"></i>${STATUS[k].label} <b>${nf(byStatus[k])}</b><span>${Math.round((byStatus[k] / total) * 100)}%</span></li>`).join("");
    el.setAttribute("aria-label", ORDER.map((k) => `${STATUS[k].label} ${byStatus[k]} ${unit}`).join(", "));
  }

  function renderSummary() {
    const c = counts();
    $("ps-stations").textContent = nf(state.stations.size);
    $("ps-pumps").textContent = nf(c.total);
    $("ps-kw").textContent = nf(c.kw);
    $("ps-kw-note").textContent = `รวมเฉพาะ ${nf(c.kwKnown)} จาก ${nf(c.total)} เครื่องที่ระบุกำลังมอเตอร์`;
    bar($("pump-bar"), $("pump-legend"), c.pumps, "เครื่อง");
    bar($("station-bar"), $("station-legend"), c.stations, "บ่อ");

    $("k-pump-run").textContent = nf(c.pumps.running);
    $("k-pump-total").textContent = ` / ${nf(c.total)}`;
    $("k-pump-foot").textContent = `พร้อม ${nf(c.pumps.ready)} · ชำรุด ${nf(c.pumps.fault)} · ขาดการติดต่อ ${nf(c.pumps.stale)}`;
  }

  function renderList() {
    const q = $("pump-search").value.trim();
    const faultCount = (s) => s.pumps.filter((p) => p.status === "fault").length;
    const runCount = (s) => s.pumps.filter((p) => p.status === "running").length;
    let rows = [...state.stations.values()];
    if (state.filter === "fault") rows = rows.filter((s) => !isStale(s) && (s.status === "fault" || faultCount(s)));
    if (state.filter === "running") rows = rows.filter((s) => !isStale(s) && (s.status === "running" || runCount(s)));
    if (state.filter === "stale") rows = rows.filter(isStale);
    if (q) rows = rows.filter((s) => `${s.name} ${district(s.district)} ${s.code}`.includes(q));
    rows.sort((a, b) => faultCount(b) - faultCount(a) || runCount(b) - runCount(a) || a.name.localeCompare(b.name, "th"));

    $("pump-list").innerHTML = rows.length
      ? rows.map((s) => `<li><button type="button" data-id="${s.id}">
          <span class="pname">${esc(s.name)}</span>
          <span class="pdots" aria-label="${s.pumps.map((p) => STATUS[eff(s, p.status)].label).join(", ")}">${s.pumps.map((p) => `<i style="background:${STATUS[eff(s, p.status)].color}"></i>`).join("")}</span>
          <span class="pmeta">เขต${esc(district(s.district))} · ${ago(s.lastSync)}</span>
          <span class="plevel">${s.levelPct !== null && !isStale(s) ? `น้ำในบ่อ ${s.levelPct}%` : ""}</span>
        </button></li>`).join("")
      : `<li class="empty">${q ? "ไม่พบบ่อสูบน้ำที่ตรงกับคำค้น" : "ไม่มีบ่อสูบน้ำในกลุ่มนี้ขณะนี้"}</li>`;
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      renderSummary();
      renderList();
      renderLive();
    }, 1500);
  }

  function renderAll() {
    for (const s of state.stations.values()) upsertMarker(s);
    renderSummary();
    renderList();
    renderLive();
  }

  function renderLive() {
    const chip = $("pump-live");
    if (state.live === "on") {
      chip.className = "live-chip on";
      chip.textContent = `สด · อัปเดตแล้ว ${nf(state.liveCount)} บ่อตั้งแต่เปิดหน้า`;
    } else if (state.live === "off") {
      chip.className = "live-chip off";
      chip.textContent = state.snapshotAt
        ? `เชื่อมต่อสดไม่ได้ · ใช้ข้อมูลเมื่อ ${ago(state.snapshotAt)}`
        : "เชื่อมต่อสดไม่ได้";
    } else {
      chip.className = "live-chip";
      chip.textContent = "กำลังเชื่อมต่อข้อมูลสด…";
    }
  }

  $("pump-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    state.filter = b.dataset.f;
    for (const x of $("pump-filter").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    renderList();
  });
  $("pump-search").addEventListener("input", renderList);
  $("pump-list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    const m = b && markers.get(Number(b.dataset.id));
    if (!m) return;
    if (!$("lyr-pump").checked) { $("lyr-pump").checked = true; syncLayer(); }
    $("map").scrollIntoView({ behavior: "smooth", block: "center" });
    map.flyTo(m.getLatLng(), 15, { duration: 0.8 });
    map.once("moveend", () => m.openPopup());
  });

  /* ---------- data ---------- */

  async function loadSnapshot() {
    const got = await Promise.all(SNAPSHOTS.map(async (url) => {
      try {
        const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 60000)}`);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    }));
    // Merge both; per-station lastSync decides which record wins
    for (const j of got) {
      if (!j?.stations) continue;
      if (!state.snapshotAt || j.generated > state.snapshotAt) state.snapshotAt = j.generated;
      for (const s of j.stations) merge(s);
    }
    renderAll();
  }

  // socket.io v4 handshake: 0 = open, 40 = namespace connect, 42 = event, 2/3 = ping/pong
  let ws;
  let retry = 0;
  const liveIds = new Set();
  function connect() {
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      return fail();
    }
    const timeout = setTimeout(() => { if (state.live !== "on") ws.close(); }, 15000);
    ws.onmessage = (e) => {
      const m = String(e.data);
      if (m.startsWith("0")) ws.send(`40${NS},{"token":""}`);
      else if (m === "2") ws.send("3");
      else if (m.startsWith(`40${NS},`)) {
        clearTimeout(timeout);
        retry = 0;
        state.live = "on";
        renderLive();
        ws.send(`42${NS},["dashboard:subscribe"]`);
      } else if (m.startsWith(`42${NS},`)) {
        let event;
        let d;
        try { [event, d] = JSON.parse(m.slice(NS.length + 3)); } catch { return; }
        if (event !== "dashboard:event" || !d?.id || !Number.isFinite(d.latitude) || !Number.isFinite(d.longitude)) return;
        const s = normalize(d);
        if (!merge(s)) return;
        liveIds.add(s.id);
        state.liveCount = liveIds.size;
        upsertMarker(s);
        scheduleRender();
      }
    };
    ws.onclose = () => { clearTimeout(timeout); fail(); };
    ws.onerror = () => ws.close();
  }

  function fail() {
    state.live = "off";
    renderLive();
    retry = Math.min(retry + 1, 6);
    setTimeout(() => { if (!document.hidden) connect(); else pendingReconnect = true; }, 2000 * 2 ** retry);
  }
  let pendingReconnect = false;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && pendingReconnect) {
      pendingReconnect = false;
      connect();
    }
  });

  // Staleness depends on the clock, so recolour once a minute
  setInterval(() => {
    for (const s of state.stations.values()) upsertMarker(s);
    renderSummary();
    renderList();
    renderLive();
  }, 60 * 1000);

  loadSnapshot().then(connect);
  setInterval(loadSnapshot, 5 * 60 * 1000);
})();
