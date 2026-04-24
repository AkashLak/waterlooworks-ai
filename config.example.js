// WaterlooWorks AI Assistant — configuration template
// Copy this file to config.js and fill in your values.
// config.js is gitignored and must never be committed.

/** @type {string} Your Google Gemini API key (free tier, from https://aistudio.google.com) */
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY_HERE";

/** @type {string} Gemini model to use — change here to switch models globally */
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";

/**
 * When true, enables verbose console logging in background.js only.
 * Must be false before distributing to users.
 * SECURITY: Even in dev mode, the API key and resume text must never be logged.
 * @type {boolean}
 */
const DEV_MODE = false;

/** @type {string} Shared secret for authenticating requests to the WaterlooWorks AI backend */
const API_SECRET = "YOUR_API_SECRET_HERE";
