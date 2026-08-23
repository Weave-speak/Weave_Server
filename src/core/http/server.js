// The HTTP front door: parse, guard, dispatch.
//
// Everything here is about the boundary — size limits, CORS, auth resolution, client
// address — so that route handlers can be small and assume they are being handed
// something already sane.

import http from 'node:http';
import { Router, sendJSON, sendText, corsHeaders, isApiPath } from './router.js';
import { truncateIp } from '../log/index.js';

/** Bodies larger than this are refused outright, before buffering. */
const DEFAULT_MAX_BYTES = 1_000_000;

export class HttpError extends Error {
    constructor(status, message, detail) {
        super(message);
        this.status = status;
        this.detail = detail;
    }
}

/**
 * The client's real address.
 *
 * Forwarded headers are believed ONLY from a configured proxy. The previous server
 * trusted `cf-connecting-ip` unconditionally, which meant anyone able to reach it
 * directly could forge an address and walk straight through the per-IP rate limits.
 */
export function clientIp(req, trustedProxies) {
    const socketIp = req.socket.remoteAddress ?? '';
    if (!trustedProxies.length) return socketIp;

    const direct = socketIp.replace(/^::ffff:/, '');
    if (!trustedProxies.includes(direct)) return socketIp;

    const forwarded = req.headers['cf-connecting-ip']
        ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    return forwarded || socketIp;
}

async function readBody(req, maxBytes) {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBytes) {
        throw new HttpError(413, `Request body too large (limit ${maxBytes} bytes)`);
    }

    const chunks = [];
    let total = 0;

    for await (const chunk of req) {
        total += chunk.length;
        // Check as we go: content-length is a claim, not a guarantee.
        if (total > maxBytes) {
            throw new HttpError(413, `Request body too large (limit ${maxBytes} bytes)`);
        }
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

export function createHttpServer({ config, log, router, auth, onUpgrade }) {
    const server = http.createServer(async (req, res) => {
        const started = process.hrtime.bigint();
        let pathname;

        try {
            pathname = decodeURIComponent(req.url.split('?')[0]);
        } catch {
            sendText(res, 400, 'Malformed URL');
            return;
        }

        const origin = req.headers.origin;
        const cors = isApiPath(pathname) ? corsHeaders(origin) : {};

        // The Authorization header forces a preflight on every authenticated call, so
        // OPTIONS has to be answered before anything else happens.
        if (req.method === 'OPTIONS' && isApiPath(pathname)) {
            res.writeHead(204, cors);
            res.end();
            return;
        }

        // HEAD is answered by the GET route. Node's ServerResponse already suppresses
        // the body for a HEAD request, so the handler needs no special case — it just has
        // to be reachable, which it was not while HEAD fell through to 405.
        const lookupMethod = req.method === 'HEAD' ? 'GET' : req.method;
        const found = router.match(lookupMethod, pathname);

        if (!found) {
            sendJSON(res, 404, { error: 'not_found', message: `No route for ${req.method} ${pathname}` }, cors);
            return;
        }
        if (found.allowed) {
            sendJSON(res, 405, { error: 'method_not_allowed', allowed: found.allowed },
                { ...cors, Allow: found.allowed.join(', ') });
            return;
        }

        const { route, params } = found;
        const ip = clientIp(req, config.trustedProxies);
        const reqLog = log.child({ ip: config.redactIps ? truncateIp(ip) : ip });

        try {
            const session = await auth.resolve(req, route.auth);

            let body = null;
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                const raw = await readBody(req, route.maxBytes ?? DEFAULT_MAX_BYTES);
                if (route.rawBody) {
                    body = raw;
                } else if (raw.length) {
                    try {
                        body = JSON.parse(raw.toString('utf8'));
                    } catch {
                        throw new HttpError(400, 'Request body is not valid JSON');
                    }
                }
            }

            const url = new URL(req.url, 'http://internal');

            await route.handler({
                req,
                res,
                params,
                query: Object.fromEntries(url.searchParams),
                body,
                session,
                ip,
                log: reqLog,
                // extra headers merge over CORS so a route can set Set-Cookie etc.
                json: (status, data, extra = {}) => sendJSON(res, status, data, { ...cors, ...extra }),
                text: (status, value, extra = {}) => sendText(res, status, value, { ...cors, ...extra }),
            });
        } catch (err) {
            const status = err instanceof HttpError ? err.status : 500;

            if (status >= 500) {
                // Log the cause; return nothing that describes our internals.
                reqLog.error({ evt: 'http.error', method: req.method, path: pathname, err },
                    `Unhandled error serving ${req.method} ${pathname}`);
            } else {
                reqLog.debug({ evt: 'http.rejected', method: req.method, path: pathname, status },
                    `${status} on ${req.method} ${pathname}: ${err.message}`);
            }

            if (!res.headersSent) {
                sendJSON(res, status, {
                    error: status >= 500 ? 'internal_error' : 'request_failed',
                    message: status >= 500 ? 'Something went wrong on the server.' : err.message,
                    ...(err.detail ? { detail: err.detail } : {}),
                }, cors);
            }
        } finally {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            if (ms > 250) {
                // better-sqlite3 is synchronous, so a slow handler blocks signalling for
                // everyone. Surfacing these is how we notice before users do.
                reqLog.warn({ evt: 'http.slow', method: req.method, path: pathname, ms: Math.round(ms) },
                    `Slow request: ${req.method} ${pathname} took ${Math.round(ms)}ms`);
            }
        }
    });

    if (onUpgrade) server.on('upgrade', onUpgrade);

    return server;
}

export { Router, sendJSON, sendText };
