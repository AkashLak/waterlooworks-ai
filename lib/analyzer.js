// Orchestrates backend API calls from the content script side.
// All communication goes through chrome.runtime.sendMessage to background.js,
// which is the only context with API_SECRET.

const WWAnalyzer = (() => {
    let _batchCancelled = false;

    // ── Message sender ────────────────────────────────────────────────────────

    function _send(payload) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(payload, (response) => {
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
                        { type: response?.errorType },
                    ));
                    return;
                }
                resolve(response.data);
            });
        });
    }

    function _err(message, type) {
        return Object.assign(new Error(message), { type });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Submits a scraped job to the backend for storage and analysis.
     * @param {Object} jobData - Scraped fields from scrapeJobDetail()
     * @returns {Promise<{ jobId: string, analysesReady: boolean, analyses?: Object }>}
     */
    function submitJob(jobData) {
        return _send({ action: 'submitJob', jobData });
    }

    /**
     * Fetches the current analysis status for a job. Poll until analysesReady is true.
     * @param {string} jobId
     * @returns {Promise<{ analysesReady: boolean, analyses?: Object }>}
     */
    function getJobAnalyses(jobId) {
        return _send({ action: 'getJobAnalyses', jobId });
    }

    /**
     * Fetches all jobs in the database with pre-computed scores.
     * @param {Object} [filters]
     * @returns {Promise<{ jobs: Object[], total: number }>}
     */
    function getAllJobs(filters) {
        return _send({ action: 'getAllJobs', filters });
    }

    /**
     * Requests a resume-specific fit score. Background reads resume from storage.
     * @param {string} jobId
     * @returns {Promise<{ fitScore: number, strengths: string[], gaps: string[], verdict: string }>}
     */
    function getFitScore(jobId) {
        return _send({ action: 'getFitScore', jobId });
    }

    /**
     * Notifies the backend which jobs are currently visible.
     * @param {string[]} jobIds
     * @returns {Promise<Object>}
     */
    function syncActiveJobs(jobIds) {
        return _send({ action: 'syncActiveJobs', jobIds });
    }

    /**
     * Searches jobs against AI-powered criteria. Background reads resume from storage.
     * @param {Object} criteria - { type: string, limit?: number }
     * @returns {Promise<{ jobs: Object[] }>}
     */
    function searchJobs(criteria) {
        return _send({ action: 'searchJobs', criteria });
    }

    /**
     * Asks a question about a job. Background reads resume from storage.
     * @param {string} jobId
     * @param {string} question
     * @returns {Promise<{ answer: string }>}
     */
    function askQuestion(jobId, question) {
        return _send({ action: 'askQuestion', jobId, question });
    }

    /**
     * Fetches backend health status and database statistics.
     * @returns {Promise<{ jobCount: number, status: string }>}
     */
    function getStatus() {
        return _send({ action: 'getStatus' });
    }

    /** Signals an in-progress batch to stop after the current job completes. */
    function cancelBatch()      { _batchCancelled = true; }
    function isBatchCancelled() { return _batchCancelled; }
    function resetBatchCancel() { _batchCancelled = false; }

    return {
        submitJob,
        getJobAnalyses,
        getAllJobs,
        getFitScore,
        syncActiveJobs,
        searchJobs,
        askQuestion,
        getStatus,
        cancelBatch,
        isBatchCancelled,
        resetBatchCancel,
    };
})();
