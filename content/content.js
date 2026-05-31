// Injected into every WaterlooWorks page.
// Depends on: WWStorage, WWScaper, WWAnalyzer (lib/),
//             renderers + DOM helpers (content/renderers.js),
//             action handlers (content/handlers.js).

// ── Shared state ───────────────────────────────────────────────────────────────
// These top-level vars are accessible from handlers.js and renderers.js
// because all content scripts share the same execution context.

let _currentJobId      = null;
let _currentDetail     = null;
let _currentAnalyses   = null; // pre-computed analyses from submitJob / polling
let _submitting        = false; // true while _submitAndPoll is in flight (before _pollTimer is set)
let _batchRunning      = false;
let _lastSubmittedJobId = null; // dedup guard — prevents double-submit on modal class flicker
let _activeFilter      = null; // Set of jobIds when table filter is active, null otherwise
let _filterMeta        = null; // { shown, total, query } for filter card restoration
let _lastRenderedMode  = null; // last rendered result mode — used by report feature
let _lastRenderedData  = null; // last rendered result data — used by report feature
let _allJobsMap        = {};   // latest getAllJobs snapshot — fallback for role_disguise in panel

// ── Direct HTTP scrape state (populated by MAIN world interceptor) ─────────────
let _directListingToken      = null;  // action token for the listing endpoint (GET or POST)
let _directListingUrl        = null;  // URL for listing requests
let _directListingMethod     = 'GET'; // 'GET' (direct nav) or 'POST' (SPA nav from Full Cycle landing)
let _directListingCandidates = [];    // POST action tokens captured before Phase 1 identifies the listing one
let _directDetailTokens    = [];   // all captured POST action tokens (HTML token is typically last)
let _directDetailUrl       = null; // URL used for job detail POSTs
let _directDetailIdParam   = 'postingId'; // body parameter name WW uses for job ID (postingId or jobId)
let _directScrapeRows      = null; // rows collected in Phase 1; grows as new rows appear
let _directScrapeState     = 0;    // 0=idle 1=phase1 2=awaiting_detail_token 3=phase2 4=done
let _directHtmlDetailToken = null; // the specific POST token that returns job HTML (cached after Phase 2 finds it)
let _directGeoToken        = null; // the POST token that returns geo JSON (city, country) — cached after Phase 2
let _directDetailBase      = null; // resolved absolute URL for detail POSTs (cached after Phase 2)
let _lastSyncedAt          = null; // ms timestamp of last successful row sync (from server response)
let _persistedFitScores    = {};   // jobId → fitScore number, loaded from chrome.storage.local at init
let _lastKnownTotal        = 0;    // totalResults from the last listing fetch — used to detect new postings
let _periodicCheckTimer    = null; // setInterval handle for the background new-job check

// ── Panel HTML ─────────────────────────────────────────────────────────────────

function _buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'wwai-panel';
    // Static developer-authored HTML — dynamic content always set via textContent
    panel.innerHTML = `
        <div class="wwai-header">
            <span class="wwai-header__title">WaterlooWorks AI</span>
            <button class="wwai-header__close" aria-label="Close">✕</button>
        </div>
        <div class="wwai-body">
            <div class="wwai-resume-status" id="wwai-resume-status"></div>
            <div class="wwai-empty" id="wwai-empty">Click a job title to start analyzing.</div>
            <div class="wwai-job-info wwai-hidden" id="wwai-job-info">
                <div class="wwai-job-info__title"   id="wwai-job-title"></div>
                <div class="wwai-job-info__meta"    id="wwai-job-meta"></div>
                <div class="wwai-job-info__sniff wwai-hidden" id="wwai-sniff-flag">💡 This role also fits other titles ▾</div>
                <div class="wwai-sniff-detail wwai-hidden" id="wwai-sniff-detail"></div>
                <div class="wwai-job-info__preview wwai-hidden" id="wwai-role-preview"></div>
            </div>
            <div class="wwai-actions wwai-hidden" id="wwai-actions">
                <button class="wwai-btn wwai-btn--full wwai-btn--primary" data-mode="SHOULD_APPLY">✅ Should I Apply?</button>
                <div class="wwai-actions__row">
                    <button class="wwai-btn" data-mode="DREAM_JOB">⭐ Dream Job?</button>
                    <button class="wwai-btn" data-mode="ROLE_EXPLAINER">💼 Explain Role</button>
                </div>
            </div>
            <div class="wwai-loading wwai-hidden" id="wwai-loading">
                <div class="wwai-spinner"></div>
                <span id="wwai-loading-text">Analyzing…</span>
            </div>
            <div id="wwai-result" class="wwai-hidden"></div>
            <hr class="wwai-divider wwai-hidden" id="wwai-ask-divider">
            <div class="wwai-ask wwai-hidden" id="wwai-ask">
                <input class="wwai-ask__input" id="wwai-ask-input" type="text"
                    placeholder="Ask anything about this job…">
                <button class="wwai-ask__btn" id="wwai-ask-btn">Ask</button>
            </div>
            <hr class="wwai-divider">
            <div class="wwai-suggestions" id="wwai-suggestions">
                <div class="wwai-suggestions__title">Smart Suggestions</div>
                <button class="wwai-btn wwai-btn--full wwai-btn--suggestion" data-search="closing_soon">⏰ Closing in 3 Days</button>
                <button class="wwai-btn wwai-btn--full wwai-btn--suggestion" data-search="top_fits">🎯 Top 10 Fits for Me</button>
                <div class="wwai-search-bar">
                    <input class="wwai-search-bar__input" id="wwai-search-input" type="text"
                        placeholder="Search &amp; filter… e.g. remote, Toronto &gt; 8 months">
                    <button class="wwai-btn wwai-btn--full" id="wwai-search-btn">🔍 Search</button>
                </div>
                <div class="wwai-status-line" id="wwai-status-line"></div>
                <div class="wwai-legend-hint">Badges: 🟢 ≥ 70 &nbsp;🟡 ≥ 40 &nbsp;🔴 &lt; 40</div>
            </div>
        </div>
        <div class="wwai-report-form wwai-hidden" id="wwai-report-form">
            <div class="wwai-report-form__title">Report an issue</div>
            <div class="wwai-report-features" id="wwai-report-features">
                <button class="wwai-report-feature-btn" data-feature="Should I Apply?">Should I Apply?</button>
                <button class="wwai-report-feature-btn" data-feature="Dream Job">Dream Job</button>
                <button class="wwai-report-feature-btn" data-feature="Explain Role">Explain Role</button>
                <button class="wwai-report-feature-btn" data-feature="Ask a Question">Ask a Question</button>
                <button class="wwai-report-feature-btn" data-feature="Free Search">Free Search</button>
                <button class="wwai-report-feature-btn" data-feature="Closing Soon">Closing Soon</button>
                <button class="wwai-report-feature-btn" data-feature="Top 10 Fits">Top 10 Fits</button>
                <button class="wwai-report-feature-btn" data-feature="Score / Badges">Score / Badges</button>
                <button class="wwai-report-feature-btn" data-feature="Other">Other</button>
            </div>
            <textarea class="wwai-report-note" id="wwai-report-note" rows="2" placeholder="What went wrong?"></textarea>
            <div class="wwai-report-form__actions">
                <button class="wwai-btn" id="wwai-report-cancel">Cancel</button>
                <button class="wwai-btn wwai-btn--primary" id="wwai-report-submit">Submit</button>
            </div>
        </div>
        <div class="wwai-footer">WaterlooWorks AI — free to use &nbsp;·&nbsp; <button id="wwai-report-btn" class="wwai-footer__report">⚑ Report issue</button></div>`;
    return panel;
}

// ── Event wiring ───────────────────────────────────────────────────────────────

function _wireEvents(panel) {
    panel.querySelector('.wwai-header__close').addEventListener('click', _closePanel);

    panel.querySelectorAll('.wwai-btn[data-mode]').forEach((btn) =>
        btn.addEventListener('click', () => _handleModeClick(btn.dataset.mode))
    );

    panel.querySelectorAll('.wwai-btn[data-search]').forEach((btn) =>
        btn.addEventListener('click', () => _handleSearch(btn.dataset.search))
    );


    const askInput = document.getElementById('wwai-ask-input');
    const submit   = () => { const q = askInput.value.trim(); if (q) _handleAsk(q); };
    document.getElementById('wwai-ask-btn').addEventListener('click', submit);
    askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    document.getElementById('wwai-sniff-flag').addEventListener('click', () => {
        const detail = document.getElementById('wwai-sniff-detail');
        const flag   = document.getElementById('wwai-sniff-flag');
        const open   = !detail.classList.contains('wwai-hidden');
        if (open) {
            _hide('wwai-sniff-detail');
            flag.textContent = flag.textContent.replace('▴', '▾');
        } else {
            _show('wwai-sniff-detail');
            flag.textContent = flag.textContent.replace('▾', '▴');
        }
    });

    const searchInput = document.getElementById('wwai-search-input');
    const searchGo = () => { const q = searchInput.value.trim(); if (q) _handleFreeSearch(q); };
    document.getElementById('wwai-search-btn').addEventListener('click', searchGo);
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchGo(); });

    document.getElementById('wwai-report-btn').addEventListener('click', _handleReport);

    document.getElementById('wwai-report-features').addEventListener('click', (e) => {
        const btn = e.target.closest('.wwai-report-feature-btn');
        if (!btn) return;
        document.querySelectorAll('.wwai-report-feature-btn')
            .forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });

    document.getElementById('wwai-report-cancel').addEventListener('click', () => {
        _hide('wwai-report-form');
    });

    document.getElementById('wwai-report-submit').addEventListener('click', async () => {
        const submitBtn  = document.getElementById('wwai-report-submit');
        const activeBtn  = document.querySelector('.wwai-report-feature-btn.active');
        const feature    = activeBtn?.dataset.feature ?? 'Other';
        const note       = document.getElementById('wwai-report-note').value.trim() || null;
        submitBtn.disabled    = true;
        submitBtn.textContent = 'Sending…';
        const jobInput = _currentJobId ? {
            jobId:    _currentJobId,
            title:    document.getElementById('wwai-job-title')?.textContent ?? null,
            employer: document.getElementById('wwai-job-meta')?.textContent?.split(' · ')[0] ?? null,
            mode:     _lastRenderedMode ?? null,
        } : null;
        try {
            await WWAnalyzer.createReport(feature, jobInput, _lastRenderedData ?? null, note);
            submitBtn.textContent = '✓ Reported!';
            setTimeout(() => {
                _hide('wwai-report-form');
                submitBtn.disabled    = false;
                submitBtn.textContent = 'Submit';
                document.getElementById('wwai-report-note').value = '';
            }, 1500);
        } catch (_) {
            submitBtn.textContent = 'Failed — try again';
            submitBtn.disabled    = false;
        }
    });
}

// ── Panel open / close ─────────────────────────────────────────────────────────

const _panel = _buildPanel();

function _openPanel()   { _panel.classList.add('wwai-open');    sessionStorage.setItem('wwai_panel_open', '1'); }
function _closePanel()  { _panel.classList.remove('wwai-open'); sessionStorage.setItem('wwai_panel_open', '0'); }
function _togglePanel() { _panel.classList.contains('wwai-open') ? _closePanel() : _openPanel(); }

// ── Mode dispatch ──────────────────────────────────────────────────────────────

function _handleModeClick(mode) {
    if (!_currentJobId) return;
    _clearResult();
    if      (mode === 'BEST_FIT')      _handleFitScore();
    else if (mode === 'SHOULD_APPLY')  _handleShouldIApply();
    else                               _handlePrecomputed(mode);
}

// ── Job change detection (MutationObserver) ────────────────────────────────────

new MutationObserver((mutations) => {
    const modal = WWScaper.getActiveModal();
    if (modal) {
        const detail = WWScaper.scrapeJobDetail(modal);
        if (detail?.jobId && detail.jobId !== _currentJobId) {
            _currentJobId    = detail.jobId;
            _currentDetail   = detail;
            _currentAnalyses = null;
            _clearPolling();
            _onJobOpen(detail);
        }
    } else if (_currentJobId) {
        _currentJobId    = null;
        _currentDetail   = null;
        _currentAnalyses = null;
        _submitting      = false;
        _clearPolling();
        _onJobClose();
        _scheduleTableSync();
    } else {
        // Detect when the XHR-rendered job table inserts rows into the DOM
        const hasNewRows = mutations.some(m =>
            m.type === 'childList' &&
            Array.from(m.addedNodes).some(n =>
                n.nodeType === Node.ELEMENT_NODE &&
                (n.matches('tr.table__row--body') || n.querySelector('tr.table__row--body'))
            )
        );
        if (hasNewRows) {
            _scheduleTableSync();
            // Trigger DOM Phase 1 when the All Jobs table first renders after SPA navigation.
            // State 0 = Phase 1 hasn't run yet (HTTP listing not captured).
            if (_directScrapeState === 0 && !_directListingToken) {
                _directScrapeState = 1;
                _runDomPhase1();
            }
        }
    }
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

function _onJobOpen(detail) {
    document.getElementById('wwai-job-title').textContent = detail.title;
    const row = WWScaper.scrapeRowByJobId(detail.jobId) ?? {};
    const deadline = row.appDeadline || detail.appDeadline || '';
    document.getElementById('wwai-job-meta').textContent =
        [detail.employer, deadline ? `Deadline: ${deadline}` : ''].filter(Boolean).join(' · ');
    _hide('wwai-sniff-flag');
    _hide('wwai-sniff-detail');
    document.getElementById('wwai-sniff-detail').innerHTML = '';
    document.getElementById('wwai-sniff-flag').textContent = '💡 Related Job Titles ▾';
    _hide('wwai-role-preview');

    // Skip submit if this job was already submitted in this session (modal class flicker guard)
    const alreadySubmitted = _lastSubmittedJobId === detail.jobId;

    _show('wwai-job-info'); _show('wwai-actions');
    _show('wwai-ask-divider'); _show('wwai-ask');
    _hide('wwai-empty'); _hide('wwai-suggestions');
    _clearLoading(); _clearResult();

    if (!alreadySubmitted) {
        _lastSubmittedJobId = detail.jobId;
        _submitAndPoll(detail);
    } else {
        _restoreAnalyses(detail.jobId);
    }
}

function _onJobClose() {
    _hide('wwai-job-info'); _hide('wwai-actions');
    _hide('wwai-ask-divider'); _hide('wwai-ask');
    _show('wwai-suggestions');
    _clearResult(); _clearLoading();

    if (_overlayEl || (_activeFilter && _filterMeta)) {
        // Overlay or DOM filter is still active — restore the panel summary card
        _hide('wwai-empty');
        _renderFilterCard(_filterMeta.shown, _filterMeta.total, _filterMeta.query, _filterMeta.emptyMsg);
    } else {
        _show('wwai-empty');
    }
}

// ── Session storage cache ──────────────────────────────────────────────────────

function _cacheKey(jobId, mode)      { return `wwai_${jobId}_${mode}`; }
function _getCached(jobId, mode)     { try { return JSON.parse(sessionStorage.getItem(_cacheKey(jobId, mode))); } catch { return null; } }
function _setCached(jobId, mode, d)  { try { sessionStorage.setItem(_cacheKey(jobId, mode), JSON.stringify(d)); } catch {} }

// ── Init ───────────────────────────────────────────────────────────────────────

(function init() {
    const toggle = document.createElement('button');
    toggle.id = 'wwai-toggle';
    toggle.textContent = 'AI';
    toggle.setAttribute('aria-label', 'Toggle WaterlooWorks AI panel');
    toggle.addEventListener('click', _togglePanel);

    document.body.appendChild(_panel);
    document.body.appendChild(toggle);
    _wireEvents(_panel);

    if (sessionStorage.getItem('wwai_panel_open') === '1') _openPanel();

    // Show resume status and keep it in sync if the user updates their resume in Settings
    function _updateResumeStatus(hasResume) {
        const el = document.getElementById('wwai-resume-status');
        el.textContent = hasResume ? '✅ Resume uploaded' : '⚠️ No resume — upload in Settings';
        el.className = 'wwai-resume-status ' + (hasResume ? 'wwai-resume-status--ok' : 'wwai-resume-status--warn');
    }
    WWStorage.getResume().then(r => _updateResumeStatus(!!r));

    // Load persisted fit scores so badges survive tab close/reopen
    WWStorage.getFitScores().then(scores => {
        _persistedFitScores = scores ?? {};
        _scheduleTableSync(); // re-inject badges now that scores are available
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if ('ww_resume' in changes) {
            _updateResumeStatus(!!changes.ww_resume.newValue);
            Object.keys(sessionStorage)
                .filter(k => k.startsWith('wwai_') && (k.endsWith('_BEST_FIT') || k.endsWith('_DREAM_JOB') || k.endsWith('_BATCH_FIT')))
                .forEach(k => sessionStorage.removeItem(k));
            WWStorage.clearFitScores();
            _persistedFitScores = {};
            _clearResult();
        }
        if ('ww_dream_criteria' in changes) {
            // Bust dream job session cache when priorities change
            Object.keys(sessionStorage)
                .filter(k => k.startsWith('wwai_') && k.endsWith('_DREAM_JOB'))
                .forEach(k => sessionStorage.removeItem(k));
        }
    });

    // ── Direct scrape token listeners ─────────────────────────────────────────
    // Tokens are stored in DOM data attributes by the MAIN world interceptor.
    // We read them on init (handles tokens captured before document_idle) AND
    // listen for future events (handles tokens captured after init).

    function _onListingToken(token, url) {
        if (_directListingToken) {
            // WW navigated to a different page of the same listing.
            // My Applications pagination reuses existing <tr> elements (updates content in-place)
            // so the MutationObserver "new row added" check never fires — schedule a sync here.
            if (url !== _directListingUrl) _scheduleTableSync();
            return;
        }
        _directListingToken = token;
        _directListingUrl   = url;
        // State 0: normal first-time run.
        // State 2: DOM Phase 1 ran first (before token arrived) and scraped only visible rows.
        //          HTTP Phase 1 can paginate — restart it now that we have the token.
        if (_directScrapeState === 0 || _directScrapeState === 2) {
            _directScrapeState = 1;
            _runDirectScrapePhase1();
        }
    }

    function _onDetailToken(token, url, idParam) {
        if (!_directDetailTokens.includes(token)) _directDetailTokens.push(token);
        if (!_directDetailUrl && url) _directDetailUrl = url;
        if (idParam && _directDetailIdParam === 'postingId') _directDetailIdParam = idParam;
        if (_directScrapeState === 2) {
            _directScrapeState = 3;
            _runDirectScrapePhase2();
        }
    }

    // ── Listing token detection (three layers, first hit wins) ───────────────
    //
    // 1. Performance API scan  — response already arrived before document_idle
    // 2. DOM dataset fallback  — interceptor writes token at send() time (before response),
    //                            so this catches slow responses that aren't in perf yet
    // 3. PerformanceObserver   — response arrives after document_idle
    //
    // The `page=` filter is omitted: My Applications initial URL may not include it.

    function _scanPerfForListingToken() {
        const ACTION_RE = /[?&]action=([^&\s]+)/;
        for (const entry of performance.getEntriesByType('resource')) {
            const url = entry.name;
            if ((url.includes('/jobs.htm') || url.includes('/applications.htm')) &&
                 ACTION_RE.test(url)) {
                const m = url.match(ACTION_RE);
                if (m) { _onListingToken(decodeURIComponent(m[1]), url); return true; }
            }
        }
        return false;
    }

    if (!_scanPerfForListingToken()) {
        // Layer 2: read from DOM dataset written by MAIN world interceptor at send() time.
        // More reliable than the Performance API when the response hasn't arrived yet.
        if (_root.dataset.wwaiListingToken && _root.dataset.wwaiListingUrl) {
            _onListingToken(_root.dataset.wwaiListingToken, _root.dataset.wwaiListingUrl);
        }

        // Layer 3: PerformanceObserver for responses that arrive after document_idle.
        if (!_directListingToken) {
            const _listingObserver = new PerformanceObserver((list) => {
                if (_directListingToken) { _listingObserver.disconnect(); return; }
                for (const entry of list.getEntries()) {
                    const url = entry.name;
                    if ((url.includes('/jobs.htm') || url.includes('/applications.htm')) &&
                         url.includes('action=')) {
                        const m = url.match(/[?&]action=([^&\s]+)/);
                        if (m) {
                            _onListingToken(decodeURIComponent(m[1]), url);
                            _listingObserver.disconnect();
                            return;
                        }
                    }
                }
            });
            _listingObserver.observe({ entryTypes: ['resource'] });
        }
    }

    // The PerformanceObserver disconnects once the first token is found, so page 2+
    // navigation is never detected there.  The MAIN world interceptor fires
    // __wwai_listing for every listing GET (including page nav) — listen here to catch them.
    document.addEventListener('__wwai_listing', (e) => _onListingToken(e.detail.token, e.detail.url));

    // ── Token bootstrap — read DOM dataset written by the MAIN world interceptor ─
    const _root = document.documentElement;

    // POST listing candidates captured before document_idle
    if (_root.dataset.wwaiListingCandidates) {
        _directListingCandidates = _root.dataset.wwaiListingCandidates.split('\n').filter(Boolean);
        if (_directScrapeState === 0 && !_directListingToken && _directListingCandidates.length) {
            _directScrapeState = 1;
            _runDirectScrapePhase1();
        }
    }
    // Future candidates (arrive after document_idle)
    document.addEventListener('__wwai_listing_candidate', (e) => {
        if (!_directListingCandidates.includes(e.detail.token)) {
            _directListingCandidates.push(e.detail.token);
            if (_directScrapeState === 0 && !_directListingToken) {
                _directScrapeState = 1;
                _runDirectScrapePhase1();
            }
        }
    });

    // Detail tokens
    if (_root.dataset.wwaiDetailTokens) {
        const savedIdParam = _root.dataset.wwaiDetailIdParam || 'postingId';
        for (const t of _root.dataset.wwaiDetailTokens.split('\n').filter(Boolean)) {
            _onDetailToken(t, _root.dataset.wwaiDetailUrl, savedIdParam);
        }
    }
    document.addEventListener('__wwai_detail_post', (e) => _onDetailToken(e.detail.token, e.detail.url, e.detail.idParam));

    // Kick off initial status + table sync after DOM settles
    _refreshStatus();
    _scheduleTableSync();
})();
