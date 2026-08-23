// Shared test helpers.
//
// The port allocation here exists because the obvious approach is racy. Binding a port,
// reading which one the OS gave you, then closing it and handing the number to something
// else is a time-of-check-to-time-of-use gap: anything on the machine can take that port
// in between, including another test. It produced exactly one flaky failure in a hundred
// runs, which is the worst frequency — often enough to erode trust in the suite, rare
// enough to be tempting to ignore.
//
// So: ask for a port, then retry the whole start if the server finds it taken.

import net from 'node:net';
import { start } from '../src/index.js';

/** Ports handed out by this process, so two tests in one file cannot collide. */
const claimed = new Set();

export async function freePort() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const port = await new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.once('error', reject);
            srv.listen(0, '127.0.0.1', () => {
                const { port: p } = srv.address();
                srv.close(() => resolve(p));
            });
        });
        if (!claimed.has(port)) {
            claimed.add(port);
            return port;
        }
    }
    throw new Error('Could not find an unclaimed port after 40 attempts');
}

/**
 * Start a server, retrying with fresh ports if something else grabbed one first.
 *
 * `env` is a function so each attempt gets a new pair of ports rather than retrying with
 * the ones that just failed.
 */
export async function startWithRetry(buildEnv, attempts = 4) {
    let lastError;
    for (let i = 0; i < attempts; i += 1) {
        const env = await buildEnv();
        try {
            return await start(env);
        } catch (err) {
            lastError = err;
            const inUse = err?.code === 'EADDRINUSE'
                || /EADDRINUSE|address already in use/i.test(String(err?.message));
            if (!inUse) throw err;
        }
    }
    throw new Error(`Server would not start after ${attempts} attempts: ${lastError?.message}`);
}
