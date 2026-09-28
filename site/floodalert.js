"use strict";
// Bangkok road flooding (กทม. "เลี่ยงถนนน้ำท่วม"): road water-level sensors,
// flooded roads, and the drainage department's list of roads still flooded.
// The data is relayed from a Thai IP to the API; the static file is a fallback.
(() => {
  const SOURCES = [
    "https://thai-flood-watch-api.vercel.app/api/snapshot?name=floodalert",
    "data/floodalert.json",
  ];
  const REFRESH_MS = 5 * 60 * 1000;
  const PAGE = "https://now.bangkok.go.th/flood-alert.html";

  const SENSOR = {
    high: { label: "ท่วมสูง >10 ซม.", css: "--road-high" },
    flood: { label: "ท่วม 10 ซม.", css: "--road-flood" },
    minor: { label: "ท่วมขังเล็กน้อย <10 ซม.", css: "--road-minor" },
    normal: { label: "ปกติ", css: "--road-ok" },
  };
  const REPORT = {
    high: { label: "ท่วมหนัก", css: "--road-high" },
    medium: { label: "ท่วมปานกลาง", css: "--road-flood" },
    low: { label: "เล็กน้อย สัญจรได้", css: "--road-minor" },
    unknown: { label: "ไม่ระบุระดับ", css: "--road-minor" },
  };
  const CHANGE = {
    new: { label: "ท่วมใหม่", css: "--road-high" },
    worse: { label: "น้ำสูงขึ้น", css: "--road-flood" },
    same: { label: "เท่าเดิม", css: "--muted" },
    better: { label: "น้ำลดลง", css: "--road-ok" },
    normal: { label: "ไม่พบน้ำท่วมแล้ว", css: "--road-ok" },
  };
  const RANK = { high: 3, flood: 2, minor: 1, medium: 2, low: 1, unknown: 0 };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const color = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const flat = (geom) => (geom || []).flat();

  let data = null;
  const layer = L.layerGroup();
  const shapes = new Map(); // list key -> bounds

  async function load() {
    const results = await Promise.all(SOURCES.map(async (url) => {
      try {
        const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 60000)}`);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    }));
    const best = results.filter((d) => d?.roads).sort((a, b) => String(b.generated).localeCompare(String(a.generated)))[0];
    if (!best) {
      $("fa-status").textContent = "โหลดข้อมูลถนนน้ำท่วมไม่สำเร็จ จะลองใหม่อัตโนมัติ";
      return;
    }
    data = best;
    render();
  }

  /* ---------- map ---------- */

  function drawMap() {
    layer.clearLayers();
    shapes.clear();
    if (!data) return;

    // Department report lines first (wide, translucent), sensors on top
    data.reports.items.forEach((it, i) => {
      if (!it.geom.length) return;
      const c = color(REPORT[it.level].css);
      const line = L.polyline(it.geom, {
        color: c, weight: 6, opacity: it.exact ? 0.5 : 0.25, dashArray: it.exact ? null : "6 8", lineCap: "round",
      }).bindPopup(`<div class="pop"><span class="tag" style="background:${c}">${REPORT[it.level].label}</span>
        <h4>${esc(it.name)}</h4><div class="sub">รายงานสำนักการระบายน้ำ เวลา ${esc(data.reports.time)} น.${it.exact ? "" : " · ไม่ระบุช่วงแน่ชัด จึงแสดงทั้งสาย"}</div></div>`);
      layer.addLayer(line);
      shapes.set(`r${i}`, line.getBounds());
    });

    for (const p of data.points) {
      const lvl = p.now ? p.now.level : "normal";
      const c = color(SENSOR[lvl].css);
      const pts = flat(p.geom);
      if (!pts.length) continue;
      const popup = `<div class="pop"><span class="tag" style="background:${c}">${p.now ? SENSOR[lvl].label : "ไม่พบน้ำท่วมแล้ว"}</span>
        <h4>${esc(p.road)}</h4><div class="sub">${esc(p.section)} · จุดวัด ${esc(p.code)}</div>
        <table>
          <tr><td>ตอนนี้ (${esc(data.sensorTime)})</td><td>${p.now ? `${p.now.cm} ซม.` : "ปกติ"}</td></tr>
          <tr><td>รอบก่อน (${esc(data.compareTime)})</td><td>${p.before ? `${p.before.cm} ซม.` : "ปกติ"}</td></tr>
          <tr><td>เทียบรอบก่อน</td><td>${CHANGE[p.change]?.label ?? "–"}</td></tr>
        </table></div>`;
      if (p.now) layer.addLayer(L.polyline(p.geom, { color: c, weight: 8, opacity: 0.95, lineCap: "round" }).bindPopup(popup));
      const mid = pts[Math.floor(pts.length / 2)];
      layer.addLayer(L.circleMarker(mid, {
        radius: p.now ? 5 : 3.5, color: color("--surface"), weight: 1.5, fillColor: c, fillOpacity: 1,
      }).bindPopup(popup));
    }

    data.roads.forEach((r, i) => {
      const pts = [...flat(r.geom), ...data.points.filter((p) => p.road === r.name).flatMap((p) => flat(p.geom))];
      if (pts.length) shapes.set(`d${i}`, L.latLngBounds(pts));
    });
  }

  function syncLayer() {
    const on = $("lyr-road").checked;
    if (on && !map.hasLayer(layer)) map.addLayer(layer);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }
  $("lyr-road").addEventListener("change", syncLayer);
  syncLayer();

  /* ---------- card ---------- */

  function trendSvg(rounds) {
    if (rounds.length < 2) return "";
    const W = 280, H = 70, P = 8, BASE = H - 16;
    const ys = rounds.map((r) => r.points);
    const max = Math.max(...ys), min = Math.min(...ys);
    const span = Math.max(1, max - min);
    const x = (i) => P + (i * (W - 2 * P)) / (rounds.length - 1);
    const y = (v) => P + ((max - v) / span) * (BASE - P - 4);
    const line = ys.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const last = ys.length - 1;
    return `<svg viewBox="0 0 ${W} ${H}" class="fa-trend" role="img" aria-label="จำนวนจุดวัดที่พบน้ำท่วม ${rounds.map((r) => `${r.time} ${r.points} จุด`).join(", ")}">
      <line x1="${P}" x2="${W - P}" y1="${BASE}" y2="${BASE}" stroke="var(--line)"></line>
      <polygon points="${P},${BASE} ${line} ${W - P},${BASE}" fill="var(--road-flood)" opacity=".12"></polygon>
      <polyline points="${line}" fill="none" stroke="var(--road-flood)" stroke-width="2" stroke-linejoin="round"></polyline>
      ${ys.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${i === last ? 3.5 : 2}" fill="var(--road-flood)"></circle>`).join("")}
      <text x="${P}" y="${H - 3}" class="t">${esc(rounds[0].time)} · ${ys[0]} จุด</text>
      <text x="${W - P}" y="${H - 3}" class="t" text-anchor="end">${esc(rounds[last].time)} · ${ys[last]} จุด</text>
    </svg>`;
  }

  function render() {
    drawMap();
    const c = data.counts;
    $("fa-status").innerHTML = `เซ็นเซอร์ ${esc(data.sensorTime)} น. · รายงานสำนักการระบายน้ำ ${esc(data.reports.time)} น. · <a href="${PAGE}" target="_blank" rel="noopener">ดูหน้าต้นทาง ↗</a>`;
    $("fa-counts").innerHTML = ["high", "flood", "minor", "normal"].map((k) =>
      `<li><i style="background:var(${SENSOR[k].css})"></i><b>${c[k] ?? "–"}</b><span>${k === "normal" ? "จุดวัดปกติ" : SENSOR[k].label}</span></li>`).join("");

    const changes = {};
    for (const p of data.points) changes[p.change] = (changes[p.change] || 0) + 1;
    $("fa-change").innerHTML = `<span class="fa-change-h">เทียบกับ ${esc(data.compareTime)} น.</span>` + Object.keys(CHANGE)
      .filter((k) => changes[k])
      .map((k) => `<span class="chip-s" style="--c:var(${CHANGE[k].css})">${CHANGE[k].label} <b>${changes[k]}</b></span>`).join("");
    $("fa-trend").innerHTML = trendSvg(data.rounds || []);

    const roads = data.roads.map((r, i) => ({ ...r, i })).sort((a, b) => RANK[b.level] - RANK[a.level] || b.maxCm - a.maxCm);
    $("fa-roads-count").textContent = roads.length;
    $("fa-roads").innerHTML = roads.map((r) => `<li><button type="button" data-k="d${r.i}">
        <span class="fa-name">${esc(r.name)}</span>
        <span class="fa-cm" style="--c:var(${SENSOR[r.level].css})">${r.maxCm} ซม.</span>
        <span class="fa-sub">เขต${esc(r.district)} · ${r.sensors.map((s) => `${esc(s.loc)} ${s.cm} ซม.`).join(" · ")}</span>
      </button></li>`).join("") || '<li class="empty">ไม่พบถนนที่มีน้ำท่วมจากเซ็นเซอร์</li>';

    const items = data.reports.items.map((it, i) => ({ ...it, i })).sort((a, b) => RANK[b.level] - RANK[a.level]);
    $("fa-report-count").textContent = items.length;
    $("fa-report").innerHTML = items.map((it) => `<li><button type="button" data-k="r${it.i}"${it.geom.length ? "" : " disabled"}>
        <span class="fa-lv" style="--c:var(${REPORT[it.level].css})">${REPORT[it.level].label}</span>
        <span class="fa-rname">${esc(it.name)}</span>
      </button></li>`).join("") || '<li class="empty">ไม่มีรายงาน</li>';
  }

  function flyTo(e) {
    const b = e.target.closest("button[data-k]");
    const bounds = b && shapes.get(b.dataset.k);
    if (!bounds) return;
    if (!$("lyr-road").checked) { $("lyr-road").checked = true; syncLayer(); }
    $("map").scrollIntoView({ behavior: "smooth", block: "center" });
    map.flyToBounds(bounds.pad(0.4), { maxZoom: 16, duration: 0.8 });
  }
  $("fa-roads").addEventListener("click", flyTo);
  $("fa-report").addEventListener("click", flyTo);

  // Canvas-drawn lines take concrete colours, so redraw when the theme flips
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => data && drawMap());

  load();
  setInterval(load, REFRESH_MS);
})();
