# WatAssistant

WatAssistant is a Chrome extension for University of Waterloo co-op students using [WaterlooWorks](https://waterlooworks.uwaterloo.ca). It adds a private AI job-analysis panel directly to the job board, helping students understand postings, assess resume fit, and find opportunities across the current term.

> Built for WaterlooWorks. A University of Waterloo email is required to use the hosted AI features.

## Highlights

- **Should I Apply?** — evaluates a posting against your resume, dream-job preferences, and role-quality signals.
- **Resume-aware fit scoring** — see a 0–100 fit score, strengths, gaps, and a clear verdict for an individual job.
- **Dream-job check** — identifies whether a role aligns with the priorities you set and whether it is a realistic stretch.
- **Plain-English role explanations** — quickly understand what a role is likely to involve day to day.
- **Ask about a posting** — ask focused questions such as whether remote work, a particular skill, or another requirement is mentioned.
- **Role-disguise signals** — surfaces warnings and adjacent job titles when a posting appears to describe a different role than its title suggests.
- **Fit badges that persist** — scored postings receive colour-coded fit badges in WaterlooWorks listings; scores remain available across browser sessions and are synced for ranked search.
- **Smart job discovery** — find your top 10 fits, lower-competition “Hidden Gems,” and postings added within a chosen number of days.
- **Natural-language search and ranking** — search jobs by constraints such as role, location, remote work, duration, skills, or education. Queries such as “top 10 highest-paying jobs,” “fewest applicants,” and “earliest deadlines” are recognized as ranked searches.
- **Cross-page results** — review search results from the collected WaterlooWorks data in an overlay, then open a job in WaterlooWorks’ native modal.
- **External-application link capture** — when a posting provides an application-by-website/email instruction, its application link is collected with the job details for backend use.

## How it works

1. Create an account with a confirmed `@uwaterloo.ca` email and add your resume in Settings.
2. Browse the WaterlooWorks jobs board as usual. WatAssistant syncs listing data and opens its panel when you select a posting.
3. The extension sends a job’s details through its background service worker to the hosted API. Analyses are returned from cache when available or prepared asynchronously for new postings.
4. Use the panel to assess the open job, or use Smart Suggestions and search to explore the wider job set.

Your resume is read from Chrome’s local extension storage by the background service worker. It is never placed in the page’s JavaScript context or logged by the extension.

## Smart search examples

Try searches such as:

- `remote software jobs in Toronto`
- `top 10 highest paying jobs`
- `lowest salary jobs`
- `fewest applicants`
- `most openings`
- `earliest deadlines`
- `8 month data analyst roles`
- `good fit for me`

Ranked compensation searches require job descriptions with compensation information to have been loaded. Similarly, richer filters such as work arrangement, duration, or skills become more complete as postings are opened and their details are collected.

## Accounts, credits, and BYOK

The free tier includes up to **50 uncached AI credits per day**, resetting at midnight UTC. Credit usage is associated with your signed-in University of Waterloo account.

You can optionally add your own OpenAI API key in Settings for unlimited AI use. The key is stored in Chrome’s local extension storage and forwarded only for requests to the hosted API; it is not stored by the backend.

## Install for development

### Prerequisites

- Chrome or another Chromium-based browser
- A configured WatAssistant backend and Supabase project
- No Node.js install or build step is required for the extension itself

### Steps

1. Clone the repository:

   ```bash
   git clone https://github.com/AkashLak/waterlooworks-ai.git
   cd waterlooworks-ai
   ```

2. Create a local configuration file:

   ```bash
   cp config.example.js config.js
   ```

3. In `config.js`, set:

   - `BACKEND_URL` — hosted backend base URL, without a trailing slash
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_ANON_KEY` — the public Supabase anon/publishable key
   - `DEV_MODE` — enable only for local debugging; never log resumes or tokens

   `config.js` is gitignored. Do not add a Supabase service-role key or another backend secret to the extension.

4. In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose this repository’s root directory.

5. Open **Settings** from the extension popup, create/sign in to a confirmed Waterloo email account, and add your resume as plain text or a PDF.

6. Visit the WaterlooWorks jobs board. Select a job title to open the analysis panel.

After changing source files, reload the extension from `chrome://extensions`. Reload the WaterlooWorks tab as well after changing content scripts or styles.

## Project structure

```text
waterlooworks-ai/
├── manifest.json                 # Chrome Manifest V3 configuration
├── config.example.js             # Local configuration template
├── background/
│   └── background.js             # Service worker and authenticated API gateway
├── content/
│   ├── interceptor.js            # MAIN-world WaterlooWorks request interception
│   ├── content.js                # Panel, lifecycle, listing synchronization
│   ├── handlers.js               # Analysis, search, scraping, and overlay actions
│   ├── renderers.js              # Safe DOM rendering and fit badges
│   └── panel.css                 # Injected panel and overlay styling
├── lib/
│   ├── analyzer.js               # Content-script to service-worker message client
│   ├── api.js                    # Hosted API client
│   ├── auth.js                   # Supabase authentication client
│   ├── scraper.js                # WaterlooWorks DOM parsing
│   ├── storage.js                # Chrome local-storage helpers
│   └── pdfjs/                    # Bundled PDF.js resume parser
├── options/                      # Account, resume, API key, and priorities settings
├── popup/                        # Extension-toolbar status popup
├── assets/icons/                 # Extension icons
└── dev.html                      # Standalone development test console
```

## Architecture

```text
WaterlooWorks page
  ├── interceptor.js (MAIN world)
  │     Captures WaterlooWorks listing/detail requests and opens native job modals
  └── content scripts (isolated world)
        Scrape displayed data, render the panel, and send extension messages
                 │
                 ▼
background service worker
  ├── Reads locally stored resume, optional BYOK key, and auth session
  ├── Refreshes Supabase sessions when necessary
  └── Makes authenticated requests to the hosted backend
                 │
                 ▼
Hosted backend + Supabase
  Stores collected job data, enforces account credits, and runs AI analysis/search
```

The extension uses `chrome.runtime.sendMessage` between content scripts and the service worker. Content scripts do not make direct backend calls and do not handle Supabase access tokens.

## Data and security

- Authentication uses short-lived Supabase access tokens tied to confirmed `@uwaterloo.ca` accounts.
- Dynamic job content is rendered with `textContent`, rather than injected as HTML.
- The background service worker rejects messages not sent by this extension.
- The extension CSP limits network connections to the configured backend and Supabase project.
- Resumes, sessions, optional API keys, and persisted fit scores live in `chrome.storage.local`.
- Resume hashes use a locally generated device identifier as a salt; raw resume text is not logged by the extension.

WaterlooWorks’ DOM and internal requests can change. If scraping stops working, begin with [`lib/scraper.js`](lib/scraper.js) and the request-capture logic in [`content/interceptor.js`](content/interceptor.js).

## Developer console

`dev.html` provides a quick way to exercise analysis flows without navigating WaterlooWorks:

1. Load the unpacked extension.
2. Open `chrome-extension://<your-extension-id>/dev.html`.
3. Paste a sample job description and run an analysis mode.

The console communicates with the same background service worker used by the extension.

## Deployment

This repository contains the Chrome extension. The API is deployed separately and configured through `BACKEND_URL`.

| Component | Service |
| --- | --- |
| Extension | Chrome, loaded unpacked during development or distributed through the Chrome Web Store |
| Backend API | Railway or another Node.js host |
| Authentication and data | Supabase |
| AI | OpenAI, managed by the backend |

## License

[MIT](LICENSE)
