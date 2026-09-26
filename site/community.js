"use strict";
// Community posts: visitors share X / Facebook links; everyone sees them.
// Cards render as light previews first. The real X / Facebook embed (and its
// script) only loads when a card comes near the viewport, so the page stays fast.
(() => {
  const API = "https://thai-flood-watch-api.vercel.app/api";
  const PAGE = 12;
  const POLL_MS = 60 * 1000;
  const COL_MIN = 340;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : darkQuery.matches;
  };

  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "เมื่อสักครู่";
    if (m < 60) return `${m} นาทีที่แล้ว`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ชม.ที่แล้ว`;
    return `${Math.round(h / 24)} วันที่แล้ว`;
  }

  const ICONS = {
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 1.2h3.7l-8 9.2L24 22.8h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L0 1.2h7.6l5.2 6.9 6.1-6.9Zm-1.3 19.4h2L6.5 3.3H4.3l13.3 17.3Z"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 22v-8.2h2.8l.4-3.2h-3.2V8.5c0-.9.3-1.6 1.6-1.6h1.7V4.1c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.4H7.3v3.2h2.8V22h3.4Z"/></svg>',
  };

  const state = {
    posts: [],
    filter: "all",
    shown: PAGE,
    pending: null,
    admin: false,
    adminKey: store.get("flood-admin-key") || "",
  };

  /* ---------- lazy platform scripts ---------- */

  const scripts = {};
  function loadScript(src, ready) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => resolve(ready());
        s.onerror = () => reject(new Error("script"));
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }

  const loadX = () => loadScript("https://platform.twitter.com/widgets.js", () => window.twttr);

  function loadFacebook() {
    if (!scripts.fb) {
      scripts.fb = new Promise((resolve, reject) => {
        window.fbAsyncInit = () => {
          window.FB.init({ xfbml: false, version: "v21.0" });
          resolve(window.FB);
        };
        const s = document.createElement("script");
        s.src = "https://connect.facebook.net/th_TH/sdk.js";
        s.async = true;
        s.crossOrigin = "anonymous";
        s.onerror = () => reject(new Error("script"));
        document.head.appendChild(s);
      });
    }
    return scripts.fb;
  }

  async function upgrade(box) {
    const post = state.posts.find((p) => p.id === box.dataset.id);
    if (!post) return;
    const facade = box.querySelector(".facade");
    const slot = document.createElement("div");
    box.appendChild(slot);
    try {
      if (post.platform === "x") {
        const twttr = await loadX();
        const el = await twttr.widgets.createTweet(post.postId, slot, {
          theme: isDark() ? "dark" : "light", dnt: true, lang: "th", conversation: "none", align: "center",
        });
        if (!el) throw new Error("unavailable");
        facade.remove();
      } else {
        const FB = await loadFacebook();
        const width = Math.max(320, Math.min(750, Math.floor(box.clientWidth)));
        slot.innerHTML = `<div class="${post.kind === "video" ? "fb-video" : "fb-post"}" data-href="${esc(post.url)}" data-width="${width}" data-show-text="true" data-lazy="true"></div>`;
        FB.XFBML.parse(slot);
        // Facebook renders nothing for posts it will not embed (private groups,
        // deleted posts); keep the preview card in that case.
        const ok = await waitFor(() => {
          const f = slot.querySelector("iframe");
          return f && f.offsetHeight > 60;
        }, 10000);
        if (!ok) throw new Error("unavailable");
        facade.remove();
      }
    } catch {
      slot.remove();
      facade.classList.add("done");
      facade.insertAdjacentHTML("beforeend", '<span class="hint" style="margin:0">แสดงตัวอย่างไม่ได้ กด "เปิด" เพื่อดูโพสต์ต้นฉบับ</span>');
    }
  }

  function waitFor(test, timeout) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function tick() {
        if (test()) return resolve(true);
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(tick, 300);
      })();
    });
  }

  const observer = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer.unobserve(e.target);
          upgrade(e.target);
        }
      }, { rootMargin: "400px 0px" })
    : null;

  /* ---------- rendering ---------- */

  function cardHtml(p) {
    const who = p.platform === "x"
      ? `<b>${esc(p.authorName || p.author)}</b><span>@${esc(p.author)} · ${ago(p.created)}</span>`
      : `<b>${esc(p.author || (p.kind === "video" ? "วิดีโอ Facebook" : "โพสต์ Facebook"))}</b><span>Facebook · ${ago(p.created)}</span>`;
    const preview = p.text
      ? `<p>${esc(p.text)}</p>`
      : '<div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div>';
    const admin = state.admin
      ? `<button type="button" class="admin-btn" data-act="toggle">${p.hidden ? "แสดง" : "ซ่อน"}</button>
         <button type="button" class="admin-btn" data-act="delete">ลบ</button>
         ${p.reports ? `<span class="hint" style="margin:0">รายงาน ${p.reports}</span>` : ""}`
      : "";
    return `<article class="cpost${p.hidden ? " is-hidden" : ""}" data-id="${esc(p.id)}">
      <header class="cpost-head">
        <span class="pf pf-${p.platform}">${ICONS[p.platform]}</span>
        <span class="cpost-who">${who}</span>
      </header>
      ${p.note ? `<p class="cpost-note">${esc(p.note)}</p>` : ""}
      <div class="cpost-embed" data-id="${esc(p.id)}">
        <div class="facade">${preview}<span class="loading">กำลังโหลดโพสต์…</span></div>
      </div>
      <footer class="cpost-foot">
        <a href="${esc(p.url)}" target="_blank" rel="noopener">เปิดใน ${p.platform === "x" ? "X" : "Facebook"} ↗</a>
        <span class="spacer"></span>
        ${admin}
        <button type="button" data-act="report" title="แจ้งโพสต์ที่ไม่เกี่ยวข้อง สแปม หรือข้อมูลเท็จ">รายงาน</button>
      </footer>
    </article>`;
  }

  function visiblePosts() {
    return state.posts.filter((p) => state.filter === "all" || p.platform === state.filter);
  }

  function columnCount() {
    const w = $("cposts").clientWidth || window.innerWidth;
    return Math.max(1, Math.min(4, Math.floor((w + 14) / (COL_MIN + 14))));
  }

  // Masonry: each card goes into the currently shortest column and stays
  // there, so cards don't jump around when embeds finish loading.
  function render() {
    const wrap = $("cposts");
    const list = visiblePosts();
    for (const k of ["all", "x", "facebook"]) {
      const n = k === "all" ? state.posts.length : state.posts.filter((p) => p.platform === k).length;
      $(`c-${k}`).textContent = n || "";
    }
    observer?.disconnect();
    if (!list.length) {
      wrap.innerHTML = `<div class="cposts-empty">${state.posts.length ? "ยังไม่มีโพสต์จากแพลตฟอร์มนี้" : "ยังไม่มีโพสต์ เป็นคนแรกที่แชร์สถานการณ์ในพื้นที่ของคุณ"}</div>`;
      $("community-more").hidden = true;
      return;
    }
    const n = columnCount();
    wrap.dataset.cols = n;
    wrap.innerHTML = Array.from({ length: n }, () => '<div class="ccol"></div>').join("");
    const cols = [...wrap.children];
    for (const p of list.slice(0, state.shown)) appendCard(cols, p);
    $("community-more").hidden = list.length <= state.shown;
  }

  function appendCard(cols, p) {
    const col = cols.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
    col.insertAdjacentHTML("beforeend", cardHtml(p));
    const box = col.lastElementChild.querySelector(".cpost-embed");
    if (observer) observer.observe(box); else upgrade(box);
  }

  function showMore() {
    const cols = [...$("cposts").querySelectorAll(".ccol")];
    const list = visiblePosts();
    for (const p of list.slice(state.shown, state.shown + PAGE)) appendCard(cols, p);
    state.shown += PAGE;
    $("community-more").hidden = list.length <= state.shown;
  }

  /* ---------- data ---------- */

  function headers(extra = {}) {
    return state.admin ? { ...extra, "X-Admin-Key": state.adminKey } : extra;
  }

  async function fetchPosts() {
    const res = await fetch(`${API}/posts`, { headers: headers(), cache: state.admin ? "no-store" : "default" });
    if (res.status === 401) throw Object.assign(new Error("key"), { status: 401 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).posts || [];
  }

  async function initialLoad() {
    try {
      state.posts = await fetchPosts();
    } catch {
      $("cposts").innerHTML = '<div class="cposts-empty">โหลดโพสต์จากชุมชนไม่สำเร็จ จะลองใหม่อัตโนมัติ</div>';
      return;
    }
    render();
  }

  async function poll() {
    if (document.hidden) return;
    try {
      const fresh = await fetchPosts();
      const known = new Set(state.posts.map((p) => p.id));
      const added = fresh.filter((p) => !known.has(p.id));
      if (!state.posts.length) {
        state.posts = fresh;
        render();
        return;
      }
      if (!added.length) return;
      state.pending = fresh;
      const pill = $("community-new");
      pill.textContent = `มีโพสต์ใหม่ ${added.length} รายการ · แสดง`;
      pill.hidden = false;
    } catch { /* try again next tick */ }
  }

  $("community-new").addEventListener("click", () => {
    if (state.pending) state.posts = state.pending;
    state.pending = null;
    $("community-new").hidden = true;
    state.shown = PAGE;
    render();
    $("community").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  /* ---------- sharing ---------- */

  function setMsg(text, kind = "") {
    const el = $("share-msg");
    el.textContent = text;
    el.className = `share-msg ${kind}`;
  }

  $("share-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = $("share-url").value.trim();
    if (!url) {
      setMsg("วางลิงก์โพสต์ X หรือ Facebook ก่อนกดแชร์", "err");
      $("share-url").focus();
      return;
    }
    const btn = $("share-btn");
    btn.disabled = true;
    setMsg("กำลังตรวจสอบลิงก์…");
    try {
      const res = await fetch(`${API}/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, note: $("share-note").value, website: $("share-website").value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "แชร์ไม่สำเร็จ กรุณาลองใหม่");
      state.posts = [body.post, ...state.posts.filter((p) => p.id !== body.post.id)];
      state.filter = "all";
      syncFilterButtons();
      render();
      $("share-form").reset();
      setMsg("แชร์แล้ว โพสต์ของคุณแสดงด้านล่าง ขอบคุณที่ช่วยส่งต่อข้อมูล", "ok");
    } catch (err) {
      setMsg(err.message, "err");
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- card actions ---------- */

  $("cposts").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const card = btn.closest(".cpost");
    const id = card.dataset.id;
    const act = btn.dataset.act;

    // Destructive actions ask once inline (dialogs are unreliable)
    if ((act === "report" || act === "delete") && btn.dataset.confirm !== "1") {
      btn.dataset.confirm = "1";
      btn.dataset.label = btn.textContent;
      btn.textContent = act === "report" ? "ยืนยันรายงาน?" : "ยืนยันลบ?";
      setTimeout(() => {
        if (btn.isConnected && btn.dataset.confirm === "1") {
          btn.dataset.confirm = "";
          btn.textContent = btn.dataset.label;
        }
      }, 4000);
      return;
    }

    btn.disabled = true;
    try {
      let res;
      if (act === "report") {
        res = await fetch(`${API}/report`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
        });
      } else if (act === "delete") {
        res = await fetch(`${API}/posts?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: headers() });
      } else {
        const post = state.posts.find((p) => p.id === id);
        res = await fetch(`${API}/posts`, {
          method: "PATCH", headers: headers({ "Content-Type": "application/json" }),
          body: JSON.stringify({ id, hidden: !post?.hidden }),
        });
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "ทำรายการไม่สำเร็จ");

      if (act === "report") {
        btn.textContent = "รายงานแล้ว ขอบคุณ";
        if (body.hidden && !state.admin) {
          state.posts = state.posts.filter((p) => p.id !== id);
          card.style.transition = "opacity .3s";
          card.style.opacity = "0";
          setTimeout(() => card.remove(), 300);
        }
      } else if (act === "delete") {
        state.posts = state.posts.filter((p) => p.id !== id);
        card.remove();
      } else {
        const i = state.posts.findIndex((p) => p.id === id);
        if (i >= 0) state.posts[i] = body.post;
        card.classList.toggle("is-hidden", body.post.hidden);
        btn.textContent = body.post.hidden ? "แสดง" : "ซ่อน";
        btn.disabled = false;
      }
    } catch (err) {
      btn.textContent = err.message;
    }
  });

  /* ---------- filter, paging, resize ---------- */

  function syncFilterButtons() {
    for (const b of $("community-filter").querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.filter === state.filter));
    }
  }
  $("community-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b || b.dataset.filter === state.filter) return;
    state.filter = b.dataset.filter;
    state.shown = PAGE;
    syncFilterButtons();
    render();
  });
  $("community-more").addEventListener("click", showMore);

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (String(columnCount()) !== $("cposts").dataset.cols && state.posts.length) render();
    }, 250);
  });

  /* ---------- admin (open the page with #admin) ---------- */

  async function enterAdmin(key) {
    state.admin = true;
    state.adminKey = key;
    try {
      state.posts = await fetchPosts();
      store.set("flood-admin-key", key);
      $("admin-state").textContent = "โหมดผู้ดูแล: เห็นโพสต์ที่ถูกซ่อน ซ่อน/แสดง/ลบได้";
      render();
    } catch (err) {
      state.admin = false;
      $("admin-state").textContent = err.status === 401 ? "รหัสไม่ถูกต้อง" : "เชื่อมต่อไม่สำเร็จ";
    }
  }

  if (location.hash === "#admin") {
    $("admin-bar").hidden = false;
    $("admin-key").value = state.adminKey;
    $("admin-apply").addEventListener("click", () => enterAdmin($("admin-key").value.trim()));
    if (state.adminKey) enterAdmin(state.adminKey);
    else initialLoad();
  } else {
    initialLoad();
  }
  setInterval(poll, POLL_MS);
})();
