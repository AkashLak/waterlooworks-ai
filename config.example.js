// WaterlooWorks AI Assistant — configuration template
// Copy this file to config.js and fill in your values.
// config.js is gitignored and must never be committed.

/** @type {string} Railway backend base URL — no trailing slash */
const BACKEND_URL = 'https://waterlooworks-ai-backend-production.up.railway.app';

/**
 * When true, enables verbose console logging in background.js only.
 * Must be false before distributing to users.
 * SECURITY: Even in dev mode, API_SECRET and resume text must never be logged.
 * @type {boolean}
 */
const DEV_MODE = false;

/** @type {string} Shared secret for authenticating requests to the backend — never expose to page context */
const API_SECRET = 'YOUR_API_SECRET_HERE';
