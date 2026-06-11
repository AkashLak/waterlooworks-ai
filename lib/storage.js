/**
 * Chrome storage helpers for WaterlooWorks AI Assistant.
 * Wraps chrome.storage.local with promise-based accessors.
 * Safe to use from both content scripts and the background service worker.
 */
const WWStorage = (() => {
    const KEYS = {
        RESUME:               'ww_resume',
        JOBS_ANALYZED:        'ww_jobs_analyzed',
        ANALYZED_IDS:         'ww_analyzed_ids',   // dedup list — clears with resetJobsAnalyzed
        PANEL_OPEN:           'ww_panel_open',
        ONBOARDING_COMPLETE:  'ww_onboarding_complete',
        FIT_SCORES:           'ww_fit_scores',      // { [jobId]: scoreNumber } — persists across sessions
    };

    /**
     * @param {string} key
     * @returns {Promise<any>}
     */
    function _get(key) {
        return new Promise((resolve) => {
            chrome.storage.local.get(key, (result) => resolve(result[key]));
        });
    }

    /**
     * @param {string} key
     * @param {any} value
     * @returns {Promise<void>}
     */
    function _set(key, value) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [key]: value }, resolve);
        });
    }

    // ─── Resume ───────────────────────────────────────────────────────────────

    /** @returns {Promise<string|null>} */
    async function getResume() {
        return (await _get(KEYS.RESUME)) ?? null;
    }

    /**
     * @param {string} text - Plain-text resume content
     * @returns {Promise<void>}
     */
    async function saveResume(text) {
        await _set(KEYS.RESUME, text);
    }

    /** @returns {Promise<void>} */
    async function clearResume() {
        await _set(KEYS.RESUME, null);
    }

    // ─── Session stats ────────────────────────────────────────────────────────

    /** @returns {Promise<number>} */
    async function getJobsAnalyzed() {
        return (await _get(KEYS.JOBS_ANALYZED)) ?? 0;
    }

    /** @returns {Promise<void>} */
    async function incrementJobsAnalyzed() {
        const current = await getJobsAnalyzed();
        await _set(KEYS.JOBS_ANALYZED, current + 1);
    }

    /** @returns {Promise<void>} */
    async function resetJobsAnalyzed() {
        await _set(KEYS.JOBS_ANALYZED, 0);
        await _set(KEYS.ANALYZED_IDS, []);
    }

    /** @returns {Promise<string[]>} */
    async function getAnalyzedIds() {
        return (await _get(KEYS.ANALYZED_IDS)) ?? [];
    }

    /**
     * Adds jobId to the analyzed set and increments the counter.
     * No-op if jobId was already recorded.
     * @param {string} jobId
     * @returns {Promise<void>}
     */
    async function recordAnalyzedJob(jobId) {
        const ids = await getAnalyzedIds();
        if (ids.includes(String(jobId))) return;
        await _set(KEYS.ANALYZED_IDS, [...ids, String(jobId)]);
        await incrementJobsAnalyzed();
    }

    // ─── Panel state ──────────────────────────────────────────────────────────

    /** @returns {Promise<boolean>} */
    async function getPanelOpen() {
        return (await _get(KEYS.PANEL_OPEN)) ?? false;
    }

    /**
     * @param {boolean} isOpen
     * @returns {Promise<void>}
     */
    async function setPanelOpen(isOpen) {
        await _set(KEYS.PANEL_OPEN, Boolean(isOpen));
    }

    // ─── Onboarding ───────────────────────────────────────────────────────────

    /** @returns {Promise<boolean>} */
    async function isOnboardingComplete() {
        return (await _get(KEYS.ONBOARDING_COMPLETE)) ?? false;
    }

    /** @returns {Promise<void>} */
    async function setOnboardingComplete() {
        await _set(KEYS.ONBOARDING_COMPLETE, true);
    }

    // ─── Fit scores ───────────────────────────────────────────────────────────────

    /** @returns {Promise<Object>} map of jobId → fitScore number */
    async function getFitScores() {
        return (await _get(KEYS.FIT_SCORES)) ?? {};
    }

    /**
     * @param {string} jobId
     * @param {number} score
     */
    async function setFitScore(jobId, score) {
        const scores = await getFitScores();
        await _set(KEYS.FIT_SCORES, { ...scores, [String(jobId)]: score });
    }

    /** @returns {Promise<void>} */
    async function clearFitScores() {
        await _set(KEYS.FIT_SCORES, {});
    }

    async function bulkSetFitScores(scores) {
        const existing = (await _get(KEYS.FIT_SCORES)) ?? {};
        await _set(KEYS.FIT_SCORES, { ...existing, ...scores });
    }

    // ─── Bulk helpers ─────────────────────────────────────────────────────────

    /**
     * Returns a snapshot of all persisted state in one storage read.
     * @returns {Promise<{ resume: string|null, jobsAnalyzed: number, panelOpen: boolean, onboardingComplete: boolean }>}
     */
    function getAll() {
        const keys = [KEYS.RESUME, KEYS.JOBS_ANALYZED, KEYS.PANEL_OPEN, KEYS.ONBOARDING_COMPLETE];
        return new Promise((resolve) => {
            chrome.storage.local.get(keys, (result) => {
                resolve({
                    resume:              result[KEYS.RESUME]              ?? null,
                    jobsAnalyzed:        result[KEYS.JOBS_ANALYZED]       ?? 0,
                    panelOpen:           result[KEYS.PANEL_OPEN]          ?? false,
                    onboardingComplete:  result[KEYS.ONBOARDING_COMPLETE] ?? false,
                });
            });
        });
    }

    return {
        getResume,
        saveResume,
        clearResume,
        getJobsAnalyzed,
        incrementJobsAnalyzed,
        resetJobsAnalyzed,
        getAnalyzedIds,
        recordAnalyzedJob,
        getPanelOpen,
        setPanelOpen,
        isOnboardingComplete,
        setOnboardingComplete,
        getAll,
        getFitScores,
        setFitScore,
        clearFitScores,
        bulkSetFitScores,
    };
})();
