// Orchestrates AI analysis requests from the content script side.
// Uses WWScaper to get job data, then sends messages to background.js which
// calls WWAi.analyze(). Never calls Gemini directly — that lives in background only.

const WWAnalyzer = (() => {
    let _batchCancelled = false;

    // ── Single job analysis ───────────────────────────────────────────────────

    /**
     * Analyzes the currently open job detail modal.
     * @param {string} mode - One of the WWAi.MODES keys
     * @param {string|null} [question] - Required for ASK mode
     * @returns {Promise<Object|string>}
     */
    async function analyzeCurrent(mode, question = null) {
        const modal = WWScaper.getActiveModal();
        if (!modal) {
            throw _err('No job is currently open. Click a job title first.', 'no_job');
        }

        const detail = WWScaper.scrapeJobDetail(modal);
        if (!detail?.jobId) {
            throw _err(
                'Unable to read this job posting — WaterlooWorks may have updated their page structure.',
                'scrape_error',
            );
        }

        const jobDescription = WWScaper.extractJobDescription(detail);

        return _sendAnalyze({
            mode,
            jobId:          detail.jobId,
            jobTitle:       detail.title,
            employer:       detail.employer,
            jobDescription,
            question,
            batchMode:      false,
        });
    }

    // ── Batch analysis ────────────────────────────────────────────────────────

    /**
     * Analyzes all currently visible listing rows in sequence.
     * Opens each job modal, scrapes it, runs BEST_FIT + QA_SNIFF, badges the row.
     * The 4-second inter-call delay is enforced by the background service worker.
     *
     * @param {Function} onProgress  Called with { current, total, jobTitle } each step
     * @param {Function} onResult    Called with { row, jobId, fitResult, qaResult, error? } per job
     * @param {Function} onComplete  Called with summary stats when done or cancelled
     */
    async function analyzeBatch(onProgress, onResult, onComplete) {
        _batchCancelled = false;

        const rows = WWScaper.scrapeAllListingRows();
        if (rows.length === 0) {
            onComplete?.({ total: 0, great: 0, decent: 0, poor: 0, disguised: 0, cancelled: false });
            return;
        }

        const stats = { total: rows.length, great: 0, decent: 0, poor: 0, disguised: 0 };

        for (let i = 0; i < rows.length; i++) {
            if (_batchCancelled) break;

            const row = rows[i];
            onProgress?.({ current: i + 1, total: rows.length, jobTitle: row.title });

            try {
                _clickJobTitle(row.titleEl);
                const modal = await WWScaper.waitForJobModal(row.jobId, 8000);
                if (_batchCancelled) break;

                const detail = WWScaper.scrapeJobDetail(modal);
                const jobDescription = WWScaper.extractJobDescription(detail);

                const fitResult = await _sendAnalyze({
                    mode:           'BEST_FIT',
                    jobId:          row.jobId,
                    jobTitle:       row.title,
                    employer:       row.organization,
                    jobDescription,
                    batchMode:      true,
                });
                if (_batchCancelled) break;

                const qaResult = await _sendAnalyze({
                    mode:           'QA_SNIFF',
                    jobId:          row.jobId,
                    jobTitle:       row.title,
                    employer:       row.organization,
                    jobDescription,
                    batchMode:      true,
                });

                const score = fitResult?.fitScore ?? 0;
                if (score >= 8)      stats.great++;
                else if (score >= 5) stats.decent++;
                else                 stats.poor++;
                if (qaResult?.isDisguised) stats.disguised++;

                onResult?.({ row, jobId: row.jobId, fitResult, qaResult });

            } catch (err) {
                // Don't abort the entire batch on a single failure; surface per-job errors
                onResult?.({ row, jobId: row.jobId, error: err.message });
            }
        }

        onComplete?.({ ...stats, cancelled: _batchCancelled });
    }

    /** Stops an in-progress batch after the current job finishes. */
    function cancelBatch() {
        _batchCancelled = true;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * Clicks a job title anchor without triggering its href="javascript:void(0)" navigation.
     * A capture-phase listener calls preventDefault() so the browser never attempts the
     * javascript: URL (which WaterlooWorks's page CSP would block and log as an error).
     * Vue's own click handler still fires because preventDefault() does not stop propagation.
     */
    function _clickJobTitle(el) {
        if (!el) return;
        // Prefer clicking the <span> parent over the <a> itself.
        // The <a> has href="javascript:void(0)" which triggers a CSP check in
        // WaterlooWorks's page context regardless of preventDefault(). The parent
        // <span> has no href, so no CSP check fires. Vue's click handler is on the
        // <a> component but bubbles up, so clicking the parent still reaches it.
        const target = el.parentElement ?? el;
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    /**
     * Sends an analyze request to background.js and returns the result.
     * Background.js validates the sender before processing.
     * @param {Object} payload
     * @returns {Promise<Object|string>}
     */
    function _sendAnalyze(payload) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: 'analyze', ...payload },
                (response) => {
                    if (chrome.runtime.lastError) {
                        reject(_err(
                            'Could not reach the extension background. Please reload the page.',
                            'ipc_error',
                        ));
                        return;
                    }
                    if (!response?.success) {
                        reject(Object.assign(
                            new Error(response?.error ?? 'An unexpected error occurred. Please try again.'),
                            {
                                type:               response?.errorType,
                                retryAfterSeconds:  response?.retryAfterSeconds,
                            },
                        ));
                        return;
                    }
                    resolve(response.data);
                },
            );
        });
    }

    function _err(message, type) {
        return Object.assign(new Error(message), { type });
    }

    return {
        analyzeCurrent,
        analyzeBatch,
        cancelBatch,
    };
})();
