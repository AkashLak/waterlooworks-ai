// Async action handlers for the WaterlooWorks AI panel.
// Shares top-level scope with content.js — reads _currentJobId, _currentAnalyses,
// _batchRunning, _getCached, _setCached, and all renderer functions.

const POLL_INTERVAL_MS = 4_000;
const MAX_POLLS        = 30;
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

function _renderAnalysesReady() {
    // Show sniff flag if QA analysis flagged this job
    const qa = _currentAnalyses?.qa_disguise;
    if (qa && (qa.isMismatch ?? qa.isDisguised ?? (qa.titleMatchesRole === false))) {
        _show('wwai-sniff-flag');
        const detailEl = document.getElementById('wwai-sniff-detail');
        if (detailEl) {
            detailEl.innerHTML = '';
            const card = document.createElement('div');
            card.className = 'wwai-result';
            _fillQaSniff(card, qa);
            detailEl.appendChild(card);
        }
    }

    // Auto-show first bullet of role explainer (structured JSON or plain text) as preview
    const roleData = _currentAnalyses?.role_explainer;
    const previewText = typeof roleData === 'string'
        ? roleData.split(/\.\s/)[0].trim()
        : (Array.isArray(roleData?.dayToDay) && roleData.dayToDay[0]) || '';
    if (previewText) {
        const preview = document.getElementById('wwai-role-preview');
        preview.textContent = previewText.endsWith('.') ? previewText : previewText + '.';
        _show('wwai-role-preview');
    }

    // Auto-run Should I Apply so the user sees their result immediately
    _handleShouldIApply();
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
        for (const job of jobs) {
            const id = job.jobId ?? job.id;
            if (id) jobsMap[id] = job;
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

const SEARCH_LABELS = { top_fits: 'Top 5 Fits', closing_soon: 'Closing Soon' };

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

        // Write BATCH_FIT so the badge appears in the table row for this job
        if (!_getCached(_currentJobId, 'BATCH_FIT')) {
            _setCached(_currentJobId, 'BATCH_FIT', fit);
        }
        const tableRow = WWScaper.scrapeRowByJobId(_currentJobId);
        if (tableRow) {
            const qa   = _currentAnalyses?.qa_disguise ?? null;
            const isQa = qa ? (qa.isMismatch ?? qa.isDisguised ?? (qa.titleMatchesRole === false)) : false;
            _injectBadge(tableRow, fit.fitScore ?? fit.fit_score, isQa);
        }

        const dream = _currentAnalyses?.dream_job ?? null;
        const qa    = _currentAnalyses?.qa_disguise ?? null;
        _renderResult('SHOULD_APPLY', { fit, dream, qa });
    } catch (err) { _renderError(err); }
    finally { _clearLoading(); }
}

const SEARCH_EMPTY_MESSAGES = {
    closing_soon: 'No upcoming deadlines — your analyzed jobs may have all closed for this cycle.',
    top_fits:     'No fit scores yet — open some jobs to score them first.',
};

async function _handleFreeSearch(query) {
    _clearTableFilter();
    _setLoading(`Searching "${query}"…`); _clearResult();
    try {
        const result = await WWAnalyzer.searchJobs({ criteria: 'free_search', query, limit: 20 });
        const jobs = result.jobs ?? result.results ?? (Array.isArray(result) ? result : []);
        const jobIds = jobs.map(j => String(j.jobId ?? j.id)).filter(Boolean);
        const { shown } = _filterTable(jobIds, query);
        _renderFilterCard(shown, jobIds.length, query);
    } catch (err) { _renderError(err); }
    finally { _clearLoading(); }
}

async function _handleSearch(searchType) {
    _clearTableFilter();
    _setLoading(`Searching ${SEARCH_LABELS[searchType] ?? searchType}…`);
    _clearResult();
    try {
        const result = await WWAnalyzer.searchJobs({ criteria: searchType, limit: searchType === 'top_fits' ? 5 : 20 });
        const jobs = result.jobs ?? result.results ?? (Array.isArray(result) ? result : []);
        const jobIds = jobs.map(j => String(j.jobId ?? j.id)).filter(Boolean);
        const label   = SEARCH_LABELS[searchType] ?? searchType;
        const emptyMsg = SEARCH_EMPTY_MESSAGES[searchType] ?? null;
        const { shown } = _filterTable(jobIds, label, emptyMsg);
        _renderFilterCard(shown, jobIds.length, label, emptyMsg);
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
    const stats = { great: 0, decent: 0, poor: 0, disguised: 0 };
    let unseenCount = 0, scoredCount = 0;
    const bar = document.getElementById('wwai-batch-bar'), txt = document.getElementById('wwai-batch-text');

    for (let i = 0; i < rows.length; i++) {
        if (WWAnalyzer.isBatchCancelled()) break;
        const row = rows[i];
        const jobRec = allJobsMap[row.jobId];
        bar.style.width = `${Math.round(((i + 1) / rows.length) * 100)}%`;

        if (!jobRec) { unseenCount++; _injectBadge(row, null, false); continue; }

        // Skip jobs with no description — scoring without content produces meaningless results
        const hasDescription = !!(jobRec.job_summary || jobRec.job_responsibilities);
        if (!hasDescription) { unseenCount++; _injectBadge(row, null, false); continue; }

        const qa = jobRec.qa_disguise || jobRec.qaResult;
        const isQa = qa ? (qa.isDisguised ?? !qa.titleMatchesRole ?? false) : false;
        if (isQa) stats.disguised++;

        const fitScore = jobRec.fitScore ?? jobRec.fit_score ?? null;
        if (fitScore != null) {
            _setCached(row.jobId, 'BATCH_FIT', { fitScore });
            _injectBadge(row, fitScore, isQa);
            _tallyStat(stats, fitScore);
            scoredCount++;
        } else {
            // Check session cache before making an API call
            const sessionCached = _getCached(row.jobId, 'BEST_FIT');
            if (sessionCached) {
                const cachedScore = sessionCached.fitScore ?? sessionCached.fit_score;
                _setCached(row.jobId, 'BATCH_FIT', sessionCached);
                _injectBadge(row, cachedScore, isQa);
                _tallyStat(stats, cachedScore);
                scoredCount++;
            } else {
                txt.textContent = `Scoring job ${scoredCount + 1} of ${rows.length - unseenCount}…`;
                try {
                    const fit = await WWAnalyzer.getFitScore(row.jobId);
                    const score = fit.fitScore ?? fit.fit_score;
                    _setCached(row.jobId, 'BEST_FIT', fit);
                    _setCached(row.jobId, 'BATCH_FIT', fit);
                    _injectBadge(row, score, isQa);
                    _tallyStat(stats, score);
                    scoredCount++;
                } catch (_) { _injectBadge(row, null, isQa); }
            }
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

function _tallyStat(stats, score) {
    if (score >= 70) stats.great++;
    else if (score >= 40) stats.decent++;
    else stats.poor++;
}

// ── DOM table filtering (similar roles) ────────────────────────────────────────

function _filterTable(jobIds, label = '', emptyMsg = null) {
    const idSet = new Set(jobIds.map(String));
    _activeFilter = idSet;
    const allRows = WWScaper.scrapeAllListingRows();
    let shown = 0, hidden = 0;
    for (const row of allRows) {
        const tr = row.titleEl?.closest('tr.table__row--body');
        if (!tr) continue;
        if (row.jobId && idSet.has(String(row.jobId))) {
            tr.style.display = '';
            shown++;
        } else {
            tr.style.display = 'none';
            hidden++;
        }
    }
    _filterMeta = { shown, total: jobIds.length, hidden, query: label, emptyMsg };
    return { shown, hidden };
}

function _clearTableFilter() {
    _activeFilter = null;
    _filterMeta   = null;
    document.querySelectorAll('tr.table__row--body').forEach(tr => { tr.style.display = ''; });
}

function _renderFilterCard(shown, total, query, emptyMsg) {
    const container = document.getElementById('wwai-result');
    container.innerHTML = '';
    container.classList.remove('wwai-hidden');
    const card = document.createElement('div');
    card.className = 'wwai-result';
    const noMatch = emptyMsg ?? `No matches on this page for "${query}" — try navigating to other pages.`;
    const msg = shown > 0
        ? `Showing ${shown} match${shown !== 1 ? 'es' : ''} for "${query}"${total > shown ? ` · ${total - shown} on other pages` : ''}.`
        : noMatch;
    const p = document.createElement('p');
    p.className = 'wwai-verdict';
    p.textContent = msg;
    const btn = document.createElement('button');
    btn.className = 'wwai-btn wwai-btn--full';
    btn.style.marginTop = '8px';
    btn.textContent = 'Clear Filter';
    btn.addEventListener('click', () => {
        _clearTableFilter();
        _clearResult();
        _show('wwai-empty');
    });
    card.appendChild(p);
    card.appendChild(btn);
    container.appendChild(card);
}

// ── Report ─────────────────────────────────────────────────────────────────────

async function _handleReport() {
    try {
        await WWAnalyzer.createReport(
            _lastRenderedMode ?? 'unknown',
            null,
            _lastRenderedData ?? null,
            null,
        );
        const footer = document.querySelector('.wwai-footer');
        if (footer) {
            const btn = document.getElementById('wwai-report-btn');
            if (btn) { btn.textContent = '✓ Reported!'; btn.disabled = true; }
            setTimeout(() => { if (btn) { btn.textContent = '⚑ Report issue'; btn.disabled = false; } }, 3000);
        }
    } catch (_) {}
}
