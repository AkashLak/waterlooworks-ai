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
    else if (mode === 'SHOULD_APPLY')   _fillShouldIApply(card, data);
    else if (mode === 'DREAM_JOB')      _fillDreamJob(card, data);
    else if (mode === 'QA_SNIFF')       _fillQaSniff(card, data);
    else if (mode === 'ROLE_EXPLAINER') _fillRoleExplainer(card, data);
    else if (mode === 'SEARCH_RESULTS') _fillSearchResults(card, data);
    else if (mode === 'ASK')            _fillAsk(card, data);
    else                                _fillText(card, data, 'Result');

    container.appendChild(card);

    // Track for report feature
    _lastRenderedMode = mode;
    _lastRenderedData = data;
}

function _fillBestFit(card, d) {
    const score = d.fitScore ?? 0;
    const tier  = score >= 70 ? 'great' : score >= 40 ? 'decent' : 'poor';
    _label(card, 'Fit Analysis');
    _el(card, 'div', 'wwai-score', `${score} / 100`);
    const bar  = _el(card, 'div', 'wwai-score__bar');
    const fill = _el(bar, 'div', `wwai-score__fill wwai-score__fill--${tier}`);
    fill.style.width = `${score}%`;
    _el(card, 'p', 'wwai-verdict', d.verdict ?? '');
    if (d.strengths?.length) { _label(card, 'Strengths'); _tagList(card, d.strengths, 'green'); }
    if (d.gaps?.length)      { _label(card, 'Gaps');      _tagList(card, d.gaps, 'red'); }
}

function _fillDreamJob(card, d) {
    const isDream = d.isDream ?? d.isDreamJob ?? false;
    const isStretch = d.isStretch ?? false;

    let verdict, color;
    if (isDream)        { verdict = '⭐ Yes — pursue this!';       color = '#16a34a'; }
    else if (isStretch) { verdict = '🔭 Big stretch — try anyway'; color = '#b45309'; }
    else                { verdict = '❌ Not the right fit for you'; color = '#888'; }

    _label(card, 'Dream Job?');
    const v = _el(card, 'div', 'wwai-score', verdict);
    v.style.fontSize = '16px';
    v.style.color = color;
    if (d.reason) _el(card, 'p', 'wwai-verdict', d.reason);
    if (d.highlightInApplication) {
        _label(card, 'What to highlight');
        _tagList(card, [d.highlightInApplication], 'warn');
    }
}

function _fillQaSniff(card, d) {
    if (d.alternativeTitles?.length) { _label(card, 'Related job titles'); _tagList(card, d.alternativeTitles, 'warn'); }
    if (d.keyResponsibilities?.length) { _label(card, 'Key responsibilities'); _tagList(card, d.keyResponsibilities, 'green'); }
}

function _fillRoleExplainer(card, d) {
    if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch { /* fall through to plain-text fallback */ }
    }
    const sections = [
        { key: 'dayToDay', label: 'Day-to-Day' },
        { key: 'team',     label: 'Team & Environment' },
        { key: 'skills',   label: 'Skills Used' },
    ];
    let hasContent = false;
    for (const { key, label } of sections) {
        const items = d?.[key];
        if (!Array.isArray(items) || !items.length) continue;
        hasContent = true;
        _label(card, label);
        const ul = document.createElement('ul');
        ul.style.cssText = 'margin:4px 0 0 0; padding-left:16px;';
        items.forEach(item => {
            const li = document.createElement('li');
            li.textContent = item;
            li.style.marginBottom = '2px';
            ul.appendChild(li);
        });
        card.appendChild(ul);
    }
    if (!hasContent) {
        // Fallback for plain-text role explainer (backward compat)
        _fillText(card, typeof d === 'string' ? d : JSON.stringify(d), 'Role Summary');
    }
}

function _fillAsk(card, data) {
    const question = typeof data === 'string' ? null : data.question;
    const answer   = typeof data === 'string' ? data  : (data.answer ?? '');
    if (question) {
        _label(card, 'Your question');
        _el(card, 'p', 'wwai-verdict', question);
    }
    _label(card, 'Answer');
    const p = _el(card, 'p', '', answer);
    p.style.whiteSpace = 'pre-wrap';
    p.style.margin = '0';
}

function _fillText(card, data, labelText) {
    _label(card, labelText);
    const p = _el(card, 'p', '', typeof data === 'string' ? data : '');
    p.style.whiteSpace = 'pre-wrap';
    p.style.margin = '0';
}

function _fillSearchResults(card, data) {
    const jobs    = Array.isArray(data) ? data : (data?.jobs ?? []);
    const message = data?.message ?? null;
    const type    = data?.type ?? null;
    _label(card, `${jobs.length} Result${jobs.length !== 1 ? 's' : ''}`);
    if (!jobs.length) {
        _el(card, 'p', 'wwai-verdict', message ?? 'No matching jobs found.');
        return;
    }
    if (type === 'top_fits' && jobs.length < 10) {
        _el(card, 'p', 'wwai-verdict', `Showing ${jobs.length} of 10 — open more job postings and run 📋 Score All Jobs to fill out your Top 10.`);
    }
    for (const job of jobs) {
        const item = _el(card, 'div', 'wwai-search-result');
        _el(item, 'div', 'wwai-search-result__title', job.title ?? job.jobId ?? '');
        const metaParts = [job.employer, job.fitScore != null ? `Fit: ${job.fitScore}/10` : null].filter(Boolean);
        if (metaParts.length) _el(item, 'div', 'wwai-search-result__meta', metaParts.join(' · '));
        if (job.reason) _el(item, 'div', 'wwai-search-result__reason', job.reason);
    }
}

function _fillShouldIApply(card, { fit, dream, qa }) {
    const score      = fit?.fitScore ?? 0;
    const isDream = dream?.isDream ?? dream?.isDreamJob ?? false;

    let rec, tier;
    if      (score >= 70) { rec = '✅ Yes — Apply';               tier = 'great'; }
    else if (score >= 40 || isDream) { rec = '🤔 Maybe — Worth Considering';  tier = 'decent'; }
    else                  { rec = '❌ Likely Not a Match';          tier = 'poor'; }

    _label(card, 'Should I Apply?');
    const v = _el(card, 'div', 'wwai-score', rec);
    v.style.fontSize = '16px';
    const bar  = _el(card, 'div', 'wwai-score__bar');
    const fill = _el(bar,  'div', `wwai-score__fill wwai-score__fill--${tier}`);
    fill.style.width = `${score}%`;
    if (fit?.verdict) _el(card, 'p', 'wwai-verdict', `Fit ${score}/100 — ${fit.verdict}`);
    if (isDream && dream?.highlightInApplication) {
        _label(card, 'What to highlight');
        _tagList(card, [dream.highlightInApplication], 'warn');
    }
    if (fit?.strengths?.length) { _label(card, 'Your Strengths');  _tagList(card, fit.strengths, 'green'); }
    if (fit?.gaps?.length)      { _label(card, 'Gaps to Address'); _tagList(card, fit.gaps, 'red'); }
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
        btn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openOptions' }));
    } else if (err.type === 'quota_exceeded') {
        _el(card, 'p', 'wwai-quota-msg', err.message ?? 'Daily analysis limit reached — resets at midnight UTC.');
    } else if (err.type === 'invalid_api_key') {
        _el(card, 'p', 'wwai-quota-msg', err.message ?? 'Invalid API key — check your key in Settings.');
        const btn = _el(card, 'button', 'wwai-btn wwai-btn--full', '→ Open Settings');
        btn.style.marginTop = '8px';
        btn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'openOptions' }));
    } else {
        _el(card, 'p', '', err.message ?? 'An unexpected error occurred. Please try again.');
    }
    container.appendChild(card);
}

// ── Badge injection ────────────────────────────────────────────────────────────

function _injectBadge(row, score) {
    const titleEl = row.titleEl;
    if (!titleEl) return;
    titleEl.closest('tr.table__row--body')?.querySelector('.wwai-badge')?.remove();

    const badge = document.createElement('span');
    badge.className = 'wwai-badge';
    badge.style.cssText = 'margin-left:5px; font-size:12px; cursor:default;';
    badge.textContent = score == null
        ? '❓'
        : (score >= 70 ? '🟢' : score >= 40 ? '🟡' : '🔴') + ` ${score}`;
    badge.title = score == null
        ? 'Not yet analyzed'
        : `Fit score: ${score}/100`;
    titleEl.insertAdjacentElement('afterend', badge);
}

function _injectPrecomputedBadges(rows, jobsMap) {
    for (const row of rows) {
        // Always remove any stale badge first — WW reuses <tr> nodes across page navigation,
        // so a badge from page 1 would otherwise persist on a different job on page 2.
        row.titleEl?.closest('tr.table__row--body')?.querySelector('.wwai-badge')?.remove();

        const job = jobsMap[row.jobId];
        const batchFit = _getCached(row.jobId, 'BATCH_FIT');
        const score = batchFit?.fitScore ?? batchFit?.fit_score
                   ?? _persistedFitScores[row.jobId]
                   ?? (job ? (job.fitScore ?? job.fit_score ?? null) : null);
        if (score == null) continue;
        _injectBadge(row, score);
    }
}
