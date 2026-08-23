// `weave doctor`.
//
// A preflight that only ever passes is worse than no preflight, because it teaches people
// to trust a green tick that means nothing. So these tests are mostly about making it
// FAIL: each one sets up a real misconfiguration and asserts that doctor notices.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { runDoctor } from '../src/cli/doctor.js';

async function freePort() {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    await new Promise((r) => srv.close(r));
    return port;
}

function tempEnv(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-doctor-'));
    return {
        dir,
        env: {
            WEAVE_HTTP_PORT: '3555',
            WEAVE_MEDIA_PORT: '35555',
            WEAVE_DATA_DIR: path.join(dir, 'data'),
            WEAVE_LOG_DIR: path.join(dir, 'logs'),
            WEAVE_LOG_LEVEL: 'silent',
            ...overrides,
        },
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

const find = (results, title) => results.find((r) => r.title === title);
const levels = (results, level) => results.filter((r) => r.level === level);

test('a clean configuration passes with no failures', async (t) => {
    const httpPort = await freePort();
    const mediaPort = await freePort();
    const h = tempEnv({
        WEAVE_HTTP_PORT: String(httpPort),
        WEAVE_MEDIA_PORT: String(mediaPort),
        WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
    });
    t.after(h.cleanup);

    const { results } = await runDoctor({ env: h.env });
    assert.equal(levels(results, 'fail').length, 0,
        `unexpected failures: ${levels(results, 'fail').map((r) => r.title)}`);
    assert.equal(find(results, 'Node runtime').level, 'ok');
});

test('invalid configuration stops everything and says why', async (t) => {
    const h = tempEnv({ WEAVE_EXPOSURE: 'public', WEAVE_BEHIND_TLS: 'false' });
    t.after(h.cleanup);

    const { results } = await runDoctor({ env: h.env });

    // Public without TLS means session cookies cannot be Secure. Nothing else is worth
    // checking until that is fixed, so doctor stops rather than burying it in a list.
    assert.equal(results.length, 1);
    assert.equal(results[0].level, 'fail');
    assert.match(results[0].detail, /requires TLS/);
});

test('an announced hostname that does not resolve is a failure', async (t) => {
    const httpPort = await freePort();
    const mediaPort = await freePort();
    const h = tempEnv({
        WEAVE_HTTP_PORT: String(httpPort),
        WEAVE_MEDIA_PORT: String(mediaPort),
        // .invalid is reserved by RFC 2606 and can never resolve.
        WEAVE_ANNOUNCED_ADDRESS: 'weave-does-not-exist.invalid',
    });
    t.after(h.cleanup);

    const { results } = await runDoctor({ env: h.env });
    const announced = find(results, 'Announced address');

    assert.equal(announced.level, 'fail');
    assert.match(announced.detail, /does not resolve/);
});

test('a private announced address on a public server is a failure', async (t) => {
    const httpPort = await freePort();
    const mediaPort = await freePort();
    const h = tempEnv({
        WEAVE_HTTP_PORT: String(httpPort),
        WEAVE_MEDIA_PORT: String(mediaPort),
        WEAVE_EXPOSURE: 'public',
        WEAVE_BEHIND_TLS: 'true',
        WEAVE_ANNOUNCED_ADDRESS: '192.168.0.50',
    });
    t.after(h.cleanup);

    const { results } = await runDoctor({ env: h.env });
    const announced = find(results, 'Announced address');

    // Everyone outside the LAN would connect and then hear nothing.
    assert.equal(announced.level, 'fail');
    assert.match(announced.detail, /private address/);
});

test('an unset announced address warns rather than passing quietly', async (t) => {
    const httpPort = await freePort();
    const mediaPort = await freePort();
    const h = tempEnv({ WEAVE_HTTP_PORT: String(httpPort), WEAVE_MEDIA_PORT: String(mediaPort) });
    t.after(h.cleanup);

    const { results } = await runDoctor({ env: h.env });
    const announced = find(results, 'Announced address');

    assert.equal(announced.level, 'warn');
    // The guess picks the first interface, which on a machine with a VPN is usually wrong
    // — as it was on the machine this was developed on.
    assert.match(announced.fix, /VPN/);
});

test('a media port held by something else is a failure', async (t) => {
    const httpPort = await freePort();
    const mediaPort = await freePort();

    // Occupy the UDP half only. Weave needs both, and a check that looked at TCP alone
    // would call this healthy.
    const squatter = dgram.createSocket('udp4');
    await new Promise((r) => squatter.bind(mediaPort, '0.0.0.0', r));
    t.after(() => squatter.close());

    const h = tempEnv({
        WEAVE_HTTP_PORT: String(httpPort),
        WEAVE_MEDIA_PORT: String(mediaPort),
        WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
    });
    t.after(h.cleanup);

    const { results } = await runDoctor({ env: h.env });
    const media = find(results, `Media port ${mediaPort}`);

    assert.equal(media.level, 'fail');
    assert.match(media.detail, /EADDRINUSE/);
    assert.match(media.fix, /BOTH protocols/);
});

test('an HTTP port held by something else is a failure', async (t) => {
    const mediaPort = await freePort();
    const httpPort = await freePort();

    const squatter = net.createServer();
    await new Promise((r) => squatter.listen(httpPort, '0.0.0.0', r));
    t.after(() => squatter.close());

    const h = tempEnv({
        WEAVE_HTTP_PORT: String(httpPort),
        WEAVE_MEDIA_PORT: String(mediaPort),
        WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
        WEAVE_HTTP_BIND: '0.0.0.0',
    });
    t.after(h.cleanup);

    const { results } = await runDoctor({ env: h.env });
    const http = find(results, 'HTTP port');

    assert.equal(http.level, 'fail');
    assert.match(http.fix, /not Weave/);
});

test('a missing administrator is reported', async (t) => {
    const httpPort = await freePort();
    const mediaPort = await freePort();
    const h = tempEnv({
        WEAVE_HTTP_PORT: String(httpPort),
        WEAVE_MEDIA_PORT: String(mediaPort),
        WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
    });
    t.after(h.cleanup);

    // Start a server once so a database exists with no admin in it.
    const { start } = await import('../src/index.js');
    const app = await start(h.env);
    await app.stop('test');

    const { results } = await runDoctor({ env: h.env });
    const admin = find(results, 'Administrator');

    assert.equal(admin.level, 'warn');
    assert.match(admin.fix, /first-run setup/);
});

test('doctor never claims to have verified inbound reachability', async (t) => {
    const httpPort = await freePort();
    const mediaPort = await freePort();
    const h = tempEnv({
        WEAVE_HTTP_PORT: String(httpPort),
        WEAVE_MEDIA_PORT: String(mediaPort),
        WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
    });
    t.after(h.cleanup);

    const { results } = await runDoctor({ env: h.env });

    // The one thing a server genuinely cannot determine about itself. No check may imply
    // otherwise, because a green report next to a silent call is how trust in the whole
    // tool gets lost.
    for (const r of results) {
        assert.ok(
            !/reachable from the internet|port is forwarded|inbound works/i.test(r.detail),
            `"${r.title}" overclaims: ${r.detail}`,
        );
    }
});
