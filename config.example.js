// WaterlooWorks AI Assistant — configuration template
// Copy this file to config.js and fill in your values.
// config.js is gitignored and must never be committed.

/** @type {string} Railway backend base URL — no trailing slash */
const BACKEND_URL = 'https://waterlooworks-ai-backend-production.up.railway.app';

/**
 * When true, enables verbose console logging in background.js only.
 * Must be false before distributing to users.
 * SECURITY: Resume text and access tokens must never be logged.
 * @type {boolean}
 */
const DEV_MODE = false;

const SUPABASE_URL = 'https://your-project-ref.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-or-publishable-key';
