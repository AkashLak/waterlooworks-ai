// WaterlooWorks AI Assistant — configuration template
// Copy this file to config.js and fill in your values.
// config.js is gitignored and must never be committed.

/** @type {string} Your Google Gemini API key (free tier, from https://aistudio.google.com) */
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY_HERE";

/**
 * When true, enables verbose console logging in background.js only.
 * Must be false before distributing to users.
 * SECURITY: Even in dev mode, the API key and resume text must never be logged.
 * @type {boolean}
 */
const DEV_MODE = false;
