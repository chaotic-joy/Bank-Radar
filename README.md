# Bank Radar

A dashboard for the Simplii Financial product team tracking **(1)** a filterable stream of
product/offer/service news from banks across the Americas, and **(2)** a calendar of recent
and upcoming banking/fintech events (conferences, keynotes, investor calls).

## How it works

```
RSS feeds (safety net) ─┐
                        ├─► scripts/aggregate.mjs ─► data/news.json  ─► static dashboard
Claude web-search ──────┘    (classify + discover)   data/events.json    (index.html)
```

- **RSS** pulls every headline from the feeds in `feeds.json` — the "don't miss anything" layer.
- **Claude** (optional, needs `ANTHROPIC_API_KEY`) then (a) classifies each RSS item into
  `product` / `offer` / `service` and drops irrelevant noise, and (b) runs a web-search pass to
  find **offers and events that have no RSS feed**.
- Output is plain JSON committed to the repo. The front end is static — **no backend, no database.**
  Deploys identically to Netlify or Vercel.

## Run locally

```bash
npm install
npm run selftest          # verifies the merge/dedupe/sort logic
npm run dev               # serve the dashboard at http://localhost:3000
ANTHROPIC_API_KEY=sk-...  npm run refresh   # pull live data (RSS-only if key omitted)
```

Without a key, `refresh` still works — it just keeps RSS items unclassified (category `news`).

## Deploy

**Either host — it's a static site, nothing to configure:**

- **Vercel:** `vercel` (or import the repo). Output dir = project root.
- **Netlify:** drag-and-drop the folder, or connect the repo. Publish dir = `.`, no build command.

## Keep it fresh (daily, automatic)

`.github/workflows/refresh.yml` runs the aggregator every morning, commits new data, and the
commit triggers your host's auto-redeploy. To enable:

1. Push this repo to GitHub.
2. Repo **Settings → Secrets → Actions** → add `ANTHROPIC_API_KEY`.
3. Done. Use the **Actions → Refresh dashboard data → Run workflow** button to trigger on demand.

## Tuning (no code)

Edit **`feeds.json`**:
- `feeds` — add/remove RSS sources (bank newsrooms, fintech press).
- `banks` — the watchlist that steers classification + discovery.
- `topics`, `regions`, `maxAgeDays`, `maxNewsItems`.

## Note on the seed data

`data/*.json` ships with real, sourced sample items (flagged **SAMPLE DATA** in the footer) so the
dashboard is useful before the first live run. Dates/terms were gathered from secondary sources —
verify against each bank's newsroom. The first `npm run refresh` replaces them with live data.
