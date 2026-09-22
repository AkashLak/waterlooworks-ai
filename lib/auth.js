// Supabase Auth REST client. Passwords are never stored or sent to the backend.
const WWAuth = (() => {
    const base = `${SUPABASE_URL}/auth/v1`;

    function normalizeSession(session) {
        if (!session?.access_token) return session;
        return { ...session, expires_at: session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600) };
    }

    function isAllowedUser(session) {
        return String(session?.user?.email || '').toLowerCase().endsWith('@uwaterloo.ca');
    }

    async function request(path, body, token) {
        if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.startsWith('REPLACE_')) {
            throw Object.assign(new Error('Supabase client configuration is missing.'), { type: 'auth_config' });
        }
        const response = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(data.error_description || data.msg || data.message || 'Authentication failed.'), { type: 'auth' });
        return normalizeSession(data);
    }

    async function refresh(refreshToken) {
        const session = await request('/token?grant_type=refresh_token', { refresh_token: refreshToken });
        await WWStorage.saveAuthSession(session);
        return session;
    }

    async function getSession() {
        const session = await WWStorage.getAuthSession();
        if (!session?.access_token) return null;
        if (!isAllowedUser(session)) {
            await WWStorage.clearAuthSession();
            return null;
        }
        if (session.expires_at && session.expires_at * 1000 < Date.now() + 60_000 && session.refresh_token) {
            try { return await refresh(session.refresh_token); } catch (_) { await WWStorage.clearAuthSession(); return null; }
        }
        return session;
    }

    async function getAccessToken() {
        const session = await getSession();
        if (!session) throw Object.assign(new Error('Please sign in to use WatAssistant.'), { type: 'auth_required' });
        return session.access_token;
    }

    async function signIn(email, password) {
        const session = await request('/token?grant_type=password', { email, password });
        if (!isAllowedUser(session)) {
            await WWStorage.clearAuthSession();
            throw Object.assign(new Error('Use your @uwaterloo.ca email address. Other email domains cannot use WatAssistant.'), { type: 'auth' });
        }
        await WWStorage.saveAuthSession(session);
        return session;
    }

    async function signUp(email, password) { return request('/signup', { email, password }); }

    async function signOut() {
        const session = await WWStorage.getAuthSession();
        if (session?.access_token) await request('/logout', {}, session.access_token).catch(() => {});
        await WWStorage.clearAuthSession();
    }

    return { getSession, getAccessToken, signIn, signUp, signOut };
})();
