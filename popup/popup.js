// Popup UI — shows resume status, current tab check, and session stats.
// WWStorage is available via ../lib/storage.js loaded before this script.

const iconResume  = document.getElementById('icon-resume');
const iconWw      = document.getElementById('icon-ww');
const jobsCount   = document.getElementById('jobs-count');
const nudge       = document.getElementById('nudge');
const btnSettings = document.getElementById('btn-settings');

btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

(async function init() {
    const [tab, storage] = await Promise.all([
        _getActiveTab(),
        WWStorage.getAll(),
    ]);

    // Resume status
    _setIcon(iconResume, !!storage.resume);

    // WaterlooWorks status
    const onWW = tab?.url?.includes('waterlooworks.uwaterloo.ca') ?? false;
    _setIcon(iconWw, onWW);
    if (!onWW) nudge.classList.remove('hidden');

    // Live job count from backend
    jobsCount.textContent = '…';
    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
        if (response?.success) {
            const count = response.data?.totalJobs ?? response.data?.jobCount ?? 0;
            jobsCount.textContent = count;
        } else {
            jobsCount.textContent = '—';
        }
    });
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
