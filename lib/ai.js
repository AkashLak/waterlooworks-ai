// ─── Prompt constants ─────────────────────────────────────────────────────────
// All prompt templates live here so they can be iterated without touching logic.
// Placeholders: {PREAMBLE} {RESUME} {JOB} {QUESTION}

const SYSTEM_PREAMBLE =
    'You are an AI assistant helping a University of Waterloo co-op student evaluate job postings on WaterlooWorks.';

const PROMPT_BEST_FIT =
`{PREAMBLE}

Analyze the fit between the student's resume and the job description below.

RESUME:
{RESUME}

JOB DESCRIPTION:
{JOB}

Return a JSON object with this exact structure:
{
  "fitScore": <integer 1-10>,
  "strengths": [<specific resume-to-job match strings>],
  "gaps": [<missing skills or experience strings>],
  "verdict": "<one-sentence conclusion>"
}

Respond only with a valid JSON object, no markdown, no explanation, no backticks.`;

const PROMPT_DREAM_JOB =
`{PREAMBLE}

Determine if this job is a "dream job" for the student — a realistic stretch slightly above their current profile but attainable, with high upside (interesting tech, strong company, good growth), and appropriate for a co-op student. Criteria: 50–70% requirement match, high upside, co-op appropriate.

RESUME:
{RESUME}

JOB DESCRIPTION:
{JOB}

Return a JSON object with this exact structure:
{
  "isDreamJob": <boolean>,
  "reason": "<one-sentence explanation>",
  "highlightInApplication": "<what to emphasize in the application, or null if not a dream job>"
}

Respond only with a valid JSON object, no markdown, no explanation, no backticks.`;

const PROMPT_QA_SNIFF =
`{PREAMBLE}

Analyze whether the actual day-to-day work of this job genuinely matches what the job title implies. For example: a "Data Science Intern" that is mostly dashboard reporting is misleading; a "Software Engineer" that is primarily manual testing is misleading; a "Machine Learning Engineer" that is mostly data cleaning and SQL queries is misleading.

Also identify 2-4 other job titles this role would equally suit based on the actual work described.

JOB DESCRIPTION:
{JOB}

Return a JSON object with this exact structure:
{
  "titleMatchesRole": <boolean — true only if the work clearly matches the title>,
  "actualRole": "<the real role type if different from the title, e.g. 'Data Analyst / BI Developer', or null if it matches>",
  "redFlags": [<short quoted phrases from the description that indicate a mismatch — empty array if it matches>],
  "alsoGoodFitFor": [<all job titles this posting would also suit based on the actual work — be comprehensive, include every relevant role e.g. Software Developer, Data Analyst, QA Engineer, Backend Engineer, DevOps, ML Engineer, etc.>],
  "summary": "<one plain-English sentence verdict for a co-op student>"
}

Respond only with a valid JSON object, no markdown, no explanation, no backticks.`;

const PROMPT_ROLE_EXPLAINER =
`{PREAMBLE}

Write a plain-English summary of this job for a co-op student: what they would actually do day-to-day, what the team likely looks like, and what skills they would gain. Be specific, honest, and concise. Write for the student, not HR.

JOB DESCRIPTION:
{JOB}

Respond with plain text only. No headers, no bullet points, no markdown.`;

const PROMPT_ASK =
`{PREAMBLE}

A student has a question about a job posting. Answer it clearly, honestly, and concisely. Focus on what is practically useful for a co-op student deciding whether to apply. Respond in plain text only — no markdown, no bold, no bullet points, no numbered lists.

STUDENT RESUME:
{RESUME}

JOB DESCRIPTION:
{JOB}

STUDENT QUESTION:
{QUESTION}`;

// ─── WWAi namespace ───────────────────────────────────────────────────────────
// Must only be used from the background service worker — never from content scripts.

const WWAi = (() => {
    const MODES = Object.freeze({
        BEST_FIT:       'BEST_FIT',
        DREAM_JOB:      'DREAM_JOB',
        QA_SNIFF:       'QA_SNIFF',
        ROLE_EXPLAINER: 'ROLE_EXPLAINER',
        ASK:            'ASK',
    });

    // Model is set in config.js as GEMINI_MODEL — change it there to switch globally
    const ENDPOINT_BASE  = `https://generativelanguage.googleapis.com/v1beta/models/${typeof GEMINI_MODEL !== 'undefined' ? GEMINI_MODEL : 'gemini-1.5-flash'}:generateContent?key=`;
    const TIMEOUT_MS     = 30_000;
    const BATCH_DELAY_MS = 4_000;
    const BACKOFF_MS     = [4_000, 8_000, 16_000]; // exponential steps for 429 retry
    const MAX_JOB_CHARS  = 8_000;                   // ~2 000 tokens at ~4 chars/token

    const JSON_MODES = new Set([MODES.BEST_FIT, MODES.DREAM_JOB, MODES.QA_SNIFF]);

    const PROMPT_MAP = {
        [MODES.BEST_FIT]:       PROMPT_BEST_FIT,
        [MODES.DREAM_JOB]:      PROMPT_DREAM_JOB,
        [MODES.QA_SNIFF]:       PROMPT_QA_SNIFF,
        [MODES.ROLE_EXPLAINER]: PROMPT_ROLE_EXPLAINER,
        [MODES.ASK]:            PROMPT_ASK,
    };

    let _lastBatchCallTime = 0;

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    /** Simple {PLACEHOLDER} → value substitution. */
    function _fill(template, vars) {
        return Object.entries(vars).reduce(
            (s, [k, v]) => s.replaceAll(`{${k}}`, v ?? ''),
            template,
        );
    }

    /**
     * Trims a job description to the token budget.
     * Keeps the front (requirements/responsibilities) and drops tail boilerplate.
     */
    function _truncateJob(text) {
        if (!text) return '';
        if (text.length <= MAX_JOB_CHARS) return text;
        return text.slice(0, MAX_JOB_CHARS) + '\n[content truncated for length]';
    }

    function _buildPrompt(mode, resume, jobDescription, question) {
        return _fill(PROMPT_MAP[mode], {
            PREAMBLE:  SYSTEM_PREAMBLE,
            RESUME:    resume ?? '',
            JOB:       _truncateJob(jobDescription),
            QUESTION:  question ?? '',
        });
    }

    function _buildBody(mode, promptText) {
        const isJson = JSON_MODES.has(mode);
        return {
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
                temperature:        isJson ? 0.3 : 0.7,
                maxOutputTokens:    1024,
                responseMimeType:   isJson ? 'application/json' : 'text/plain',
            },
        };
    }

    async function _fetchWithTimeout(url, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            return await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
                signal:  controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Calls the Gemini API with 429-backoff retry.
     * @param {string} url - Full endpoint URL including key
     * @param {Object} body - Request body
     * @param {Function} [onProgress] - Called with { type, delaySeconds } on 429 retries
     * @returns {Promise<string>} Raw text from the model's first candidate
     */
    async function _callWithBackoff(url, body, onProgress) {
        const maxAttempts = 1 + BACKOFF_MS.length;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (attempt > 0) {
                const delayMs = BACKOFF_MS[attempt - 1];
                onProgress?.({ type: 'retrying', delaySeconds: delayMs / 1000 });
                await _sleep(delayMs);
            }

            let response;
            try {
                response = await _fetchWithTimeout(url, body);
            } catch (err) {
                if (err.name === 'AbortError') {
                    const e = new Error('Request timed out after 30 seconds. Please try again.');
                    e.type = 'timeout';
                    throw e;
                }
                const e = new Error('Network error. Please check your connection and try again.');
                e.type = 'network';
                throw e;
            }

            if (response.status === 429) {
                if (attempt < maxAttempts - 1) continue; // will wait at top of next loop
                const e = new Error('Rate limit reached after multiple retries. Please wait before trying again.');
                e.type = 'rate_limit';
                throw e;
            }

            if (!response.ok) {
                const e = new Error(`Gemini API returned an error (${response.status}). Please try again.`);
                e.type = 'api_error';
                throw e;
            }

            const data = await response.json().catch(() => null);
            return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Runs an AI analysis for a job posting.
     * MUST be called from the background service worker only.
     *
     * @param {Object}   opts
     * @param {string}   opts.mode            - One of WWAi.MODES
     * @param {string}   opts.resume          - Student's resume text
     * @param {string}   opts.jobDescription  - Job summary + responsibilities concatenated
     * @param {string}   [opts.question]      - Student's question (ASK mode only)
     * @param {string}   opts.apiKey          - Gemini API key (never logged)
     * @param {boolean}  [opts.batchMode]     - Enforces 4 s inter-call delay when true
     * @param {Function} [opts.onProgress]    - Called with progress updates during retries
     * @returns {Promise<Object|string>} Parsed JSON object for structured modes; plain text for ROLE_EXPLAINER / ASK
     */
    async function analyze({ mode, resume, jobDescription, question, apiKey, batchMode = false, onProgress }) {
        if (!MODES[mode]) {
            throw new Error(`Unknown analysis mode: ${mode}`);
        }

        if (batchMode) {
            const elapsed = Date.now() - _lastBatchCallTime;
            if (elapsed < BATCH_DELAY_MS) {
                await _sleep(BATCH_DELAY_MS - elapsed);
            }
            _lastBatchCallTime = Date.now();
        }

        const promptText = _buildPrompt(mode, resume, jobDescription, question);
        const body = _buildBody(mode, promptText);
        // Key is only ever concatenated at call time; never stored in a named variable
        const rawText = await _callWithBackoff(ENDPOINT_BASE + apiKey, body, onProgress);

        if (!JSON_MODES.has(mode)) {
            return rawText;
        }

        try {
            return JSON.parse(rawText);
        } catch (_) {
            // Retry once with explicit JSON reinforcement injected into the prompt
            const reinforced = JSON.parse(JSON.stringify(body));
            reinforced.contents[0].parts[0].text +=
                '\n\nCRITICAL: Your previous response was not valid JSON. ' +
                'Respond ONLY with a valid JSON object. No markdown. No backticks. No explanation text.';

            const retryText = await _callWithBackoff(ENDPOINT_BASE + apiKey, reinforced, onProgress);
            try {
                return JSON.parse(retryText);
            } catch (_) {
                const e = new Error('Failed to parse the AI response. Please try again.');
                e.type = 'parse_error';
                throw e;
            }
        }
    }

    return { MODES, analyze };
})();
