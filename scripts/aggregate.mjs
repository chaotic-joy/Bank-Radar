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
// Translated items are keyed by their ORIGINAL title, so the same story arriving
// again untranslated from its RSS feed merges into it and keeps the English text.
const isDirect = (u) => u && !/news\.google\./.test(u);
function mergeNews(existing, incoming, { maxAgeDays, limit }) {
  const byKey = new Map();
  for (const it of [...existing, ...incoming]) {
    if (!it.title || !it.date) continue;
    if (daysAgo(it.date) > maxAgeDays) continue;
    const key = normTitle(cleanTitle(it.titleOriginal || it.title)).slice(0, 80);
    if (!key) continue;
    const prev = byKey.get(key);
    const keepXlat = prev?.lang && !it.lang; // already translated; don't let a raw re-fetch undo it
    const merged = prev
      ? {
          ...prev, ...it,
          category: it.category !== "news" ? it.category : prev.category,
          url: isDirect(it.url) ? it.url : (isDirect(prev.url) ? prev.url : (it.url || prev.url)),
          summary: keepXlat ? prev.summary
            : (it.summary || "").length >= (prev.summary || "").length ? it.summary : prev.summary,
          bank: it.bank || prev.bank,
          region: it.region || prev.region,
          ...(keepXlat && { title: prev.title, titleOriginal: prev.titleOriginal, lang: prev.lang }),
        }
      : { ...it };
    merged.id = idFor(merged);
    byKey.set(key, merged);
  }
  return [...byKey.values()]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, limit);
}

// Apply one translation result to an item. Always records the language (so the
// item is never sent again); for non-English items swaps in the English title
// and summary and keeps the original title for search and dedupe.
function applyTranslation(it, r) {
  const lang = String(r?.lang || "").toLowerCase().slice(0, 2);
  if (!lang) return it;
  if (lang === "en" || !r.title_en) return { ...it, lang };
  return {
    ...it,
    lang,
    titleOriginal: it.titleOriginal || it.title,
    title: r.title_en.trim(),
    summary: r.summary_en ? r.summary_en.trim() : it.summary,
  };
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

// Forced tool => the API guarantees schema-valid structured output, instead of
// us parsing free text (Haiku was intermittently returning non-JSON prose).
const VERDICT_TOOL = {
  name: "record_verdicts",
  description: "Record one classification verdict per item.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            i: { type: "integer", description: "the item's index" },
            category: { type: "string", enum: ["product", "offer", "service", "drop"] },
            region: { type: "string", enum: ["NA", "SA"] },
            bank: { type: "string", description: "short bank name, or empty" },
          },
          required: ["i", "category"],
        },
      },
    },
    required: ["verdicts"],
  },
};

// Classify RSS items in small batches, returning ONLY items tagged
// product/offer/service; a failed batch is dropped, not kept-raw.
// No key -> nothing (unclassified RSS is just noise).
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
      `Classify these banking headlines for a Simplii Financial product-team dashboard, via record_verdicts.\n` +
      `Relevant = a RETAIL/consumer bank or neobank in the Americas doing one of: ${cfg.topics.join("; ")}.\n` +
      `Drop banks based outside North/South America (e.g. African, European, Asian banks), even when a fintech outlet covers them.\n` +
      `Banks of interest (not exhaustive): ${cfg.banks.join(", ")}.\n\n` +
      `One verdict per item. category: "product" (feature/platform/app launch), "offer" (rate/discount/bonus/promo), ` +
      `"service" (new service, fee change, access/eligibility), or "drop" for anything not about a specific bank's ` +
      `product/service/offer (generic macro news, regulation think-pieces, crypto prices, sports/unrelated noise).\n` +
      `region: "NA" or "SA". bank: short name or "".\n\nITEMS:\n${JSON.stringify(batchInput)}`;
    try {
      const resp = await anthropic.messages.create({
        model: MODEL_FAST,
        max_tokens: 2000,
        tools: [VERDICT_TOOL],
        tool_choice: { type: "tool", name: "record_verdicts" },
        messages: [{ role: "user", content: prompt }],
      });
      const tu = resp.content.find((c) => c.type === "tool_use");
      for (const v of tu?.input?.verdicts || []) {
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

// Translate non-English items to English (LatAm feeds are Portuguese/Spanish).
// Runs on the merged board and only touches items with no `lang` yet: new
// items each day, plus a one-time backfill of anything from before this existed.
// Best-effort: a failed batch leaves those items untouched for the next run.
const XLAT_TOOL = {
  name: "record_translations",
  description: "Record the language of each item and, if it isn't English, an English translation.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            i: { type: "integer", description: "the item's index" },
            lang: { type: "string", description: "ISO 639-1 code of the item's language, e.g. en, pt, es" },
            title_en: { type: "string", description: "English translation of the title; only if lang is not en" },
            summary_en: { type: "string", description: "English translation of the summary; only if lang is not en and a summary was given" },
          },
          required: ["i", "lang"],
        },
      },
    },
    required: ["items"],
  },
};

async function translate(client, items) {
  const todo = items.map((it, idx) => ({ it, idx })).filter(({ it }) => !it.lang);
  if (!client || todo.length === 0) return items;
  const anthropic = await client;
  const out = [...items];
  const BATCH = 25;
  let translated = 0, failed = 0;
  for (let start = 0; start < todo.length; start += BATCH) {
    const slice = todo.slice(start, start + BATCH);
    const batchInput = slice.map(({ it }, i) => ({ i, title: it.title, summary: it.summary || "" }));
    const prompt =
      `These are banking news headlines (with summaries) for an English-speaking product team, via record_translations.\n` +
      `For each item give its language as an ISO 639-1 code. If it is NOT English, also translate the title and the ` +
      `summary into natural, concise English. Keep bank, product, program and brand names exactly as written ` +
      `(e.g. Nubank, Itaú, Pix, Nu Smart Invest, Mercado Pago, Personnalité). Translate only; don't add or drop facts.\n\n` +
      `ITEMS:\n${JSON.stringify(batchInput)}`;
    try {
      const resp = await anthropic.messages.create({
        model: MODEL_FAST,
        max_tokens: 6000,
        tools: [XLAT_TOOL],
        tool_choice: { type: "tool", name: "record_translations" },
        messages: [{ role: "user", content: prompt }],
      });
      const tu = resp.content.find((c) => c.type === "tool_use");
      for (const r of tu?.input?.items || []) {
        const target = slice[r.i];
        if (!target) continue;
        out[target.idx] = applyTranslation(target.it, r);
        if (out[target.idx].titleOriginal && !target.it.titleOriginal) translated++;
      }
    } catch (err) {
      failed++;
      console.warn(`  translate batch @${start} skipped: ${err.message}`);
    }
  }
  console.log(`  languages tagged for ${todo.length} items; translated ${translated}${failed ? ` (${failed} batches failed)` : ""}`);
  return out;
}

// Daily brief: themes + highlights worth reacting to, from the final board.
// Best-effort; returns null (frontend hides the block) on no key / failure.
async function summarize(client, news) {
  if (!client || news.length === 0) return null;
  const anthropic = await client;
  const recent = [...news]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 60)
    .map((n) => ({ title: n.title, bank: n.bank, category: n.category, region: n.region, date: n.date, summary: (n.summary || "").slice(0, 200) }));
  const prompt =
    `You are briefing the Simplii Financial product team on competitor bank news. ` +
    `Below is today's tracked news across banks in the Americas.\n\n` +
    `Write a sharp, skimmable brief:\n` +
    `- "tldr": 1-2 sentences capturing the state of play today.\n` +
    `- "themes": 3-5 short phrases naming common threads across the items (e.g. "AI assistants in mobile apps", "savings-rate competition").\n` +
    `- "highlights": 2-4 items genuinely worth reacting to, each {"headline": the development, "why": one line on why it matters to Simplii's product team}. ` +
    `Prefer moves by direct competitors (CIBC, RBC, TD, Scotiabank, BMO, Wealthsimple, EQ Bank, Tangerine, Chime) or clear category shifts.\n\n` +
    `Base it ONLY on the items below; do not invent. Output a SINGLE JSON object in a \`\`\`json fence:\n` +
    `\`\`\`json\n{"tldr":"","themes":["",""],"highlights":[{"headline":"","why":""}]}\n\`\`\`\n\n` +
    `ITEMS:\n${JSON.stringify(recent)}`;
  try {
    const resp = await anthropic.messages.create({
      model: MODEL_SMART,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.map((c) => c.text || "").join("");
    const s = extractJson(text);
    const brief = {
      tldr: String(s.tldr || ""),
      themes: Array.isArray(s.themes) ? s.themes.map(String).slice(0, 6) : [],
      highlights: Array.isArray(s.highlights) ? s.highlights.filter((h) => h && h.headline).slice(0, 4) : [],
    };
    console.log(`  brief: ${brief.themes.length} themes, ${brief.highlights.length} highlights`);
    return brief;
  } catch (err) {
    console.warn(`  brief skipped: ${err.message}`);
    return null;
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

  const merged = mergeNews(existingNews, [...classified, ...found.news], {
    maxAgeDays: cfg.maxAgeDays ?? 120,
    limit: cfg.maxNewsItems ?? 150,
  }).filter((n) => REAL_CATS.includes(n.category)); // board shows only categorized items
  const events = mergeEvents(existingEvents, found.events);

  console.log("Translating…");
  const news = await translate(client, merged);

  console.log("Writing brief…");
  const brief = await summarize(client, news);

  const stamp = { updated: new Date().toISOString() };
  await writeFile(join(DATA, "news.json"), JSON.stringify(news, null, 2));
  await writeFile(join(DATA, "events.json"), JSON.stringify(events, null, 2));
  // keep the previous brief if this run couldn't make one
  if (brief) await writeFile(join(DATA, "summary.json"), JSON.stringify({ ...stamp, ...brief }, null, 2));
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

  // translation: English items just get tagged; others swap in English and keep the original
  const en = applyTranslation({ title: "BMO launches AI agent", summary: "s" }, { i: 0, lang: "en" });
  assert(en.lang === "en" && en.title === "BMO launches AI agent" && !en.titleOriginal, "english item only tagged");
  const pt = applyTranslation(
    { title: "Itaú lança cartão World Legend - Valor", summary: "O banco lançou um cartão" },
    { i: 0, lang: "pt", title_en: "Itaú launches World Legend card - Valor", summary_en: "The bank launched a card" });
  assert(pt.lang === "pt" && pt.title.startsWith("Itaú launches") && pt.titleOriginal.startsWith("Itaú lança"), "non-english item translated, original kept");
  assert(pt.summary === "The bank launched a card", "summary translated");
  assert(applyTranslation({ title: "x" }, { i: 0 }).lang === undefined, "no lang in result leaves item untouched");

  // the same story re-fetched untranslated from RSS merges into the translated one and keeps the English
  const again = mergeNews(
    [{ ...pt, url: "https://news.google.com/rss/articles/itau", date: "2026-11-05", category: "product" }],
    [{ title: "Itaú lança cartão World Legend - Valor", summary: "O banco lançou um cartão de altíssima renda", url: "https://news.google.com/rss/articles/itau", date: "2026-11-05", category: "product" }],
    { maxAgeDays: 999999, limit: 10 });
  assert(again.length === 1, "translated item and its untranslated re-fetch dedupe");
  assert(again[0].title.startsWith("Itaú launches") && again[0].lang === "pt", "re-fetch doesn't overwrite the English title");
  assert(again[0].summary === "The bank launched a card", "re-fetch doesn't overwrite the English summary (even if longer)");

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
