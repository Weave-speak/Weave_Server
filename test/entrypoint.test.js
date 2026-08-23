// Starting the server the way it is actually deployed.
//
// This exists because of a bug that no unit test could have caught and that looked like
// success from every angle: the installed layout puts the code behind a symlink
// (/opt/weave/current -> releases/<version>) so an upgrade is a symlink flip. Node
// resolves symlinks for `import.meta.url` but leaves `process.argv[1]` as written, so the
// entry-point guard compared two different strings, declined to start, and exited 0.
//
// systemd called that "Deactivated successfully". The application log was empty, because
// nothing ever ran.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

async function freePort() {
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    await new Promise((r) => srv.close(r));
    return port;
}

/** Wait for the server to answer, or give up with whatever it printed. */
async function waitForHealth(port, child, output) {
    for (let i = 0; i < 60; i += 1) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
                signal: AbortSignal.timeout(500),
            });
            if (res.ok) return res.json();
        } catch { /* not up yet */ }

        if (child.exitCode !== null) {
            throw new Error(
                `The server exited with code ${child.exitCode} instead of listening.\n`
                + `Output was:\n${output.join('') || '(nothing)'}`,
            );
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Never became healthy. Output:\n${output.join('')}`);
}

test('the server starts when launched through a symlinked path', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-link-'));
    const link = path.join(dir, 'current');

    try {
        // 'junction' works on Windows without elevation; ignored elsewhere.
        fs.symlinkSync(ROOT, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
        t.skip(`cannot create a symlink here: ${err.message}`);
        return;
    }

    const httpPort = await freePort();
    const mediaPort = await freePort();

    const child = spawn(process.execPath, [path.join(link, 'src', 'index.js')], {
        env: {
            ...process.env,
            WEAVE_HTTP_PORT: String(httpPort),
            WEAVE_HTTP_BIND: '127.0.0.1',
            WEAVE_MEDIA_PORT: String(mediaPort),
            WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
            WEAVE_DATA_DIR: path.join(dir, 'data'),
            WEAVE_LOG_DIR: path.join(dir, 'logs'),
            WEAVE_LOG_LEVEL: 'silent',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = [];
    child.stdout.on('data', (d) => output.push(String(d)));
    child.stderr.on('data', (d) => output.push(String(d)));

    t.after(async () => {
        child.kill('SIGKILL');
        await new Promise((r) => child.once('exit', r));
        // Windows holds the SQLite file briefly after the process dies.
        for (let i = 0; i < 10; i += 1) {
            try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
        }
    });

    const health = await waitForHealth(httpPort, child, output);
    assert.equal(health.ok, true);

    // The precise failure mode: the process used to exit 0 having done nothing at all.
    assert.equal(child.exitCode, null, 'still running rather than having quietly exited');
});
