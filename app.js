// Static dashboard: reads data/*.json, renders news (filterable) + events.
const state = { news: [], events: [], cat: "all", region: "all", focus: "all", bank: "all", q: "" };

// own brand = Simplii (Ray's team); match on bank field or title
const isOwn = (n) => /simplii/i.test(`${n.bank || ""} ${n.title || ""}`);

const $ = (s) => document.querySelector(s);
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });

async function load() {
  const [news, events, meta] = await Promise.all([
    fetch("data/news.json").then((r) => r.json()).catch(() => []),
    fetch("data/events.json").then((r) => r.json()).catch(() => []),
    fetch("data/meta.json").then((r) => r.json()).catch(() => ({})),
  ]);
  state.news = news;
  state.events = events;

  const when = meta.updated ? new Date(meta.updated).toLocaleString("en-CA") : "—";
  $("#meta").innerHTML = `Updated ${esc(when)}<br>${news.length} news · ${events.length} events · AI ${meta.aiEnabled ? "on" : "off"}`;
  $("#footnote").innerHTML = meta.seed
    ? `<span class="seedbadge">SAMPLE DATA</span> Seeded for demo. Add an ANTHROPIC_API_KEY and run <code>npm run refresh</code> for live aggregation.`
    : "Live data from RSS + AI aggregation. Click any card for the source.";

  populateBanks();
  renderNews();
  renderEvents();
}

// fill the bank dropdown from banks present in the data (Simplii pinned first)
function populateBanks() {
  const banks = [...new Set(state.news.map((n) => n.bank).filter(Boolean))];
  banks.sort((a, b) => (/simplii/i.test(b) ? 1 : 0) - (/simplii/i.test(a) ? 1 : 0) || a.localeCompare(b));
  $("#bankFilter").innerHTML =
    `<option value="all">All banks</option>` +
    banks.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
}

function renderNews() {
  const q = state.q.toLowerCase();
  const items = state.news.filter((n) => {
    if (state.cat !== "all" && n.category !== state.cat) return false;
    if (state.region !== "all" && n.region !== state.region) return false;
    if (state.focus === "own" && !isOwn(n)) return false;
    if (state.focus === "competitors" && isOwn(n)) return false;
    if (state.bank !== "all" && (n.bank || "") !== state.bank) return false;
    if (q && !(`${n.title} ${n.summary} ${n.bank} ${n.source}`.toLowerCase().includes(q))) return false;
    return true;
  });
  $("#news").innerHTML = items.length
    ? items.map(card).join("")
    : `<div class="empty">No items match these filters.</div>`;
}

function card(n) {
  const cat = n.category || "news";
  return `<a class="card${isOwn(n) ? " own" : ""}" href="${esc(n.url)}" target="_blank" rel="noopener">
    <div class="row1">
      <span class="tag ${cat}">${cat === "news" ? "News" : cat}</span>
      ${n.bank ? `<span class="bank">${esc(n.bank)}</span>` : ""}
      <span class="date">${esc(fmtDate(n.date))}</span>
    </div>
    <h3>${esc(n.title)}</h3>
    ${n.summary ? `<p>${esc(n.summary)}</p>` : ""}
    <div class="src">${esc(n.source || "")}${n.region ? " · " + (n.region === "SA" ? "S. America" : "N. America") : ""}</div>
  </a>`;
}

function renderEvents() {
  const today = new Date().toISOString().slice(0, 10);
  const sorted = [...state.events].sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = sorted.filter((e) => (e.endDate || e.date) >= today);
  const recent = sorted.filter((e) => (e.endDate || e.date) < today).reverse();
  const section = (label, list, past) =>
    list.length ? `<div class="ev-group">${label}</div>` + list.map((e) => eventRow(e, past)).join("") : "";
  const html = section("Upcoming", upcoming, false) + section("Recent", recent, true);
  $("#events").innerHTML = html || `<div class="empty">No events yet.</div>`;
}

function eventRow(e, past) {
  const d = new Date(e.date + "T00:00:00");
  const range = e.endDate && e.endDate !== e.date
    ? `${fmtDate(e.date)} – ${fmtDate(e.endDate)}` : fmtDate(e.date);
  const inner = `<div class="event ${past ? "past" : ""}">
    <div class="when"><div class="m">${d.toLocaleDateString("en-CA", { month: "short" })}</div><div class="d">${d.getDate()}</div></div>
    <div class="body">
      <h3>${esc(e.name)}</h3>
      <p>${esc(range)}${e.location ? " · " + esc(e.location) : ""}</p>
      <span class="pill">${esc(e.type || "event")}</span>
      ${e.region === "SA" ? `<span class="pill">S. America</span>` : ""}
    </div>
  </div>`;
  return e.url ? `<a class="card" href="${esc(e.url)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="card">${inner}</div>`;
}

// filter wiring: chip groups (cat / focus / region) via data-group + data-value
$("#controls").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".chip[data-group]");
  if (!btn) return;
  const group = btn.dataset.group;
  btn.parentElement.querySelectorAll(`.chip[data-group="${group}"]`).forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  state[group] = btn.dataset.value;
  renderNews();
});
$("#bankFilter").addEventListener("change", (e) => { state.bank = e.target.value; renderNews(); });
$("#search").addEventListener("input", (e) => { state.q = e.target.value; renderNews(); });

// theme toggle (initial theme is set pre-paint by the inline script in <head>)
const toggle = $("#themeToggle");
function syncToggle() {
  const dark = (document.documentElement.getAttribute("data-theme") || "dark") !== "light";
  toggle.textContent = dark ? "☀" : "☾";
  toggle.title = dark ? "Switch to light" : "Switch to dark";
}
toggle.addEventListener("click", () => {
  const next = (document.documentElement.getAttribute("data-theme") === "light") ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
  syncToggle();
});
syncToggle();

load();
