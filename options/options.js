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

    reader.onload = async (event) => {
        try {
            const text = await _extractPdfText(event.target.result);
            if (text.length > 80) {
                resumeTextEl.value = text;
                _updateCharCount();
                pdfStatusEl.textContent = '✓ Text extracted from PDF';
            } else {
                pdfStatusEl.textContent =
                    'Could not extract text. Open the PDF, press Cmd+A then Cmd+C, and paste directly.';
            }
        } catch (_) {
            pdfStatusEl.textContent =
                'Could not read this PDF. Open it, press Cmd+A then Cmd+C, and paste directly.';
        }
        pdfUploadEl.value = '';
    };

    reader.onerror = () => {
        pdfStatusEl.textContent = 'Failed to read file.';
    };

    reader.readAsArrayBuffer(file);
});

/**
 * Extracts plain text from a PDF ArrayBuffer.
 * Handles both uncompressed and FlateDecode (zlib) compressed content streams
 * using the browser's native DecompressionStream API — no external libraries needed.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
async function _extractPdfText(buffer) {
    const bytes = new Uint8Array(buffer);

    // Build a latin-1 string — each character maps 1:1 to a byte so positions match
    const CHUNK = 32768;
    let raw = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        raw += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }

    const parts = [];

    // Find every stream...endstream block in the file
    const streamRe = /stream\r?\n/g;
    let m;
    while ((m = streamRe.exec(raw)) !== null) {
        const contentStart = m.index + m[0].length;
        const endIdx = raw.indexOf('endstream', contentStart);
        if (endIdx === -1) continue;

        // Look back for the object dictionary to check for FlateDecode
        const dictStart = raw.lastIndexOf('<<', m.index);
        const dict = dictStart !== -1 ? raw.slice(dictStart, m.index) : '';
        const isFlate = /FlateDecode|\/Fl[\s/]/.test(dict);

        let content = '';
        if (isFlate) {
            try {
                const compressed = bytes.subarray(contentStart, endIdx);
                const decompressed = await _zlibDecompress(compressed);
                content = new TextDecoder('latin1').decode(decompressed);
            } catch (_) {
                continue; // stream is not valid zlib, skip it
            }
        } else {
            content = raw.slice(contentStart, endIdx);
        }

        const text = _extractTextOps(content);
        if (text.length > 10) parts.push(text);
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Decompress a zlib (FlateDecode) buffer using the browser's DecompressionStream.
 * Tries the zlib wrapper format first, then falls back to raw deflate.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function _zlibDecompress(data) {
    // PDF FlateDecode uses zlib format (deflate + 2-byte header + adler32 checksum)
    for (const format of ['deflate', 'deflate-raw']) {
        try {
            const ds = new DecompressionStream(format);
            const writer = ds.writable.getWriter();
            const reader = ds.readable.getReader();
            writer.write(data);
            writer.close();

            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }

            const total = chunks.reduce((s, c) => s + c.length, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            return out;
        } catch (_) {
            // try next format
        }
    }
    throw new Error('Decompression failed');
}

/** Extracts text from PDF content stream operators (Tj and TJ). */
function _extractTextOps(content) {
    const parts = [];
    let m;

    const tjRe = /\(([^)\\]|\\.)*\)\s*Tj/g;
    while ((m = tjRe.exec(content)) !== null) {
        parts.push(_decodePdfString(m[0].slice(1, m[0].lastIndexOf(')'))));
    }

    const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
    while ((m = tjArrRe.exec(content)) !== null) {
        const strRe = /\(([^)\\]|\\.)*\)/g;
        let sm;
        while ((sm = strRe.exec(m[1])) !== null) {
            parts.push(_decodePdfString(sm[0].slice(1, -1)));
        }
    }

    return parts.join(' ').trim();
}

function _decodePdfString(s) {
    return s
        .replace(/\\n/g, '\n').replace(/\\r/g, '\n')
        .replace(/\\t/g, ' ').replace(/\\(.)/g, '$1');
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
