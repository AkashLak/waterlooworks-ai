// Options page logic — resume save/load, PDF extraction, connection test, dream criteria.
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
    _showStatus('Saving…', 'loading');

    await WWStorage.saveResume(text);
    _setResumeCheck(true);

    chrome.runtime.sendMessage({ action: 'testConnection' }, (response) => {
        saveBtn.disabled = false;

        if (chrome.runtime.lastError || !response?.success) {
            _showStatus(
                '✓ Resume saved! (Could not verify connection — reload WaterlooWorks if analysis seems slow.)',
                'success',
            );
            return;
        }

        _showStatus('✓ Resume saved! You\'re all set.', 'success');
        WWStorage.setOnboardingComplete();
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

// ── Dream job criteria ─────────────────────────────────────────────────────────

const DEFAULT_CRITERIA = [
    'Salary',
    'Company Prestige',
    'Technical Stack',
    'Learning Opportunities',
    'Ownership & Impact',
];

let _currentCriteria = [...DEFAULT_CRITERIA];

(async function initCriteria() {
    const stored = await new Promise(r =>
        chrome.storage.local.get('ww_dream_criteria', d => r(d.ww_dream_criteria))
    );
    // Preserve user's order for recognized criteria; append any new defaults they haven't seen yet
    const validSet = new Set(DEFAULT_CRITERIA);
    const filtered = Array.isArray(stored) ? stored.filter(c => validSet.has(c)) : [];
    const filteredSet = new Set(filtered);
    const newDefaults = DEFAULT_CRITERIA.filter(c => !filteredSet.has(c));
    _currentCriteria = filtered.length ? [...filtered, ...newDefaults] : [...DEFAULT_CRITERIA];
    // Persist the cleaned-up list so stale items don't reappear
    if (JSON.stringify(_currentCriteria) !== JSON.stringify(stored)) {
        _saveCriteria(_currentCriteria);
    }
    _renderCriteriaList(_currentCriteria);
})();

function _renderCriteriaList(criteria) {
    const list = document.getElementById('criteria-list');
    list.innerHTML = '';
    criteria.forEach((item, i) => {
        const li = document.createElement('li');
        li.className = 'criteria-item';
        li.draggable = true;
        li.dataset.index = String(i);

        const rank  = document.createElement('span');
        rank.className = 'criteria-rank';
        rank.textContent = i + 1;

        const handle = document.createElement('span');
        handle.className = 'criteria-drag';
        handle.textContent = '⠿';

        const label = document.createElement('span');
        label.className = 'criteria-label';
        label.textContent = item;

        li.appendChild(rank);
        li.appendChild(handle);
        li.appendChild(label);

        li.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', String(i));
            li.classList.add('dragging');
        });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        li.addEventListener('dragover', e => { e.preventDefault(); li.classList.add('drag-over'); });
        li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
        li.addEventListener('drop', e => {
            e.preventDefault();
            li.classList.remove('drag-over');
            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
            const toIdx   = parseInt(li.dataset.index, 10);
            if (fromIdx === toIdx) return;
            const next = [..._currentCriteria];
            const [moved] = next.splice(fromIdx, 1);
            next.splice(toIdx, 0, moved);
            _currentCriteria = next;
            _saveCriteria(next);
            _renderCriteriaList(next);
        });

        list.appendChild(li);
    });
}

function _saveCriteria(criteria) {
    chrome.storage.local.set({ ww_dream_criteria: criteria }, () => {
        const msg = document.getElementById('criteria-status-msg');
        msg.textContent = '✓ Priorities saved';
        msg.className = 'status-msg success';
        msg.classList.remove('hidden');
        setTimeout(() => msg.classList.add('hidden'), 2000);
    });
}

document.getElementById('reset-criteria-btn').addEventListener('click', () => {
    _currentCriteria = [...DEFAULT_CRITERIA];
    _saveCriteria(_currentCriteria);
    _renderCriteriaList(_currentCriteria);
});
