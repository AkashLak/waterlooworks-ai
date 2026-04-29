/**
 * WaterlooWorks AI — XHR/fetch interceptor.
 *
 * Runs in the MAIN world at document_start, before any page scripts execute.
 * Overrides XMLHttpRequest and fetch to observe WaterlooWorks's own requests,
 * then dispatches CustomEvents to the isolated-world content scripts with the
 * captured action tokens needed for direct HTTP scraping.
 *
 * Events dispatched on document:
 *   __wwai_listing     — first job-listing GET; carries { token, url }
 *   __wwai_detail_post — any job-detail POST (may fire multiple times); carries { token, url }
 */
(function () {
    // Only intercept requests to WaterlooWorks job board URLs
    const WW_BOARD_RE = /\/(jobs|applications)\.htm/;

    function _dispatch(type, detail) {
        document.dispatchEvent(new CustomEvent('__wwai_' + type, {
            detail: JSON.parse(JSON.stringify(detail)),
        }));
    }

    // Extracts the `action=` value from a URL query string or POST body string
    function _extractToken(str) {
        const m = (str || '').match(/(?:^|[?&])action=([^&\s]+)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    // ── XMLHttpRequest ────────────────────────────────────────────────────────

    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && WW_BOARD_RE.test(url)) {
            this._wwai = { method: method.toUpperCase(), url };
        }
        return _origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
        if (this._wwai) {
            const { method, url } = this._wwai;
            const bodyStr = typeof body === 'string' ? body : '';
            const srcStr  = method === 'GET' ? url : bodyStr;
            const token   = _extractToken(srcStr);

            if (token) {
                if (method === 'GET') {
                    _dispatch('listing', { token, url });
                } else if (method === 'POST' && bodyStr.includes('postingId=')) {
                    _dispatch('detail_post', { token, url });
                }
            }
        }
        return _origSend.apply(this, arguments);
    };

    // ── fetch ─────────────────────────────────────────────────────────────────

    const _origFetch = window.fetch;
    window.fetch = function (resource, init) {
        const url = typeof resource === 'string' ? resource : (resource?.url ?? '');
        if (WW_BOARD_RE.test(url)) {
            const method  = ((init?.method) || 'GET').toUpperCase();
            const bodyStr = typeof init?.body === 'string' ? init.body : '';
            const srcStr  = method === 'GET' ? url : bodyStr;
            const token   = _extractToken(srcStr);
            if (token) {
                if (method === 'GET') {
                    _dispatch('listing', { token, url });
                } else if (method === 'POST' && bodyStr.includes('postingId=')) {
                    _dispatch('detail_post', { token, url });
                }
            }
        }
        return _origFetch.apply(this, arguments);
    };
})();
