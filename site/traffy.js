"use strict";
// Citizens' flood reports in Bangkok from Traffy Fondue: a map layer (off by
// default, the map is already busy) and a summary of status and districts.
// The data is a trimmed snapshot (no text or photos), see scripts/build-traffy.mjs.
(() => {
  const SOURCES = ["data/traffy.json", "https://thai-flood-watch-api.vercel.app/api/snapshot?name=traffy"];
  const REFRESH_MS = 5 * 60 * 1000;
  const STALE_MS = 3 * 3600e3;

  const GROUPS = {
    start: { label: "รอรับเรื่อง", css: "--lv5" },
    inprogress: { label: "กำลังดำเนินการ", css: "--lv4" },
    forward: { label: "ส่งต่อหน่วยงาน", css: "--accent" },
    finish: { label: "เสร็จสิ้น", css: "--lv3" },
    irrelevant: { label: "ไม่เกี่ยวข้อง/ยกเลิก", css: "--muted" },
  };
  const ORDER = ["start", "inprogress", "forward", "finish", "irrelevant"];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const nf = (n) => n.toLocaleString("th-TH");
  const color = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const clock = (d) => d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  const ago = (d) => {
    const m = Math.round((Date.now() - d.getTime()) / 60000);
    return m < 1 ? "เมื่อสักครู่" : m < 60 ? `${m} นาทีที่แล้ว` : `${Math.round(m / 60)} ชม.ที่แล้ว`;
  };

  let data = null;
  const layer = L.layerGroup();

  async function load() {
    const got = await Promise.all(SOURCES.map(async (u) => {
      try {
        const res = await fetch(`${u}${u.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 60000)}`);
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    }));
    const best = got.filter((f) => f?.points).sort((a, b) => String(b.generated).localeCompare(String(a.generated)))[0];
    if (!best) {
      $("tf-meta").textContent = "โหลดข้อมูลจาก Traffy Fondue ไม่สำเร็จ จะลองใหม่อัตโนมัติ";
      return;
    }
    data = best;
    render();
  }

  function drawMap() {
    layer.clearLayers();
    if (!data) return;
    // Oldest first so the newest reports draw on top
    for (const p of [...data.points].reverse()) {
      const g = GROUPS[p.st] || GROUPS.start;
      const c = color(g.css);
      const at = new Date(p.at);
      layer.addLayer(L.circleMarker([p.lat, p.lng], {
        radius: 4, color: color("--surface"), weight: 1, fillColor: c, fillOpacity: 0.85,
      }).bindPopup(`<div class="pop">
        <span class="tag" style="background:${c}">${esc(g.label)}</span>
        <h4>ประชาชนแจ้งน้ำท่วม</h4>
        <div class="sub">${p.s ? `แขวง${esc(p.s)} ` : ""}เขต${esc(p.d)}</div>
        <table><tr><td>แจ้งเมื่อ</td><td>${clock(at)} น. (${ago(at)})</td></tr></table>
        <div class="sub" style="margin:6px 0 0">แจ้งโดยประชาชนผ่าน Traffy Fondue ยังไม่ผ่านการตรวจสอบ ตำแหน่งโดยประมาณ</div>
      </div>`));
    }
  }

  function syncLayer() {
    const on = $("lyr-traffy").checked;
    if (on && !map.hasLayer(layer)) map.addLayer(layer);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }
  $("lyr-traffy").addEventListener("change", syncLayer);

  function render() {
    drawMap();
    syncLayer();
    const by = data.byState || {};
    const total = data.total || 0;
    $("tf-total").textContent = nf(total);
    $("tf-wait").textContent = nf(by.start || 0);
    $("tf-done").textContent = nf(by.finish || 0);

    const sum = ORDER.reduce((n, k) => n + (by[k] || 0), 0) || 1;
    $("tf-bar").innerHTML = ORDER.filter((k) => by[k])
      .map((k) => `<i style="flex:${by[k]};background:var(${GROUPS[k].css})" title="${GROUPS[k].label} ${by[k]}"></i>`).join("");
    $("tf-legend").innerHTML = ORDER.filter((k) => by[k])
      .map((k) => `<li><i class="dot" style="background:var(${GROUPS[k].css})"></i>${GROUPS[k].label} <b>${nf(by[k])}</b><span>${Math.round((by[k] / sum) * 100)}%</span></li>`).join("");

    const since = data.since ? new Date(data.since) : null;
    const until = data.until ? new Date(data.until) : null;
    const stale = until && Date.now() - until.getTime() > STALE_MS;
    $("tf-meta").innerHTML = until
      ? `เรื่องที่จัดหมวด "น้ำท่วม" ช่วง ${clock(since)}–${clock(until)} น. (${ago(until)})${stale ? " · ข้อมูลอาจไม่เป็นปัจจุบัน" : ""} · ผ่าน <a href="https://bangkok.traffy.in.th/" target="_blank" rel="noopener">Traffy Fondue</a>`
      : "ยังไม่มีข้อมูล";

    const max = Math.max(1, ...data.districts.map((d) => d.n));
    const top = data.districts.slice(0, 12);
    $("tf-dcount").textContent = data.districts.length ? `จาก ${data.districts.length} เขต` : "";
    $("tf-districts").innerHTML = top.map((d, i) => {
      const seg = ORDER.filter((k) => d[k]).map((k) => `<i style="width:${(d[k] / max) * 100}%;background:var(${GROUPS[k].css})"></i>`).join("");
      return `<li><button type="button" data-d="${esc(d.name)}" title="รอรับเรื่อง ${d.start || 0} · กำลังดำเนินการ ${d.inprogress || 0} · ส่งต่อ ${d.forward || 0} · เสร็จสิ้น ${d.finish || 0}">
        <span class="rank">${i + 1}</span><span class="pname">เขต${esc(d.name)}</span>
        <span class="bar">${seg}</span><span class="pnum">${nf(d.n)}${d.start ? ` · รอ ${nf(d.start)}` : ""}</span>
      </button></li>`;
    }).join("") || '<li class="op-empty">ยังไม่มีเรื่องแจ้งในช่วงนี้</li>';
  }

  $("tf-districts").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-d]");
    if (!b || !data) return;
    const pts = data.points.filter((p) => p.d === b.dataset.d).map((p) => [p.lat, p.lng]);
    if (!pts.length) return;
    $("lyr-traffy").checked = true;
    syncLayer();
    $("map").scrollIntoView({ behavior: "smooth", block: "center" });
    map.flyToBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 14, duration: 0.8 });
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => data && drawMap());
  load();
  setInterval(load, REFRESH_MS);
})();
