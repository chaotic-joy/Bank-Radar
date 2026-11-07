// Static dashboard: reads data/*.json, renders news (filterable) + events.
const state = { news: [], events: [], cat: "all", region: "all", sector: "all", bank: "all", q: "", evType: "all" };

// event-type chip labels; unknown types fall back to a capitalized version
const EV_LABELS = { conference: "Conferences", keynote: "Keynotes", earnings: "Earnings calls", "investor-call": "Investor calls" };
const evLabel = (t) => EV_LABELS[t] || (t ? t[0].toUpperCase() + t.slice(1) : "Other");

// own brand = Simplii (Ray's team); match on bank field or title
const SECTOR_LABELS = { bank: "Bank", fintech: "Fintech", exchange: "Exchange" };

const OWN = "Simplii Financial";
const isOwn = (n) => /simplii/i.test(`${n.bank || ""} ${n.title || ""}`);

const $ = (s) => document.querySelector(s);
const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });

async function load() {
  const [news, events, meta, brief] = await Promise.all([
    fetch("data/news.json").then((r) => r.json()).catch(() => []),
    fetch("data/events.json").then((r) => r.json()).catch(() => []),
    fetch("data/meta.json").then((r) => r.json()).catch(() => ({})),
    fetch("data/summary.json").then((r) => r.json()).catch(() => null),
  ]);
  state.news = news;
  state.events = events;
  renderBrief(brief);

  const when = meta.updated ? new Date(meta.updated).toLocaleString("en-CA") : "—";
  $("#meta").innerHTML = `<span>Updated ${esc(when)}</span><span>${news.length} news · ${events.length} events · AI ${meta.aiEnabled ? "on" : "off"}</span>`;
  $("#footnote").innerHTML = meta.seed
    ? `<span class="seedbadge">SAMPLE DATA</span> Seeded for demo. Add an ANTHROPIC_API_KEY and run <code>npm run refresh</code> for live aggregation.`
    : "Live data from RSS + AI aggregation. Click any card for the source.";

  populateBanks();
  mirrorChips($("#controls"));
  populateEventTypes();
  renderNews();
  renderEvents();
  markTab();
  hideLoader();
}

// fade out the radar loading overlay; held for at least one sweep so a fast load doesn't just flash it
function hideLoader() {
  const el = $("#loader");
  setTimeout(() => {
    el.classList.add("done");
    setTimeout(() => el.remove(), 500);
  }, Math.max(0, 2400 - performance.now()));
}

// daily AI brief above the news stream (hidden if none was generated)
function renderBrief(b) {
  const el = $("#brief");
  const empty = !b || (!b.tldr && !(b.themes || []).length && !(b.highlights || []).length);
  $('#jumpMenu a[href="#brief"]').hidden = empty; // no brief today -> nothing to jump to
  if (empty) { el.innerHTML = ""; return; }
  const when = b.updated ? new Date(b.updated).toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) : "";
  const themes = (b.themes || []).map((t) => `<span class="theme">${esc(t)}</span>`).join("");
  const highlights = (b.highlights || [])
    .map((h) => `<li><span class="hl-head">${esc(h.headline)}</span>${h.why ? ` <span class="hl-why">${esc(h.why)}</span>` : ""}</li>`)
    .join("");
  el.innerHTML = `
    <div class="brief-head"><span class="label">Daily brief${when ? ` · ${esc(when)}` : ""}</span></div>
    ${b.tldr ? `<p class="brief-tldr">${esc(b.tldr)}</p>` : ""}
    ${themes ? `<div class="brief-themes">${themes}</div>` : ""}
    ${highlights ? `<ul class="brief-highlights">${highlights}</ul>` : ""}`;
}

// On narrow screens each chip group shows as a dropdown instead (styles.css swaps them).
// The chips stay the source of truth: a dropdown change clicks the matching chip, and
// the chip click handlers keep the dropdown in step.
const ALL_LABELS = { cat: "All types", region: "All regions", sector: "All sectors", evType: "All event types" };
const GROUP_NAMES = { cat: "type", region: "region", sector: "sector", evType: "event type" };
function mirrorChips(container) {
  container.querySelectorAll(".chip-select").forEach((s) => s.remove());
  const groups = new Set([...container.querySelectorAll(".chip[data-group]")].map((c) => c.dataset.group));
  for (const g of groups) {
    const chips = [...container.querySelectorAll(`.chip[data-group="${g}"]`)];
    const sel = document.createElement("select");
    sel.className = "select chip-select";
    sel.dataset.group = g;
    sel.setAttribute("aria-label", `Filter by ${GROUP_NAMES[g] || g}`);
    sel.innerHTML = chips.map((c) => {
      const label = c.dataset.value === "all" ? ALL_LABELS[g] || c.textContent : c.textContent;
      return `<option value="${esc(c.dataset.value)}"${c.classList.contains("active") ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
    sel.addEventListener("change", () => chips.find((c) => c.dataset.value === sel.value)?.click());
    chips[0].before(sel);
  }
}

// mark a chip active within its group and keep that group's dropdown in step
function activateChip(btn) {
  const group = btn.dataset.group;
  btn.parentElement.querySelectorAll(`.chip[data-group="${group}"]`).forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  const sel = btn.parentElement.querySelector(`.chip-select[data-group="${group}"]`);
  if (sel) sel.value = btn.dataset.value;
  state[group] = btn.dataset.value;
  return group;
}

// fill the company dropdown from companies present in the data, limited to the selected
// sector so the list stays short. Simplii Financial is always listed first under banks,
// even on a day with no Simplii news.
function populateBanks() {
  const banks = [...new Set(state.news.filter(inSector).map((n) => n.bank).filter((b) => b && !/simplii/i.test(b)))]
    .sort((a, b) => a.localeCompare(b));
  if (state.sector === "all" || state.sector === "bank") banks.unshift(OWN);
  $("#bankFilter").innerHTML =
    `<option value="all">All companies</option>` +
    banks.map((b) => `<option value="${esc(b)}"${b === state.bank ? " selected" : ""}>${esc(b)}</option>`).join("");
  if (!banks.includes(state.bank)) state.bank = "all";
}

// items without a sector predate it and were all bank news
const sectorOf = (n) => n.sector || "bank";
const inSector = (n) => state.sector === "all" || sectorOf(n) === state.sector;

function renderNews() {
  const q = state.q.toLowerCase();
  const items = state.news.filter((n) => {
    if (state.cat !== "all" && n.category !== state.cat) return false;
    if (state.region !== "all" && n.region !== state.region) return false;
    if (!inSector(n)) return false;
    // Simplii also matches stories that only mention it in the headline
    if (state.bank === OWN ? !isOwn(n) : state.bank !== "all" && (n.bank || "") !== state.bank) return false;
    if (q && !(`${n.title} ${n.titleOriginal || ""} ${n.summary} ${n.bank} ${n.source}`.toLowerCase().includes(q))) return false;
    return true;
  });
  $("#news").innerHTML = items.length
    ? items.map(card).join("")
    : `<div class="empty">No items match these filters.</div>`;
}

// "pt" -> "Portuguese"; falls back to the code where Intl.DisplayNames isn't available
const langName = (code) => { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code); } catch { return code; } };

function card(n) {
  const cat = n.category || "news";
  const translated = n.lang && n.lang !== "en" && n.titleOriginal;
  return `<a class="card${isOwn(n) ? " own" : ""}" href="${esc(n.url)}" target="_blank" rel="noopener">
    <div class="row1">
      <span class="tag ${cat}">${cat === "news" ? "News" : cat}</span>
      ${n.bank ? `<span class="bank">${esc(n.bank)}</span>` : ""}
      <span class="date">${esc(fmtDate(n.date))}</span>
    </div>
    <h3>${esc(n.title)}</h3>
    ${n.summary ? `<p>${esc(n.summary)}</p>` : ""}
    <div class="src">${esc(SECTOR_LABELS[sectorOf(n)] || "")} · ${esc(n.source || "")}${n.region ? " · " + (n.region === "SA" ? "S. America" : "N. America") : ""}${translated ? ` · <span title="Original: ${esc(n.titleOriginal)}">Translated from ${esc(langName(n.lang))}</span>` : ""}</div>
  </a>`;
}

// build event-type chips from the types actually present (most common first)
function populateEventTypes() {
  const counts = {};
  state.events.forEach((e) => { if (e.type) counts[e.type] = (counts[e.type] || 0) + 1; });
  const types = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  const chip = (v, label, active) =>
    `<button class="chip${active ? " active" : ""}" data-group="evType" data-value="${esc(v)}">${esc(label)}</button>`;
  $("#eventControls").innerHTML =
    chip("all", "All", true) + types.map((t) => chip(t, evLabel(t), false)).join("");
  mirrorChips($("#eventControls"));
}

function renderEvents() {
  const today = new Date().toISOString().slice(0, 10);
  const matched = state.evType === "all"
    ? state.events
    : state.events.filter((e) => (e.type || "") === state.evType);
  const sorted = [...matched].sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = sorted.filter((e) => (e.endDate || e.date) >= today);
  const recent = sorted.filter((e) => (e.endDate || e.date) < today).reverse();
  const section = (label, list, past) =>
    list.length ? `<div class="ev-group">${label}</div>` + list.map((e) => eventRow(e, past)).join("") : "";
  const html = section("Upcoming", upcoming, false) + section("Recent", recent, true);
  $("#events").innerHTML = html
    || `<div class="empty">${state.evType === "all" ? "No events yet." : "No events match this filter."}</div>`;
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

// filter wiring: chip groups (cat / sector / region) via data-group + data-value
$("#controls").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".chip[data-group]");
  if (!btn) return;
  if (activateChip(btn) === "sector") populateBanks();
  renderNews();
});
// event-type chips (same data-group/data-value pattern, scoped to the events column)
$("#eventControls").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".chip[data-group]");
  if (!btn) return;
  activateChip(btn);
  renderEvents();
});
$("#bankFilter").addEventListener("change", (e) => { state.bank = e.target.value; renderNews(); });
$("#search").addEventListener("input", (e) => { state.q = e.target.value; renderNews(); });

// theme toggle (initial theme is set pre-paint by the inline script in <head>)
const toggle = $("#themeToggle");
function syncToggle() {
  const dark = (document.documentElement.getAttribute("data-theme") || "dark") !== "light";
  toggle.setAttribute("aria-checked", String(dark)); // on = dark
  toggle.title = dark ? "Switch to light" : "Switch to dark";
}
toggle.addEventListener("click", () => {
  const next = (document.documentElement.getAttribute("data-theme") === "light") ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
  syncToggle();
});
syncToggle();

// mobile tab bar: highlight the section currently under the header
const TABS = [...document.querySelectorAll("#jumpMenu a")];
function markTab() {
  const line = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 80) + 40;
  let current = null;
  for (const a of TABS) {
    const el = !a.hidden && document.querySelector(a.getAttribute("href"));
    if (el && el.getBoundingClientRect().top <= line) current = a;
  }
  // at the very bottom the last section may never reach the line; it's the one on screen
  if (scrollY > 0 && innerHeight + scrollY >= document.documentElement.scrollHeight - 2) current = TABS.filter((a) => !a.hidden).at(-1);
  current ||= TABS.find((a) => !a.hidden);
  TABS.forEach((a) => a === current ? a.setAttribute("aria-current", "location") : a.removeAttribute("aria-current"));
}
addEventListener("scroll", markTab, { passive: true });
addEventListener("resize", markTab);

// the header is sticky, so jump targets land below it: keep --header-h at its current height
const topbar = $(".topbar");
new ResizeObserver(() => document.documentElement.style.setProperty("--header-h", topbar.offsetHeight + "px")).observe(topbar);

// money button: shows a random money emoji, bursts emoji confetti on click
const MONEY = ["💰", "💵", "💸", "🤑", "💴", "💶", "💷", "🪙", "🏦", "💎"];
const rand = (a, b) => a + Math.random() * (b - a);
const pickMoney = () => MONEY[Math.floor(Math.random() * MONEY.length)];
const moneyBtn = $("#moneyBtn");
moneyBtn.textContent = pickMoney();
// explosion physics: radial launch velocity, then gravity + air drag until off-screen
const GRAVITY = 1500; // px/s², tune for heavier/lighter feel
const DRAG = 0.6;     // fraction of velocity kept per second
let pieces = [], rafId = 0;
function step(now) {
  const t = Math.min((now - step.last) / 1000, 0.05); // clamp so a hidden tab doesn't teleport pieces
  step.last = now;
  const drag = DRAG ** t;
  pieces = pieces.filter((p) => {
    p.vy += GRAVITY * t;
    p.vx *= drag; p.vy *= drag;
    p.x += p.vx * t; p.y += p.vy * t; p.rot += p.spin * t;
    p.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) rotate(${p.rot}deg)`;
    if (p.y > innerHeight + 80) { p.el.remove(); return false; }
    return true;
  });
  rafId = pieces.length ? requestAnimationFrame(step) : 0;
}

// "ching": synthesized with Web Audio (no audio file). Two bell tones.
let audio;
function kaching() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audio ||= new AC(); // created on the first click, which browsers require before playing sound
  audio.resume();
  const t = audio.currentTime;
  const out = audio.createGain();
  out.gain.value = 0.25; // master volume
  out.connect(audio.destination);

  // "ching": bell = fundamental + inharmonic overtones, fast attack, long exponential ring-out
  const bell = (freq, at, dur) => {
    for (const [mult, vol] of [[1, 1], [2.76, 0.35], [5.4, 0.15]]) {
      const osc = audio.createOscillator(), g = audio.createGain();
      osc.frequency.value = freq * mult;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(g).connect(out);
      osc.start(at);
      osc.stop(at + dur);
    }
  };
  bell(1568, t, 0.9); // G6
  bell(2093, t + 0.06, 1.1); // C7
}

moneyBtn.addEventListener("click", () => {
  kaching();
  moneyBtn.textContent = pickMoney();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = moneyBtn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let i = 0; i < 112; i++) {
    const el = document.createElement("span");
    el.className = "money-piece";
    el.textContent = pickMoney();
    el.style.fontSize = Math.round(rand(32, 60)) + "px";
    document.body.appendChild(el);
    // ponytail: fan sideways/down since the button sits at the top edge; widen to full 2π if it moves
    const angle = rand(-0.2, 1.2) * Math.PI, speed = rand(450, 1200);
    pieces.push({
      el, x: cx, y: cy, rot: rand(0, 360), spin: rand(-540, 540),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - rand(150, 350), // upward kick so it pops before falling
    });
  }
  if (!rafId) { step.last = performance.now(); rafId = requestAnimationFrame(step); }
});

load();
