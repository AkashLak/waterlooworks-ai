// Service worker for WaterlooWorks AI Assistant.
// SECURITY: This is the only file that reads GEMINI_API_KEY or calls the Gemini API.
// All AI requests from content scripts are routed here via chrome.runtime.sendMessage.

importScripts('../config.js', '../lib/storage.js', '../lib/ai.js');

// Tracks job IDs analyzed this service worker session.
// Using a Set means clicking multiple analysis buttons on the same job
// only increments the counter once — when that job is first analyzed.
const _analyzedJobIds = new Set();

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

// Write safe config info to storage so dev.html can read it without message passing.
// GEMINI_API_KEY is intentionally excluded — only the model name is stored.
chrome.storage.local.set({ ww_dev_model: GEMINI_MODEL }).catch(() => {});

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

    // Increment only the first time a specific job is analyzed this session.
    // All 4 buttons on the same job count as 1, not 4.
    if (jobId && !_analyzedJobIds.has(jobId)) {
        _analyzedJobIds.add(jobId);
        WWStorage.incrementJobsAnalyzed().catch(() => {});
    }

    _log('Analysis complete | mode:', mode, '| job:', jobId);

    return result;
}

async function handleTestConnection() {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
        throw new Error('Gemini API key is not configured in config.js.');
    }

    // Single-attempt fetch — no retry loop. A 429 here means the key is valid
    // but temporarily rate-limited, which the options page treats as success.
    // A 401/403 means the key is genuinely wrong.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    let response;
    try {
        response = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                contents: [{ parts: [{ text: 'Respond with only the word "ok".' }] }],
                generationConfig: { maxOutputTokens: 10 },
            }),
            signal: controller.signal,
        });
    } catch (err) {
        throw new Error(err.name === 'AbortError' ? 'Connection timed out.' : 'Network error.');
    } finally {
        clearTimeout(timer);
    }

    // 429 = valid key, just rate limited — treat as pass
    if (response.status === 429) return;

    if (response.status === 401 || response.status === 403) {
        throw new Error('API key is invalid or unauthorized. Check your key in config.js.');
    }

    if (!response.ok) {
        throw new Error(`Gemini API returned status ${response.status}.`);
    }

    _log('Connection test passed');
}
