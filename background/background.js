// Service worker for WaterlooWorks AI Assistant.
// SECURITY: This is the only file that reads GEMINI_API_KEY or calls the Gemini API.
// All AI requests from content scripts are routed here via chrome.runtime.sendMessage.

importScripts('../config.js', '../lib/storage.js', '../lib/ai.js');

// ── Dev-mode logger ────────────────────────────────────────────────────────────
// SECURITY: Never log GEMINI_API_KEY, resume text, or raw API responses.

function _log(...args) {
    if (typeof DEV_MODE !== 'undefined' && DEV_MODE) {
        console.log('[WW AI]', ...args);
    }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
    _log('Extension lifecycle event, reason:', reason);
});

// ── Message router ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Security: reject any message that did not originate from this extension.
    // Content scripts from waterlooworks.uwaterloo.ca are sandboxed in an isolated
    // world, but the sender.id check ensures no other extension or injected script
    // can trigger our handlers.
    if (sender.id !== chrome.runtime.id) {
        _log('Rejected message from unexpected sender id');
        return;
    }

    switch (message.action) {
        case 'analyze':
            handleAnalyze(message, sender).then(
                (data) => sendResponse({ success: true, data }),
                (err)  => sendResponse({
                    success:           false,
                    error:             err.message ?? 'An unexpected error occurred.',
                    errorType:         err.type,
                    retryAfterSeconds: err.retryAfterSeconds,
                }),
            );
            return true; // keep channel open so async sendResponse is valid

        case 'testConnection':
            handleTestConnection().then(
                ()    => sendResponse({ success: true }),
                (err) => sendResponse({ success: false, error: err.message }),
            );
            return true;

        case 'getStats':
            WWStorage.getAll().then(
                (data) => sendResponse({ success: true, data }),
                (err)  => sendResponse({ success: false, error: err.message }),
            );
            return true;

        default:
            _log('Received unknown action:', message.action);
    }
});

// ── Handlers ───────────────────────────────────────────────────────────────────

async function handleAnalyze(message, sender) {
    const { mode, jobId, jobTitle, employer, jobDescription, question, batchMode } = message;

    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
        throw Object.assign(
            new Error('Gemini API key is not configured. Please set it in config.js.'),
            { type: 'no_api_key' },
        );
    }

    // Resume is always read directly from storage here in the background.
    // It is never passed through the content script message payload to minimize
    // the surface area where resume text is in memory.
    const resume = await WWStorage.getResume();
    if (!resume) {
        throw Object.assign(
            new Error('No resume found. Please add your resume in Settings first.'),
            { type: 'no_resume' },
        );
    }

    _log('Analyzing | job:', jobId, '| mode:', mode, '| batch:', batchMode ?? false);

    const tabId = sender.tab?.id;

    const result = await WWAi.analyze({
        mode,
        resume,
        jobDescription,
        question,
        apiKey:    GEMINI_API_KEY,
        batchMode: batchMode ?? false,

        // Push retry progress to the content script so the panel can show
        // "Rate limit hit, retrying in Xs..." without blocking sendResponse.
        onProgress: tabId != null
            ? (update) => {
                // Spread would overwrite 'type', so pass fields explicitly
                chrome.tabs.sendMessage(tabId, {
                    type:         'wwai_progress',
                    progressType: update.type,
                    delaySeconds: update.delaySeconds,
                }).catch(() => {}); // tab may have closed between retries
              }
            : undefined,
    });

    // Increment session counter — fire-and-forget; storage errors must not
    // propagate back and fail the analysis response.
    WWStorage.incrementJobsAnalyzed().catch(() => {});

    _log('Analysis complete | mode:', mode, '| job:', jobId);

    return result;
}

async function handleTestConnection() {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
        throw new Error('Gemini API key is not configured in config.js.');
    }

    // Minimal round-trip to confirm the API key is valid and the endpoint is reachable.
    // Uses ASK mode so it goes through the same code path as real analysis calls.
    await WWAi.analyze({
        mode:           WWAi.MODES.ASK,
        resume:         '(connection test)',
        jobDescription: '(connection test)',
        question:       'Respond with only the word "ok".',
        apiKey:         GEMINI_API_KEY,
    });

    _log('Connection test passed');
}
