// Async action handlers for the WaterlooWorks AI panel.
// Shares top-level scope with content.js — reads _currentJobId, _currentAnalyses,
// _batchRunning, _getCached, _setCached, and all renderer functions.

const POLL_INTERVAL_MS = 4_000;
const MAX_POLLS        = 30;
const BATCH_DELAY_MS   = 4_000;
let _pollTimer = null;
let _pollCount = 0;

// ── Job submission and analysis polling ────────────────────────────────────────

/**
 * Waits until the open modal has populated its content fields, or timeoutMs elapses.
 * WaterlooWorks opens the modal shell before fetching job detail via an internal API.
 */
function _waitForModalContent(timeoutMs = 2500) {
    const modal = WWScaper.getActiveModal();
    if (!modal) return Promise.resolve();
    if (modal.querySelector('.tag__key-value-list p')?.textContent?.trim()) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => { observer.disconnect(); resolve(); }, timeoutMs);
        const observer = new MutationObserver(() => {
            if (modal.querySelector('.tag__key-value-list p')?.textContent?.trim()) {
                clearTimeout(timer); observer.disconnect(); resolve();
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
        city:                  row.city         || fresh.city        || '',
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
    if (_tableSyncScheduled) return;
    _tableSyncScheduled = true;
    setTimeout(_onTableChange, 1_500);
}

function _renderAnalysesReady() {
    _clearLoading();

    // Passive sniff warning — show in header if QA analysis flagged this job
    const qa = _currentAnalyses?.qa_disguise;
    if (qa && (qa.isDisguised ?? (qa.titleMatchesRole === false))) {
        _show('wwai-sniff-flag');
        // Pre-populate the expandable detail card
        const detailEl = document.getElementById('wwai-sniff-detail');
        if (detailEl) {
            detailEl.innerHTML = '';
            const card = document.createElement('div');
            card.className = 'wwai-result';
            _fillQaSniff(card, qa);
            detailEl.appendChild(card);
        }
    }

    // Auto-show first sentence of role explainer as a quick preview
    const roleText = _currentAnalyses?.role_explainer;
    if (typeof roleText === 'string' && roleText.trim()) {
        const sentence = roleText.split(/\.\s/)[0].trim();
        if (sentence) {
            const preview = document.getElementById('wwai-role-preview');
            preview.textContent = sentence + '.';
            _show('wwai-role-preview');
        }
    }

    const container = document.getElementById('wwai-result');
    container.innerHTML = '';
    container.classList.remove('wwai-hidden');
    const card = document.createElement('div');
    card.className = 'wwai-result';
    const p = document.createElement('p');
    p.textContent = 'Analysis ready — click ✅ Should I Apply?, ⭐ Dream Job?, or 💼 Explain Role to view results.';
    card.appendChild(p);
    container.appendChild(card);
}

async function _onTableChange() {
    _tableSyncScheduled = false;
    const rows = WWScaper.scrapeAllListingRows();
    if (!rows.length) return;

    // Strip titleEl (DOM node) before sending — it's only needed for batch click()
    const rowData = rows.map(({ titleEl, ...rest }) => rest).filter(r => r.jobId);
    if (!rowData.length) return;

    try {
        await WWAnalyzer.syncActiveJobs(rowData);
        const response = await WWAnalyzer.getAllJobs();
        const jobs     = response.jobs ?? (Array.isArray(response) ? response : []);
        const jobsMap  = {};
        for (const job of jobs) { if (job.jobId) jobsMap[job.jobId] = job; }
        _injectPrecomputedBadges(rows, jobsMap);
        _refreshStatus();
    } catch (_) {}
}

// ── Single-job analysis handlers ───────────────────────────────────────────────

async function _restoreAnalyses(jobId) {
    try {
        const result = await WWAnalyzer.getJobAnalyses(jobId);
        if (result.analysesReady && result.analyses) {
            _currentAnalyses = result.analyses;
            _renderAnalysesReady();
        }
    } catch (_) {}
}

async function _handleFitScore() {
    if (!_currentJobId) return;
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
    const cached = _getCached(_currentJobId, mode);
    if (cached) { _renderResult(mode, cached); return; }
    const KEY_MAP = { DREAM_JOB: 'dream_job', QA_SNIFF: 'qa_disguise', ROLE_EXPLAINER: 'role_explainer' };
    const key = KEY_MAP[mode];
    const data = key && _currentAnalyses ? _currentAnalyses[key] : null;
    if (data) { _setCached(_currentJobId, mode, data); _renderResult(mode, data); }
    else if (_pollTimer) _renderError({ message: 'Analysis in progress — please wait a moment and try again.' });
    else _renderError({ message: 'Analysis not yet available. Try reopening this job.' });
}

async function _handleAsk(question) {
    if (!_currentJobId) return;
    _setLoading('Thinking…');
    _clearResult();
    try {
        const result = await WWAnalyzer.askQuestion(_currentJobId, question);
        const answer = typeof result === 'string' ? result : (result.answer ?? JSON.stringify(result));
        _renderResult('ASK', answer);
        document.getElementById('wwai-ask-input').value = '';
    } catch (err) {
        _renderError(err);
    } finally {
        _clearLoading();
    }
}

// ── Smart Suggestions ──────────────────────────────────────────────────────────

const SEARCH_LABELS = { top_fits: 'Top 5 Fits', closing_soon: 'Closing Soon' };

async function _handleShouldIApply() {
    if (!_currentJobId) return;
    _setLoading('Evaluating…'); _clearResult();
    try {
        const cached = _getCached(_currentJobId, 'BEST_FIT');
        const fit = cached ?? await (async () => {
            const r = await WWAnalyzer.getFitScore(_currentJobId);
            _setCached(_currentJobId, 'BEST_FIT', r);
            return r;
        })();
        const dream = _currentAnalyses?.dream_job ?? null;
        const qa    = _currentAnalyses?.qa_disguise ?? null;
        _renderResult('SHOULD_APPLY', { fit, dream, qa });
    } catch (err) { _renderError(err); }
    finally { _clearLoading(); }
}

async function _handleFreeSearch(query) {
    _setLoading(`Searching "${query}"…`); _clearResult();
    try {
        const result = await WWAnalyzer.searchJobs({ criteria: 'free_search', query, limit: 10 });
        const jobs = result.jobs ?? result.results ?? (Array.isArray(result) ? result : []);
        _renderResult('SEARCH_RESULTS', { jobs, message: result.message });
    } catch (err) { _renderError(err); }
    finally { _clearLoading(); }
}

async function _handleSearch(searchType) {
    _setLoading(`Searching ${SEARCH_LABELS[searchType] ?? searchType}…`);
    _clearResult();
    try {
        const result = await WWAnalyzer.searchJobs({ criteria: searchType, limit: searchType === 'top_fits' ? 5 : 20 });
        const jobs = result.jobs ?? result.results ?? (Array.isArray(result) ? result : []);
        _renderResult('SEARCH_RESULTS', { jobs, message: result.message });
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

function _decodeHtml(str) {
    if (!str) return str;
    const el = document.createElement('textarea');
    el.innerHTML = str;
    return el.value;
}

async function _handleBatch() {
    if (_batchRunning) return;
    _batchRunning = true;
    WWAnalyzer.resetBatchCancel();

    _show('wwai-batch-progress');
    _hide('wwai-batch-summary');
    document.getElementById('wwai-batch-bar').style.width = '0%';

    let allJobsMap = {};
    try {
        const response = await WWAnalyzer.getAllJobs();
        const jobs = response.jobs ?? (Array.isArray(response) ? response : []);
        for (const job of jobs) { if (job.jobId) allJobsMap[job.jobId] = job; }
    } catch (_) {}

    const rows = WWScaper.scrapeAllListingRows();
    const stats = { great: 0, decent: 0, poor: 0, disguised: 0 };
    let unseenCount = 0, scoredCount = 0;
    const bar = document.getElementById('wwai-batch-bar'), txt = document.getElementById('wwai-batch-text');

    for (let i = 0; i < rows.length; i++) {
        if (WWAnalyzer.isBatchCancelled()) break;
        const row = rows[i];
        const jobRec = allJobsMap[row.jobId];
        bar.style.width = `${Math.round(((i + 1) / rows.length) * 100)}%`;

        if (!jobRec) { unseenCount++; _injectBadge(row, null, false); continue; }

        const qa = jobRec.qa_disguise || jobRec.qaResult;
        const isQa = qa ? (qa.isDisguised ?? !qa.titleMatchesRole ?? false) : false;
        if (isQa) stats.disguised++;

        if (jobRec.fitScore != null) {
            _injectBadge(row, jobRec.fitScore, isQa);
            _tallyStat(stats, jobRec.fitScore);
            scoredCount++;
        } else {
            txt.textContent = `Scoring job ${scoredCount + 1} of ${rows.length - unseenCount}…`;
            try {
                const fit = await WWAnalyzer.getFitScore(row.jobId);
                _injectBadge(row, fit.fitScore, isQa);
                _tallyStat(stats, fit.fitScore);
                scoredCount++;
                await _sleep(BATCH_DELAY_MS);
            } catch (_) { _injectBadge(row, null, isQa); }
        }
    }

    _batchRunning = false;
    _hide('wwai-batch-progress');
    const parts = [`🟢 ${stats.great} great fits`, `🟡 ${stats.decent} decent matches`, `🔴 ${stats.poor} poor fits`];
    if (stats.disguised) parts.push(`⚠️ ${stats.disguised} title mismatches`);
    if (unseenCount) parts.push(`${unseenCount} need descriptions — open each title once to enable scoring`);
    if (WWAnalyzer.isBatchCancelled()) parts.push('(cancelled)');
    const summaryEl = document.getElementById('wwai-batch-summary');
    summaryEl.textContent = parts.join(' · ');
    _show('wwai-batch-summary');
}

function _tallyStat(stats, score) {
    if (score >= 8) stats.great++;
    else if (score >= 5) stats.decent++;
    else stats.poor++;
}
