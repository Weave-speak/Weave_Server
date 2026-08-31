// HTTP routing.
//
// Replaces a 650-line `if`-chain in which route order was load-bearing and adding a
// route meant editing one enormous function. Routes are registered objects, so a
// module can add and REMOVE them, and so the set of live routes can be listed for
// diagnostics.
//
// CORS is deliberately asymmetric, and the asymmetry is the security property:
//
//   /api/*   — used by native clients from an origin we cannot predict, authenticated
//              with a Bearer token. We echo the request origin and do NOT set
//              Allow-Credentials. A hostile page can therefore make the request but
//              cannot attach the user's token, because a token is not a cookie.
//   /admin/* — used from a browser, authenticated with a cookie. It gets NO CORS
//              headers at all, so it is same-origin only. Echoing an origin here while
//              allowing credentials would be a cross-site request forgery hole.

export class Router {
    #routes = [];
    #log;

    constructor(log) {
        this.#log = log;
    }

    /**
     * Register a route. Paths may contain `:name` segments.
     * `auth`: 'none' | 'user' | 'admin'.
     * Returns a disposer, which is what makes a module's routes removable.
     */
    register(owner, method, pattern, handler, opts = {}) {
        const { regex, params } = compile(pattern);
        const route = {
            owner,
            method: method.toUpperCase(),
            pattern,
            regex,
            params,
            handler,
            auth: opts.auth ?? 'user',
            maxBytes: opts.maxBytes,
            rawBody: opts.rawBody === true,
        };

        const clash = this.#routes.find((r) => r.method === route.method && r.pattern === route.pattern);
        if (clash) {
            throw new Error(
                `Route ${route.method} ${route.pattern} is already registered by "${clash.owner}"`,
            );
        }

        this.#routes.push(route);
        return () => {
            const i = this.#routes.indexOf(route);
            if (i >= 0) this.#routes.splice(i, 1);
        };
    }

    /** Find a route. Returns the match, or the set of methods if only the path matched. */
    match(method, pathname) {
        const methodMismatch = [];

        for (const route of this.#routes) {
            const m = route.regex.exec(pathname);
            if (!m) continue;
            if (route.method !== method.toUpperCase()) {
                methodMismatch.push(route.method);
                continue;
            }
            const params = {};
            route.params.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
            return { route, params };
        }

        // Distinguishing 405 from 404 is what makes an OPTIONS preflight answerable.
        return methodMismatch.length ? { allowed: [...new Set(methodMismatch)] } : null;
    }

    get routes() {
        return this.#routes.map(({ owner, method, pattern, auth }) => ({ owner, method, pattern, auth }));
    }
}

/** Turn `/api/bubbles/:id/messages` into a regex plus its parameter names. */
function compile(pattern) {
    const params = [];
    const source = pattern
        .split('/')
        .map((segment) => {
            if (!segment) return '';
            if (segment.startsWith(':')) {
                params.push(segment.slice(1));
                return '([^/]+)';
            }
            if (segment === '*') return '.*';
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/');

    return { regex: new RegExp(`^${source}/?$`), params };
}

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
};

export function sendJSON(res, status, data, extraHeaders = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...SECURITY_HEADERS,
        ...extraHeaders,
    });
    res.end(body);
}

export function sendText(res, status, text, extraHeaders = {}) {
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...SECURITY_HEADERS,
        ...extraHeaders,
    });
    res.end(text);
}

/**
 * CORS headers for the client API. Never applied to /admin.
 * `Authorization` forces a preflight on every call, so OPTIONS must be answered.
 */
export function corsHeaders(origin) {
    if (!origin) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        // PATCH is on the list because a browser refuses a method the preflight did not
        // name, and it refuses it BEFORE the request is sent — so the symptom is a CORS
        // error rather than anything the route could report.
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
        // Allow-Credentials is deliberately absent. See the note at the top of this file.
    };
}

export const isApiPath = (pathname) => pathname.startsWith('/api/');
