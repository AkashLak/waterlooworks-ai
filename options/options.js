// Options page logic — resume save/load, PDF extraction, connection test.
// WWStorage is available via ../lib/storage.js loaded before this script in options.html.

const resumeTextEl = document.getElementById('resume-text');
const charCountEl  = document.getElementById('char-count');
const pdfUploadEl  = document.getElementById('pdf-upload');
const pdfStatusEl  = document.getElementById('pdf-status');
const saveBtn      = document.getElementById('save-btn');
const clearBtn     = document.getElementById('clear-btn');
const statusMsgEl  = document.getElementById('status-msg');
const iconResume   = document.getElementById('icon-resume');

// ── Init ───────────────────────────────────────────────────────────────────────

(async function init() {
    const resume = await WWStorage.getResume();
    if (resume) {
        resumeTextEl.value = resume;
        _updateCharCount();
        _setResumeCheck(true);
    }
})();

// ── Character count ────────────────────────────────────────────────────────────

resumeTextEl.addEventListener('input', _updateCharCount);

function _updateCharCount() {
    const n = resumeTextEl.value.length;
    charCountEl.textContent = `${n.toLocaleString()} character${n === 1 ? '' : 's'}`;
}

// ── PDF upload ─────────────────────────────────────────────────────────────────

pdfUploadEl.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    pdfStatusEl.textContent = 'Reading…';
    const reader = new FileReader();

    reader.onload = (event) => {
        const text = _extractPdfText(event.target.result);
        if (text.length > 80) {
            resumeTextEl.value = text;
            _updateCharCount();
            pdfStatusEl.textContent = '✓ Text extracted from PDF';
        } else {
            pdfStatusEl.textContent =
                'Could not extract text — this PDF may use compressed streams. Please paste your resume text directly.';
        }
        // Reset so the same file can be re-selected if needed
        pdfUploadEl.value = '';
    };

    reader.onerror = () => {
        pdfStatusEl.textContent = 'Failed to read file.';
    };

    reader.readAsArrayBuffer(file);
});

/**
 * Basic PDF text extraction without external libraries.
 * Works for PDFs with uncompressed text streams (most Word/Google Docs exports).
 * Falls back gracefully for compressed-stream PDFs.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function _extractPdfText(buffer) {
    const bytes = new Uint8Array(buffer);

    // Build a latin-1 string in chunks to avoid stack overflow on large files
    const CHUNK = 32768;
    let raw = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        raw += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }

    const parts = [];

    // Pattern 1: (text) Tj  — single string text show
    const tjRe = /\(([^)\\]|\\.)*\)\s*Tj/g;
    let m;
    while ((m = tjRe.exec(raw)) !== null) {
        const inner = m[0].slice(1, m[0].lastIndexOf(')'));
        parts.push(_decodePdfString(inner));
    }

    // Pattern 2: [(text) spacing ...] TJ  — array text show
    const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
    while ((m = tjArrRe.exec(raw)) !== null) {
        const strRe = /\(([^)\\]|\\.)*\)/g;
        let sm;
        while ((sm = strRe.exec(m[1])) !== null) {
            parts.push(_decodePdfString(sm[0].slice(1, -1)));
        }
    }

    return parts
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _decodePdfString(s) {
    return s
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\n')
        .replace(/\\t/g, ' ')
        .replace(/\\(.)/g, '$1');
}

// ── Save ───────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', _handleSave);

async function _handleSave() {
    const text = resumeTextEl.value.trim();

    if (!text) {
        _showStatus('Please add your resume before saving.', 'error');
        return;
    }

    saveBtn.disabled = true;
    _showStatus('Saving and testing connection…', 'loading');

    await WWStorage.saveResume(text);
    _setResumeCheck(true);

    // Test that the Gemini API key works
    chrome.runtime.sendMessage({ action: 'testConnection' }, (response) => {
        saveBtn.disabled = false;

        if (chrome.runtime.lastError) {
            _showStatus(
                'Resume saved. Could not reach the extension background — try reloading.',
                'error',
            );
            return;
        }

        if (response?.success) {
            _showStatus('✓ Resume saved! Gemini connection confirmed.', 'success');
            WWStorage.setOnboardingComplete();
        } else {
            const isRateLimit = response?.error?.toLowerCase().includes('rate limit');
            if (isRateLimit) {
                _showStatus(
                    '✓ Resume saved! (Connection test hit the rate limit — your API key is valid. Wait a moment and try analyzing a job.)',
                    'success',
                );
                WWStorage.setOnboardingComplete();
            } else {
                _showStatus(
                    `Resume saved, but Gemini connection failed: ${response?.error ?? 'unknown error'}. Check your API key in config.js.`,
                    'error',
                );
            }
        }
    });
}

// ── Clear ──────────────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', async () => {
    if (!resumeTextEl.value.trim()) return;
    resumeTextEl.value = '';
    _updateCharCount();
    pdfStatusEl.textContent = '';
    await WWStorage.clearResume();
    _setResumeCheck(false);
    _showStatus('Resume cleared.', 'success');
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function _showStatus(message, type) {
    statusMsgEl.textContent = message;
    statusMsgEl.className = `status-msg ${type}`;
}

function _setResumeCheck(done) {
    iconResume.textContent = done ? '✓' : '○';
    iconResume.classList.toggle('done', done);
}
