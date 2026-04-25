// Developer console for WaterlooWorks AI Assistant.
// Accessible at chrome-extension://[id]/dev.html
// Sends messages directly to background.js to test backend connectivity and storage state.

const outputBox   = document.getElementById('output-box');
const outputLabel = document.getElementById('output-label');
const badgeResume = document.getElementById('badge-resume');
const badgeStatus = document.getElementById('badge-model'); // repurposed for backend status
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

    // Check backend connectivity on load
    _testBackend();
})();

// Keep badges in sync whenever storage changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
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

// ── Backend status test ────────────────────────────────────────────────────────

function _testBackend() {
    badgeStatus.textContent = 'Backend: checking…';
    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
            badgeStatus.textContent = 'Backend: ✗ unreachable';
            badgeStatus.classList.add('badge--err');
            return;
        }
        const count = response.data?.jobCount ?? response.data?.total ?? '?';
        badgeStatus.textContent = `Backend: ✓ (${count} jobs)`;
        badgeStatus.classList.add('badge--ok');
    });
}

document.getElementById('btn-ask')?.addEventListener('click', _testBackend);

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

// ── Status display ─────────────────────────────────────────────────────────────

function _showResult(label, data) {
    outputLabel.textContent = label;
    outputBox.textContent = typeof data === 'string'
        ? data
        : JSON.stringify(data, null, 2);
}

function _showError(msg) {
    outputLabel.textContent = 'Error';
    outputBox.innerHTML = '';
    const el = document.createElement('span');
    el.className = 'output-error';
    el.textContent = msg;
    outputBox.appendChild(el);
}

// Show backend status in the output area on demand
document.querySelectorAll('.btn--mode').forEach((btn) => {
    btn.addEventListener('click', () => {
        outputLabel.textContent = 'Backend Status';
        outputBox.textContent = 'Fetching…';
        chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
            if (chrome.runtime.lastError) {
                _showError('Background unreachable. Reload the extension.');
                return;
            }
            if (!response?.success) {
                _showError(response?.error ?? 'Unknown error.');
                return;
            }
            _showResult('Backend Status', response.data);
        });
    });
});
