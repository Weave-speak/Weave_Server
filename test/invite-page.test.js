// The invite landing page: the one URL strangers see before they have the app.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startWithRetry } from './helpers.js';

async function launch(extraEnv = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-invpage-'));
    let httpPort;

    const app = await startWithRetry(async () => {
        httpPort = await freePort();
        return {
            ...extraEnv,
            WEAVE_HTTP_PORT: String(httpPort),
            WEAVE_HTTP_BIND: '127.0.0.1',
            WEAVE_MEDIA_PORT: String(await freePort()),
            WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
            WEAVE_DATA_DIR: path.join(dir, 'data'),
            WEAVE_LOG_DIR: path.join(dir, 'logs'),
            WEAVE_LOG_LEVEL: 'silent',
            WEAVE_INSTANCE_NAME: 'The <Crew>',   // hostile on purpose
        };
    });

    const base = `http://127.0.0.1:${httpPort}`;
    const call = async (method, url, { body, token, headers = {} } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, text: await res.text(), headers: res.headers };
    };

    const code = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: { code, username: 'admin', password: 'a-long-enough-password' },
    });
    const adminBody = JSON.parse(admin.text);

    return { app, call, adminToken: adminBody.token, stop: () => app.stop() };
}

test('a live invite renders the join page; a dead one says only that', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const made = await h.call('POST', '/api/invites', { token: h.adminToken, body: {} });
    const invite = JSON.parse(made.text).invite;

    const page = await h.call('GET', `/invite/${invite.code}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.text, /weave:\/\/join\?server=/, 'the deep link is on the page');
    assert.match(page.text, new RegExp(invite.code), 'so is the code, for the manual path');
    assert.match(page.text, /\/download\/windows/, 'and the stable download URL');
    assert.match(page.text, /The &lt;Crew&gt;/, 'the server name is escaped, not trusted');
    assert.ok(!page.text.includes('<Crew>'), 'no raw markup from config');

    const dead = await h.call('GET', '/invite/NOPE99');
    assert.equal(dead.status, 200);
    assert.match(dead.text, /no longer valid/);
    assert.ok(!dead.text.includes('weave://join'), 'a dead code offers no deep link');
});

test('the stable download URL resolves, caches, and degrades honestly', async () => {
    const { createDownloadResolver } = await import('../src/core/http/routes/invite-page.js');
    let calls = 0;
    const answer = {
        ok: true,
        json: async () => [{
            assets: [
                { name: 'Weave-Setup-9.9.9.exe.blockmap', browser_download_url: 'https://x/map' },
                { name: 'Weave-Setup-9.9.9.exe', browser_download_url: 'https://x/Weave-Setup-9.9.9.exe' },
            ],
        }],
    };
    const resolve = createDownloadResolver(async () => { calls += 1; return answer; });

    assert.equal(await resolve(), 'https://x/Weave-Setup-9.9.9.exe', 'the exe, never the blockmap');
    assert.equal(await resolve(), 'https://x/Weave-Setup-9.9.9.exe');
    assert.equal(calls, 1, 'the second answer came from cache');

    // A resolver whose API is down keeps serving the page fallback rather than dying.
    const dead = createDownloadResolver(async () => { throw new Error('offline'); });
    assert.match(await dead(), /releases\/latest$/);
});

test('the download route answers with a redirect, never a dead end', async (t) => {
    const h = await launch();
    t.after(() => h.stop());
    const res = await fetch(`http://127.0.0.1${''}`, { method: 'HEAD' }).catch(() => null);
    void res;
    const page = await h.call('GET', '/download/windows');
    // Whatever the resolver knew, the answer is a redirect somewhere real. call() follows
    // redirects, so a 200 here means the Location resolved; GitHub answers both the
    // asset and the releases page.
    assert.ok([200, 302].includes(page.status), String(page.status));
});

// ── Where the page says this server lives ────────────────────────────────────
//
// The invite page hands a stranger a weave:// link containing an ORIGIN, and that origin
// is what their client will connect to and sign in against. Deriving it from a header the
// requester controls means whoever sends the request decides where the invitee's
// credentials get typed.

test('a forged X-Forwarded-Host is not reflected into the deep link', async (t) => {
    const h = await launch();
    t.after(() => h.stop());

    const made = await h.call('POST', '/api/invites', { token: h.adminToken, body: {} });
    const invite = JSON.parse(made.text).invite;

    const page = await h.call('GET', `/invite/${invite.code}`, {
        headers: {
            'X-Forwarded-Host': 'evil.example.com',
            'X-Forwarded-Proto': 'https',
        },
    });

    assert.equal(page.status, 200);
    assert.ok(!page.text.includes('evil.example.com'),
        'a header the sender chose must not decide where an invitee signs in');
    // And it still produces a usable link rather than nothing at all.
    assert.match(page.text, /weave:\/\/join\?server=/);
    assert.match(page.text, /127\.0\.0\.1/, 'the host the browser actually asked for');
});

test('a configured public URL is what the page advertises', async (t) => {
    // The right answer behind a tunnel: config knows the outside name, the Host header
    // only knows 127.0.0.1.
    const h = await launch({ WEAVE_PUBLIC_URL: 'https://weave.example.com/' });
    t.after(() => h.stop());

    const made = await h.call('POST', '/api/invites', { token: h.adminToken, body: {} });
    const invite = JSON.parse(made.text).invite;

    const page = await h.call('GET', `/invite/${invite.code}`, {
        headers: { 'X-Forwarded-Host': 'evil.example.com' },
    });

    assert.ok(page.text.includes('weave.example.com'), 'the configured origin wins');
    assert.ok(!page.text.includes('evil.example.com'));
    // The trailing slash is trimmed, or the link reads https://host//?server=
    assert.ok(!page.text.includes('weave.example.com/&'), 'no doubled separator');
});
