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
                    'This PDF uses a custom font encoding that requires a PDF library to decode. ' +
                    'Open it, press Cmd+A → Cmd+C, and paste directly — takes under 10 seconds.';
            }
        } catch (_) {
            pdfStatusEl.textContent =
                'Could not read this PDF. Open it, press Cmd+A → Cmd+C, and paste directly.';
        }
        pdfUploadEl.value = '';
    };

    reader.onerror = () => {
        pdfStatusEl.textContent = 'Failed to read file.';
    };

    reader.readAsArrayBuffer(file);
});

/**
 * Extracts plain text from a PDF ArrayBuffer using PDF.js (bundled locally).
 * Handles all PDF types: compressed, CIDFont, custom encodings, multi-page.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
async function _extractPdfText(buffer) {
    // pdfjsLib is loaded globally from lib/pdfjs/pdf.min.js
    // Point the worker at the bundled file via the extension URL
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        chrome.runtime.getURL('lib/pdfjs/pdf.worker.min.js');

    const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
    const pageTexts = [];

    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        // Concatenate text items, preserving word boundaries
        pageTexts.push(content.items.map(item => item.str).join(' '));
    }

    await pdf.destroy();
    return pageTexts.join('\n').replace(/[ \t]+/g, ' ').trim();
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

    // Test that the backend is reachable
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
            _showStatus('✓ Resume saved! Backend connection confirmed.', 'success');
            WWStorage.setOnboardingComplete();
        } else {
            _showStatus(
                'Resume saved, but could not reach the backend. Check your connection and try again.',
                'error',
            );
        }
    });
}

// ── Clear ──────────────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', async () => {
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
