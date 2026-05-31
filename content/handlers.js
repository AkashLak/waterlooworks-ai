// Async action handlers for the WaterlooWorks AI panel.
// Shares top-level scope with content.js — reads _currentJobId, _currentAnalyses,
// _batchRunning, _getCached, _setCached, and all renderer functions.

const POLL_INTERVAL_MS = 4_000;
const MAX_POLLS        = 30;
let _pollTimer  = null;
let _pollCount  = 0;
let _overlayEl  = null; // injected overlay for cross-page search results

// ── Utilities ─────────────────────────────────────────────────────────────────

// Extracts an external application URL from an "Additional Application Information" block.
// Only returns a URL when "apply" appears in the text leading up to it — avoids picking up
// informational links like "visit our website at https://..." that aren't application links.
// Returns true if WW's listing GET URL contains params beyond the standard pagination ones,
// meaning the user has active filters that would produce a partial job list.
// POST listings are always unfiltered — the extension reconstructs the body without filter params.
function _isListingFiltered() {
    if (_directListingMethod !== 'GET' || !_directListingUrl) return false;
    try {
        const url = new URL(_directListingUrl);
        const STANDARD = new Set(['action', 'page', 'itemsPerPage']);
        for (const key of url.searchParams.keys()) {
            if (!STANDARD.has(key)) return true;
        }
    } catch (_) {}
    return false;
}

function _getTermKey() {
    const d = new Date(), m = d.getMonth() + 1, day = d.getDate(), y = d.getFullYear();
    if ((m === 5 && day >= 11) || m === 6 || m === 7 || (m === 8 && day <= 21)) return `${y}_spring`;
    if ((m === 9 && day >= 8) || m === 10 || m === 11 || (m === 12 && day <= 23)) return `${y}_fall`;
    return `${y}_winter`;
}

function _extractExternalAppUrl(text) {
    for (const match of text.matchAll(/https?:\/\/[^\s,)]+/g)) {
        const before = text.slice(Math.max(0, match.index - 200), match.index).toLowerCase();
        if (/\bappl[yi]/.test(before)) return match[0];
    }
    return '';
}

// Decodes a fetched HTML response with charset detection.
// response.text() defaults to UTF-8; WW job detail endpoints may use ISO-8859-1/windows-1252,
// which causes é→U+FFFD corruption. Falls back to windows-1252 if replacement chars appear.
async function _fetchHtmlText(res) {
    const bytes = await res.arrayBuffer();
    const utf8  = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!utf8.includes('�')) return utf8;
    return new TextDecoder('windows-1252').decode(bytes);
}

// Writes a fit score to session cache (BATCH_FIT) and persists the numeric score
// to chrome.storage.local so badges survive tab close / session end.
function _persistFitScore(jobId, fit) {
    _setCached(jobId, 'BATCH_FIT', fit);
    const score = fit?.fitScore ?? fit?.fit_score ?? null;
    if (score != null) {
        _persistedFitScores[String(jobId)] = score;
        WWStorage.setFitScore(String(jobId), score).catch(() => {});
    }
}

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
    _submitting = true;
    try {

    // Wait for WaterlooWorks to finish loading modal content before scraping.
    await _waitForModalContent();

    // Re-scrape now that content fields are populated. Bail if modal was closed.
    const modal = WWScaper.getActiveModal();
    if (!modal) { _submitting = false; return; }
    const fresh = WWScaper.scrapeJobDetail(modal) ?? detail;
    if (fresh.jobId !== detail.jobId) { _submitting = false; return; }

    // Refresh meta line with post-load data — the initial scrape in _onJobOpen
    // runs before modal content loads and can produce a wrong deadline value.
    const metaEl = document.getElementById('wwai-job-meta');
    if (metaEl && _currentJobId === fresh.jobId) {
        const row = WWScaper.scrapeRowByJobId(fresh.jobId) ?? {};
        const deadline = row.appDeadline || fresh.applicationDeadline || fresh.appDeadline || '';
        metaEl.textContent = [fresh.employer || detail.employer, deadline ? `Deadline: ${deadline}` : ''].filter(Boolean).join(' · ');
    }

    const row = WWScaper.scrapeRowByJobId(fresh.jobId) ?? {};
    // All Jobs modal uses different label text than My Applications:
    //   "Work Term:" → fresh.workTerm (not fresh.term)
    //   "Number of Job Openings:" → fresh.numberOfJobOpenings (not fresh.openings)
    //   "Application Deadline:" → fresh.applicationDeadline (not fresh.appDeadline)
    const rawOpenings = row.openings || fresh.numberOfJobOpenings || fresh.openings || '';
    const jobData = {
        ...fresh,
        city:                  row.city         || fresh.city        || '',
        province:              fresh.province   || '',
        country:               fresh.country    || '',
        openings:              parseInt(rawOpenings, 10) || null,
        level:                 row.level        || fresh.level || '',
        apps:                  row.apps         || null,
        term:                  row.term         || fresh.workTerm || fresh.term || '',
        deadline:              row.appDeadline  || fresh.applicationDeadline || fresh.appDeadline || null,
        organization:          row.organization || fresh.employer    || '',
        description:           WWScaper.extractJobDescription(fresh) || null,
        employmentArrangement: fresh.employmentLocationArrangement   || '',
        externalUrl:           _decodeHtml(fresh.ifByWebsiteGoTo || fresh.ifByEmailSendTo || _extractExternalAppUrl(fresh.additionalApplicationInformation || '') || ''),
    };

    let submitResult;
    try {
        submitResult = await WWAnalyzer.submitJob(jobData);
    } catch (_) {
        _submitting = false;
        return;
    }

    _submitting = false;

    if (submitResult.analysesReady && submitResult.analyses) {
        _currentAnalyses = submitResult.analyses;
        _renderAnalysesReady(); // calls _prefetchFitScore internally
    } else {
        // Job now exists in DB — safe to prefetch fit score without a race condition
        _prefetchFitScore();
        _setLoading('Analyzing new job…');
        _startPolling(detail.jobId);
    }

    } catch (_) { _submitting = false; } // outer try — catches _waitForModalContent errors
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
    // Fall back to the allJobsMap snapshot if the analyses response didn't include role_disguise
    const qa = _currentAnalyses?.role_disguise
            ?? _allJobsMap[_currentJobId]?.role_disguise
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
        _persistFitScore(jobId, fit);
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
    // Only sync rows Phase 1 hasn't already handled — avoids bumping last_updated_at on every call.
    let unseenRows = null; // null means Phase 1 hasn't run yet — fall back to syncing all visible rows
    if (_directScrapeRows) {
        const knownIds = new Set(_directScrapeRows.map(r => r.jobId));
        const newRows  = rowData.filter(r => !knownIds.has(r.jobId));
        unseenRows = newRows;
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

    // Sync only unseen rows (isFiltered:true bypasses the 30-min gate for incremental writes).
    // When Phase 1 hasn't run yet (unseenRows === null), sync all visible rows as fallback.
    const rowsToSync = unseenRows ?? rowData;
    try {
        if (rowsToSync.length) await WWAnalyzer.syncActiveJobs(rowsToSync, _getTermKey(), true);
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
                const qa = _allJobsMap[_currentJobId]?.role_disguise ?? null;
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
    _submitting = true;
    _setLoading('Loading analyses…');
    try {
        const result = await WWAnalyzer.getJobAnalyses(jobId);
        _submitting = false;
        if (result.analysesReady && result.analyses) {
            _currentAnalyses = result.analyses;
            _clearLoading();
            _renderAnalysesReady();
        } else {
            // Analyses still computing — resume polling
            _startPolling(jobId);
        }
    } catch (_) { _submitting = false; _clearLoading(); }
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
    const KEY_MAP = { QA_SNIFF: 'role_disguise', ROLE_EXPLAINER: 'role_explainer' };
    const key = KEY_MAP[mode];
    const data = key && _currentAnalyses ? _currentAnalyses[key] : null;
    if (data) { _setCached(_currentJobId, mode, data); _renderResult(mode, data); }
    else if (_pollTimer || _submitting) _renderError({ message: 'Analysis in progress — please wait a moment and try again.' });
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
            _persistFitScore(_currentJobId, fit);
            const tableRow = WWScaper.scrapeRowByJobId(_currentJobId);
            if (tableRow) _injectBadge(tableRow, fit.fitScore ?? fit.fit_score);
        }

        const dream = _currentAnalyses?.dream_job ?? null;
        const qa    = _currentAnalyses?.role_disguise ?? null;
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

function _updateStatusLine(msg) {
    const el = document.getElementById('wwai-status-line');
    if (!el) return;
    el.textContent = typeof msg === 'number' ? `${msg} jobs in database` : (msg ?? '');
}

async function _refreshStatus() {
    try {
        const status = await WWAnalyzer.getStatus();
        const count  = status.totalJobs ?? status.jobCount ?? 0;
        if (_lastSyncedAt) {
            const minsAgo   = Math.floor((Date.now() - _lastSyncedAt) / 60000);
            const syncLabel = minsAgo === 0 ? 'just now' : `${minsAgo} min ago`;
            _updateStatusLine(`${count} jobs · synced ${syncLabel}`);
        } else {
            _updateStatusLine(count);
        }
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
            _persistFitScore(row.jobId, { fitScore });
            _injectBadge(row, fitScore);
            _tallyStat(stats, fitScore);
            scoredCount++;
        } else {
            // Check session cache before making an API call
            const sessionCached = _getCached(row.jobId, 'BEST_FIT');
            if (sessionCached) {
                const cachedScore = sessionCached.fitScore ?? sessionCached.fit_score;
                _persistFitScore(row.jobId, sessionCached);
                _injectBadge(row, cachedScore);
                _tallyStat(stats, cachedScore);
                scoredCount++;
            } else {
                txt.textContent = `Scoring job ${scoredCount + 1} of ${rows.length - unseenCount}…`;
                try {
                    const fit = await WWAnalyzer.getFitScore(row.jobId);
                    const score = fit.fitScore ?? fit.fit_score;
                    _setCached(row.jobId, 'BEST_FIT', fit);
                    _persistFitScore(row.jobId, fit);
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
                _persistFitScore(id, fit);
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

const _SCRAPE_CONCURRENCY = 5; // parallel HTML fetches from WaterlooWorks

async function _directFetch(url, options, retries = 2) {
    // Always include credentials so WW's session cookies are sent with every request.
    // Content-script fetches originate from the extension origin, not the page origin,
    // so cookies are not sent by default without this flag.
    const opts = { credentials: 'include', ...options };
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, opts);
            if (res.ok) return res;
        } catch (_) {}
        if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
    return null;
}

async function _runDirectScrapePhase1() {
    console.log('[WWAI-DIAG] Phase1 start — token:', _directListingToken, '| url:', _directListingUrl, '| method:', _directListingMethod);
    if (!_directListingToken && _directListingCandidates.length) {
        const baseUrl = new URL(
            document.documentElement.dataset.wwaiListingCandidateUrl || '/myAccount/co-op/full/jobs.htm',
            window.location.href
        ).href;

        for (const candidate of _directListingCandidates) {
            const testBody = `action=${encodeURIComponent(candidate)}&page=1&itemsPerPage=100`;
            const testRes = await _directFetch(baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: testBody,
            });
            if (!testRes) continue;
            const rawText = await testRes.text();
            let testJson;
            try { testJson = JSON.parse(rawText); } catch { continue; }
            if (testJson.totalResults !== undefined && Array.isArray(testJson.data)) {
                _directListingToken  = candidate;
                _directListingUrl    = baseUrl;
                _directListingMethod = 'POST';
                break;
            }
        }
    }

    // DOM fallback — WW SPA navigation pre-renders the table; no listing GET/POST needed.
    // Scrape visible rows directly only if HTTP listing is completely unavailable.
    const domFallbackRows = [];
    if (!_directListingToken && !_directListingUrl) {
        await new Promise(r => setTimeout(r, 300)); // let Vue finish rendering
        for (const row of WWScaper.scrapeAllListingRows()) {
            if (row.jobId) domFallbackRows.push(row);
        }
    }

    if (!_directListingToken && !_directListingUrl && !domFallbackRows.length) {
        _directScrapeState = 0;
        await _refreshStatus();
        return;
    }

    _updateStatusLine('Syncing all jobs…');

    // Helper: fetch one page of the listing (GET or POST depending on how listing was captured)
    async function _fetchListingPage(pageNum) {
        if (_directListingMethod === 'POST') {
            const body = `action=${encodeURIComponent(_directListingToken)}&page=${pageNum}&itemsPerPage=100`;
            return _directFetch(_directListingUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
        }
        const url = new URL(_directListingUrl);
        // Do NOT override itemsPerPage — WW calculates page offset as (page-1)*itemsPerPage.
        // Applications caps at 45/page; requesting 100 makes page 2 start at record 101 (empty).
        url.searchParams.set('page', String(pageNum));
        return _directFetch(url.toString());
    }

    // Use DOM rows if we fell back to scraping; otherwise fetch via HTTP
    const allRows = domFallbackRows.length ? domFallbackRows : [];

    if (!domFallbackRows.length) {
        let page  = 1;
        let total = Infinity; // stays Infinity if API omits a total field → page-exhaust loop
        const MAX_PAGES = 60;

        // Page-exhaustion loop: fetch until WW returns an empty page.
        // totalResults is not used for stopping — WW listing types return it inconsistently
        // (e.g. My Applications sets totalResults to the per-page count, not the grand total).
        while (page <= MAX_PAGES) {
            const res = await _fetchListingPage(page);
            console.log('[WWAI-DIAG] Page', page, 'fetch result:', res ? `${res.status} ${res.statusText}` : 'null');
            if (!res) break;

            const rawText = await res.text();
            console.log('[WWAI-DIAG] Page', page, 'response (first 200 chars):', rawText.slice(0, 200));
            let json;
            try { json = JSON.parse(rawText); } catch { console.log('[WWAI-DIAG] Page', page, 'JSON parse failed'); break; }

            if (!json.data?.length) { console.log('[WWAI-DIAG] Page', page, 'no json.data, keys:', Object.keys(json).join(',')); break; }

            let addedThisPage = 0;
            for (const apiRow of json.data) {
                const row = WWScaper.parseListingRow(apiRow);
                if (row.jobId) { allRows.push(row); addedThisPage++; }
            }
            console.log('[WWAI-DIAG] Page', page, 'added', addedThisPage, 'rows, total so far:', allRows.length);
            if (!addedThisPage) break; // page had data but no valid job IDs

            page++;
        }
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
    try {
        const syncResult = await WWAnalyzer.syncActiveJobs(syncPayload, _getTermKey(), _isListingFiltered());
        if (syncResult?.skipped) {
            _lastSyncedAt = new Date(syncResult.nextSyncAt).getTime() - 30 * 60 * 1000;
        } else {
            _lastSyncedAt = Date.now();
        }
    } catch (_) {}

    _scheduleTableSync(); // refresh badge injection with newly synced rows

    // Start background check for new postings — one API call every 5 min while WW is open
    if (_periodicCheckTimer) clearInterval(_periodicCheckTimer);
    _periodicCheckTimer = setInterval(_runPeriodicNewJobCheck, 5 * 60 * 1000);

    _directScrapeState = 3;
    _runDirectScrapePhase2();
}

// Fast DOM-only Phase 1 — called when the All Jobs table renders after SPA navigation.
// Skips HTTP candidate trials; scrapes visible rows immediately, then transitions to Phase 2.
async function _runDomPhase1() {
    console.log('[WWAI-DIAG] DOM Phase1 running — no HTTP listing URL was captured');
    const rows = WWScaper.scrapeAllListingRows().filter(r => r.jobId);
    if (!rows.length) {
        _directScrapeState = 0;
        return;
    }

    _directScrapeRows = rows;
    _lastKnownTotal   = rows.length;

    _updateStatusLine(`${rows.length} jobs synced — click any job once to load descriptions`);

    const syncPayload = rows.map(({ boardUrl, ...r }) => r);
    try {
        const syncResult = await WWAnalyzer.syncActiveJobs(syncPayload, _getTermKey(), _isListingFiltered());
        if (syncResult?.skipped) {
            _lastSyncedAt = new Date(syncResult.nextSyncAt).getTime() - 30 * 60 * 1000;
        } else {
            _lastSyncedAt = Date.now();
        }
    } catch (_) {}

    _scheduleTableSync();

    _directScrapeState = 3;
    _runDirectScrapePhase2();
}

async function _runDirectScrapePhase2() {
    const rows = _directScrapeRows;
    if (!rows?.length) {
        // Rows not populated yet — fall back to waiting for first click.
        _directScrapeState = 2;
        return;
    }

    if (!_directDetailTokens.length) {
        _directScrapeState = 2;
        _updateStatusLine(`${rows.length} jobs synced — click any job once to load descriptions`);
        return;
    }

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
        // No detail token available yet — fall back to waiting for the user to click any job.
        // _onDetailToken will restart Phase 2 once a token is captured.
        _directScrapeState = 2;
        _updateStatusLine(`${rows.length} jobs synced — click any job once to load descriptions`);
        return;
    }

    // Cache token and resolved base URL — _onTableChange uses these for new rows later
    _directHtmlDetailToken = htmlToken;
    _directDetailBase = _directDetailUrl
        ? new URL(_directDetailUrl, window.location.href).href
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

// Fetches HTML descriptions for all rows from WaterlooWorks (concurrent),
// then sends ONE bulk request to the backend per call — no per-job rate limit exposure.
async function _fetchAndSubmitDescriptions(rows, statusLabel) {
    const total = rows.length;
    _updateStatusLine(`${statusLabel}…`);

    // Step 1: fetch HTML for all jobs concurrently (5 at a time from WW)
    const jobDatas = [];
    let fetched = 0;

    for (let i = 0; i < total; i += _SCRAPE_CONCURRENCY) {
        await Promise.all(
            rows.slice(i, i + _SCRAPE_CONCURRENCY).map(async (row) => {
                if (!row.jobId) return;
                try {
                    const body = `action=${encodeURIComponent(_directHtmlDetailToken)}&${_directDetailIdParam}=${encodeURIComponent(row.jobId)}`;
                    const res  = await _directFetch(_directDetailBase, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body,
                    });
                    if (!res) return;

                    const html = await _fetchHtmlText(res);
                    if (!html.includes('tag__key-value-list')) return;

                    const detail = WWScaper.scrapeJobDetailFromHtml(
                        html, row.jobId, row.title, row.organization || row.employer || '', row.division
                    );
                    if (!detail) return;

                    const desc = WWScaper.extractJobDescription(detail);
                    const geo  = await _fetchGeoData(row.jobId);

                    jobDatas.push({
                        jobId:               row.jobId,
                        title:               row.title || '',
                        employer:            row.organization || row.employer || detail.employer || '',
                        division:            row.division || detail.division || '',
                        city:                row.city || geo.city || detail.city || '',
                        province:            detail.province || detail.jobProvincestate || '',
                        country:             geo.country || detail.country || detail.jobCountry || '',
                        openings:            (row.openings ?? parseInt(detail.numberOfJobOpenings ?? detail.openings, 10)) || null,
                        level:               row.level || detail.level || '',
                        apps:                row.apps || null,
                        term:                row.term || detail.workTerm || detail.term || '',
                        deadline:            row.appDeadline || detail.applicationDeadline || detail.appDeadline || null,
                        organization:        row.organization || row.employer || detail.employer || '',
                        description:         desc || null,
                        jobSummary:                  detail.jobSummary || '',
                        jobResponsibilities:         detail.jobResponsibilities || '',
                        requiredSkills:              detail.requiredSkills || '',
                        compensationAndBenefits:     detail.compensationAndBenefits || '',
                        applicationDocumentsRequired: detail.applicationDocumentsRequired || '',
                        workTermDuration:            detail.workTermDuration || '',
                        employmentArrangement:       detail.employmentLocationArrangement || '',
                        externalUrl:                 _decodeHtml(detail.ifByWebsiteGoTo || detail.ifByEmailSendTo || _extractExternalAppUrl(detail.additionalApplicationInformation || '') || ''),
                    });
                    fetched++;
                } catch (_) {}
            })
        );
        _updateStatusLine(`${statusLabel}… ${fetched}/${total} fetched`);
    }

    if (!jobDatas.length) {
        _updateStatusLine('No descriptions fetched');
        return;
    }

    // Step 2: single bulk request — backend queues AI analysis at a controlled rate internally
    _updateStatusLine(`Submitting ${jobDatas.length} descriptions…`);
    try {
        const result = await WWAnalyzer.bulkDescriptions(jobDatas);
        _updateStatusLine(`${result?.stored ?? jobDatas.length} jobs ready`);
    } catch (e) {
        _updateStatusLine(`Bulk submit failed — ${e?.message}`);
    }
}

async function _findHtmlDetailToken(sampleRow) {
    // Try each captured POST token on a single job.
    // One token returns HTML (job fields) — that's the HTML token.
    // Another returns JSON with geo data (city, country) — cache that too.
    const detailUrl = _directDetailUrl
        ? new URL(_directDetailUrl, window.location.href).href
        : _directListingUrl
            ? `${new URL(_directListingUrl).origin}${new URL(_directListingUrl).pathname}`
            : `${window.location.origin}/myAccount/co-op/full/jobs.htm`;

    let htmlToken = null;

    for (const token of _directDetailTokens) {
        const body = `action=${encodeURIComponent(token)}&${_directDetailIdParam}=${encodeURIComponent(sampleRow.jobId)}`;
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
        const body = `action=${encodeURIComponent(_directGeoToken)}&${_directDetailIdParam}=${encodeURIComponent(jobId)}`;
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
    if (!_directListingUrl) return;
    if (_directScrapeState < 4) return; // Phase 2 still running — skip this tick

    async function _fetchPeriodicPage(pageNum) {
        if (_directListingMethod === 'POST') {
            const body = `action=${encodeURIComponent(_directListingToken)}&page=${pageNum}&itemsPerPage=100`;
            return _directFetch(_directListingUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
        }
        const url = new URL(_directListingUrl);
        url.searchParams.set('page', String(pageNum));
        return _directFetch(url.toString());
    }

    try {
        const res = await _fetchPeriodicPage(1);
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
                const pageRes = await _fetchPeriodicPage(page);
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
        try { await WWAnalyzer.syncActiveJobs(syncPayload, _getTermKey(), true); } catch (_) {}

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
        tbody.addEventListener('click', (e) => {
            const row = e.target.closest('.wwai-overlay-row[data-job-id]');
            if (!row) return;
            tbody.querySelectorAll('.wwai-overlay-row--selected')
                .forEach(r => r.classList.remove('wwai-overlay-row--selected'));
            row.classList.add('wwai-overlay-row--selected');
            _openJobFromOverlay(row.dataset.jobId);
        });

        for (const job of jobs) {
            const jobId = String(job.jobId ?? job.id ?? '');
            // Search results only carry AI-scoring fields — fill gaps from the full jobs snapshot
            const stored = _allJobsMap[jobId] ?? {};
            const tr = document.createElement('tr');
            tr.className = 'wwai-overlay-row';
            if (jobId) tr.dataset.jobId = jobId;

            const tdTitle = document.createElement('td');
            const titleBtn = document.createElement('span');
            titleBtn.className = 'wwai-overlay-title-btn';
            titleBtn.textContent = job.title ?? stored.title ?? '';
            tdTitle.appendChild(titleBtn);

            const tdEmp = document.createElement('td');
            tdEmp.textContent = job.employer ?? job.organization ?? stored.employer ?? stored.organization ?? '';

            const tdCity = document.createElement('td');
            tdCity.textContent = job.city ?? stored.city ?? '';

            const tdTerm = document.createElement('td');
            const rawDur = job.term ?? job.work_term_duration ?? stored.term ?? stored.work_term_duration ?? '';
            tdTerm.textContent = rawDur.replace(/\s*work\s*term\s*/i, '').trim();

            const tdDead = document.createElement('td');
            const rawDeadline = job.deadline ?? job.app_deadline ?? stored.deadline ?? stored.app_deadline ?? '';
            tdDead.textContent = rawDeadline ? _formatDate(rawDeadline) : '';

            const tdFit = document.createElement('td');
            const cached = _getCached(jobId, 'BATCH_FIT') ?? _getCached(jobId, 'BEST_FIT');
            const score  = job.fitScore ?? job.fit_score ?? cached?.fitScore ?? cached?.fit_score
                        ?? _persistedFitScores[jobId] ?? null;
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
    // Overlay stays open — WW modal z-index (100000102) is above the overlay (100000100),
    // so the modal appears on top and the user returns to their results when they close it.

    // If the job row is on the current WW page, click its title link directly.
    const row = WWScaper.scrapeRowByJobId(jobId);
    if (row?.titleEl) {
        row.titleEl.click();
        return;
    }

    // Job is on a different page — dispatch to MAIN world so interceptor.js can call
    // WW's native viewPosting(), which loads the modal without page navigation.
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
