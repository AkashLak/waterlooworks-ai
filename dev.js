// Developer console for WaterlooWorks AI Assistant.
// Accessible at chrome-extension://[id]/dev.html
// Sends messages directly to background.js — bypasses WaterlooWorks DOM entirely.

const jobTitleEl  = document.getElementById('job-title');
const jobEmplEl   = document.getElementById('job-employer');
const jobDescEl   = document.getElementById('job-desc');
const askInputEl  = document.getElementById('ask-input');
const outputBox   = document.getElementById('output-box');
const outputLabel = document.getElementById('output-label');
const badgeResume = document.getElementById('badge-resume');
const badgeModel  = document.getElementById('badge-model');
const badgeJobs   = document.getElementById('badge-jobs');

// ── Init ───────────────────────────────────────────────────────────────────────

(async function init() {
    const { resume, jobsAnalyzed } = await WWStorage.getAll();

    if (resume) {
        badgeResume.textContent = `Resume: ✓ (${resume.length.toLocaleString()} chars)`;
        badgeResume.classList.add('badge--ok');
    } else {
        badgeResume.textContent = 'Resume: ✗ not set';
        badgeResume.classList.add('badge--err');
    }

    badgeJobs.textContent = `Jobs analyzed: ${jobsAnalyzed ?? 0}`;

    // Send a message to wake the service worker (which writes ww_dev_model to storage),
    // then read it in the callback — guarantees the value exists before we read it.
    chrome.runtime.sendMessage({ action: 'getStats' }, () => {
        chrome.storage.local.get('ww_dev_model', (result) => {
            badgeModel.textContent = `Model: ${result.ww_dev_model ?? 'see config.js'}`;
        });
    });
})();

// Keep badges in sync whenever storage changes (service worker startup, Options page, etc.)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ww_dev_model?.newValue) {
        badgeModel.textContent = `Model: ${changes.ww_dev_model.newValue}`;
    }
    if (changes.ww_resume) {
        const resume = changes.ww_resume.newValue;
        if (resume) {
            badgeResume.textContent = `Resume: ✓ (${resume.length.toLocaleString()} chars)`;
            badgeResume.classList.add('badge--ok');
            badgeResume.classList.remove('badge--err');
        } else {
            badgeResume.textContent = 'Resume: ✗ not set';
            badgeResume.classList.remove('badge--ok');
            badgeResume.classList.add('badge--err');
        }
    }
    if (changes.ww_jobs_analyzed) {
        badgeJobs.textContent = `Jobs analyzed: ${changes.ww_jobs_analyzed.newValue ?? 0}`;
    }
});

// ── Mode buttons ───────────────────────────────────────────────────────────────

document.querySelectorAll('.btn--mode').forEach((btn) => {
    btn.addEventListener('click', () => _runAnalysis(btn.dataset.mode));
});

// ── Ask ────────────────────────────────────────────────────────────────────────

document.getElementById('btn-ask').addEventListener('click', () => {
    const q = askInputEl.value.trim();
    if (q) _runAnalysis('ASK', q);
});
askInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const q = askInputEl.value.trim(); if (q) _runAnalysis('ASK', q); }
});

// ── Utilities ──────────────────────────────────────────────────────────────────

document.getElementById('btn-copy').addEventListener('click', () => {
    const text = outputBox.innerText;
    if (text) navigator.clipboard.writeText(text).catch(() => {});
});

document.getElementById('btn-reset-stats').addEventListener('click', async () => {
    await WWStorage.resetJobsAnalyzed();
    badgeJobs.textContent = 'Jobs analyzed: 0';
});

document.getElementById('btn-clear-resume').addEventListener('click', async () => {
    if (!confirm('Clear the saved resume?')) return;
    await WWStorage.clearResume();
    badgeResume.textContent = 'Resume: ✗ not set';
    badgeResume.classList.remove('badge--ok');
    badgeResume.classList.add('badge--err');
});

// ── Core ───────────────────────────────────────────────────────────────────────

function _runAnalysis(mode, question = null) {
    const jobDescription = jobDescEl.value.trim();
    if (!jobDescription) {
        _showError('Job description is empty.');
        return;
    }

    const modeLabels = {
        BEST_FIT: 'Fit Analysis', DREAM_JOB: 'Dream Job', QA_SNIFF: 'Sniff Test',
        ROLE_EXPLAINER: 'Role Explainer', ASK: `Ask: "${question}"`,
    };

    _setLoading(modeLabels[mode] ?? mode);

    chrome.runtime.sendMessage({
        action:         'analyze',
        mode,
        jobId:          'dev-test',
        jobTitle:       jobTitleEl.value.trim(),
        employer:       jobEmplEl.value.trim(),
        jobDescription,
        question,
        batchMode:      false,
    }, (response) => {
        if (chrome.runtime.lastError) {
            _showError('Background unreachable. Reload the extension.');
            return;
        }
        if (!response?.success) {
            _showError(response?.error ?? 'Unknown error.');
            return;
        }
        _showResult(modeLabels[mode] ?? mode, response.data);
    });
}

function _setLoading(label) {
    outputLabel.textContent = label;
    outputBox.innerHTML = '';
    const el = document.createElement('span');
    el.className = 'output-loading';
    el.textContent = 'Waiting for Gemini…';
    outputBox.appendChild(el);

    // Update badge jobs count after a result comes in
    WWStorage.getJobsAnalyzed().then(n => { badgeJobs.textContent = `Jobs analyzed: ${n}`; });
}

function _showResult(label, data) {
    outputLabel.textContent = label;
    outputBox.textContent = typeof data === 'string'
        ? data
        : JSON.stringify(data, null, 2);

    WWStorage.getJobsAnalyzed().then(n => { badgeJobs.textContent = `Jobs analyzed: ${n}`; });
}

function _showError(msg) {
    outputLabel.textContent = 'Error';
    outputBox.innerHTML = '';
    const el = document.createElement('span');
    el.className = 'output-error';
    el.textContent = msg;
    outputBox.appendChild(el);
}
