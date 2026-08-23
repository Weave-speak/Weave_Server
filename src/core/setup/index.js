// First-run setup.
//
// No default credentials, ever. A freshly installed server has no administrator, and
// the only way to create the first one is to prove you can read the machine's console
// or its data directory — which is exactly the same thing as proving you own the box.
//
// The design borrows the "wizard only while zero admins exist" gate and adds a
// possession proof, while deliberately avoiding two failure modes seen elsewhere:
//
//   - It does NOT stop the service or run a suicide timer. Expiry is recoverable by
//     restarting, so a distracted admin has not bricked anything.
//   - It is NOT a standing credential kept in a config file forever. Once the first
//     admin exists the token is deleted and the route stops existing.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { countAdmins } from '../users/index.js';

/** Long enough that expiry is generous, short enough that a stale token is not lying around. */
export const SETUP_TOKEN_TTL_MS = 60 * 60 * 1000;

// Same unambiguous alphabet as invite codes: this gets read off a terminal and typed
// into a browser, sometimes over a phone call.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function generateCode() {
    const bytes = crypto.randomBytes(16);
    const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
    return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export class SetupState {
    #token = null;
    #expiresAt = 0;
    #file;
    #db;
    #log;

    constructor({ db, config, log }) {
        this.#db = db;
        this.#log = log;
        this.#file = path.join(config.dataDir, 'setup-token');
    }

    /** True while the server has no usable administrator. */
    get required() {
        return countAdmins(this.#db) === 0;
    }

    /**
     * Issue a token if setup is required. Called at boot and after any restart, so a
     * missed window costs a `systemctl restart`, not a reinstall.
     */
    begin({ httpPort, httpBind, instanceName, version, quiet = false }) {
        if (!this.required) {
            this.clear();
            return null;
        }

        this.#token = generateCode();
        this.#expiresAt = Date.now() + SETUP_TOKEN_TTL_MS;

        // Written 0600 so an admin who scrolled past the banner can still read it,
        // without it being world-readable on a shared box.
        try {
            fs.writeFileSync(this.#file, `${this.#token}\n`, { mode: 0o600 });
        } catch (err) {
            this.#log.warn({ evt: 'setup.token_file_failed', err },
                'Could not write the setup token file; use the console banner instead');
        }

        // Straight to stdout, not through the logger: this must be readable and
        // unmissable in `journalctl` and `docker logs`, not formatted as a log record.
        // `quiet` exists for tests and for an operator who has deliberately silenced
        // output; the token is still written to disk either way.
        if (quiet) return this.#token;
        const url = `http://${httpBind === '0.0.0.0' ? '127.0.0.1' : httpBind}:${httpPort}/admin/setup`;
        const line = '═'.repeat(70);
        process.stdout.write(`
${line}
  ${instanceName.toUpperCase()} ${version} — FIRST-RUN SETUP REQUIRED

  No administrator account exists yet. Open this URL and enter the setup
  code below to create one.

     ${url}

  Setup code:   ${this.#token}
  Expires:      in 60 minutes (restart the server to get a new code)

  Not on this machine? Don't expose the port yet — tunnel instead:
     ssh -L ${httpPort}:127.0.0.1:${httpPort} you@your-server

  Lost the code?  cat ${this.#file}
${line}

`);

        this.#log.warn({ evt: 'setup.required' }, 'First-run setup is required — see the console banner');
        return this.#token;
    }

    /**
     * Check a submitted code.
     *
     * Constant-time comparison: a token compared with === leaks its prefix through
     * timing, and this one guards the creation of an administrator.
     */
    verify(candidate) {
        if (!this.#token) return { ok: false, reason: 'Setup has already been completed.' };
        if (Date.now() > this.#expiresAt) {
            return { ok: false, reason: 'That setup code has expired. Restart the server for a new one.' };
        }

        const a = Buffer.from(String(candidate ?? '').toUpperCase().trim());
        const b = Buffer.from(this.#token);
        // timingSafeEqual throws on a length mismatch, which would itself be an oracle,
        // so equalise first and let the content comparison decide.
        const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

        return ok ? { ok: true } : { ok: false, reason: 'That setup code is not correct.' };
    }

    /** Called once the first admin exists. The token stops existing with it. */
    clear() {
        this.#token = null;
        this.#expiresAt = 0;
        try {
            if (fs.existsSync(this.#file)) fs.unlinkSync(this.#file);
        } catch (err) {
            this.#log.warn({ evt: 'setup.token_cleanup_failed', err },
                'Could not remove the setup token file');
        }
    }
}
