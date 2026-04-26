/**
 * Backend API client for WaterlooWorks AI.
 * Loaded via importScripts in background/background.js only.
 * SECURITY: API_SECRET is only ever concatenated here, in the background service worker.
 * This module must never be loaded in content scripts.
 */
const WWApi = (() => {
    const TIMEOUT_MS = 30_000;

    function _headers() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_SECRET}`,
        };
    }

    /**
     * Core fetch wrapper with timeout and typed error handling.
     * @param {string} method - HTTP method
     * @param {string} path - Path appended to BACKEND_URL
     * @param {Object} [body] - Request body (JSON-serialized)
     * @returns {Promise<any>} Parsed JSON response
     */
    async function _request(method, path, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let response;
        try {
            response = await fetch(`${BACKEND_URL}${path}`, {
                method,
                headers: _headers(),
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            throw _err('Unable to reach server — check your connection', 'network');
        }
        clearTimeout(timer);

        if (!response.ok) {
            throw _err(_statusMessage(response.status), _statusType(response.status));
        }

        return response.json().catch(() => ({}));
    }

    function _statusMessage(status) {
        if (status === 401) return 'Authentication error — please reinstall the extension';
        if (status === 429) return 'Too many requests — please wait a moment and try again';
        return 'Something went wrong — please try again';
    }

    function _statusType(status) {
        if (status === 401) return 'auth';
        if (status === 429) return 'rate_limit';
        return 'server_error';
    }

    function _err(message, type) {
        return Object.assign(new Error(message), { type });
    }

    /**
     * Submits a scraped job posting to the backend for analysis.
     * Returns immediately with cached analyses if the job is already in the database.
     * @param {Object} jobData - Scraped fields: jobId, title, employer, description, ...
     * @returns {Promise<{ jobId: string, analysesReady: boolean, analyses?: Object }>}
     */
    async function submitJob(jobData) {
        return _request('POST', '/api/jobs/submit', jobData);
    }

    /**
     * Fetches a single stored job record by ID.
     * @param {string} jobId
     * @returns {Promise<Object>}
     */
    async function getJob(jobId) {
        return _request('GET', `/api/jobs/${encodeURIComponent(jobId)}`);
    }

    /**
     * Fetches all available analyses for a job. Poll this until analysesReady is true.
     * @param {string} jobId
     * @returns {Promise<{ analysesReady: boolean, analyses?: Object }>}
     */
    async function getJobAnalyses(jobId) {
        // Cache-busting param forces a fresh response on every poll — without it,
        // the browser returns 304 Not Modified even after analyses complete in the DB.
        return _request('GET', `/api/jobs/${encodeURIComponent(jobId)}/analyses?t=${Date.now()}`);
    }

    /**
     * Fetches all jobs in the database with pre-computed scores.
     * @param {Object} [filters] - Optional query parameters (e.g. { term, status })
     * @returns {Promise<{ jobs: Object[], total: number }>}
     */
    async function getAllJobs(filters) {
        const qs = filters && Object.keys(filters).length
            ? '?' + new URLSearchParams(filters).toString()
            : '';
        return _request('GET', `/api/jobs${qs}`);
    }

    /**
     * Computes a resume-specific fit score for a job posting.
     * @param {string} jobId
     * @param {string} resumeText - User's resume text (never logged)
     * @returns {Promise<{ fitScore: number, strengths: string[], gaps: string[], verdict: string }>}
     */
    async function getFitScore(jobId, resumeText) {
        return _request('POST', '/api/fit-score', { jobId, resumeText });
    }

    /**
     * Notifies the backend which job IDs are currently visible in the listing table.
     * The backend queues unseen jobs for background analysis.
     * @param {string[]} visibleJobIds
     * @returns {Promise<Object>}
     */
    async function syncActiveJobs(visibleJobIds) {
        return _request('POST', '/api/jobs/sync-active', { visibleJobIds });
    }

    /**
     * Searches the job database using AI-powered criteria matching.
     * @param {string} resumeText - User's resume text (never logged)
     * @param {Object} criteria - Search criteria: { type, limit, ... }
     * @returns {Promise<{ jobs: Object[] }>}
     */
    async function searchJobs(resumeText, criteria) {
        return _request('POST', '/api/jobs/search', { resumeText, ...criteria });
    }

    /**
     * Asks a free-form question about a specific job posting.
     * @param {string} jobId
     * @param {string} question
     * @param {string} resumeText - User's resume text (never logged)
     * @returns {Promise<{ answer: string }>}
     */
    async function askQuestion(jobId, question, resumeText) {
        return _request('POST', `/api/jobs/${encodeURIComponent(jobId)}/ask`, { question, resumeText });
    }

    /**
     * Fetches backend health status and database statistics.
     * @returns {Promise<{ jobCount: number, status: string }>}
     */
    async function getStatus() {
        return _request('GET', '/api/status');
    }

    return {
        submitJob,
        getJob,
        getJobAnalyses,
        getAllJobs,
        getFitScore,
        syncActiveJobs,
        searchJobs,
        askQuestion,
        getStatus,
    };
})();
