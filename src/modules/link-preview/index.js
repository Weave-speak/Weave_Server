// Link previews.
//
// The server fetches the page so no client's IP ever touches a stranger's link, and so
// one fetch serves the whole crew from cache. The dangerous part of this feature is not
// the parsing — it is that "fetch this URL for me" is an invitation to reach the
// server's OWN network. Every address is resolved and checked against private ranges,
// and every redirect hop is re-checked, because a public URL that 302s into
// 192.168.0.1 is the classic shape of this attack.

import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from '../../core/http/server.js';

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 6_000;

/** Loopback, RFC1918, link-local, CGNAT, and the v6 equivalents. */
function isPrivateAddress(addr) {
    if (net.isIPv6(addr)) {
        const low = addr.toLowerCase();
        if (low === '::1' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return true;
        if (low.startsWith('::ffff:')) return isPrivateAddress(low.slice(7));
        return false;
    }
    const parts = addr.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168);
}

async function assertPublicHost(hostname) {
    if (net.isIP(hostname)) {
        if (isPrivateAddress(hostname)) throw new HttpError(400, 'That address is not previewable.');
        return;
    }
    let records;
    try {
        records = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
        throw new HttpError(400, 'That host does not resolve.');
    }
    if (!records.length || records.some((r) => isPrivateAddress(r.address))) {
        throw new HttpError(400, 'That address is not previewable.');
    }
}

/** One meta tag's content, tried across the property spellings sites actually use. */
function metaOf(html, name) {
    for (const attr of ['property', 'name']) {
        const re = new RegExp(
            `<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']*)["']`
            + `|<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${name}["']`, 'i');
        const m = html.match(re);
        if (m) return (m[1] ?? m[2] ?? '').trim();
    }
    return '';
}

const decodeEntities = (s) => s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");

export function register(ctx) {
    const cache = new Map();   // url -> { at, data }

    ctx.http.route('GET', '/api/link-preview', async ({ query, json }) => {
        const raw = String(query.url ?? '');
        let url;
        try { url = new URL(raw); } catch { throw new HttpError(400, 'Not a URL.'); }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new HttpError(400, 'Only web links are previewable.');
        }

        const hit = cache.get(url.href);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return json(200, hit.data);

        let current = url;
        let response = null;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            await assertPublicHost(current.hostname);
            response = await fetch(current.href, {
                redirect: 'manual',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                headers: {
                    // Some large sites only serve OG tags to things that look like link
                    // expanders; a bare Node UA gets a consent wall instead.
                    'user-agent': 'Mozilla/5.0 (compatible; WeaveLinkPreview/1.0)',
                    accept: 'text/html,application/xhtml+xml',
                },
            }).catch(() => null);
            if (!response) throw new HttpError(502, 'That page did not answer.');
            if (response.status >= 300 && response.status < 400) {
                const next = response.headers.get('location');
                if (!next) break;
                current = new URL(next, current);   // relative redirects resolve here
                continue;
            }
            break;
        }
        if (!response.ok) throw new HttpError(502, 'That page did not answer.');
        const type = response.headers.get('content-type') ?? '';
        if (!type.includes('text/html') && !type.includes('xhtml')) {
            throw new HttpError(415, 'That link is not a page.');
        }

        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (total < MAX_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.length;
        }
        reader.cancel().catch(() => {});
        const html = Buffer.concat(chunks).toString('utf8');

        const title = metaOf(html, 'og:title') || metaOf(html, 'twitter:title')
            || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim();
        const data = {
            url: url.href,
            site: decodeEntities(metaOf(html, 'og:site_name') || current.hostname),
            title: decodeEntities(title).slice(0, 200),
            description: decodeEntities(metaOf(html, 'og:description') || metaOf(html, 'description')).slice(0, 300),
            image: (() => {
                const img = metaOf(html, 'og:image') || metaOf(html, 'twitter:image');
                try {
                    const u = new URL(decodeEntities(img), current);
                    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
                } catch { return null; }
            })(),
        };
        if (!data.title && !data.description) {
            throw new HttpError(404, 'That page offers nothing to preview.');
        }

        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(url.href, { at: Date.now(), data });
        json(200, data);
    });
}
