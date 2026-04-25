// Result rendering and DOM helpers for the WaterlooWorks AI panel.
// Loaded before handlers.js and content.js — all functions are shared via top-level scope.

// ── DOM helpers ────────────────────────────────────────────────────────────────

function _el(parent, tag, cls, text = '') {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = text; // always textContent — never innerHTML for dynamic data
    parent.appendChild(el);
    return el;
}

function _label(parent, text) {
    const l = _el(parent, 'div', 'wwai-result__label', text);
    l.style.marginTop = '6px';
    return l;
}

function _tagList(parent, items, color) {
    const w = _el(parent, 'div', 'wwai-tag-list');
    items.forEach(t => _el(w, 'span', `wwai-tag wwai-tag--${color}`, t));
}

function _show(id) { document.getElementById(id)?.classList.remove('wwai-hidden'); }
function _hide(id) { document.getElementById(id)?.classList.add('wwai-hidden'); }

function _setLoading(msg) {
    document.getElementById('wwai-loading-text').textContent = msg;
    _show('wwai-loading');
}

function _clearLoading() { _hide('wwai-loading'); }

function _clearResult() {
    const el = document.getElementById('wwai-result');
    if (el) { el.innerHTML = ''; el.classList.add('wwai-hidden'); }
}

// ── Result renderers ───────────────────────────────────────────────────────────

function _renderResult(mode, data) {
    const container = document.getElementById('wwai-result');
    container.innerHTML = '';
    container.classList.remove('wwai-hidden');

    const card = document.createElement('div');
    card.className = 'wwai-result';

    if (mode === 'BEST_FIT')            _fillBestFit(card, data);
    else if (mode === 'DREAM_JOB')      _fillDreamJob(card, data);
    else if (mode === 'QA_SNIFF')       _fillQaSniff(card, data);
    else if (mode === 'SEARCH_RESULTS') _fillSearchResults(card, data);
    else                                _fillText(card, data, mode === 'ROLE_EXPLAINER' ? 'Day-to-Day Breakdown' : 'Answer');

    container.appendChild(card);
}

function _fillBestFit(card, d) {
    const score = d.fitScore ?? 0;
    const tier  = score >= 8 ? 'great' : score >= 5 ? 'decent' : 'poor';
    _label(card, 'Fit Analysis');
    _el(card, 'div', 'wwai-score', `${score} / 10`);
    const bar  = _el(card, 'div', 'wwai-score__bar');
    const fill = _el(bar, 'div', `wwai-score__fill wwai-score__fill--${tier}`);
    fill.style.width = `${score * 10}%`;
    _el(card, 'p', 'wwai-verdict', d.verdict ?? '');
    if (d.strengths?.length) { _label(card, 'Strengths'); _tagList(card, d.strengths, 'green'); }
    if (d.gaps?.length)      { _label(card, 'Gaps');      _tagList(card, d.gaps, 'red'); }
}

function _fillDreamJob(card, d) {
    _label(card, 'Dream Job Analysis');
    const v = _el(card, 'div', 'wwai-score', d.isDreamJob ? '⭐ Dream Job!' : 'Not a dream job');
    v.style.fontSize = '18px';
    v.style.color = d.isDreamJob ? '#1a1a1a' : '#888';
    _el(card, 'p', 'wwai-verdict', d.reason ?? '');
    if (d.isDreamJob && d.highlightInApplication) {
        _label(card, 'What to highlight');
        _tagList(card, [d.highlightInApplication], 'warn');
    }
}

function _fillQaSniff(card, d) {
    _label(card, 'Role Check');
    const matches = d.titleMatchesRole ?? true;
    const v = _el(card, 'div', 'wwai-score',
        matches ? '✓ Title matches the role' : `⚠️ ${d.actualRole ?? 'Title is misleading'}`
    );
    v.style.fontSize = '15px';
    v.style.color = matches ? '#22c55e' : '#ef4444';
    if (d.summary) _el(card, 'p', 'wwai-verdict', d.summary);
    if (d.redFlags?.length)       { _label(card, 'Red Flags');           _tagList(card, d.redFlags, 'red'); }
    if (d.alsoGoodFitFor?.length) { _label(card, 'Also a good fit for'); _tagList(card, d.alsoGoodFitFor, 'warn'); }
}

function _fillText(card, data, labelText) {
    _label(card, labelText);
    const p = _el(card, 'p', '', typeof data === 'string' ? data : '');
    p.style.whiteSpace = 'pre-wrap';
    p.style.margin = '0';
}

function _fillSearchResults(card, jobs) {
    _label(card, `${jobs.length} Result${jobs.length !== 1 ? 's' : ''}`);
    if (!jobs.length) {
        _el(card, 'p', 'wwai-verdict', 'No matching jobs found.');
        return;
    }
    for (const job of jobs) {
        const item = _el(card, 'div', 'wwai-search-result');
        _el(item, 'div', 'wwai-search-result__title', job.title ?? job.jobId ?? '');
        const metaParts = [job.employer, job.fitScore != null ? `Fit: ${job.fitScore}/10` : null].filter(Boolean);
        if (metaParts.length) _el(item, 'div', 'wwai-search-result__meta', metaParts.join(' · '));
        if (job.reason) _el(item, 'div', 'wwai-search-result__reason', job.reason);
    }
}

// ── Error renderer ─────────────────────────────────────────────────────────────

function _renderError(err) {
    const container = document.getElementById('wwai-result');
    container.innerHTML = '';
    container.classList.remove('wwai-hidden');

    const card = document.createElement('div');
    card.className = 'wwai-result';

    if (err.type === 'no_resume') {
        _el(card, 'p', '', 'Add your resume in Settings to start analyzing.');
        const btn = _el(card, 'button', 'wwai-btn wwai-btn--full', '→ Open Settings');
        btn.style.marginTop = '8px';
        btn.addEventListener('click', () => chrome.runtime.openOptionsPage());
    } else {
        _el(card, 'p', '', err.message ?? 'An unexpected error occurred. Please try again.');
    }
    container.appendChild(card);
}

// ── Badge injection ────────────────────────────────────────────────────────────

function _injectBadge(row, score, isQa) {
    const titleEl = row.titleEl;
    if (!titleEl) return;
    titleEl.closest('tr.table__row--body')?.querySelector('.wwai-badge')?.remove();

    const badge = document.createElement('span');
    badge.className = 'wwai-badge';
    badge.style.cssText = 'margin-left:5px; font-size:12px; cursor:default;';
    badge.textContent = score == null
        ? '❓'
        : (score >= 8 ? '🟢' : score >= 5 ? '🟡' : '🔴') + (isQa ? ' ⚠️' : '');
    badge.title = score == null
        ? 'Not yet analyzed'
        : `Fit: ${score}/10${isQa ? ' — may be QA role' : ''}`;
    titleEl.insertAdjacentElement('afterend', badge);
}

function _injectPrecomputedBadges(rows, jobsMap) {
    for (const row of rows) {
        const job = jobsMap[row.jobId];
        if (!job) continue;
        const score = job.fitScore ?? null;
        const isQa  = job.qaResult ? !job.qaResult.titleMatchesRole : false;
        _injectBadge(row, score, isQa);
    }
}
