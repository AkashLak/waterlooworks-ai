// WaterlooWorks DOM scraping utilities.
// All selectors are annotated with their verification date.
// If the UI breaks, these are the first lines to audit.

const WWScaper = (() => {

    // ── Listing table ─────────────────────────────────────────────────────────

    // Maps normalized header label text → our internal field name.
    // Covers both Full-Cycle Service board and Employer-Student Direct board.
    const _HEADER_LABEL_MAP = {
        'job id':                  'jobId',
        'job #':                   'jobId',
        'term':                    'term',
        'term level':              'term',
        'organization':            'organization',
        'company name':            'organization',
        'employer':                'organization',
        'position name':           'title',
        'app status':              'appStatus',
        'application status':      'appStatus',
        'job status':              'jobStatus',
        'division':                'division',
        'location':                'location',
        'city':                    'city',
        'openings':                'openings',
        'number of openings':      'openings',
        'app deadline':            'appDeadline',
        'application deadline':    'appDeadline',
        'app submitted on':        'appSubmittedOn',
        'app submitted by':        'appSubmittedBy',
    };

    /**
     * Reads the visible job table's <thead> and returns a fieldName → column-index map.
     * Works across all WaterlooWorks job board views regardless of column order.
     * Returns {} if no thead is found — callers fall back to fixed indices.
     * WaterlooWorks DOM — verified April 2026.
     * @returns {Object}
     */
    function scrapeColumnHeaders() {
        const headerCells = document.querySelectorAll('table thead tr > th');
        if (!headerCells.length) return {};
        const colMap = {};
        headerCells.forEach((th, i) => {
            const label = th.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
            const field = _HEADER_LABEL_MAP[label];
            if (field && !(field in colMap)) colMap[field] = i;
        });
        return colMap;
    }

    /**
     * Extracts job metadata from a single visible table row.
     * When colMap is provided (from scrapeColumnHeaders), fields are read by
     * header-detected indices — works on any board layout. Falls back to the
     * fixed indices verified for Employer-Student Direct when colMap is absent.
     * @param {HTMLTableRowElement} tr
     * @param {Object} [colMap] - fieldName → column index, from scrapeColumnHeaders()
     * @returns {Object}
     */
    function scrapeListingRow(tr, colMap) {
        const titleAnchor = tr.querySelector('th .overflow--ellipsis a');
        const cells = tr.querySelectorAll('td.table__value');

        const cell = (i) =>
            cells[i]?.querySelector('.overflow--ellipsis')?.textContent?.trim() ?? '';

        const useDynamic = colMap && Object.keys(colMap).length > 0;

        const field = (name, fallbackIdx) => {
            if (useDynamic) {
                const idx = colMap[name];
                return idx != null ? cell(idx) : '';
            }
            return cell(fallbackIdx);
        };

        // Title: prefer the <th>-anchored link (Direct board); fall back to the
        // column mapped as 'title' (Full-Cycle board uses a <td> for Position Name).
        const title = titleAnchor?.textContent?.trim()
            || (useDynamic && colMap.title != null ? cell(colMap.title) : '');

        return {
            title,
            titleEl:        titleAnchor, // kept for programmatic click() in batch mode
            jobId:          field('jobId',          0),
            term:           field('term',            1),
            organization:   field('organization',    2),
            appStatus:      field('appStatus',       3),
            jobStatus:      field('jobStatus',       4),
            division:       field('division',        5),
            location:       field('location',        6),
            city:           field('city',            7),
            openings:       field('openings',        8),
            appDeadline:    field('appDeadline',     9),
            appSubmittedOn: field('appSubmittedOn', 10),
            appSubmittedBy: field('appSubmittedBy', 11),
        };
    }

    /**
     * Scrapes all currently visible job rows from the listing table.
     * Detects column layout once from the thead, then applies it to every row.
     * @returns {Array<Object>}
     */
    function scrapeAllListingRows() {
        // WaterlooWorks DOM — verified April 2026
        const colMap = scrapeColumnHeaders();
        const rows = document.querySelectorAll('tr.table__row--body');
        return Array.from(rows).map(tr => scrapeListingRow(tr, colMap));
    }

    /**
     * Returns the job IDs of all currently visible listing rows.
     * Used for syncActiveJobs calls.
     * @returns {string[]}
     */
    function getVisibleJobIds() {
        return scrapeAllListingRows()
            .map(r => r.jobId)
            .filter(Boolean);
    }

    /**
     * Finds and scrapes the table row matching a given job ID.
     * The table row persists in the DOM after the modal opens (overlay, not navigation),
     * so this is safe to call from the modal-open handler.
     * Returns null if the job is not currently visible in the table.
     * @param {string} jobId
     * @returns {Object|null}
     */
    function scrapeRowByJobId(jobId) {
        // WaterlooWorks DOM — verified April 2026
        const colMap = scrapeColumnHeaders();
        const rows = document.querySelectorAll('tr.table__row--body');
        for (const tr of rows) {
            const row = scrapeListingRow(tr, colMap);
            if (row.jobId === String(jobId)) return row;
        }
        return null;
    }

    // ── Modal detection ───────────────────────────────────────────────────────

    /**
     * Returns the currently visible job detail modal, or null if none is open.
     * The detail view is a modal overlay — NOT a page navigation.
     * @returns {HTMLElement|null}
     */
    function getActiveModal() {
        // WaterlooWorks DOM — verified April 2026
        return document.querySelector('div.modal.is--visible[role="dialog"]');
    }

    // ── Job detail scraping ───────────────────────────────────────────────────

    /**
     * Extracts all available fields from an open job detail modal.
     * @param {HTMLElement} modal
     * @returns {Object|null} Flat object of camelCased field keys → string values
     */
    function scrapeJobDetail(modal) {
        if (!modal) return null;
        try {
            // Job ID from the bullet chip: "• 402162"
            // WaterlooWorks DOM — verified April 2026
            const idChip = modal.querySelector('.dashboard-header__posting-title .tag-label');
            const jobId  = (idChip?.textContent ?? '').replace(/\D/g, '');

            // Main title heading
            // WaterlooWorks DOM — verified April 2026
            const title = modal.querySelector('.dashboard-header__posting-title h2')
                ?.textContent?.trim() ?? '';

            // "Employer Name - Division" subtitle line
            // WaterlooWorks DOM — verified April 2026
            const metaLine = modal.querySelector('.font--14.margin--t--s');
            const metaSpans = metaLine ? Array.from(metaLine.querySelectorAll('span')) : [];
            const employer  = metaSpans[0]?.textContent?.trim() ?? '';
            const division  = metaSpans[1]?.textContent?.trim() ?? '';

            // Job fields live in the Overview tab panel. Fall back to the full modal
            // if the tabpanel attribute is absent — WaterlooWorks DOM — verified April 2026
            const panel  = modal.querySelector('div[role="tabpanel"][aria-labelledby="overview"]') ?? modal;
            const fields = _scrapeFields(panel);

            return { jobId, title, employer, division, ...fields };
        } catch (_) {
            return null;
        }
    }

    /**
     * Extracts all field label/value pairs from the Overview tab panel.
     * WaterlooWorks DOM — verified April 2026:
     *   div.tag__key-value-list.js--question--container
     *     span.label  → "Work Term:" / "Job Summary:" / etc.
     *     one or more <p> tags → value text (some fields split content across multiple <p>s)
     *
     * Uses full block text minus the label rather than just the first <p>, so multi-paragraph
     * fields like Job Responsibilities are captured in their entirety.
     */
    function _scrapeFields(container) {
        // WaterlooWorks DOM — verified April 2026
        // .js--question--container narrows to actual job fields, filtering out UI chrome
        const result = {};
        const blocks = container.querySelectorAll(
            'div.tag__key-value-list.js--question--container, div.tag__key-value-list'
        );

        for (const block of blocks) {
            const labelEl = block.querySelector('span.label');
            if (!labelEl) continue;

            const label = labelEl.textContent.trim().replace(/:$/, '').trim();
            if (!label) continue;

            // Clone the block, replace <br> with spaces, strip the label, read all remaining text.
            // This captures fields split across multiple <p> tags (e.g. Job Responsibilities).
            const clone = block.cloneNode(true);
            clone.querySelectorAll('br').forEach(br => br.replaceWith(' '));
            clone.querySelector('span.label')?.remove();
            const value = _cleanText(clone.textContent);

            if (value) result[_toFieldKey(label)] = value;
        }

        return result;
    }



    /**
     * Normalizes messy whitespace scraped from WaterlooWorks HTML.
     * Collapses horizontal whitespace without destroying newlines.
     */
    function _cleanText(text) {
        return text
            .replace(/[^\S\n]+/g, ' ')  // collapse spaces/tabs → single space
            .replace(/\n{2,}/g, '\n')   // collapse multiple newlines → one
            .trim();
    }

    /** "Job Summary" → "jobSummary", "Employment Location Arrangement" → "employmentLocationArrangement" */
    function _toFieldKey(label) {
        return label
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .trim()
            .split(/\s+/)
            .map((w, i) =>
                i === 0
                    ? w.toLowerCase()
                    : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
            )
            .join('');
    }

    // ── Job description extraction ────────────────────────────────────────────

    /**
     * Builds the AI input string from a scraped detail object.
     * Concatenates Job Summary (trimmed) + Job Responsibilities.
     * @param {Object} detail - Output of scrapeJobDetail()
     * @returns {string}
     */
    function extractJobDescription(detail) {
        if (!detail) return '';
        const summary         = _cleanText(_trimBoilerplate(detail.jobSummary ?? ''));
        const responsibilities = _cleanText(detail.jobResponsibilities ?? '');
        return [summary, responsibilities].filter(Boolean).join('\n\n');
    }

    function _trimBoilerplate(text) {
        const idx = text.search(/about the business unit/i);
        return idx > 0 ? text.slice(0, idx).trim() : text;
    }

    // ── Batch navigation ──────────────────────────────────────────────────────

    /**
     * Waits until the active modal is showing a specific job ID.
     * Used by batch mode after programmatically clicking a job title.
     * @param {string} expectedJobId
     * @param {number} [timeoutMs]
     * @returns {Promise<HTMLElement>} Resolves with the modal element
     */
    function waitForJobModal(expectedJobId, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
                const modal = getActiveModal();
                if (modal) {
                    const chip = modal.querySelector('.dashboard-header__posting-title .tag-label');
                    if ((chip?.textContent ?? '').replace(/\D/g, '') === String(expectedJobId)) {
                        resolve(modal);
                        return;
                    }
                }
                if (Date.now() >= deadline) {
                    reject(new Error(`Timed out waiting for job ${expectedJobId} to load.`));
                    return;
                }
                requestAnimationFrame(check);
            };
            check();
        });
    }

    return {
        scrapeListingRow,
        scrapeAllListingRows,
        getVisibleJobIds,
        scrapeRowByJobId,
        getActiveModal,
        scrapeJobDetail,
        extractJobDescription,
        waitForJobModal,
    };
})();
