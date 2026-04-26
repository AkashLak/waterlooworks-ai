// Injected into every WaterlooWorks page.
// Depends on: WWStorage, WWScaper, WWAnalyzer (lib/),
//             renderers + DOM helpers (content/renderers.js),
//             action handlers (content/handlers.js).

// ── Shared state ───────────────────────────────────────────────────────────────
// These top-level vars are accessible from handlers.js and renderers.js
// because all content scripts share the same execution context.

let _currentJobId    = null;
let _currentDetail   = null;
let _currentAnalyses = null; // pre-computed analyses from submitJob / polling
let _batchRunning    = false;

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
                <div class="wwai-job-info__sniff wwai-hidden" id="wwai-sniff-flag">⚠️ Title may not match this role</div>
                <div class="wwai-job-info__preview wwai-hidden" id="wwai-role-preview"></div>
            </div>
            <div class="wwai-actions wwai-hidden" id="wwai-actions">
                <button class="wwai-btn wwai-btn--full wwai-btn--primary" data-mode="SHOULD_APPLY">✅ Should I Apply?</button>
                <div class="wwai-actions__row">
                    <button class="wwai-btn" data-mode="BEST_FIT">📊 Analyze Fit</button>
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
            <button class="wwai-btn wwai-btn--full wwai-btn--gold" id="wwai-batch-btn">
                📋 Score All Jobs
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
            <hr class="wwai-divider">
            <div class="wwai-suggestions">
                <div class="wwai-suggestions__title">Smart Suggestions</div>
                <button class="wwai-btn wwai-btn--full wwai-btn--suggestion" data-search="closing_soon">⏰ Closing Soon</button>
                <button class="wwai-btn wwai-btn--full wwai-btn--suggestion" data-search="top_fits">🎯 Top 5 Fits for Me</button>
                <div class="wwai-search-bar">
                    <input class="wwai-search-bar__input" id="wwai-search-input" type="text"
                        placeholder="Search jobs… e.g. remote, Toronto, data science">
                    <button class="wwai-btn wwai-btn--full" id="wwai-search-btn">🔍 Search</button>
                </div>
                <div class="wwai-status-line" id="wwai-status-line"></div>
            </div>
        </div>
        <div class="wwai-footer">WaterlooWorks AI — free to use</div>`;
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

    const searchInput = document.getElementById('wwai-search-input');
    const searchGo = () => { const q = searchInput.value.trim(); if (q) _handleFreeSearch(q); };
    document.getElementById('wwai-search-btn').addEventListener('click', searchGo);
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchGo(); });

    document.getElementById('wwai-batch-btn').addEventListener('click', _handleBatch);
    document.getElementById('wwai-cancel-btn').addEventListener('click', () =>
        WWAnalyzer.cancelBatch()
    );
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
        if (hasNewRows) _scheduleTableSync();
    }
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

function _onJobOpen(detail) {
    document.getElementById('wwai-job-title').textContent = detail.title;
    const row = WWScaper.scrapeRowByJobId(detail.jobId) ?? {};
    const deadline = row.appDeadline || detail.appDeadline || '';
    document.getElementById('wwai-job-meta').textContent =
        [detail.employer, deadline ? `Deadline: ${deadline}` : ''].filter(Boolean).join(' · ');
    _hide('wwai-sniff-flag');
    _hide('wwai-role-preview');

    _show('wwai-job-info'); _show('wwai-actions');
    _show('wwai-ask-divider'); _show('wwai-ask');
    _hide('wwai-empty'); _clearLoading(); _clearResult();

    _submitAndPoll(detail);
}

function _onJobClose() {
    _hide('wwai-job-info'); _hide('wwai-actions');
    _hide('wwai-ask-divider'); _hide('wwai-ask');
    _show('wwai-empty');
    _clearResult(); _clearLoading();
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
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && 'ww_resume' in changes) {
            _updateResumeStatus(!!changes.ww_resume.newValue);
        }
    });

    // Kick off initial status + table sync after DOM settles
    _refreshStatus();
    _scheduleTableSync();
})();
