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
 * Strategy:
 *   1. Try direct Tj/TJ operator extraction (uncompressed PDFs).
 *   2. Brute-force scan for zlib magic bytes and decompress each hit using
 *      the browser's native DecompressionStream — no PDF structure parsing,
 *      handles FlateDecode streams from Google Docs, Word, and most builders.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
async function _extractPdfText(buffer) {
    const bytes = new Uint8Array(buffer);

    // Build latin-1 string (1 char = 1 byte, positions match)
    const CHUNK = 32768;
    let raw = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        raw += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }

    // Pass 1: direct extraction — works for uncompressed PDFs
    const direct = _extractTextOps(raw).trim();
    if (direct.length > 80) return direct;

    // Pass 2: scan for zlib magic bytes and decompress
    // All FlateDecode streams start with 0x78 + one of: 0x01, 0x9C, 0xDA, 0x5E
    const VALID_B2 = new Set([0x01, 0x9C, 0xDA, 0x5E]);
    const parts = [];
    const seen = new Set(); // skip duplicate streams

    for (let i = 0; i < bytes.length - 1; i++) {
        if (bytes[i] !== 0x78 || !VALID_B2.has(bytes[i + 1])) continue;
        if (bytes.length - i < 50) continue;

        try {
            // Cap each attempt at 512 KB so a bad hit doesn't stall
            const slice = bytes.subarray(i, Math.min(i + 524288, bytes.length));
            const decompressed = await _zlibDecompress(slice);
            if (decompressed.length < 30) continue;

            const decompText = new TextDecoder('latin1').decode(decompressed);
            const extracted = _extractTextOps(decompText).trim();
            if (extracted.length > 10 && !seen.has(extracted)) {
                seen.add(extracted);
                parts.push(extracted);
            }
        } catch (_) {
            // Not a valid zlib stream at this offset — move on
        }
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Decompresses a zlib/deflate buffer using the browser's DecompressionStream.
 * Collects all chunks even if trailing bytes cause a terminal error, since
 * passing more data than a single stream contains is expected here.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function _zlibDecompress(data) {
    for (const format of ['deflate', 'deflate-raw']) {
        const chunks = [];
        try {
            const ds = new DecompressionStream(format);
            const writer = ds.writable.getWriter();
            const reader = ds.readable.getReader();

            // Errors from trailing bytes after stream end are expected — ignore them
            writer.write(data).catch(() => {});
            writer.close().catch(() => {});

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                }
            } catch (_) {
                // May throw after all valid data has been read
            }

            if (chunks.length === 0) continue;

            const total = chunks.reduce((s, c) => s + c.length, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            if (out.length > 10) return out;
        } catch (_) {
            // format mismatch, try next
        }
    }
    throw new Error('Not a valid zlib stream');
}

/**
 * Extracts text from a PDF content stream.
 * Handles both literal strings — (text) Tj — and hex-encoded strings — <hex> Tj.
 * Hex encoding is used by CIDFont PDFs (Google Docs, Word, most resume builders).
 */
function _extractTextOps(content) {
    const parts = [];
    let m;

    // Literal string: (text) Tj
    const tjRe = /\(([^)\\]|\\.)*\)\s*Tj/g;
    while ((m = tjRe.exec(content)) !== null) {
        parts.push(_decodePdfString(m[0].slice(1, m[0].lastIndexOf(')'))));
    }

    // Literal string array: [(text) spacing ...] TJ
    const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
    while ((m = tjArrRe.exec(content)) !== null) {
        const strRe = /\(([^)\\]|\\.)*\)/g;
        let sm;
        while ((sm = strRe.exec(m[1])) !== null) {
            parts.push(_decodePdfString(sm[0].slice(1, -1)));
        }
    }

    // Hex string: <0041006B...> Tj  (CIDFont — most modern PDFs)
    const hexTjRe = /<([0-9A-Fa-f]{2,})>\s*Tj/g;
    while ((m = hexTjRe.exec(content)) !== null) {
        const t = _decodeHexPdfString(m[1]);
        if (t) parts.push(t);
    }

    // Hex string array: [<hex> spacing ...] TJ  (CIDFont)
    const hexArrRe = /\[([^\]]*)\]\s*TJ/g;
    while ((m = hexArrRe.exec(content)) !== null) {
        const hexStrRe = /<([0-9A-Fa-f]{2,})>/g;
        let sm;
        while ((sm = hexStrRe.exec(m[1])) !== null) {
            const t = _decodeHexPdfString(sm[1]);
            if (t) parts.push(t);
        }
    }

    return parts.join(' ').trim();
}

/**
 * Decodes a hex-encoded PDF string.
 * Tries 2-byte Unicode (4 hex chars per character) first — used by CIDFont.
 * Falls back to 1-byte Latin-1 if the 2-byte pass produces no readable text.
 */
function _decodeHexPdfString(hex) {
    // 2-byte Unicode (common in Google Docs / Word PDFs)
    if (hex.length % 4 === 0) {
        let out = '';
        for (let i = 0; i < hex.length; i += 4) {
            const cp = parseInt(hex.slice(i, i + 4), 16);
            if (cp > 0x001F && cp < 0xFFFE) out += String.fromCodePoint(cp);
        }
        if (out.replace(/\s/g, '').length > 0) return out;
    }
    // 1-byte Latin-1 fallback
    let out = '';
    for (let i = 0; i + 1 <= hex.length; i += 2) {
        const cp = parseInt(hex.slice(i, i + 2), 16);
        if (cp > 0x1F && cp < 0x80) out += String.fromCharCode(cp);
    }
    return out;
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
