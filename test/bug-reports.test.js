// Reporting a bug, and reading the reports.
//
// The endpoint already existed for update failures and stream-quality notes. What a bug
// report adds is the part written by a person — and the thing worth testing is that both
// sides of the moment end up in one file, so an administrator reads one report instead of
// correlating a client's account of it against the server log by timestamp.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-bug-'));
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
            // Not silent: a bug report attaches the server's own log, and there has to be
            // one for it to attach.
            WEAVE_LOG_LEVEL: 'info',
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

    const code = fs.readFileSync(path.join(dir, 'data', 'setup-token'), 'utf8').trim();
    const admin = await call('POST', '/api/setup', {
        body: { code, username: 'admin', password: 'a-long-enough-password' },
    });
    assert.equal(admin.status, 201, JSON.stringify(admin.body));

    const mint = async (username) => {
        const invite = await call('POST', '/api/invites', { token: admin.body.token, body: {} });
        const user = await call('POST', '/api/auth/register', {
            body: { inviteCode: invite.body.invite.code, username, password: 'a-long-enough-password' },
        });
        assert.equal(user.status, 201, JSON.stringify(user.body));
        return user.body;
    };

    const stored = () => fs.readdirSync(path.join(dir, 'data', 'diagnostics'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'diagnostics', f), 'utf8')));

    return { app, dir, call, mint, stored, adminToken: admin.body.token };
}

test('a bug report keeps what the person said, and what the server was doing', async (t) => {
    const h = await launch();
    t.after(() => h.app.stop());

    const res = await h.call('POST', '/api/diagnostics', {
        token: h.adminToken,
        body: {
            kind: 'bug',
            description: 'The screen share froze while three of us were watching.',
            client: { version: '0.1.61', target: 'desktop' },
            log: 'renderer: consumer stalled',
        },
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));

    const [report] = h.stored();
    assert.equal(report.kind, 'bug');
    assert.match(report.description, /screen share froze/);
    assert.equal(report.log, 'renderer: consumer stalled');
    assert.equal(report.from.username, 'admin');

    // Both sides of the moment, in one file: the server's load at receipt, and its own log
    // around the same time.
    assert.ok(typeof report.server.loadPerCore === 'number');
    assert.ok(Array.isArray(report.serverLog) && report.serverLog.length > 0,
        "the server's own log is attached");
});

test('a report from a build with no log is still a report', async (t) => {
    const h = await launch();
    t.after(() => h.app.stop());

    // A browser has no log file it can read. Refusing would lose the only part that
    // matters, which is what the person actually says.
    const res = await h.call('POST', '/api/diagnostics', {
        token: h.adminToken,
        body: { kind: 'bug', description: 'Audio cut out when I switched rooms.' },
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));

    const [report] = h.stored();
    assert.match(report.description, /Audio cut out/);
    assert.equal(report.log, null);
});

test('neither an empty description nor an empty log alone is a report', async (t) => {
    const h = await launch();
    t.after(() => h.app.stop());

    const empty = await h.call('POST', '/api/diagnostics', {
        token: h.adminToken, body: { kind: 'bug', description: '   ' },
    });
    assert.equal(empty.status, 400);
    assert.equal(h.stored().length, 0);
});

test("only a bug report carries the server's log", async (t) => {
    const h = await launch();
    t.after(() => h.app.stop());

    // A tester marks a moment often enough that attaching 300 lines to each would be a way
    // to fill a disk, and an update failure has nothing to do with the server at all.
    await h.call('POST', '/api/diagnostics', {
        token: h.adminToken, body: { kind: 'stream-quality', log: '{"fps":3}' },
    });
    const [report] = h.stored();
    assert.equal(report.serverLog, undefined);
});

test('a description longer than the field is cut, not refused', async (t) => {
    const h = await launch();
    t.after(() => h.app.stop());

    await h.call('POST', '/api/diagnostics', {
        token: h.adminToken, body: { kind: 'bug', description: 'x'.repeat(9000) },
    });
    const [report] = h.stored();
    assert.equal(report.description.length, 4000, 'capped rather than thrown away');
});

test('an administrator can list, read and delete reports', async (t) => {
    const h = await launch();
    t.after(() => h.app.stop());

    await h.call('POST', '/api/diagnostics', {
        token: h.adminToken,
        body: { kind: 'bug', description: 'The join sound plays twice.', log: 'a line' },
    });

    const list = await h.call('GET', '/api/admin/diagnostics', { token: h.adminToken });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.total, 1);
    const [summary] = list.body.reports;
    assert.match(summary.description, /join sound plays twice/);
    assert.equal(summary.from, 'admin');
    assert.ok(summary.bytes > 0);

    const one = await h.call('GET', `/api/admin/diagnostics/${summary.name}`, { token: h.adminToken });
    assert.equal(one.status, 200);
    assert.equal(one.body.report.log, 'a line');

    const gone = await h.call('DELETE', `/api/admin/diagnostics/${summary.name}`, { token: h.adminToken });
    assert.equal(gone.status, 200);
    assert.equal(h.stored().length, 0);
});

test('a report name has to be one this server minted', async (t) => {
    const h = await launch();
    t.after(() => h.app.stop());

    // Checked against the shape the module mints rather than sanitised. Sanitising a path
    // is a game of finding every escape; refusing anything that is not already ours has
    // one move.
    for (const name of ['..%2F..%2Fdata%2Fweave.db', 'weave.db', 'not-a-report.json']) {
        const res = await h.call('GET', `/api/admin/diagnostics/${name}`, { token: h.adminToken });
        assert.equal(res.status, 404, `${name} must not resolve`);
    }
});

test('reading other people’s reports is an administrator’s business', async (t) => {
    const h = await launch();
    t.after(() => h.app.stop());

    const member = await h.mint('sinister');
    await h.call('POST', '/api/diagnostics', {
        token: h.adminToken, body: { kind: 'bug', description: 'Something broke.' },
    });

    // A report can carry somebody's log and their account name, so the read side is for
    // whoever runs the server, not for whoever uses it.
    for (const [method, url] of [
        ['GET', '/api/admin/diagnostics'],
        ['GET', '/api/admin/diagnostics/anything.json'],
        ['DELETE', '/api/admin/diagnostics/anything.json'],
    ]) {
        assert.equal((await h.call(method, url, { token: member.token })).status, 403,
            `${method} ${url} is not theirs to call`);
        assert.equal((await h.call(method, url)).status, 401, `${method} ${url} needs a session`);
    }
});
