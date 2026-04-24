// Popup UI — shows resume status, current tab check, and session stats.
// WWStorage is available via ../lib/storage.js loaded before this script.

const iconResume  = document.getElementById('icon-resume');
const iconWw      = document.getElementById('icon-ww');
const jobsCount   = document.getElementById('jobs-count');
const nudge       = document.getElementById('nudge');
const btnSettings = document.getElementById('btn-settings');

btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

(async function init() {
    const [tab, { resume, jobsAnalyzed }] = await Promise.all([
        _getActiveTab(),
        WWStorage.getAll(),
    ]);

    // Resume status
    if (resume) {
        _setIcon(iconResume, true);
    } else {
        _setIcon(iconResume, false);
    }

    // WaterlooWorks status
    const onWW = tab?.url?.includes('waterlooworks.uwaterloo.ca') ?? false;
    _setIcon(iconWw, onWW);
    if (!onWW) nudge.classList.remove('hidden');

    // Session stats
    jobsCount.textContent = jobsAnalyzed ?? 0;
})();

function _getActiveTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            resolve(tabs[0] ?? null);
        });
    });
}

function _setIcon(el, on) {
    el.textContent = on ? '✓' : '✗';
    el.classList.toggle('status-icon--on',  on);
    el.classList.toggle('status-icon--off', !on);
}
