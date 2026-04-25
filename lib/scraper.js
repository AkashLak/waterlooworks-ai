// WaterlooWorks DOM scraping utilities.
// All selectors are annotated with their verification date.
// If the UI breaks, these are the first lines to audit.

const WWScaper = (() => {

    // ── Listing table ─────────────────────────────────────────────────────────

    /**
     * Extracts job metadata from a single visible table row.
     * Column order confirmed from real DOM — April 2026.
     * @param {HTMLTableRowElement} tr
     * @returns {Object}
     */
    function scrapeListingRow(tr) {
        // WaterlooWorks DOM — verified April 2026
        // Title anchor lives inside a span.overflow--ellipsis inside the <th>
        const titleAnchor = tr.querySelector('th .overflow--ellipsis a');
        const cells = tr.querySelectorAll('td.table__value');

        const cell = (i) =>
            cells[i]?.querySelector('.overflow--ellipsis')?.textContent?.trim() ?? '';

        return {
            title:          titleAnchor?.textContent?.trim() ?? '',
            titleEl:        titleAnchor, // kept for programmatic click() in batch mode
            jobId:          cell(0),
            term:           cell(1),
            organization:   cell(2),
            appStatus:      cell(3),
            jobStatus:      cell(4),
            division:       cell(5),
            location:       cell(6),
            city:           cell(7),
            openings:       cell(8),
            appDeadline:    cell(9),
            appSubmittedOn: cell(10),
            appSubmittedBy: cell(11),
        };
    }

    /**
     * Scrapes all currently visible job rows from the listing table.
     * @returns {Array<Object>}
     */
    function scrapeAllListingRows() {
        // WaterlooWorks DOM — verified April 2026
        const rows = document.querySelectorAll('tr.table__row--body');
        return Array.from(rows).map(scrapeListingRow);
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

            // All JOB POSTING INFORMATION fields live inside the Overview tab panel
            // WaterlooWorks DOM — verified April 2026
            const panel  = modal.querySelector('div[role="tabpanel"][aria-labelledby="overview"]');
            const fields = panel ? _scrapeFields(panel) : {};

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
     *     p           → value text (may contain <br> and <strong> sub-headings)
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
            const valueEl = block.querySelector('p');
            if (!labelEl || !valueEl) continue;

            const label = labelEl.textContent.trim().replace(/:$/, '').trim();
            if (!label) continue;

            const value = _cleanText(_extractFieldText(valueEl));
            if (value) result[_toFieldKey(label)] = value;
        }

        return result;
    }

    /**
     * Extracts text from a field value element, converting <br> to spaces
     * so line breaks in long text fields aren't silently dropped by textContent.
     * Operates on a clone to avoid mutating the live DOM.
     */
    function _extractFieldText(el) {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
        return clone.textContent;
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
        getActiveModal,
        scrapeJobDetail,
        extractJobDescription,
        waitForJobModal,
    };
})();
