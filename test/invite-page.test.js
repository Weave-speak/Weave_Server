// The invite landing page: the one URL strangers see before they have the app.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startWithRetry } from './helpers.js';

async function launch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-invpage-'));
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
            WEAVE_INSTANCE_NAME: 'The <Crew>',   // hostile on purpose
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
    assert.match(page.text, /releases\/latest/, 'and the download');
    assert.match(page.text, /The &lt;Crew&gt;/, 'the server name is escaped, not trusted');
    assert.ok(!page.text.includes('<Crew>'), 'no raw markup from config');

    const dead = await h.call('GET', '/invite/NOPE99');
    assert.equal(dead.status, 200);
    assert.match(dead.text, /no longer valid/);
    assert.ok(!dead.text.includes('weave://join'), 'a dead code offers no deep link');
});
