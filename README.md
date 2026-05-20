# WaterlooWorks AI Assistant

A Chrome extension that injects an AI-powered analysis panel directly into [WaterlooWorks](https://waterlooworks.uwaterloo.ca), the University of Waterloo co-op job board. Upload your resume once — then get instant fit scores, role explanations, and smart job search on every posting you browse.

---

## What it does

Open any job posting on WaterlooWorks and the extension automatically submits it to a Railway-hosted backend, which runs GPT-powered analysis and stores the results in Supabase. From the injected side panel you can:

- **Should I Apply?** — composite score combining fit, dream-job assessment, and a role sniff check
- **Analyze Fit** — resume-specific fit score with strengths, gaps, and a verdict (0–100)
- **Dream Job?** — attainability assessment based on your personal dream-role criteria
- **Explain Role** — plain-English summary of what the job actually involves day-to-day
- **Also Consider** — identifies related roles that overlap with this posting, so you can discover other job types worth applying to
- **Ask** — free-form question about any posting ("is remote work mentioned?")
- **Score All Jobs** — batch-scores every visible posting and injects colored badges into the table
- **Smart Suggestions** — one-click searches for closing-soon jobs and your top 10 fits

---

## Stack

| Layer | Technology |
|---|---|
| Extension | Chrome Manifest V3 — plain JavaScript, no build step |
| Content scripts | `content.js`, `handlers.js`, `renderers.js`, `interceptor.js` (MAIN world) |
| Background | Service worker (`background/background.js`) |
| Backend | Railway (Node.js + Express + Supabase) |
| AI | OpenAI `gpt-4o-mini` + `text-embedding-3-small` |
| Resume storage | `chrome.storage.local` (plain text, never leaves the device except to the backend via the service worker) |
| PDF parsing | PDF.js (bundled, `lib/pdfjs/`) |

---

## Project Structure

```
waterlooworks-ai/
├── manifest.json                  # MV3 manifest
├── config.example.js              # Config template — copy to config.js
├── config.js                      # Gitignored — BACKEND_URL, API_SECRET, DEV_MODE
│
├── background/
│   └── background.js              # Service worker — only file that reads API_SECRET
│
├── content/
│   ├── interceptor.js             # MAIN world script (document_start): intercepts XHR/fetch for WW action tokens
│   ├── content.js                 # Panel HTML, shared state, MutationObserver, init
│   ├── handlers.js                # All async action handlers (submit, poll, batch, search, ask, overlay)
│   ├── renderers.js               # DOM helpers (_el, _label, _tagList) and result renderers
│   └── panel.css                  # Panel styles
│
├── lib/
│   ├── analyzer.js                # WWAnalyzer namespace: thin wrapper over chrome.runtime.sendMessage
│   ├── api.js                     # WWApi namespace: all REST calls to the backend
│   ├── scraper.js                 # WWScaper namespace: all WaterlooWorks DOM selectors
│   ├── storage.js                 # WWStorage namespace: chrome.storage.local wrappers
│   └── pdfjs/                     # Bundled PDF.js for resume parsing
│       ├── pdf.min.js
│       └── pdf.worker.min.js
│
├── options/
│   ├── options.html               # Settings page (resume upload, dream-job criteria)
│   ├── options.js
│   └── options.css
│
├── popup/
│   ├── popup.html                 # Extension toolbar popup
│   ├── popup.js
│   └── popup.css
│
├── assets/
│   └── icons/                     # 16/48/128px extension icons
│
└── dev.html                       # Developer console — test analysis without navigating WaterlooWorks
```

---

## Setup

**Prerequisites:** Chrome or any Chromium browser. No Node.js or build tools required.

1. Clone the repo:
   ```bash
   git clone https://github.com/AkashLak/waterlooworks-ai.git
   cd waterlooworks-ai
   ```

2. Create your config file:
   ```bash
   cp config.example.js config.js
   ```
   Then fill in `BACKEND_URL` and `API_SECRET` in `config.js`. Never commit this file — it is gitignored.

3. Load the extension unpacked:
   - Open `chrome://extensions`
   - Enable **Developer mode** (toggle, top right)
   - Click **Load unpacked** → select this repo root

4. Go to the extension's **Options** page and paste in your resume (plain text or PDF upload).

5. Navigate to [WaterlooWorks](https://waterlooworks.uwaterloo.ca) — the panel appears automatically.

> After editing source files, click the reload icon on `chrome://extensions` (or press **R** on that page). Content script changes also require reloading the WaterlooWorks tab.

---

## Developer Console (`dev.html`)

The fastest way to test AI analysis without navigating WaterlooWorks:

- Open `chrome-extension://[your-extension-id]/dev.html` in the browser
- Paste a mock job description and click any analysis mode button
- Messages go directly to `background.js`, bypassing all DOM scraping
- Your extension ID appears on `chrome://extensions`

---

## Architecture

All backend calls are gated through the background service worker. Content scripts never touch `API_SECRET` or call the backend directly.

```
WaterlooWorks page
  └── content/interceptor.js    MAIN world (document_start): intercepts XHR/fetch to capture
  |                             WW action tokens; listens for __wwai_open_job → viewPosting()
  └── content/content.js        Panel HTML, shared state, MutationObserver, init
  └── content/handlers.js       All async action handlers (submit, poll, batch, search, ask, overlay)
  └── content/renderers.js      DOM helpers and result renderers

background/background.js        Service worker — ONLY file that reads API_SECRET
  └── lib/api.js                WWApi namespace: all REST calls to the backend
  └── lib/storage.js            WWStorage namespace: chrome.storage.local wrappers

lib/analyzer.js                 WWAnalyzer namespace: thin wrapper sending chrome.runtime.sendMessage
lib/scraper.js                  WWScaper namespace: all WaterlooWorks DOM selectors
```

### Message flow

1. User opens a job modal — `MutationObserver` in `content.js` detects it.
2. `handlers.js` calls `WWAnalyzer.submitJob(jobData)` → background → `WWApi.submitJob()` → `POST /api/jobs/submit`.
3. Backend stores the job in Supabase and queues GPT analysis. Returns `{ analysesReady, analyses }`.
4. If not ready, `handlers.js` polls `GET /api/jobs/{jobId}/analyses` every 4 seconds (max 30 polls) until `analysesReady: true`.
5. On ready, the panel shows the sniff warning (if flagged) and role preview in the header.
6. User clicks an action button → `handlers.js` calls the appropriate `WWAnalyzer.*` method → background → `WWApi.*` → backend.
7. Result returned via `sendResponse`, rendered into the panel by `renderers.js`.

---

## Analysis Modes

| Mode | Returns | How it's computed |
|---|---|---|
| `BEST_FIT` | `{ fitScore, strengths, gaps, verdict }` | `POST /api/fit-score` — resume-specific, live call |
| `DREAM_JOB` | `{ isDream, isStretch, reason, attainabilityNote }` | `POST /api/dream-fit` — resume-specific, live call |
| `SHOULD_APPLY` | Composite of fit + dream + QA sniff | Calls fit + reads pre-computed dream/qa |
| `QA_SNIFF` | `{ isDisguised, actualRole, redFlags, alsoGoodFitFor, summary }` | Pre-computed on submit — surfaces related roles people applying to this posting typically also apply to |
| `ROLE_EXPLAINER` | Plain-text role summary | Pre-computed on submit |
| `ASK` | `{ answer }` | `POST /api/ask` — live call, resume optional |

---

## Score All Jobs (Batch Mode)

Driven by `_handleBatch()` in `handlers.js`:

1. Fetches all stored jobs from the backend (`GET /api/jobs/all`).
2. Iterates visible table rows — skips jobs with no stored description.
3. For each row: checks backend `fit_score` → session `BEST_FIT` cache → calls `POST /api/fit-score` as last resort.
4. Writes result to both `BEST_FIT` and `BATCH_FIT` cache keys, injects a colored score badge into the table row.
5. After the visible page finishes, silently pre-computes fit scores for all other DB jobs with descriptions so badges appear instantly on page navigation.

---

## Smart Suggestions & Search

Located in the panel footer. Hidden while a job modal is open; restored on close.

| Button | Behavior |
|---|---|
| ⏰ Closing in 3 Days | `POST /api/jobs/search` with `criteria: closing_soon` — backend hardcodes the 3-day window |
| 🎯 Top 10 Fits for Me | `POST /api/jobs/search` with `criteria: top_fits` — returns your top 10 scored jobs |
| Free search bar | `POST /api/jobs/search` with `type: free_search` — natural-language query |

All three display results in a full-viewport search overlay. Clicking a job title either clicks the live DOM row (if visible on the current page) or dispatches `__wwai_open_job` so `interceptor.js` can call WaterlooWorks's native `viewPosting()`.

---

## Session Cache

Results are cached in `sessionStorage` per job to avoid redundant API calls.

| Key | Written by | Used by |
|---|---|---|
| `wwai_{jobId}_BEST_FIT` | Analyze Fit, Should I Apply? | Panel UI speed |
| `wwai_{jobId}_BATCH_FIT` | Score All Jobs only | Table badge injection |
| `wwai_{jobId}_DREAM_JOB` | Dream Job? | Panel UI speed |
| `wwai_{jobId}_QA_SNIFF` | Submitted on job open | QA Sniff panel |

When the user updates their resume in Settings, all `BEST_FIT`, `DREAM_JOB`, and `BATCH_FIT` keys are cleared.

---

## Storage Keys

All keys are prefixed `ww_`. The background service worker reads the resume directly from storage and never accepts it in message payloads.

| Key | Type | Purpose |
|---|---|---|
| `ww_resume` | string | Plain-text resume |
| `ww_jobs_analyzed` | number | Count of jobs analyzed this session |
| `ww_analyzed_ids` | array | Job IDs analyzed (dedup) |
| `ww_tracking_version` | number | Bumped to force a one-time reset of job tracking data |

---

## DOM Scraping (`lib/scraper.js`)

All selectors are annotated with their verification date. **`lib/scraper.js` is the first file to audit if the extension breaks** — WaterlooWorks periodically updates its frontend.

Key selectors (verified April 2026):

| Selector | Purpose |
|---|---|
| `tr.table__row--body` | Listing table rows |
| `div.modal.is--visible[role="dialog"]` | Open job detail modal |
| `div.tag__key-value-list` | Field label/value pairs in the Overview tab |
| `.dashboard-header__posting-title .tag-label` | Job ID chip |

---

## Security

- `API_SECRET` is only ever read in `background/background.js`. It is never logged, passed through content script messages, or stored anywhere else.
- Dynamic data in the panel is always set via `textContent`, never `innerHTML`, to prevent XSS from scraped job text.
- The background service worker rejects any message whose `sender.id !== chrome.runtime.id`.
- The extension CSP (`manifest.json`) restricts `connect-src` to the backend domain only.
- `DEV_MODE` in `config.js` must be `false` before distributing — it enables verbose logging in the background service worker only.

---

## Config Reference

| Variable | Purpose |
|---|---|
| `BACKEND_URL` | Railway backend base URL (no trailing slash) |
| `API_SECRET` | Shared secret for authenticating requests to the backend |
| `DEV_MODE` | `true` enables verbose background logging — set to `false` before distributing |

---

## Deployment

The backend is a separate Railway-hosted service (not included in this repo). The extension talks to it via `BACKEND_URL` set in `config.js`.

| Component | Platform |
|---|---|
| Extension | Loaded unpacked (development) or Chrome Web Store |
| Backend API | Railway |
| Database | Supabase (managed via backend) |
| AI | OpenAI GPT-4o-mini + text-embedding-3-small (managed via backend) |

---

## License

MIT
