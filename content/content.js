// Injected into every WaterlooWorks page.
// Depends on WWStorage, WWScaper, WWAnalyzer (loaded first via manifest content_scripts order).

// ── State ──────────────────────────────────────────────────────────────────────

let _currentJobId  = null;
let _currentDetail = null;
let _activeMode    = null;
let _batchRunning  = false;

// ── Panel creation ─────────────────────────────────────────────────────────────

function _buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'wwai-panel';
    // Static developer-authored HTML — dynamic content always set via textContent below
    panel.innerHTML = `
        <div class="wwai-header">
            <span class="wwai-header__title">WaterlooWorks AI</span>
            <button class="wwai-header__close" aria-label="Close">✕</button>
        </div>
        <div class="wwai-body">
            <div class="wwai-empty" id="wwai-empty">Click a job title to start analyzing.</div>
            <div class="wwai-job-info wwai-hidden" id="wwai-job-info">
                <div class="wwai-job-info__title"    id="wwai-job-title"></div>
                <div class="wwai-job-info__employer" id="wwai-job-employer"></div>
            </div>
            <div class="wwai-actions wwai-hidden" id="wwai-actions">
                <button class="wwai-btn" data-mode="BEST_FIT">📊 Analyze Fit</button>
                <button class="wwai-btn" data-mode="DREAM_JOB">⭐ Dream Job?</button>
                <button class="wwai-btn" data-mode="QA_SNIFF">🔍 Sniff Test</button>
                <button class="wwai-btn" data-mode="ROLE_EXPLAINER">💼 Explain Role</button>
            </div>
            <div class="wwai-loading wwai-hidden" id="wwai-loading">
                <div class="wwai-spinner"></div>
                <span id="wwai-loading-text">Analyzing...</span>
            </div>
            <div id="wwai-result" class="wwai-hidden"></div>
            <hr class="wwai-divider wwai-hidden" id="wwai-ask-divider">
            <div class="wwai-ask wwai-hidden" id="wwai-ask">
                <input class="wwai-ask__input" id="wwai-ask-input" type="text"
                    placeholder="Ask anything about this job...">
                <button class="wwai-ask__btn" id="wwai-ask-btn">Ask</button>
            </div>
            <hr class="wwai-divider">
            <button class="wwai-btn wwai-btn--full wwai-btn--gold" id="wwai-batch-btn">
                📋 Analyze All Visible Jobs
            </button>
            <div id="wwai-batch-progress" class="wwai-hidden">
                <div class="wwai-progress">
                    <span id="wwai-batch-text"></span>
                    <div class="wwai-progress__bar">
                        <div class="wwai-progress__fill" id="wwai-batch-bar" style="width:0%"></div>
                    </div>
                </div>
                <button class="wwai-btn wwai-btn--full" id="wwai-cancel-btn">Cancel</button>
            </div>
            <div id="wwai-batch-summary" class="wwai-summary wwai-hidden"></div>
        </div>
        <div class="wwai-footer">Powered by Gemini — free to use</div>`;
    return panel;
}

// ── Wire events ────────────────────────────────────────────────────────────────

function _wireEvents(panel) {
    panel.querySelector('.wwai-header__close').addEventListener('click', _closePanel);

    panel.querySelectorAll('.wwai-btn[data-mode]').forEach((btn) =>
        btn.addEventListener('click', () => _handleAnalyze(btn.dataset.mode))
    );

    const askInput = document.getElementById('wwai-ask-input');
    const submit   = () => { const q = askInput.value.trim(); if (q) _handleAsk(q); };
    document.getElementById('wwai-ask-btn').addEventListener('click', submit);
    askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    document.getElementById('wwai-batch-btn').addEventListener('click', _handleBatch);
    document.getElementById('wwai-cancel-btn').addEventListener('click', () => {
        WWAnalyzer.cancelBatch();
    });
}

// ── Panel open / close ─────────────────────────────────────────────────────────

const _panel = _buildPanel();

function _openPanel()   { _panel.classList.add('wwai-open');    sessionStorage.setItem('wwai_panel_open', '1'); }
function _closePanel()  { _panel.classList.remove('wwai-open'); sessionStorage.setItem('wwai_panel_open', '0'); }
function _togglePanel() { _panel.classList.contains('wwai-open') ? _closePanel() : _openPanel(); }

// ── Job change detection ───────────────────────────────────────────────────────

new MutationObserver(() => {
    const modal  = WWScaper.getActiveModal();
    if (modal) {
        const detail = WWScaper.scrapeJobDetail(modal);
        if (detail?.jobId && detail.jobId !== _currentJobId) {
            _currentJobId  = detail.jobId;
            _currentDetail = detail;
            _onJobOpen(detail);
        }
    } else if (_currentJobId) {
        _currentJobId  = null;
        _currentDetail = null;
        _onJobClose();
    }
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

function _onJobOpen(detail) {
    // Use textContent — these values are scraped from the page (user-controlled)
    document.getElementById('wwai-job-title').textContent    = detail.title;
    document.getElementById('wwai-job-employer').textContent = detail.employer;

    _show('wwai-job-info'); _show('wwai-actions');
    _show('wwai-ask-divider'); _show('wwai-ask');
    _hide('wwai-empty');

    _clearResult(); _clearLoading();
}

function _onJobClose() {
    _hide('wwai-job-info'); _hide('wwai-actions');
    _hide('wwai-ask-divider'); _hide('wwai-ask');
    _show('wwai-empty');
    _clearResult(); _clearLoading();
}

// ── Analysis handlers ──────────────────────────────────────────────────────────

async function _handleAnalyze(mode) {
    if (!_currentJobId) return;

    const cached = _getCached(_currentJobId, mode);
    if (cached) { _activeMode = mode; _renderResult(mode, cached); return; }

    _activeMode = mode;
    _setLoading('Analyzing...');
    _clearResult();

    try {
        const result = await WWAnalyzer.analyzeCurrent(mode);
        _setCached(_currentJobId, mode, result);
        _renderResult(mode, result);
    } catch (err) {
        _renderError(err);
    } finally {
        _clearLoading();
    }
}

async function _handleAsk(question) {
    if (!_currentJobId) return;

    _setLoading('Thinking...');
    _clearResult();

    try {
        const result = await WWAnalyzer.analyzeCurrent('ASK', question);
        _renderResult('ASK', result);
        document.getElementById('wwai-ask-input').value = '';
    } catch (err) {
        _renderError(err);
    } finally {
        _clearLoading();
    }
}

async function _handleBatch() {
    if (_batchRunning) return;
    _batchRunning = true;

    _show('wwai-batch-progress'); _hide('wwai-batch-summary');
    document.getElementById('wwai-batch-bar').style.width = '0%';

    await WWAnalyzer.analyzeBatch(
        ({ current, total, jobTitle }) => {
            document.getElementById('wwai-batch-text').textContent =
                `Analyzing job ${current} of ${total}…`;
            document.getElementById('wwai-batch-bar').style.width =
                `${Math.round((current / total) * 100)}%`;
        },
        ({ row, jobId, fitResult, qaResult, error }) => {
            const score = fitResult?.fitScore ?? 0;
            const isQa  = qaResult?.isDisguised ?? false;
            if (!error) { _setCached(jobId, 'BEST_FIT', fitResult); _setCached(jobId, 'QA_SNIFF', qaResult); }
            _injectBadge(row, error ? null : score, isQa);
        },
        (stats) => {
            _batchRunning = false;
            _hide('wwai-batch-progress');
            const el = document.getElementById('wwai-batch-summary');
            el.textContent = [
                `🟢 ${stats.great} great`,
                `🟡 ${stats.decent} decent`,
                `🔴 ${stats.poor} poor`,
                stats.disguised ? `⚠️ ${stats.disguised} QA in disguise` : null,
                stats.cancelled ? '(cancelled)' : null,
            ].filter(Boolean).join(' · ');
            _show('wwai-batch-summary');
        },
    );
}

function _injectBadge(row, score, isQa) {
    const tr = row.titleEl?.closest('tr.table__row--body');
    if (!tr) return;
    tr.querySelector('.wwai-badge')?.remove(); // remove any previous badge

    const badge = document.createElement('span');
    badge.className = 'wwai-badge';
    badge.style.cssText = 'margin-left:5px; font-size:12px;';
    badge.textContent = score == null
        ? '❓'
        : (score >= 8 ? '🟢' : score >= 5 ? '🟡' : '🔴') + (isQa ? ' ⚠️' : '');
    badge.title = score == null ? 'Analysis failed' : `Fit: ${score}/10${isQa ? ' — may be QA role' : ''}`;
    row.titleEl?.insertAdjacentElement('afterend', badge);
}

// ── Result renderers ───────────────────────────────────────────────────────────

function _renderResult(mode, data) {
    const container = document.getElementById('wwai-result');
    container.innerHTML = '';
    container.classList.remove('wwai-hidden');

    const card = document.createElement('div');
    card.className = 'wwai-result';

    if (mode === 'BEST_FIT')       _fillBestFit(card, data);
    else if (mode === 'DREAM_JOB') _fillDreamJob(card, data);
    else if (mode === 'QA_SNIFF')  _fillQaSniff(card, data);
    else                            _fillText(card, data, mode === 'ROLE_EXPLAINER' ? 'Day-to-Day Breakdown' : 'Answer');

    container.appendChild(card);
}

function _fillBestFit(card, d) {
    const score = d.fitScore ?? 0;
    const tier  = score >= 8 ? 'great' : score >= 5 ? 'decent' : 'poor';
    _label(card, 'Fit Analysis');
    _el(card, 'div', 'wwai-score', `${score} / 10`);
    const bar = _el(card, 'div', 'wwai-score__bar');
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
    _label(card, 'Sniff Test');
    const v = _el(card, 'div', 'wwai-score', d.isDisguised ? `⚠️ ${d.actualRole ?? 'Disguised role'}` : '✓ Looks like real dev work');
    v.style.fontSize = '15px';
    v.style.color = d.isDisguised ? '#ef4444' : '#22c55e';
    if (d.redFlags?.length) { _label(card, 'Red Flags'); _tagList(card, d.redFlags, 'red'); }
}

function _fillText(card, data, labelText) {
    _label(card, labelText);
    const p = _el(card, 'p', '', typeof data === 'string' ? data : '');
    p.style.whiteSpace = 'pre-wrap';
    p.style.margin = '0';
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
        if (_activeMode) {
            const btn = _el(card, 'button', 'wwai-btn wwai-btn--full', 'Retry');
            btn.style.marginTop = '8px';
            btn.addEventListener('click', () => _handleAnalyze(_activeMode));
        }
    }
    container.appendChild(card);
}

// ── DOM helpers ────────────────────────────────────────────────────────────────

function _el(parent, tag, cls, text = '') {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = text; // always textContent — never innerHTML for dynamic data
    parent.appendChild(el);
    return el;
}
function _label(parent, text)             { const l = _el(parent, 'div', 'wwai-result__label', text); l.style.marginTop = '6px'; return l; }
function _tagList(parent, items, color)   { const w = _el(parent, 'div', 'wwai-tag-list'); items.forEach(t => _el(w, 'span', `wwai-tag wwai-tag--${color}`, t)); }
function _show(id) { document.getElementById(id)?.classList.remove('wwai-hidden'); }
function _hide(id) { document.getElementById(id)?.classList.add('wwai-hidden'); }
function _setLoading(msg)  { document.getElementById('wwai-loading-text').textContent = msg; _show('wwai-loading'); }
function _clearLoading()   { _hide('wwai-loading'); }
function _clearResult()    { const el = document.getElementById('wwai-result'); el.innerHTML = ''; _hide('wwai-result'); }

// ── SessionStorage cache ───────────────────────────────────────────────────────

function _cacheKey(jobId, mode)      { return `wwai_${jobId}_${mode}`; }
function _getCached(jobId, mode)     { try { return JSON.parse(sessionStorage.getItem(_cacheKey(jobId, mode))); } catch { return null; } }
function _setCached(jobId, mode, d)  { try { sessionStorage.setItem(_cacheKey(jobId, mode), JSON.stringify(d)); } catch {} }

// ── Progress messages from background (429 retry status) ──────────────────────

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'wwai_progress' && msg.progressType === 'retrying') {
        const el = document.getElementById('wwai-loading-text');
        if (el) el.textContent = `Rate limit hit — retrying in ${msg.delaySeconds}s…`;
    }
});

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

    // Restore panel open/close state from previous navigation in this tab
    if (sessionStorage.getItem('wwai_panel_open') === '1') _openPanel();
})();
