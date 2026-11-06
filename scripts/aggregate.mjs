#!/usr/bin/env node
// Aggregates bank product news + events into data/news.json and data/events.json.
//
// Pipeline: RSS feeds (safety net, never misses what has a feed)
//   -> Claude classifies each item (category + region + relevance)   [needs ANTHROPIC_API_KEY]
//   -> Claude web-search pass finds offers + events RSS can't surface  [needs ANTHROPIC_API_KEY]
//   -> merge + dedupe with existing data -> write JSON.
//
// No API key? Falls back to RSS-only (items kept as category "news", unclassified).
// Run:  npm run refresh     Self-check:  npm run selftest

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const MODEL_FAST = "claude-haiku-5-5";     // cheap classification
const MODEL_SMART = "claude-sonnet-5-5";   // web-search discovery
const CATEGORIES = ["product", "offer", "service", "news"];

// --- pure helpers (covered by --selftest) ----------------------------------

const normTitle = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// strip a trailing " - Publisher" / " | Publisher" suffix (Google News adds these)
const cleanTitle = (s) => (s || "").replace(/\s[-–—|]\s[^-–—|]*$/, "").trim();

const idFor = (item) =>
  createHash("sha1").update(item.url || normTitle(item.title)).digest("hex").slice(0, 12);

const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

// Pull JSON out of an LLM reply that may wrap it in a ```json fence or narrate
// around it (web-search answers interleave citations). Prefers a fenced block,
// else the outermost {...} or [...]. Throws if nothing parses.
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const o = text.indexOf("{"), oc = text.lastIndexOf("}");
  const a = text.indexOf("["), ac = text.lastIndexOf("]");
  const obj = o !== -1 && oc > o ? text.slice(o, oc + 1) : null;
  const arr = a !== -1 && ac > a ? text.slice(a, ac + 1) : null;
  // try the outermost container first (whichever bracket opens earliest)
  if (arr && (o === -1 || a < o)) { candidates.push(arr); if (obj) candidates.push(obj); }
  else { if (obj) candidates.push(obj); if (arr) candidates.push(arr); }
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  throw new Error("no parseable JSON in model reply");
}

// Merge new items into existing, dedupe by cleaned title (collapses the same
// story arriving from Google News and the AI discovery pass), newest first,
// drop anything older than maxAgeDays, cap to limit. On a collision keep the
// best of each field: direct source URL, a real category, the longer summary.
const isDirect = (u) => u && !/news\.google\./.test(u);
function mergeNews(existing, incoming, { maxAgeDays, limit }) {
  const byKey = new Map();
  for (const it of [...existing, ...incoming]) {
    if (!it.title || !it.date) continue;
    if (daysAgo(it.date) > maxAgeDays) continue;
    const key = normTitle(cleanTitle(it.title)).slice(0, 80);
    if (!key) continue;
    const prev = byKey.get(key);
    const merged = prev
      ? {
          ...prev, ...it,
          category: it.category !== "news" ? it.category : prev.category,
          url: isDirect(it.url) ? it.url : (isDirect(prev.url) ? prev.url : (it.url || prev.url)),
          summary: (it.summary || "").length >= (prev.summary || "").length ? it.summary : prev.summary,
          bank: it.bank || prev.bank,
          region: it.region || prev.region,
        }
      : { ...it };
    merged.id = idFor(merged);
    byKey.set(key, merged);
  }
  return [...byKey.values()]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, limit);
}

function mergeEvents(existing, incoming) {
  const byKey = new Map();
  for (const ev of [...existing, ...incoming]) {
    if (!ev.name || !ev.date) continue;
    if (daysAgo(ev.date) > 90) continue; // keep upcoming + last ~90 days
    const key = normTitle(ev.name) + ev.date.slice(0, 7);
    byKey.set(key, { ...byKey.get(key), ...ev, id: idFor({ title: ev.name + ev.date }) });
  }
  return [...byKey.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
}

// --- I/O --------------------------------------------------------------------

async function loadJson(name, fallback) {
  try {
    return JSON.parse(await readFile(join(DATA, name), "utf8"));
  } catch {
    return fallback;
  }
}

async function fetchRss(feeds) {
  const { default: Parser } = await import("rss-parser");
  const parser = new Parser({
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BankRadar/1.0; +https://github.com/chaotic-joy/Bank-Radar)" },
  });
  const out = [];
  for (const { url, source } of feeds) {
    try {
      const feed = await parser.parseURL(url);
      for (const e of feed.items || []) {
        const date = e.isoDate || e.pubDate;
        if (!date) continue;
        out.push({
          title: (e.title || "").trim(),
          url: e.link,
          source,
          summary: (e.contentSnippet || e.content || "").replace(/\s+/g, " ").trim().slice(0, 400),
          date: new Date(date).toISOString().slice(0, 10),
          category: "news",
          bank: null,
          region: "NA",
        });
      }
      console.log(`  rss ok: ${source} (${feed.items?.length ?? 0})`);
    } catch (err) {
      console.warn(`  rss FAIL: ${source} — ${err.message}`);
    }
  }
  return out;
}

// --- AI passes (no-ops without a key) ---------------------------------------

function makeClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return import("@anthropic-ai/sdk").then((m) => new m.default());
}

const REAL_CATS = ["product", "offer", "service"]; // raw RSS "news" is noise; only these reach the board

// Classify RSS items in small batches (one big call returns unparseable JSON).
// Returns ONLY items a batch tagged product/offer/service; a failed batch is
// dropped, not kept-raw. No key -> nothing (unclassified RSS is just noise).
async function classify(client, items, cfg) {
  if (!client || items.length === 0) return [];
  const anthropic = await client;
  const BATCH = 40;
  const kept = [];
  let failed = 0;
  for (let start = 0; start < items.length; start += BATCH) {
    const slice = items.slice(start, start + BATCH);
    const batchInput = slice.map((it, i) => ({ i, title: it.title, summary: (it.summary || "").slice(0, 180), source: it.source }));
    const prompt =
      `You screen banking-industry headlines for a Simplii Financial product-team dashboard.\n` +
      `Relevant = a RETAIL/consumer bank or neobank in the Americas doing one of: ${cfg.topics.join("; ")}.\n` +
      `Banks of interest (not exhaustive): ${cfg.banks.join(", ")}.\n\n` +
      `For EACH item return JSON. DROP anything not about a specific bank's product, service, or offer ` +
      `(generic macro news, regulation think-pieces, crypto prices, sports/unrelated noise).\n` +
      `category: "product" (feature/platform/app launch), "offer" (rate/discount/bonus/promo), ` +
      `"service" (new service, fee change, access/eligibility), or null to drop.\n` +
      `region: "NA" or "SA". bank: the bank's short name or null.\n\n` +
      `Return ONLY a JSON array like [{"i":0,"category":"product","region":"NA","bank":"RBC"}].\n\n` +
      `ITEMS:\n${JSON.stringify(batchInput)}`;
    try {
      const resp = await anthropic.messages.create({
        model: MODEL_FAST,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      });
      const text = resp.content.map((c) => c.text || "").join("");
      for (const v of extractJson(text)) {
        const it = slice[v.i];
        if (!it || !REAL_CATS.includes(v.category)) continue;
        kept.push({ ...it, category: v.category, region: v.region || it.region, bank: v.bank || it.bank });
      }
    } catch (err) {
      failed++;
      console.warn(`  classify batch @${start} dropped: ${err.message}`);
    }
  }
  console.log(`  classified: kept ${kept.length}/${items.length}${failed ? ` (${failed} batches failed)` : ""}`);
  return kept;
}

// Web-search discovery: offers + events RSS won't have. Best-effort; never fatal.
async function discover(client, cfg) {
  const empty = { news: [], events: [] };
  if (!client) return empty;
  const anthropic = await client;
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    `Today is ${today}. Use web search to compile, for a Simplii Financial product-team dashboard, ` +
    `news and events about RETAIL banks and neobanks in the Americas. Banks of interest: ${cfg.banks.join(", ")}.\n\n` +
    `Find items from the LAST 60 DAYS in three buckets, plus upcoming events:\n` +
    `A) PRODUCT news — a bank launching a feature, platform update, or app capability (category "product").\n` +
    `B) OFFERS — welcome bonuses, savings/GIC rate promos, credit-card offers, discounts (category "offer").\n` +
    `C) SERVICE news — new services, fee changes, access/eligibility changes (category "service").\n` +
    `D) EVENTS — recent and UPCOMING banking/fintech conferences, keynotes, investor days, earnings calls in ` +
    `North AND South America (Money20/20, Finovate, bank investor days, Wealthsimple keynotes, LatAm fintech events).\n\n` +
    `Aim for 15-25 news items and 8-15 events. Only include items with a REAL source URL and a concrete date; ` +
    `prefer primary sources (the bank's own newsroom). Set region "NA" or "SA".\n\n` +
    `Output your final answer as a SINGLE JSON object in a \`\`\`json fenced code block, nothing after it:\n` +
    `\`\`\`json\n{"news":[{"title":"","summary":"","url":"","source":"","bank":"","category":"product|offer|service","region":"NA","date":"YYYY-MM-DD"}],` +
    `"events":[{"name":"","type":"conference|keynote|investor-call|earnings","organizer":"","url":"","location":"","region":"NA","date":"YYYY-MM-DD","endDate":"YYYY-MM-DD"}]}\n\`\`\``;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL_SMART,
      max_tokens: 8000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.map((c) => c.text || "").join("");
    const parsed = extractJson(text);
    const news = (parsed.news || [])
      .filter((n) => n.url && n.date)
      .map((n) => ({ region: "NA", bank: null, ...n, category: CATEGORIES.includes(n.category) ? n.category : "news" }));
    const events = (parsed.events || []).filter((e) => e.date && e.name);
    console.log(`  discovered: ${news.length} news, ${events.length} events`);
    return { news, events };
  } catch (err) {
    console.warn(`  discovery skipped: ${err.message}`);
    return empty;
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  const cfg = JSON.parse(await readFile(join(ROOT, "feeds.json"), "utf8"));
  const client = makeClient();

  console.log("Fetching RSS…");
  const rss = await fetchRss(cfg.feeds);

  // dedupe + keep the newest ~140 unique candidates before classifying (keeps
  // each batch small and the API cost bounded)
  const seen = new Set();
  const candidates = [];
  for (const it of rss.sort((a, b) => new Date(b.date) - new Date(a.date))) {
    const k = normTitle(cleanTitle(it.title)).slice(0, 80);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    candidates.push(it);
    if (candidates.length >= 140) break;
  }
  const classified = await classify(client, candidates, cfg);

  console.log("Discovery pass…");
  const found = await discover(client, cfg);

  const existingNews = await loadJson("news.json", []);
  const existingEvents = await loadJson("events.json", []);

  const news = mergeNews(existingNews, [...classified, ...found.news], {
    maxAgeDays: cfg.maxAgeDays ?? 120,
    limit: cfg.maxNewsItems ?? 150,
  }).filter((n) => REAL_CATS.includes(n.category)); // board shows only categorized items
  const events = mergeEvents(existingEvents, found.events);

  const stamp = { updated: new Date().toISOString() };
  await writeFile(join(DATA, "news.json"), JSON.stringify(news, null, 2));
  await writeFile(join(DATA, "events.json"), JSON.stringify(events, null, 2));
  await writeFile(join(DATA, "meta.json"), JSON.stringify({ ...stamp, news: news.length, events: events.length, aiEnabled: !!client }, null, 2));
  console.log(`Done. ${news.length} news, ${events.length} events. AI=${!!client}`);
}

// --- self-check -------------------------------------------------------------

function selftest() {
  const assert = (c, m) => { if (!c) throw new Error("FAIL: " + m); };

  // extractJson: fenced block wins over surrounding narration
  assert(extractJson('Here are results:\n```json\n{"a":1}\n```').a === 1, "extractJson reads fenced block");
  assert(extractJson('I searched the web. Final answer: {"news":[],"events":[]} done.').news.length === 0, "extractJson reads bare object amid prose");
  assert(extractJson('[{"i":0,"category":"product"}]')[0].category === "product", "extractJson reads bare array");
  let threw = false; try { extractJson("no json here"); } catch { threw = true; }
  assert(threw, "extractJson throws when nothing parses");

  // cross-source title dedupe: same story from Google News + discovery collapses,
  // keeping the direct URL, the real category, and the longer summary
  const merged = mergeNews([], [
    { title: "BMO launches AI agent - BMO Newsroom", url: "https://news.google.com/rss/articles/abc", date: "2026-11-01", category: "news", summary: "short" },
    { title: "BMO launches AI agent", url: "https://bmo.com/press/ai", date: "2026-11-01", category: "product", summary: "a much longer summary with detail" },
  ], { maxAgeDays: 999999, limit: 10 });
  assert(merged.length === 1, "cross-source title dedupe");
  assert(merged[0].url === "https://bmo.com/press/ai", "prefers direct url over google news redirect");
  assert(merged[0].category === "product", "prefers classified category");
  assert(/longer/.test(merged[0].summary), "keeps the longer summary");

  // age filter
  const old = mergeNews([], [{ title: "old", url: "u", date: "2000-01-01", category: "news" }], { maxAgeDays: 120, limit: 10 });
  assert(old.length === 0, "drops items older than maxAgeDays");

  // sort newest first
  const sorted = mergeNews([], [
    { title: "a", url: "a", date: "2026-10-01", category: "news" },
    { title: "b", url: "b", date: "2026-11-01", category: "news" },
  ], { maxAgeDays: 999999, limit: 10 });
  assert(sorted[0].title === "b", "sorts newest first");

  // events: dedupe same name+month, keep chronological
  const evs = mergeEvents([], [
    { name: "Money20/20 USA", date: "2026-12-20" },
    { name: "Money20/20 USA", date: "2026-12-21", location: "Las Vegas" },
    { name: "Finovate", date: "2026-12-01" },
  ]);
  assert(evs.length === 2, "event dedupe by name+month");
  assert(evs[0].name === "Finovate", "events sorted ascending");

  console.log("selftest OK");
}

if (process.argv.includes("--selftest")) selftest();
else main().catch((e) => { console.error(e); process.exit(1); });
