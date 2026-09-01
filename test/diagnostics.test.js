// The diagnostics endpoint, against a running server.
//
// This route is deliberately reachable without sign-in — an updater that broke before
// login is its whole reason to exist — which makes its defences the thing worth testing:
// the rate limit, the size cap, and that a report actually lands on disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-diag-'));
    let httpPort;

    const app = await startWithRetry(async () => {
        httpPort = await freePort();
        return {
            WEAVE_HTTP_PORT: String(httpPort),
            WEAVE_HTTP_BIND: '127.0.0.1',
            WEAVE_MEDIA_PORT: String(await freePort()),
            WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
            WEAVE_DATA_DIR: path.join(dir, 'data'),
            WEAVE_LOG_DIR: path.join(dir, 'logs'),
            WEAVE_LOG_LEVEL: 'silent',
        };
    });

    const base = `http://127.0.0.1:${httpPort}`;
    const call = async (method, url, { body, token } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        return { status: res.status, body: parsed };
    };

    return { app, dir, call };
}

test('diagnostics land on disk, before and after sign-in', async (t) => {
    const { app, dir, call } = await launch();
    t.after(() => app.stop());

    // Anonymous — the updater-broke-before-login case.
    const anon = await call('POST', '/api/diagnostics', {
        body: { kind: 'update-failure', client: { version: '0.1.9', target: 'desktop' }, log: 'checkForUpdates: ENOTFOUND' },
    });
    assert.equal(anon.status, 202, JSON.stringify(anon.body));

    // Signed in — the report should carry the name.
    const code = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: { code, username: 'admin', password: 'a-long-enough-password' },
    });
    assert.equal(admin.status, 201);
    const named = await call('POST', '/api/diagnostics', {
        token: admin.body.token,
        body: { kind: 'update-failure', log: 'differential download failed' },
    });
    assert.equal(named.status, 202);

    const reports = fs.readdirSync(path.join(dir, 'data', 'diagnostics'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'diagnostics', f), 'utf8')));
    assert.equal(reports.length, 2);
    assert.ok(reports.some((r) => r.from === null), 'the anonymous report stays anonymous');
    assert.ok(reports.some((r) => r.from?.username === 'admin'), 'the signed-in report is attributed');

    // The server stamps its own load onto every report — the "is it the Pi?" signal neither
    // endpoint of a call can measure. Present and numeric even on a quiet test machine, where
    // loadavg may legitimately read 0 (Windows) — a number is the contract, not a threshold.
    assert.ok(reports.every((r) => r.server && typeof r.server.loadPerCore === 'number'),
        'every report carries a server-load stamp');
    assert.ok(reports.every((r) => typeof r.server.cpus === 'number' && r.server.cpus >= 1),
        'the core count is always known');

    // A garbage token must not turn into a 401 — the report still matters more.
    const badToken = await call('POST', '/api/diagnostics', {
        token: 'not-a-real-token',
        body: { kind: 'update-failure', log: 'still worth having' },
    });
    assert.equal(badToken.status, 202);
});

test('the defences hold: empty, oversized, and repeat posts are refused', async (t) => {
    const { app, call } = await launch();
    t.after(() => app.stop());

    const empty = await call('POST', '/api/diagnostics', { body: { kind: 'x', log: '   ' } });
    assert.equal(empty.status, 400);

    const oversized = await call('POST', '/api/diagnostics', {
        body: { kind: 'x', log: 'a'.repeat(300 * 1024) },
    });
    assert.ok([413, 400].includes(oversized.status), `expected a size refusal, got ${oversized.status}`);

    // The per-address limit: default 6/hour. The empty and oversized posts above were
    // refused BEFORE consuming... no — allow() runs first, so every attempt counts.
    // Post until refused and assert the refusal arrives where configured.
    let refusedAt = null;
    for (let i = 0; i < 10; i++) {
        const r = await call('POST', '/api/diagnostics', { body: { kind: 'x', log: `attempt ${i}` } });
        if (r.status === 429) { refusedAt = i; break; }
    }
    assert.notEqual(refusedAt, null, 'the rate limit never engaged');
});

test('a signed-in account is not held to the strict anonymous limit', async (t) => {
    const { app, dir, call } = await launch();
    t.after(() => app.stop());

    const code = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: { code, username: 'admin', password: 'a-long-enough-password' },
    });
    assert.equal(admin.status, 201);

    // The anonymous cap is 6/hour; a tester marks moments and must not lose reports to it. Ten
    // signed-in posts in a row — well past 6 — all land, because the per-account window is high.
    for (let i = 0; i < 10; i++) {
        const r = await call('POST', '/api/diagnostics', {
            token: admin.body.token,
            body: { kind: 'stream-bad', log: `moment ${i}` },
        });
        assert.equal(r.status, 202, `signed-in report ${i} was refused: ${JSON.stringify(r.body)}`);
    }
});
