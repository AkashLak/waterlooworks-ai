// Service worker for WaterlooWorks AI Assistant.
// SECURITY: This is the only file that reads API_SECRET or calls the backend.
// All requests from content scripts are routed here via chrome.runtime.sendMessage.

importScripts('../config.js', '../lib/storage.js', '../lib/api.js');

// ── Dev-mode logger ────────────────────────────────────────────────────────────
// SECURITY: Never log API_SECRET or resume text.

function _log(...args) {
    if (typeof DEV_MODE !== 'undefined' && DEV_MODE) {
        console.log('[WW AI]', ...args);
    }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

// Bump this string whenever the job-tracking logic changes to force a one-time reset.
const TRACKING_VERSION = '2';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    _log('Extension lifecycle event, reason:', reason);
    const stored = await new Promise(r =>
        chrome.storage.local.get('ww_tracking_version', d => r(d.ww_tracking_version))
    );
    if (stored !== TRACKING_VERSION) {
        await WWStorage.resetJobsAnalyzed();
        chrome.storage.local.set({ ww_tracking_version: TRACKING_VERSION });
        _log('Job tracking reset to version', TRACKING_VERSION);
    }
});

// ── Message router ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Reject messages that did not originate from this extension.
    if (sender.id !== chrome.runtime.id) {
        _log('Rejected message from unexpected sender id');
        return;
    }

    // Wraps an async handler: resolves → { success, data }; rejects → { success, error, errorType }
    const respond = (promise) => {
        promise.then(
            (data) => sendResponse({ success: true, data }),
            (err)  => sendResponse({
                success:   false,
                error:     err.message ?? 'An unexpected error occurred.',
                errorType: err.type,
            }),
        );
        return true; // keep channel open for async sendResponse
    };

    switch (message.action) {
        case 'submitJob':
            return respond(_handleSubmitJob(message.jobData));

        case 'getJobAnalyses':
            return respond(WWApi.getJobAnalyses(message.jobId));

        case 'getAllJobs':
            return respond(WWApi.getAllJobs(message.filters));

        case 'getFitScore':
            return respond(_handleGetFitScore(message.jobId));

        case 'getDreamFit':
            return respond(_handleGetDreamFit(message.jobId, message.dreamCriteria));

        case 'createReport':
            return respond(WWApi.createReport(message.feature, message.input, message.output, message.note));

        case 'syncActiveJobs':
            return respond(WWApi.syncActiveJobs(message.rows));

        case 'searchJobs':
            return respond(_handleSearchJobs(message.criteria));

        case 'askQuestion':
            return respond(_handleAskQuestion(message.jobId, message.question));

        case 'getStatus':
        case 'testConnection': // alias used by options page
            return respond(WWApi.getStatus());

        case 'openOptions':
            chrome.runtime.openOptionsPage();
            return;

        case 'getStats': // dev.html compat
            return respond(WWStorage.getAll());

        default:
            _log('Received unknown action:', message.action);
    }
});

// ── Handlers ───────────────────────────────────────────────────────────────────

async function _handleSubmitJob(jobData) {
    if (jobData?.jobId) await WWStorage.recordAnalyzedJob(jobData.jobId);
    return WWApi.submitJob(jobData);
}

// ── Handlers that require resume from storage ──────────────────────────────────
// Resume is always read here in the background and never accepted from the
// content script message payload — limits the surface area where resume text is in memory.

async function _handleGetFitScore(jobId) {
    const resume = await _requireResume();
    _log('getFitScore | job:', jobId);
    return WWApi.getFitScore(jobId, resume);
}

async function _handleGetDreamFit(jobId, dreamCriteria) {
    const resume = await _requireResume();
    _log('getDreamFit | job:', jobId);
    return WWApi.getDreamFit(jobId, resume, dreamCriteria);
}

async function _handleSearchJobs(criteria) {
    // top_fits and free_search rank against the user's resume — require it.
    // closing_soon and similar_roles work without a resume.
    const needsResume = criteria?.criteria === 'top_fits' || criteria?.criteria === 'free_search';
    const resume = needsResume
        ? await _requireResume()
        : (await WWStorage.getResume() ?? null);
    _log('searchJobs | type:', criteria?.criteria);
    return WWApi.searchJobs(resume, criteria ?? {});
}

async function _handleAskQuestion(jobId, question) {
    const resume = await WWStorage.getResume(); // optional — send if available, don't block if not
    _log('askQuestion | job:', jobId);
    return WWApi.askQuestion(jobId, question, resume);
}

async function _requireResume() {
    const resume = await WWStorage.getResume();
    if (!resume) {
        throw Object.assign(
            new Error('No resume found. Please add your resume in Settings first.'),
            { type: 'no_resume' },
        );
    }
    return resume;
}
