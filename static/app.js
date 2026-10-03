const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const img = (id) => (id ? `/api/img/${id}` : "");
const hours = (s) => (s / 3600).toFixed(1);
const gb = (b) => (b / 1e9 >= 1000 ? `${(b / 1e12).toFixed(2)} TB` : `${Math.round(b / 1e9)} GB`);
const dur = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const ep = (it) => (it.season != null && it.episode != null ? `S${String(it.season).padStart(2, "0")}E${String(it.episode).padStart(2, "0")}` : "");
const label = (it) => (it.series_name ? `${it.series_name} · ${ep(it) ? ep(it) + " " : ""}${it.item_name}` : `${it.item_name}${it.year ? ` (${it.year})` : ""}`);
const poster = (it) => img(it.series_id || it.item_id);

function ago(iso) {
  if (!iso) return "";
  const t = new Date(iso.includes("T") || iso.endsWith("Z") ? iso : iso.replace(" ", "T"));
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return t.toLocaleDateString();
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, credentials: "same-origin", ...opts });
  if (r.status === 401 && path !== "/api/login") { showLogin(); throw new Error("unauthorized"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

let me = null, tab = "now", timer = null;

function showLogin() { $("#app").hidden = true; $("#login").hidden = false; clearInterval(timer); }
async function boot() {
  try { me = await api("/api/me"); } catch { return showLogin(); }
  $("#login").hidden = true; $("#app").hidden = false;
  $("#me").textContent = me.name;
  const saved = (() => { try { return localStorage.getItem("tab"); } catch { return null; } })();
  switchTab(saved && $(`#tabs [data-tab="${saved}"]`) ? saved : "now");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#login-error").hidden = true;
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ username: f.get("username"), password: f.get("password") || "" }) });
    e.target.reset(); boot();
  } catch (err) { $("#login-error").textContent = err.message; $("#login-error").hidden = false; }
});
$("#logout").addEventListener("click", async (e) => { e.preventDefault(); await api("/api/logout", { method: "POST" }); showLogin(); });

$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) switchTab(b.dataset.tab); });
function switchTab(name) {
  tab = name;
  try { localStorage.setItem("tab", name); } catch {}
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  clearInterval(timer);
  const load = loaders[name];
  load();
  const every = { now: 10000, system: 15000, board: 60000, history: 60000 }[name];
  if (every) timer = setInterval(load, every);
}

const loaders = {
  async now() {
    const [now, board] = await Promise.all([api("/api/now"), api("/api/leaderboard")]);
    $("#now").innerHTML = now.length ? now.map((n) => {
      const direct = n.method === "DirectPlay" || n.method === "DirectStream";
      return `<div class="card now-item">
        <img src="${poster(n)}" alt="" loading="lazy">
        <div class="now-body">
          <div class="title">${esc(label(n))}</div>
          <div class="muted small"><span class="user">${esc(n.user)}</span> on ${esc(n.device || n.client)}</div>
          <div style="margin-top:.35rem">
            ${n.paused ? '<span class="tag warn">paused</span>' : '<span class="tag good">playing</span>'}
            <span class="tag ${direct ? "good" : "warn"}">${esc(n.method === "Transcode" ? `transcode${n.hw_accel ? " · " + n.hw_accel : ""}` : n.method)}</span>
            ${n.transcode_reasons.map((r) => `<span class="tag">${esc(r)}</span>`).join("")}
          </div>
          ${n.progress != null ? `<div class="progress"><i style="width:${n.progress}%"></i></div>` : ""}
        </div></div>`;
    }).join("") : `<div class="empty">Nothing playing right now.</div>`;
    $("#recent").innerHTML = board.recent.length ? board.recent.slice(0, 12).map((c) => `
      <div class="feed-row"><span class="user">${esc(c.user_name)}</span>
      <span>finished ${esc(c.series_name ? `${c.series_name} · ${c.item_name}` : c.item_name)}</span>
      <span class="when">${dur(c.runtime_s)} · ${ago(c.at)}</span></div>`).join("")
      : `<div class="empty">Nothing finished since tracking started.</div>`;
  },

  async board() {
    const b = await api("/api/leaderboard");
    $("#board-since").textContent = b.since ? `· since ${new Date(b.since).toLocaleString()}` : "";
    const render = (rows) => {
      if (!rows.length) return `<div class="empty">No finished watches yet.</div>`;
      const max = rows[0].seconds || 1;
      return rows.map((r, i) => `<div class="rank ${i === 0 ? "first" : ""}">
        <span class="pos">${i + 1}</span>
        <div><div class="user">${esc(r.user_name)}</div><div class="muted small">${r.movies} movies · ${r.episodes} episodes</div></div>
        <span class="hours">${hours(r.seconds)}h</span>
        <div class="progress bar"><i style="width:${(100 * r.seconds) / max}%"></i></div></div>`).join("");
    };
    $("#board-all").innerHTML = render(b.all_time);
    $("#board-week").innerHTML = render(b.week);
    $("#top-shows").innerHTML = b.top_shows.length ? b.top_shows.map((s) => `
      <div class="feed-row"><span class="user">${esc(s.user_name)}</span><span>${esc(s.series_name)}</span>
      <span class="when">${s.episodes} eps · ${hours(s.seconds)}h</span></div>`).join("") : `<div class="empty">No shows yet.</div>`;
  },

  async ratings() {
    const [toRate, ratings] = await Promise.all([api("/api/to-rate"), api("/api/ratings")]);
    ratingsCache = ratings;
    $("#to-rate").innerHTML = toRate.length ? toRate.map(posterCard).join("")
      : `<div class="empty" style="grid-column:1/-1">You're all caught up. Search below to rate anything else.</div>`;
    $("#ratings").innerHTML = ratings.length ? ratings.map((it) => `
      <div class="card review-item">
        <img src="${poster(it)}" alt="" loading="lazy" data-rate='${esc(JSON.stringify(it))}'>
        <div class="body">
          <span class="avg">${it.avg}<small>/10</small></span>
          <div class="title">${esc(it.series_name && it.item_type === "Episode" ? `${it.series_name} · ${it.item_name}` : it.item_name)}</div>
          <div class="muted small">${esc(it.item_type === "Series" ? "Show" : it.item_type)}${it.year ? ` · ${it.year}` : ""} · ${it.reviews.length} review${it.reviews.length > 1 ? "s" : ""}</div>
          ${it.reviews.map((r) => `<div class="review">
            <span class="user">${esc(r.user_name)}</span> <span class="score">${r.score}/10</span>
            <span class="muted small"> · ${ago(r.updated_at)}</span>
            <div class="note">${esc(r.note)}</div></div>`).join("")}
        </div></div>`).join("") : `<div class="empty">No reviews yet. Be the first.</div>`;
  },

  async history() {
    const h = await api("/api/history");
    $("#history").innerHTML = `<thead><tr><th>When</th><th>Who</th><th>What</th><th>Watched</th><th>How</th><th>Device</th></tr></thead><tbody>${
      h.length ? h.map((r) => `<tr><td>${esc(ago(r.at))}</td><td class="user">${esc(r.user)}</td><td class="name">${esc(r.name)}</td>
        <td>${dur(r.seconds)}</td><td><span class="tag ${/transcode/i.test(r.method) ? "warn" : "good"}">${esc(r.method)}</span></td>
        <td class="muted">${esc(r.device || r.client)}</td></tr>`).join("")
      : `<tr><td colspan="6" class="muted">No playback recorded yet.</td></tr>`}</tbody>`;
  },

  async system() {
    const s = await api("/api/system");
    const mem = s.memory, memUsed = mem.total - mem.available;
    const disk = (d) => {
      const pct = (100 * d.used) / d.total;
      return `<div class="card stat"><div class="label">${esc(d.label)} storage</div>
        <div class="value">${gb(d.free)} <span class="muted small">free</span></div>
        <div class="progress"><i style="width:${pct}%;${pct > 90 ? "background:var(--bad)" : ""}"></i></div>
        <div class="sub" style="margin-top:.35rem">${gb(d.used)} of ${gb(d.total)} used · ${
          d.days_to_full != null ? `full in ~${d.days_to_full} days` : "growth estimate after a few hours of data"}</div></div>`;
    };
    const up = Math.floor(s.uptime / 86400);
    const temps = Object.entries(s.temps).map(([k, v]) => `${k} ${Math.round(v)}°C`).join(" · ") || "n/a";
    const down = s.containers.filter((c) => c.state !== "running");
    $("#system").innerHTML = `
      <h2>Storage</h2><div class="sys-grid">${s.disks.map(disk).join("")}</div>
      <h2>Host</h2><div class="sys-grid">
        <div class="card stat"><div class="label">CPU</div><div class="value">${s.cpu ?? "…"}%</div>
          <div class="sub">${s.cores} cores · load ${s.load.map((l) => l.toFixed(2)).join(" / ")}</div></div>
        <div class="card stat"><div class="label">Memory</div><div class="value">${gb(memUsed)}</div>
          <div class="progress"><i style="width:${(100 * memUsed) / mem.total}%"></i></div><div class="sub" style="margin-top:.35rem">of ${gb(mem.total)}</div></div>
        <div class="card stat"><div class="label">Temperatures</div><div class="value" style="font-size:1.15rem">${esc(temps)}</div>
          <div class="sub">up ${up}d ${Math.floor((s.uptime % 86400) / 3600)}h</div></div>
        <div class="card stat"><div class="label">Library</div><div class="value">${s.library.MovieCount} <span class="muted small">movies</span></div>
          <div class="sub">${s.library.SeriesCount} shows · ${s.library.EpisodeCount} episodes</div></div>
      </div>
      <h2>Downloads</h2>
      ${s.queue.length ? `<div class="feed">${s.queue.map((q) => `<div class="feed-row">
        <span class="tag">${esc(q.app)}</span><span class="title" style="flex:1">${esc(q.title)}</span>
        <span class="when">${q.warning ? '<span class="tag warn">needs attention</span>' : ""}${esc(q.status)} · ${q.progress}%${q.timeleft ? ` · ${esc(q.timeleft)}` : ""}</span></div>`).join("")}</div>`
        : `<div class="empty">Download queue is empty.</div>`}
      <h2>Containers ${down.length ? `<span class="tag bad">${down.length} down</span>` : `<span class="tag good">all running</span>`}</h2>
      <div class="containers">${s.containers.map((c) => `<div class="ctr"><span class="dot ${c.state === "running" ? (/unhealthy/.test(c.status) ? "warn" : "") : "down"}"></span>
        <span>${esc(c.name)}</span><span class="muted small" style="margin-left:auto">${esc(c.status.replace(/^Up /, ""))}</span></div>`).join("")}</div>`;
  },
};

// ------------------------------------------------------------------ rating
let ratingsCache = [];
const posterCard = (it) => `<button class="poster" data-rate='${esc(JSON.stringify(it))}'>
  <img src="${poster(it)}" alt="" loading="lazy"><div class="cap">${esc(it.series_name || it.item_name)}${
  it.series_name && it.item_type === "Episode" ? `<div class="muted">${esc(ep(it))}</div>` : it.year ? ` <span class="muted">(${it.year})</span>` : ""}</div></button>`;

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-rate]");
  if (el) openRate(JSON.parse(el.dataset.rate));
});

let rateState = null;
function openRate(it) {
  const targets = [{ id: it.item_id, label: it.item_type === "Episode" ? `This episode (${ep(it)})` : it.item_type === "Series" ? "Whole show" : "This movie" }];
  if (it.item_type === "Episode" && it.series_id) targets.unshift({ id: it.series_id, label: `Whole show: ${it.series_name}` });
  rateState = { it, targets, target: targets[0].id, score: null };
  $("#rate-img").src = poster(it);
  $("#rate-title").textContent = label(it);
  renderRate();
  $("#rate-dialog").showModal();
}
function renderRate() {
  const { targets, target } = rateState;
  const existing = ratingsCache.find((r) => r.item_id === target)?.reviews.find((r) => r.user_id === me.id);
  if (rateState.loadedFor !== target) {
    rateState.loadedFor = target;
    rateState.score = existing?.score ?? null;
    $("#rate-note").value = existing?.note ?? "";
  }
  $("#rate-target").innerHTML = targets.length > 1 ? targets.map((t) => `<button type="button" data-target="${t.id}" class="${t.id === target ? "on" : ""}">${esc(t.label)}</button>`).join("") : `<span class="muted small">${esc(targets[0].label)}</span>`;
  $("#rate-scores").innerHTML = Array.from({ length: 10 }, (_, i) => `<button type="button" data-score="${i + 1}" class="${rateState.score === i + 1 ? "on" : ""}">${i + 1}</button>`).join("");
  $("#rate-delete").hidden = !existing;
  $("#rate-save").disabled = !rateState.score;
}
$("#rate-target").addEventListener("click", (e) => { const b = e.target.closest("[data-target]"); if (b) { rateState.target = b.dataset.target; renderRate(); } });
$("#rate-scores").addEventListener("click", (e) => { const b = e.target.closest("[data-score]"); if (b) { rateState.score = +b.dataset.score; renderRate(); } });
$("#rate-cancel").addEventListener("click", () => $("#rate-dialog").close());
$("#rate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!rateState.score) return;
  await api("/api/ratings", { method: "POST", body: JSON.stringify({ item_id: rateState.target, score: rateState.score, note: $("#rate-note").value }) });
  $("#rate-dialog").close(); loaders.ratings();
});
$("#rate-delete").addEventListener("click", async () => {
  await api(`/api/ratings/${rateState.target}`, { method: "DELETE" });
  $("#rate-dialog").close(); loaders.ratings();
});

let searchT = null;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchT);
  const q = e.target.value.trim();
  if (q.length < 2) { $("#search-results").innerHTML = ""; return; }
  searchT = setTimeout(async () => {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    $("#search-results").innerHTML = res.length ? res.map(posterCard).join("") : `<div class="muted small">No matches.</div>`;
  }, 250);
});

boot();
