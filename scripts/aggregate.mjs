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

const idFor = (item) =>
  createHash("sha1").update(item.url || normTitle(item.title)).digest("hex").slice(0, 12);

const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

// Merge new items into existing, dedupe by url OR normalized title, newest first,
// drop anything older than maxAgeDays, cap to limit.
function mergeNews(existing, incoming, { maxAgeDays, limit }) {
  const byKey = new Map();
  for (const it of [...existing, ...incoming]) {
    if (!it.title || !it.date) continue;
    if (daysAgo(it.date) > maxAgeDays) continue;
    const key = it.url ? it.url.replace(/[?#].*$/, "") : normTitle(it.title);
    const prev = byKey.get(key);
    // keep the richer record (prefer one that has been classified)
    if (!prev || (prev.category === "news" && it.category !== "news")) {
      byKey.set(key, { ...prev, ...it, id: idFor(it) });
    }
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
  const parser = new Parser({ timeout: 15000 });
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

// Classify + filter RSS items. Returns a subset, tagged with category/bank/region.
async function classify(client, items, cfg) {
  if (!client || items.length === 0) return items;
  const anthropic = await client;
  const batchInput = items.map((it, i) => ({ i, title: it.title, summary: it.summary, source: it.source }));
  const prompt =
    `You screen banking-industry headlines for a Simplii Financial product-team dashboard.\n` +
    `Relevant = a RETAIL/consumer bank or neobank in the Americas doing one of: ${cfg.topics.join("; ")}.\n` +
    `Banks of interest (not exhaustive): ${cfg.banks.join(", ")}.\n\n` +
    `For EACH item below return JSON. Drop items that are not about a specific bank's product, ` +
    `service, or offer (e.g. generic macro news, regulation think-pieces, crypto price moves).\n` +
    `category: "product" (feature/platform/app launch), "offer" (rate/discount/bonus/promo), ` +
    `"service" (new service, fee change, access/eligibility), or null to drop.\n` +
    `region: "NA" or "SA". bank: the bank's short name or null.\n\n` +
    `Return ONLY a JSON array like [{"i":0,"category":"product","region":"NA","bank":"RBC"}].\n\n` +
    `ITEMS:\n${JSON.stringify(batchInput)}`;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL_FAST,
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.map((c) => c.text || "").join("");
    const verdicts = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    const kept = [];
    for (const v of verdicts) {
      const it = items[v.i];
      if (!it || !v.category || !CATEGORIES.includes(v.category)) continue;
      kept.push({ ...it, category: v.category, region: v.region || it.region, bank: v.bank || it.bank });
    }
    console.log(`  classified: kept ${kept.length}/${items.length}`);
    return kept;
  } catch (err) {
    console.warn(`  classify FAIL (keeping RSS unclassified): ${err.message}`);
    return items;
  }
}

// Web-search discovery: offers + events RSS won't have. Best-effort; never fatal.
async function discover(client, cfg) {
  const empty = { news: [], events: [] };
  if (!client) return empty;
  const anthropic = await client;
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    `Today is ${today}. Using web search, find for a Simplii Financial product-team dashboard:\n` +
    `1) Recent (last 60 days) PROMOTIONAL OFFERS from banks in the Americas — welcome bonuses, ` +
    `savings/GIC rate promos, credit-card offers. Banks of interest: ${cfg.banks.join(", ")}.\n` +
    `2) Recent and UPCOMING banking/fintech EVENTS in North AND South America — conferences, ` +
    `keynotes, investor days, earnings calls (e.g. Money20/20, Finovate, bank investor days, ` +
    `Wealthsimple keynotes, LatAm fintech events).\n\n` +
    `Return ONLY JSON: {"news":[{"title","summary","url","source","bank","category":"offer","region","date":"YYYY-MM-DD"}],` +
    `"events":[{"name","type":"conference|keynote|investor-call|earnings","organizer","url","location","region","date":"YYYY-MM-DD","endDate":"YYYY-MM-DD"}]}.\n` +
    `Only include items with a real source URL and a concrete date. Prefer primary sources.`;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL_SMART,
      max_tokens: 4000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.map((c) => c.text || "").join("");
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const news = (parsed.news || []).filter((n) => n.url && n.date).map((n) => ({ category: "offer", region: "NA", bank: null, ...n }));
    const events = (parsed.events || []).filter((e) => e.date && e.name);
    console.log(`  discovered: ${news.length} offers, ${events.length} events`);
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
  const classified = await classify(client, rss, cfg);

  console.log("Discovery pass…");
  const found = await discover(client, cfg);

  const existingNews = await loadJson("news.json", []);
  const existingEvents = await loadJson("events.json", []);

  const news = mergeNews(existingNews, [...classified, ...found.news], {
    maxAgeDays: cfg.maxAgeDays ?? 120,
    limit: cfg.maxNewsItems ?? 150,
  });
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

  // dedupe by url, prefer classified over "news"
  const merged = mergeNews(
    [{ title: "RBC launches X", url: "http://a/1", date: "2026-11-01", category: "news" }],
    [{ title: "RBC launches X!", url: "http://a/1?utm=1", date: "2026-11-01", category: "product" }],
    { maxAgeDays: 120, limit: 10 }
  );
  assert(merged.length === 1, "url dedupe (ignoring query string)");
  assert(merged[0].category === "product", "prefers classified record");

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
