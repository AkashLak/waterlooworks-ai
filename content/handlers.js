// Async action handlers for the WaterlooWorks AI panel.
// Shares top-level scope with content.js — reads _currentJobId, _currentAnalyses,
// _batchRunning, _getCached, _setCached, and all renderer functions.

const POLL_INTERVAL_MS = 4_000;
const MAX_POLLS        = 30;
let _pollTimer  = null;
let _pollCount  = 0;
let _overlayEl  = null; // injected overlay for cross-page search results

// ── Job submission and analysis polling ────────────────────────────────────────

/**
 * Waits until the open modal has populated its content fields, or timeoutMs elapses.
 * WaterlooWorks opens the modal shell before fetching job detail via an internal API.
 */
function _waitForModalContent(timeoutMs = 5000) {
    const modal = WWScaper.getActiveModal();
    if (!modal) return Promise.resolve();

    const SETTLE_MS = 800;

    return new Promise((resolve) => {
        let settleTimer = null;
        let observer    = null; // declared before done() so observer?.disconnect() is always safe

        const done = () => {
            clearTimeout(hardTimer);
            clearTimeout(settleTimer);
            observer?.disconnect();
            resolve();
        };

        const hardTimer = setTimeout(done, timeoutMs);

        const bump = () => {
            clearTimeout(settleTimer);
            settleTimer = setTimeout(done, SETTLE_MS);
        };

        if (modal.querySelector('.tag__key-value-list p')?.textContent?.trim()) {
            bump(); // content already present — settle timer only, no observer needed
            return;
        }

        observer = new MutationObserver(() => {
            if (modal.querySelector('.tag__key-value-list p')?.textContent?.trim()) {
                // Disconnect immediately — prevents map tile mutations from
                // continuously resetting the settle timer
                observer.disconnect();
                observer = null;
                bump();
            }
        });
        observer.observe(modal, { subtree: true, childList: true });
    });
}

/**
 * Submits the open job to the backend, then polls for analyses if it's a new job.
 * Merges modal data with table-row data — location/city/openings/term/deadline are
 * only reliably available in the row, not the modal.
 * @param {Object} detail - Output of WWScaper.scrapeJobDetail()
 */
async function _submitAndPoll(detail) {
    // Wait for WaterlooWorks to finish loading modal content before scraping.
    await _waitForModalContent();

    // Re-scrape now that content fields are populated. Bail if modal was closed.
    const modal = WWScaper.getActiveModal();
    if (!modal) return;
    const fresh = WWScaper.scrapeJobDetail(modal) ?? detail;
    if (fresh.jobId !== detail.jobId) return;

    const row = WWScaper.scrapeRowByJobId(fresh.jobId) ?? {};
    const rawOpenings = row.openings || fresh.openings || '';
    const jobData = {
        ...fresh,
        location:              row.location     || fresh.location    || '',
        city:                  row.city    || fresh.city    || '',
        country:               fresh.country || '',
        openings:              parseInt(rawOpenings, 10) || null,
        term:                  row.term         || fresh.term        || '',
        deadline:              row.appDeadline  || fresh.appDeadline || null,
        organization:          row.organization || fresh.employer    || '',
        description:           WWScaper.extractJobDescription(fresh) || null,
        // WaterlooWorks label → camelCase key differs from what backend expects
        employmentArrangement: fresh.employmentLocationArrangement   || '',
        externalUrl:           _decodeHtml(fresh.ifByWebsiteGoTo || fresh.ifByEmailSendTo || ''),
    };

    let submitResult;
    try {
        submitResult = await WWAnalyzer.submitJob(jobData);
    } catch (_) {
        return;
    }

    if (submitResult.analysesReady && submitResult.analyses) {
        _currentAnalyses = submitResult.analyses;
        _renderAnalysesReady();
    } else {
        _setLoading('Analyzing new job…');
        _startPolling(detail.jobId);
    }
}

function _startPolling(jobId) {
    _clearPolling();
    _pollCount = 0;
    _schedulePoll(jobId);
}

function _schedulePoll(jobId) {
    _pollTimer = setTimeout(() => _pollTick(jobId), POLL_INTERVAL_MS);
}

async function _pollTick(jobId) {
    if (jobId !== _currentJobId) return;
    if (_pollCount >= MAX_POLLS) {
        _clearPolling();
        if (_currentDetail) {
            _submitAndPoll(_currentDetail);
        } else {
            _clearLoading();
            _showRetryPolling(jobId);
        }
        return;
    }
    _pollCount++;
    try {
        const result = await WWAnalyzer.getJobAnalyses(jobId);
        if (result.analysesReady && result.analyses) {
            _currentAnalyses = result.analyses;
            _clearPolling();
            _renderAnalysesReady();
        } else {
            _schedulePoll(jobId);
        }
    } catch (_) {
        _schedulePoll(jobId);
    }
}

function _clearPolling() {
    clearTimeout(_pollTimer);
    _pollTimer = null;
    _pollCount = 0;
}

function _showRetryPolling(jobId) {
    const container = document.getElementById('wwai-result');
    container.innerHTML = '';
    container.classList.remove('wwai-hidden');
    const card = document.createElement('div');
    card.className = 'wwai-result';
    const p = document.createElement('p');
    p.textContent = 'Analysis is taking longer than expected.';
    const btn = document.createElement('button');
    btn.className = 'wwai-btn wwai-btn--full';
    btn.style.marginTop = '8px';
    btn.textContent = 'Retry';
    btn.addEventListener('click', async () => {
        container.innerHTML = '';
        container.classList.add('wwai-hidden');
        try {
            const check = await WWAnalyzer.getJobAnalyses(jobId);
            if (check.analysesReady && check.analyses) {
                _currentAnalyses = check.analyses;
                _renderAnalysesReady();
                return;
            }
        } catch (_) {}
        if (_currentDetail) {
            _submitAndPoll(_currentDetail);
        } else {
            _startPolling(jobId);
        }
    });
    card.appendChild(p); card.appendChild(btn); container.appendChild(card);
}

// ── Table sync ─────────────────────────────────────────────────────────────────

let _tableSyncScheduled = false;

function _scheduleTableSync() {
    if (_tableSyncScheduled || _batchRunning) return;
    _tableSyncScheduled = true;
    setTimeout(_onTableChange, 1_500);
}

function _qaHasAlternateTitles(qa) {
    if (!qa) return false;
    return Array.isArray(qa.alternativeTitles) && qa.alternativeTitles.length > 0;
}

function _showSniffFlag(qa) {
    const flag = document.getElementById('wwai-sniff-flag');
    if (flag) flag.textContent = '💡 Related Job Titles ▾';
    _show('wwai-sniff-flag');
    const detailEl = document.getElementById('wwai-sniff-detail');
    if (detailEl && !detailEl.innerHTML.trim()) {
        const card = document.createElement('div');
        card.className = 'wwai-result';
        _fillQaSniff(card, qa);
        detailEl.appendChild(card);
    }
}

function _renderAnalysesReady() {
    // Show sniff flag whenever alternate titles exist — collapsed by default, expands on click
    // Fall back to the allJobsMap snapshot if the analyses response didn't include qa_disguise
    const qa = _currentAnalyses?.qa_disguise
            ?? _allJobsMap[_currentJobId]?.qa_disguise
            ?? null;
    if (_qaHasAlternateTitles(qa)) {
        _showSniffFlag(qa);
    }

    // Show first dayToDay bullet as a one-line role preview
    const roleRaw = _currentAnalyses?.role_explainer;
    let firstBullet = '';
    if (typeof roleRaw === 'string') {
        try { firstBullet = JSON.parse(roleRaw)?.dayToDay?.[0] ?? ''; }
        catch { firstBullet = roleRaw.split(/\.\s/)[0].trim(); }
    } else if (Array.isArray(roleRaw?.dayToDay)) {
        firstBullet = roleRaw.dayToDay[0] ?? '';
    }
    if (firstBullet) {
        const preview = document.getElementById('wwai-role-preview');
        preview.textContent = firstBullet.endsWith('.') ? firstBullet : firstBullet + '.';
        _show('wwai-role-preview');
    }

    _clearLoading();

    // Silently pre-fetch fit score so clicking Should I Apply? is instant
    _prefetchFitScore();
}

async function _prefetchFitScore() {
    const jobId = _currentJobId; // capture before any await — modal may close while scoring runs
    if (!jobId || _getCached(jobId, 'BEST_FIT')) return;
    try {
        const fit = await WWAnalyzer.getFitScore(jobId);
        _setCached(jobId, 'BEST_FIT', fit);
        _setCached(jobId, 'BATCH_FIT', fit);
        // Inject badge even if modal closed — table row is always in the DOM
        const tableRow = WWScaper.scrapeRowByJobId(jobId);
        if (tableRow) _injectBadge(tableRow, fit.fitScore ?? fit.fit_score);
    } catch (_) {}
}

async function _onTableChange() {
    _tableSyncScheduled = false;
    const rows = WWScaper.scrapeAllListingRows();
    if (!rows.length) return;

    // Strip titleEl (DOM node) before sending — it's only needed for batch click()
    const rowData = rows.map(({ titleEl, ...rest }) => rest).filter(r => r.jobId);
    if (!rowData.length) return;

    // Detect rows that appeared after Phase 1 ran (new postings, pagination, etc.)
    if (_directScrapeRows) {
        const knownIds = new Set(_directScrapeRows.map(r => r.jobId));
        const newRows  = rowData.filter(r => !knownIds.has(r.jobId));
        if (newRows.length) {
            _directScrapeRows = [..._directScrapeRows, ...newRows];
            if (_directScrapeState === 4 && _directHtmlDetailToken) {
                // Phase 2 already ran — scrape new rows immediately using the cached token
                _fetchAndSubmitDescriptions(newRows, `Loading ${newRows.length} new job description${newRows.length !== 1 ? 's' : ''}`)
                    .then(() => { _refreshStatus(); _scheduleTableSync(); })
                    .catch(() => {});
            }
            // If state === 2 (awaiting first click), the new rows are now in _directScrapeRows
            // and will be included automatically when Phase 2 triggers on the next click.
        }
    }

    try {
        await WWAnalyzer.syncActiveJobs(rowData);
        const response = await WWAnalyzer.getAllJobs();
        const jobs     = response.jobs ?? (Array.isArray(response) ? response : []);
        const jobsMap  = {};
        for (const job of jobs) {
            const id = job.jobId ?? job.id;
            if (id) jobsMap[id] = job;
        }
        _allJobsMap = jobsMap; // cache for sniff flag fallback in _renderAnalysesReady

        // If a job modal is open and the sniff flag hasn't shown yet
        // (because _renderAnalysesReady ran before this map was ready), show it now.
        if (_currentJobId) {
            const flag = document.getElementById('wwai-sniff-flag');
            if (flag && flag.classList.contains('wwai-hidden')) {
                const qa = _allJobsMap[_currentJobId]?.qa_disguise ?? null;
                if (_qaHasAlternateTitles(qa)) _showSniffFlag(qa);
            }
        }

        // Clear stale session cache for jobs the backend no longer has a record of.
        // Prevents old scores from a wiped DB from showing as badges.
        for (const row of rows) {
            if (row.jobId && !jobsMap[row.jobId]) {
                ['BEST_FIT', 'BATCH_FIT', 'DREAM_JOB', 'QA_SNIFF', 'ROLE_EXPLAINER'].forEach(mode =>
                    sessionStorage.removeItem(_cacheKey(row.jobId, mode))
                );
            }
        }

        _injectPrecomputedBadges(rows, jobsMap);
        _refreshStatus();

        // Re-apply active filter to newly rendered rows (e.g. after WW page navigation).
        // Skip when the overlay is showing — overlay already displays all results; no DOM hiding needed.
        if (!_overlayEl && _activeFilter && _filterMeta) {
            const { shown } = _filterTable([..._activeFilter], _filterMeta.query, _filterMeta.emptyMsg);
            _filterMeta.shown = shown;
            _renderFilterCard(shown, _filterMeta.total, _filterMeta.query, _filterMeta.emptyMsg);
        }
    } catch (_) {}
}

// ── Single-job analysis handlers ───────────────────────────────────────────────

async function _restoreAnalyses(jobId) {
    _setLoading('Loading analyses…');
    try {
        const result = await WWAnalyzer.getJobAnalyses(jobId);
        if (result.analysesReady && result.analyses) {
            _currentAnalyses = result.analyses;
            _clearLoading();
            _renderAnalysesReady();
        } else {
            // Analyses still computing — resume polling
            _startPolling(jobId);
        }
    } catch (_) { _clearLoading(); }
}

async function _handleFitScore() {
    if (!_currentJobId) return;
    if (_pollTimer) { _renderError({ message: 'Analysis in progress — please wait a moment and try again.' }); return; }
    const cached = _getCached(_currentJobId, 'BEST_FIT');
    if (cached) { _renderResult('BEST_FIT', cached); return; }
    _setLoading('Analyzing fit…'); _clearResult();
    try {
        const result = await WWAnalyzer.getFitScore(_currentJobId);
        _setCached(_currentJobId, 'BEST_FIT', result);
        _renderResult('BEST_FIT', result);
    } catch (err) { _renderError(err); } finally { _clearLoading(); }
}

async function _handlePrecomputed(mode) {
    if (!_currentJobId) return;
    if (mode === 'DREAM_JOB') { await _handleDreamFit(); return; }
    const cached = _getCached(_currentJobId, mode);
    if (cached) { _renderResult(mode, cached); return; }
    const KEY_MAP = { QA_SNIFF: 'qa_disguise', ROLE_EXPLAINER: 'role_explainer' };
    const key = KEY_MAP[mode];
    const data = key && _currentAnalyses ? _currentAnalyses[key] : null;
    if (data) { _setCached(_currentJobId, mode, data); _renderResult(mode, data); }
    else if (_pollTimer) _renderError({ message: 'Analysis in progress — please wait a moment and try again.' });
    else _renderError({ message: 'Analysis not yet available. Try reopening this job.' });
}

async function _handleDreamFit() {
    if (_pollTimer) { _renderError({ message: 'Analysis in progress — please wait a moment and try again.' }); return; }
    const cached = _getCached(_currentJobId, 'DREAM_JOB');
    if (cached) { _renderResult('DREAM_JOB', cached); return; }
    _setLoading('Assessing dream fit…'); _clearResult();
    try {
        const dreamCriteria = await _loadDreamCriteria();
        const result = await WWAnalyzer.getDreamFit(_currentJobId, dreamCriteria);
        _setCached(_currentJobId, 'DREAM_JOB', result);
        _renderResult('DREAM_JOB', result);
    } catch (err) { _renderError(err); }
    finally { _clearLoading(); }
}

function _loadDreamCriteria() {
    return new Promise(resolve =>
        chrome.storage.local.get('ww_dream_criteria', d => resolve(d.ww_dream_criteria ?? null))
    );
}

async function _handleAsk(question) {
    if (!_currentJobId) return;
    _setLoading('Thinking…');
    _clearResult();
    try {
        const result = await WWAnalyzer.askQuestion(_currentJobId, question);
        const answer = typeof result === 'string' ? result : (result.answer ?? JSON.stringify(result));
        _renderResult('ASK', { question, answer });
        document.getElementById('wwai-ask-input').value = '';
    } catch (err) {
        _renderError(err);
    } finally {
        _clearLoading();
    }
}

// ── Smart Suggestions ──────────────────────────────────────────────────────────

const SEARCH_LABELS = { top_fits: 'Top 10 Fits', closing_soon: 'Closing in 3 Days' };

async function _handleShouldIApply() {
    if (!_currentJobId) return;
    if (_pollTimer) { _renderError({ message: 'Analysis in progress — please wait a moment and try again.' }); return; }
    _setLoading('Evaluating…'); _clearResult();
    try {
        const cached = _getCached(_currentJobId, 'BEST_FIT');
        const fit = cached ?? await (async () => {
            const r = await WWAnalyzer.getFitScore(_currentJobId);
            _setCached(_currentJobId, 'BEST_FIT', r);
            return r;
        })();

        // Ensure badge is in the table (prefetch may have already done this, but guard for direct clicks)
        if (!_getCached(_currentJobId, 'BATCH_FIT')) {
            _setCached(_currentJobId, 'BATCH_FIT', fit);
            const tableRow = WWScaper.scrapeRowByJobId(_currentJobId);
            if (tableRow) _injectBadge(tableRow, fit.fitScore ?? fit.fit_score);
        }

        const dream = _currentAnalyses?.dream_job ?? null;
        const qa    = _currentAnalyses?.qa_disguise ?? null;
        _renderResult('SHOULD_APPLY', { fit, dream, qa });
    } catch (err) { _renderError(err); }
    finally { _clearLoading(); }
}

const SEARCH_EMPTY_MESSAGES = {
    closing_soon: 'No jobs closing within 3 days — deadlines may have passed or these jobs haven\'t been analyzed yet.',
    top_fits:     'No fit scores yet — open some job postings and run Score All Jobs to build your Top 10.',
};

async function _handleFreeSearch(query) {
    _clearTableFilter();
    _setLoading(`Searching "${query}"…`); _clearResult();
    try {
        const result = await WWAnalyzer.searchJobs({ criteria: 'free_search', query });
        const jobs = result.jobs ?? result.results ?? (Array.isArray(result) ? result : []);

        let emptyMsg = null;
        if (!jobs.length && _directScrapeState < 4) {
            const asksForModalFields = /\b(month|hybrid|remote|in.person|on.?site|arrangement|skill|education|duration|gpa)\b/i.test(query);
            if (asksForModalFields) {
                emptyMsg = 'Work term duration, hybrid/remote, and skills details aren\'t loaded yet — click any job title once, then search again.';
            }
        }

        _showSearchOverlay(jobs, query, emptyMsg);
        _renderFilterCard(jobs.length, jobs.length, query, emptyMsg);
    } catch (err) { _renderError(err); }
    finally { _clearLoading(); }
}

async function _handleSearch(searchType) {
    _clearTableFilter();
    _setLoading(`Searching ${SEARCH_LABELS[searchType] ?? searchType}…`);
    _clearResult();
    try {
        const result = await WWAnalyzer.searchJobs({ criteria: searchType });
        let jobs = result.jobs ?? result.results ?? (Array.isArray(result) ? result : []);

        // Filter to jobs from the current cycle's All Jobs listing.
        // _directScrapeRows is populated by Phase 1 from the live listing — any job
        // not in that set belongs to a previous cycle and should not appear here.
        if (_directScrapeRows?.length) {
            const currentIds = new Set(_directScrapeRows.map(r => String(r.jobId)));
            jobs = jobs.filter(j => currentIds.has(String(j.jobId ?? j.id ?? '')));
        }

        const label    = SEARCH_LABELS[searchType] ?? searchType;
        const emptyMsg = SEARCH_EMPTY_MESSAGES[searchType] ?? null;
        _showSearchOverlay(jobs, label, emptyMsg);
        _renderFilterCard(jobs.length, jobs.length, label, emptyMsg);
    } catch (err) {
        _renderError(err);
    } finally {
        _clearLoading();
    }
}

// ── Status line ────────────────────────────────────────────────────────────────

function _updateStatusLine(jobCount) {
    const el = document.getElementById('wwai-status-line');
    if (el) el.textContent = `${jobCount ?? 0} jobs in database`;
}

async function _refreshStatus() {
    try {
        const status = await WWAnalyzer.getStatus();
        _updateStatusLine(status.totalJobs ?? status.jobCount ?? 0);
    } catch (_) {}
}

// ── Batch analysis ─────────────────────────────────────────────────────────────

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _formatDate(iso) {
    try {
        return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return iso; }
}

function _decodeHtml(str) {
    if (!str) return str;
    const el = document.createElement('textarea');
    el.innerHTML = str;
    return el.value;
}

async function _handleBatch() {
    if (_batchRunning) return;

    const resume = await WWStorage.getResume();
    if (!resume) {
        _renderError({ type: 'no_resume' });
        _show('wwai-result');
        return;
    }

    _batchRunning = true;
    WWAnalyzer.resetBatchCancel();

    _show('wwai-batch-progress');
    _hide('wwai-batch-summary');
    document.getElementById('wwai-batch-bar').style.width = '0%';

    let allJobsMap = {};
    try {
        const response = await WWAnalyzer.getAllJobs();
        const jobs = response.jobs ?? (Array.isArray(response) ? response : []);
        for (const job of jobs) {
            const id = job.jobId ?? job.id;
            if (id) allJobsMap[id] = job;
        }
    } catch (_) {}

    const rows = WWScaper.scrapeAllListingRows();
    const stats = { great: 0, decent: 0, poor: 0 };
    let unseenCount = 0, scoredCount = 0;
    const bar = document.getElementById('wwai-batch-bar'), txt = document.getElementById('wwai-batch-text');

    for (let i = 0; i < rows.length; i++) {
        if (WWAnalyzer.isBatchCancelled()) break;
        const row = rows[i];
        const jobRec = allJobsMap[row.jobId];
        bar.style.width = `${Math.round(((i + 1) / rows.length) * 100)}%`;

        if (!jobRec) { unseenCount++; _injectBadge(row, null); continue; }

        // Skip jobs with no description — scoring without content produces meaningless results
        const hasDescription = !!(jobRec.job_summary || jobRec.job_responsibilities);
        if (!hasDescription) { unseenCount++; _injectBadge(row, null); continue; }

        const fitScore = jobRec.fitScore ?? jobRec.fit_score ?? null;
        if (fitScore != null) {
            _setCached(row.jobId, 'BATCH_FIT', { fitScore });
            _injectBadge(row, fitScore);
            _tallyStat(stats, fitScore);
            scoredCount++;
        } else {
            // Check session cache before making an API call
            const sessionCached = _getCached(row.jobId, 'BEST_FIT');
            if (sessionCached) {
                const cachedScore = sessionCached.fitScore ?? sessionCached.fit_score;
                _setCached(row.jobId, 'BATCH_FIT', sessionCached);
                _injectBadge(row, cachedScore);
                _tallyStat(stats, cachedScore);
                scoredCount++;
            } else {
                txt.textContent = `Scoring job ${scoredCount + 1} of ${rows.length - unseenCount}…`;
                try {
                    const fit = await WWAnalyzer.getFitScore(row.jobId);
                    const score = fit.fitScore ?? fit.fit_score;
                    _setCached(row.jobId, 'BEST_FIT', fit);
                    _setCached(row.jobId, 'BATCH_FIT', fit);
                    _injectBadge(row, score);
                    _tallyStat(stats, score);
                    scoredCount++;
                } catch (_) { _injectBadge(row, null); }
            }
        }
    }

    _batchRunning = false;
    _hide('wwai-batch-progress');
    const parts = [`🟢 ${stats.great} great fits`, `🟡 ${stats.decent} decent matches`, `🔴 ${stats.poor} poor fits`];
    if (unseenCount) parts.push(`${unseenCount} need descriptions — open each title once to enable scoring`);
    if (WWAnalyzer.isBatchCancelled()) parts.push('(cancelled)');
    const summaryEl = document.getElementById('wwai-batch-summary');
    summaryEl.textContent = parts.join(' · ');
    _show('wwai-batch-summary');

    // Silently pre-compute fit scores for all other DB jobs with descriptions.
    // When the user navigates to other pages, _injectPrecomputedBadges reads
    // session cache and shows badges immediately without any extra work.
    if (!WWAnalyzer.isBatchCancelled()) {
        const visibleIds = new Set(rows.map(r => r.jobId));
        const toPrecompute = Object.entries(allJobsMap).filter(([id, job]) =>
            !visibleIds.has(id) &&
            !!(job.job_summary || job.job_responsibilities) &&
            !_getCached(id, 'BATCH_FIT')
        );
        for (const [id] of toPrecompute) {
            try {
                const fit = await WWAnalyzer.getFitScore(id);
                _setCached(id, 'BEST_FIT', fit);
                _setCached(id, 'BATCH_FIT', fit);
            } catch (_) {}
        }
    }
}

// ── Direct HTTP scraping ────────────────────────────────────────────────────────
//
// Phase 1 — fetch all listing pages (JSON) → sync row-level data to backend.
//            Triggered by __wwai_listing event (fires automatically on page load).
// Phase 2 — fetch each job's description HTML → submit full jobData to backend.
//            Triggered by __wwai_detail_post event (fires when user first clicks a job).
//
// Both phases use WaterlooWorks's own authenticated session — no extra login needed.

const _SCRAPE_CONCURRENCY = 5; // max simultaneous detail fetches

async function _directFetch(url, options, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;
        } catch (_) {}
        if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
    return null;
}

async function _runDirectScrapePhase1() {
    if (!_directListingToken || !_directListingUrl) {
        _directScrapeState = 0;
        return;
    }

    _updateStatusLine('Syncing all jobs…');

    const template = new URL(_directListingUrl);
    template.searchParams.set('itemsPerPage', '100');

    const allRows = [];
    let page  = 1;
    let total = Infinity;

    while (allRows.length < total) {
        template.searchParams.set('page', String(page));
        const res = await _directFetch(template.toString());
        if (!res) break;

        let json;
        try { json = await res.json(); } catch { break; }

        if (total === Infinity) total = json.totalResults ?? 0;
        if (!json.data?.length) break;

        for (const apiRow of json.data) {
            const row = WWScaper.parseListingRow(apiRow);
            if (row.jobId) allRows.push(row);
        }

        if (allRows.length >= total) break;
        page++;
    }

    if (!allRows.length) {
        _directScrapeState = 0;
        await _refreshStatus();
        return;
    }

    _directScrapeRows  = allRows;
    _lastKnownTotal    = allRows.length;

    // Sync row-level metadata to backend immediately (no descriptions yet)
    const syncPayload = allRows.map(({ boardUrl, ...r }) => r);
    try { await WWAnalyzer.syncActiveJobs(syncPayload); } catch (_) {}

    _scheduleTableSync(); // refresh badge injection with newly synced rows

    // Start background check for new postings — one API call every 5 min while WW is open
    if (_periodicCheckTimer) clearInterval(_periodicCheckTimer);
    _periodicCheckTimer = setInterval(_runPeriodicNewJobCheck, 5 * 60 * 1000);

    if (_directDetailTokens.length > 0) {
        _directScrapeState = 3;
        _runDirectScrapePhase2();
    } else {
        _directScrapeState = 2;
        _updateStatusLine(`${allRows.length} jobs synced — click any job once to load descriptions`);
    }
}

async function _runDirectScrapePhase2() {
    const rows = _directScrapeRows;
    if (!rows?.length || !_directDetailTokens.length) return;

    // Ask the DB which jobs already have descriptions — skip those, only fetch new ones
    let describedIds = new Set();
    try {
        const response = await WWAnalyzer.getAllJobs();
        const jobs = response.jobs ?? (Array.isArray(response) ? response : []);
        for (const job of jobs) {
            const id = String(job.jobId ?? job.id ?? '');
            // Only skip if description AND location fields are already populated.
            // Jobs with a description but null city/country still need a re-fetch.
            if (id && (job.job_summary || job.job_responsibilities) && job.city && job.country) {
                describedIds.add(id);
            }
        }
    } catch (_) {}

    const rowsToFetch = rows.filter(r => !describedIds.has(String(r.jobId)));

    if (!rowsToFetch.length) {
        _directScrapeState = 4;
        _updateStatusLine(`${rows.length} jobs already loaded`);
        await _refreshStatus();
        return;
    }

    // Find which captured token returns job detail HTML (not the JSON geo-data token)
    const htmlToken = await _findHtmlDetailToken(rowsToFetch[0]);
    if (!htmlToken) {
        _directScrapeState = 4;
        _updateStatusLine(`${describedIds.size} jobs loaded`);
        await _refreshStatus();
        return;
    }

    // Cache token and resolved base URL — _onTableChange uses these for new rows later
    _directHtmlDetailToken = htmlToken;
    _directDetailBase = _directDetailUrl
        ? new URL(_directDetailUrl, window.location.origin).href
        : _directListingUrl
            ? `${new URL(_directListingUrl).origin}${new URL(_directListingUrl).pathname}`
            : `${window.location.origin}/myAccount/co-op/full/jobs.htm`;

    const label = describedIds.size > 0
        ? `Loading ${rowsToFetch.length} new job description${rowsToFetch.length !== 1 ? 's' : ''}`
        : `Loading ${rowsToFetch.length} job description${rowsToFetch.length !== 1 ? 's' : ''}`;
    await _fetchAndSubmitDescriptions(rowsToFetch, label);

    _directScrapeState = 4;
    await _refreshStatus();
    _scheduleTableSync();
}

// Fetches and submits descriptions for a given set of rows using the cached HTML token.
// Called by Phase 2 on initial load and by _onTableChange for any new rows that appear later.
async function _fetchAndSubmitDescriptions(rows, statusLabel) {
    let completed = 0;
    const total = rows.length;
    _updateStatusLine(`${statusLabel}…`);

    for (let i = 0; i < total; i += _SCRAPE_CONCURRENCY) {
        await Promise.all(
            rows.slice(i, i + _SCRAPE_CONCURRENCY).map(async (row) => {
                if (!row.jobId) return;
                try {
                    const body = `action=${encodeURIComponent(_directHtmlDetailToken)}&postingId=${encodeURIComponent(row.jobId)}`;
                    const res  = await _directFetch(_directDetailBase, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body,
                    });
                    if (!res) return;

                    const html = await res.text();
                    if (!html.includes('tag__key-value-list')) return;

                    const detail = WWScaper.scrapeJobDetailFromHtml(
                        html, row.jobId, row.title, row.employer, row.division
                    );
                    if (!detail) return;

                    // Fetch geo data in parallel — city/country come from WW's separate geo endpoint
                    const geo = await _fetchGeoData(row.jobId);

                    const jobData = {
                        ...detail,
                        location:              row.location    || detail.location    || '',
                        city:                  row.city        || geo.city           || detail.city    || '',
                        country:               geo.country     || detail.country     || '',
                        openings:              (row.openings ?? parseInt(detail.openings, 10)) || null,
                        term:                  row.term        || detail.term        || '',
                        deadline:              row.appDeadline || detail.appDeadline || null,
                        organization:          row.employer    || detail.employer    || '',
                        description:           WWScaper.extractJobDescription(detail) || null,
                        employmentArrangement: detail.employmentLocationArrangement  || '',
                        externalUrl:           _decodeHtml(detail.ifByWebsiteGoTo || detail.ifByEmailSendTo || ''),
                    };

                    await WWAnalyzer.submitJob(jobData);
                    completed++;
                } catch (_) {}
            })
        );
        if (i + _SCRAPE_CONCURRENCY < total) {
            _updateStatusLine(`${statusLabel}… ${completed}/${total}`);
        }
    }

    _updateStatusLine(`${completed} jobs ready`);
}

async function _findHtmlDetailToken(sampleRow) {
    // Try each captured POST token on a single job.
    // One token returns HTML (job fields) — that's the HTML token.
    // Another returns JSON with geo data (city, country) — cache that too.
    const detailUrl = _directDetailUrl
        ? new URL(_directDetailUrl, window.location.origin).href
        : _directListingUrl
            ? `${new URL(_directListingUrl).origin}${new URL(_directListingUrl).pathname}`
            : `${window.location.origin}/myAccount/co-op/full/jobs.htm`;

    let htmlToken = null;

    for (const token of _directDetailTokens) {
        const body = `action=${encodeURIComponent(token)}&postingId=${encodeURIComponent(sampleRow.jobId)}`;
        const res  = await _directFetch(detailUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        if (!res) continue;
        const text = await res.text();
        if (text.includes('tag__key-value-list')) {
            htmlToken = token;
        } else {
            try {
                const geo = JSON.parse(text);
                if (geo && (geo.city !== undefined || geo.country !== undefined || geo.data)) {
                    _directGeoToken = token;
                }
            } catch (_) {}

        }
    }

    return htmlToken;
}

// Fetches geo data (city, country) for a single job using the cached geo token.
// Returns { city, country } or {} if geo token unavailable or response unrecognised.
async function _fetchGeoData(jobId) {
    if (!_directGeoToken || !_directDetailBase) return {};
    try {
        const body = `action=${encodeURIComponent(_directGeoToken)}&postingId=${encodeURIComponent(jobId)}`;
        const res  = await _directFetch(_directDetailBase, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        if (!res) return {};
        const text = await res.text();
        const geo  = JSON.parse(text);
        // WW geo response shape varies — look for city/country at top level or nested
        const city    = geo.city    ?? geo.location ?? geo.data?.city    ?? null;
        const country = geo.country ?? geo.data?.country ?? null;
        return { city: city || null, country: country || null };
    } catch (_) {
        return {};
    }
}

// ── Periodic new-job detection ─────────────────────────────────────────────────
//
// Runs every 5 minutes while WaterlooWorks is open.
// Strategy: fetch page 1 of the listing to read totalResults.
// If totalResults > _lastKnownTotal, new jobs exist — scan pages until
// we've collected exactly that many new job IDs, then sync + fetch descriptions.
// On most ticks nothing changed: 1 API call, returns immediately.

async function _runPeriodicNewJobCheck() {
    if (!_directListingToken || !_directListingUrl) return;
    if (_directScrapeState < 4) return; // Phase 2 still running — skip this tick

    try {
        const template = new URL(_directListingUrl);
        template.searchParams.set('itemsPerPage', '100');
        template.searchParams.set('page', '1');

        const res = await _directFetch(template.toString());
        if (!res) return;

        let json;
        try { json = await res.json(); } catch { return; }

        const currentTotal = json.totalResults ?? 0;
        if (currentTotal <= _lastKnownTotal) return; // nothing new

        const newCount = currentTotal - _lastKnownTotal;
        const knownIds = new Set((_directScrapeRows ?? []).map(r => r.jobId));
        const newRows  = [];

        // Collect new job IDs from page 1 (already fetched) then continue if needed
        let pageJson = json;
        let page     = 1;
        const MAX_PAGES = 60;

        while (newRows.length < newCount && page <= MAX_PAGES) {
            if (page > 1) {
                template.searchParams.set('page', String(page));
                const pageRes = await _directFetch(template.toString());
                if (!pageRes) break;
                try { pageJson = await pageRes.json(); } catch { break; }
            }
            if (!pageJson.data?.length) break;

            for (const apiRow of pageJson.data) {
                const row = WWScaper.parseListingRow(apiRow);
                if (row.jobId && !knownIds.has(row.jobId)) {
                    newRows.push(row);
                    knownIds.add(row.jobId);
                }
            }
            page++;
        }

        _lastKnownTotal = currentTotal;
        if (!newRows.length) return;

        // Merge into known rows and sync row-level data
        _directScrapeRows = [...(_directScrapeRows ?? []), ...newRows];
        const syncPayload = newRows.map(({ boardUrl, ...r }) => r);
        try { await WWAnalyzer.syncActiveJobs(syncPayload); } catch (_) {}

        // Fetch descriptions automatically if token is cached from Phase 2
        if (_directHtmlDetailToken && _directDetailBase) {
            await _fetchAndSubmitDescriptions(
                newRows,
                `Loading ${newRows.length} new job description${newRows.length !== 1 ? 's' : ''}`
            );
            await _refreshStatus();
            _scheduleTableSync();
        } else {
            _updateStatusLine(`${newRows.length} new job${newRows.length !== 1 ? 's' : ''} found — click any job to load descriptions`);
        }
    } catch (_) {}
}

function _tallyStat(stats, score) {
    if (score >= 70) stats.great++;
    else if (score >= 40) stats.decent++;
    else stats.poor++;
}

// ── Cross-page search overlay ──────────────────────────────────────────────────
//
// Shows ALL backend search results (every WW page) in a full-page table overlaid
// on WaterlooWorks.  Clicking a job title opens WW's native modal for that job:
//   • job is in the current DOM table → find the <a> and click it directly
//   • job is on another page → dispatch __wwai_open_job to the MAIN world,
//     which calls WW's viewPosting() to load the modal without page navigation

function _showSearchOverlay(jobs, query, emptyMsg) {
    _hideSearchOverlay();
    _filterMeta = { shown: jobs.length, total: jobs.length, query, emptyMsg: emptyMsg ?? null };

    const overlay = document.createElement('div');
    overlay.id = 'wwai-search-overlay';

    // ── Header bar ─────────────────────────────────────────────────────────────
    const bar = document.createElement('div');
    bar.className = 'wwai-overlay-bar';

    const barTitle = document.createElement('span');
    barTitle.className = 'wwai-overlay-bar__title';
    barTitle.textContent = jobs.length
        ? `${jobs.length} result${jobs.length !== 1 ? 's' : ''} for "${query}"`
        : `No results for "${query}"`;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'wwai-overlay-bar__clear';
    clearBtn.textContent = 'Clear filter ✕';
    clearBtn.addEventListener('click', () => { _clearTableFilter(); _clearResult(); _show('wwai-empty'); });

    bar.appendChild(barTitle);
    bar.appendChild(clearBtn);

    // ── Body ────────────────────────────────────────────────────────────────────
    const bodyEl = document.createElement('div');
    bodyEl.className = 'wwai-overlay-body';

    if (!jobs.length) {
        const emptyEl = document.createElement('p');
        emptyEl.className = 'wwai-overlay-empty';
        emptyEl.textContent = emptyMsg ?? `No matching jobs found for "${query}".`;
        bodyEl.appendChild(emptyEl);
    } else {
        const table = document.createElement('table');
        table.className = 'wwai-overlay-table';

        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        ['Job Title', 'Employer', 'City', 'Term', 'Deadline', 'Fit'].forEach(label => {
            const th = document.createElement('th');
            th.textContent = label;
            htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const job of jobs) {
            const jobId = String(job.jobId ?? job.id ?? '');
            const tr = document.createElement('tr');
            tr.className = 'wwai-overlay-row';

            const tdTitle = document.createElement('td');
            const titleBtn = document.createElement('button');
            titleBtn.className = 'wwai-overlay-title-btn';
            titleBtn.textContent = job.title ?? '';
            if (jobId) titleBtn.addEventListener('click', () => _openJobFromOverlay(jobId));
            tdTitle.appendChild(titleBtn);

            const tdEmp = document.createElement('td');
            tdEmp.textContent = job.employer ?? job.organization ?? '';

            const tdCity = document.createElement('td');
            tdCity.textContent = job.city ?? '';

            const tdTerm = document.createElement('td');
            const rawDur = job.term ?? job.work_term_duration ?? '';
            tdTerm.textContent = rawDur.replace(/\s*work\s*term\s*/i, '').trim();

            const tdDead = document.createElement('td');
            const rawDeadline = job.deadline ?? job.app_deadline ?? '';
            tdDead.textContent = rawDeadline ? _formatDate(rawDeadline) : '';

            const tdFit = document.createElement('td');
            const cached = _getCached(jobId, 'BATCH_FIT') ?? _getCached(jobId, 'BEST_FIT');
            const score  = job.fitScore ?? job.fit_score ?? cached?.fitScore ?? cached?.fit_score ?? null;
            if (score != null) {
                const badge = document.createElement('span');
                badge.className = `wwai-overlay-badge wwai-overlay-badge--${score >= 70 ? 'great' : score >= 40 ? 'decent' : 'poor'}`;
                badge.textContent = String(score);
                tdFit.appendChild(badge);
            }

            tr.appendChild(tdTitle); tr.appendChild(tdEmp);  tr.appendChild(tdCity);
            tr.appendChild(tdTerm);  tr.appendChild(tdDead); tr.appendChild(tdFit);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        bodyEl.appendChild(table);
    }

    overlay.appendChild(bar);
    overlay.appendChild(bodyEl);
    document.body.appendChild(overlay);
    _overlayEl = overlay;
}

function _hideSearchOverlay() {
    if (_overlayEl) { _overlayEl.remove(); _overlayEl = null; }
}

function _openJobFromOverlay(jobId) {
    if (!jobId) return;
    // Always dispatch to the MAIN world — WW title links use javascript: hrefs which
    // Chrome blocks when clicked programmatically from extension context (CSP violation).
    // viewPosting() called natively from interceptor.js is exempt from that restriction.
    document.dispatchEvent(new CustomEvent('__wwai_open_job', { detail: { postingId: jobId } }));
}

// ── DOM table filtering (kept for _onTableChange re-apply when overlay is off) ──

function _filterTable(jobIds, label = '', emptyMsg = null) {
    const idSet = new Set(jobIds.map(String));
    _activeFilter = idSet;
    const allRows = WWScaper.scrapeAllListingRows();
    let shown = 0, hidden = 0;
    for (const row of allRows) {
        const tr = row.titleEl?.closest('tr.table__row--body');
        if (!tr) continue;
        if (row.jobId && idSet.has(String(row.jobId))) { tr.style.display = ''; shown++; }
        else                                           { tr.style.display = 'none'; hidden++; }
    }
    _filterMeta = { shown, total: jobIds.length, hidden, query: label, emptyMsg };
    return { shown, hidden };
}

function _clearTableFilter() {
    _activeFilter = null;
    _filterMeta   = null;
    _hideSearchOverlay();
    document.querySelectorAll('tr.table__row--body').forEach(tr => { tr.style.display = ''; });
}

function _renderFilterCard(shown, total, query, emptyMsg) {
    const container = document.getElementById('wwai-result');
    container.innerHTML = '';
    container.classList.remove('wwai-hidden');
    const card = document.createElement('div');
    card.className = 'wwai-result';
    const noMatch = emptyMsg ?? `No matching jobs found for "${query}".`;
    const msg = shown > 0
        ? `Showing ${shown} match${shown !== 1 ? 'es' : ''} for "${query}".`
        : noMatch;
    const p = document.createElement('p');
    p.className = 'wwai-verdict';
    p.textContent = msg;
    const btn = document.createElement('button');
    btn.className = 'wwai-btn wwai-btn--full';
    btn.style.marginTop = '8px';
    btn.textContent = 'Clear Filter';
    btn.addEventListener('click', () => { _clearTableFilter(); _clearResult(); _show('wwai-empty'); });
    card.appendChild(p);
    card.appendChild(btn);
    container.appendChild(card);
}

// ── Report ─────────────────────────────────────────────────────────────────────

const _MODE_TO_FEATURE = {
    SHOULD_APPLY:  'Should I Apply?',
    DREAM_JOB:     'Dream Job',
    ROLE_EXPLAINER:'Explain Role',
    ASK:           'Ask a Question',
    BEST_FIT:      'Score / Badges',
    SEARCH_RESULTS:'Free Search',
};

function _handleReport() {
    const target = (_lastRenderedMode && _MODE_TO_FEATURE[_lastRenderedMode])
        ? _MODE_TO_FEATURE[_lastRenderedMode]
        : null;
    document.querySelectorAll('.wwai-report-feature-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.feature === target);
    });
    _show('wwai-report-form');
}
