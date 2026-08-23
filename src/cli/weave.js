#!/usr/bin/env node
// The `weave` command.
//
// Everything here works against the data directory directly rather than through the HTTP
// API, because these are the things you need when the server is not running or you cannot
// get into it. Being able to read the data directory IS the authorisation — it is the same
// proof the first-run setup token relies on, and it is why `admin-reset` needs no password
// of its own.
//
// This is what makes `sqlite3 weave.db` never the answer.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig, describeConfig, ConfigError } from '../core/config/index.js';
import { openDatabase, migrateCore, backup as backupDb, checkIntegrity } from '../db/index.js';
import { createNullLogger } from '../core/log/index.js';
import {
    listUsers, getUserByUsername, setPassword, countAdmins, createUser, UserError,
} from '../core/users/index.js';
import { revokeAllForUser } from '../core/auth/index.js';
import { runDoctor, printReport } from './doctor.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const argv = process.argv.slice(2);
const command = argv[0];

/** Read `--name value` and `--flag`. */
function flag(name, fallback = null) {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return fallback;
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
}

const die = (message, code = 1) => {
    process.stderr.write(`${message}\n`);
    process.exit(code);
};

function withConfig() {
    try {
        return loadConfig();
    } catch (err) {
        if (err instanceof ConfigError) die(`\n${err.message}\n`, 78);
        throw err;
    }
}

function withDatabase(config) {
    if (!fs.existsSync(config.dbPath)) {
        die(`No database at ${config.dbPath}.\nStart the server once to create it, or check WEAVE_DATA_DIR.`);
    }
    try {
        return openDatabase(config, createNullLogger());
    } catch (err) {
        die(`Could not open ${config.dbPath}: ${err.message}\n`
            + 'If you are running this as the wrong user, try again with sudo -u weave.');
    }
}

async function ask(question, { silent = false } = {}) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!silent) {
        const answer = await rl.question(question);
        rl.close();
        return answer.trim();
    }
    // Node's readline has no built-in masking; muting the output stream is the usual way.
    process.stdout.write(question);
    rl.output.write = () => {};
    const answer = await rl.question('');
    rl.output.write = process.stdout.write.bind(process.stdout);
    rl.close();
    process.stdout.write('\n');
    return answer.trim();
}

/* ── commands ──────────────────────────────────────────────────────────────── */

const COMMANDS = {
    async doctor() {
        const stun = argv.includes('--stun');
        const report = await runDoctor({ stun });
        process.exit(printReport(report, { stun }));
    },

    async 'admin-reset'() {
        const config = withConfig();
        const db = withDatabase(config);

        const username = flag('user');
        const promote = flag('promote');

        if (promote && typeof promote === 'string') {
            const user = getUserByUsername(db, promote);
            if (!user) die(`No account named "${promote}".`);
            db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
            process.stdout.write(`${user.username} is now an administrator.\n`);
            db.close();
            return;
        }

        if (!username) {
            const admins = listUsers(db).filter((u) => u.isAdmin);
            process.stdout.write('\nAdministrator accounts on this server:\n\n');
            if (!admins.length) {
                process.stdout.write('  (none)\n\n');
                process.stdout.write(
                    'There is no administrator. Restart the server and it will print a\n'
                    + 'first-run setup code, or create one now with:\n\n'
                    + '  weave admin-reset --create <username>\n\n',
                );
            } else {
                for (const a of admins) process.stdout.write(`  ${a.username}  (${a.displayName})\n`);
                process.stdout.write(
                    '\nReset one with:      weave admin-reset --user <username>\n'
                    + 'Promote someone:     weave admin-reset --promote <username>\n\n',
                );
            }
            db.close();
            return;
        }

        const user = getUserByUsername(db, username);
        if (!user) die(`No account named "${username}".`);

        const password = await ask(`New password for ${user.username}: `, { silent: true });
        const again = await ask('Repeat it: ', { silent: true });
        if (password !== again) die('Those did not match. Nothing was changed.');

        try {
            await setPassword(db, user.id, password);
        } catch (err) {
            if (err instanceof UserError) die(err.message);
            throw err;
        }

        // Whoever knew the old password is signed out. If you are resetting it, that is
        // the outcome you want.
        const revoked = revokeAllForUser(db, user.id);
        db.prepare('UPDATE users SET is_admin = 1, is_disabled = 0 WHERE id = ?').run(user.id);
        db.close();

        process.stdout.write(
            `\nPassword changed for ${user.username}, administrator access confirmed, `
            + `and ${revoked} existing session(s) signed out.\n\n`,
        );
    },

    async 'admin-create'() {
        const config = withConfig();
        fs.mkdirSync(config.dataDir, { recursive: true });
        const db = openDatabase(config, createNullLogger());
        migrateCore(db, createNullLogger());

        const username = flag('user') || await ask('Username: ');
        const password = await ask('Password: ', { silent: true });
        const again = await ask('Repeat it: ', { silent: true });
        if (password !== again) die('Those did not match. Nothing was created.');

        try {
            const user = await createUser(db, { username, displayName: username, password, isAdmin: true });
            process.stdout.write(`\nCreated administrator ${user.username}.\n\n`);
        } catch (err) {
            if (err instanceof UserError) die(err.message);
            throw err;
        } finally {
            db.close();
        }
    },

    async backup() {
        const config = withConfig();
        const db = withDatabase(config);

        // SQLite's own backup API, not a file copy. Copying a WAL database while it is
        // being written produces a result that looks fine until you try to restore it.
        const result = await backupDb(db, config, flag('label') || 'manual');
        const integrity = checkIntegrity(db);
        db.close();

        process.stdout.write(
            `\nBacked up to ${result.path}\n`
            + `  ${(result.bytes / 1048576).toFixed(2)} MB · source integrity ${integrity.ok ? 'ok' : 'FAILED'}\n\n`
            + 'Uploads are NOT in this file. To back up everything:\n'
            + `  tar -czf weave-backup.tar.gz -C ${path.dirname(config.dataDir)} ${path.basename(config.dataDir)}\n\n`,
        );
    },

    config() {
        const config = withConfig();
        process.stdout.write('\nSettings, with the value currently in effect\n');
        process.stdout.write('════════════════════════════════════════════\n\n');

        for (const item of describeConfig()) {
            const live = config[Object.keys(config).find((k) =>
                k.toLowerCase() === item.key.replace('WEAVE_', '').replace(/_/g, '').toLowerCase())];
            process.stdout.write(`${item.key}\n`);
            process.stdout.write(`  ${item.doc}\n`);
            process.stdout.write(`  default: ${JSON.stringify(item.default)}`);
            if (live !== undefined) process.stdout.write(`   now: ${JSON.stringify(live)}`);
            process.stdout.write('\n\n');
        }
    },

    placeholders() {
        // Read from the console's own list so this can never drift from what is on screen.
        const source = fs.readFileSync(new URL('../../admin/app.js', import.meta.url), 'utf8');
        const titles = [...source.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]);
        process.stdout.write('\nAdmin console screens that are not built yet\n');
        process.stdout.write('═══════════════════════════════════════════\n\n');
        for (const t of titles) process.stdout.write(`  · ${t}\n`);
        process.stdout.write('\nSee docs/placeholders.md for what each one needs.\n\n');
    },

    version() {
        process.stdout.write(`weave ${pkg.version} (node ${process.version})\n`);
    },

    help() {
        process.stdout.write(`
weave ${pkg.version}

  weave doctor [--stun]        Check this server's configuration and report problems.
                               --stun also asks how the internet sees this machine.

  weave admin-reset            List administrators.
    --user <name>              Reset that account's password and confirm its access.
    --promote <name>           Make an existing account an administrator.
  weave admin-create           Create an administrator from the command line.
    --user <name>

  weave backup [--label x]     Take a consistent snapshot of the database.
  weave config                 Show every setting, what it does, and its current value.
  weave placeholders           List admin screens that are not built yet.
  weave version

Settings come from the environment, usually /etc/weave/weave.env.
Being able to read the data directory is the authorisation for these commands.

`);
    },
};

const handler = COMMANDS[command] ?? (command ? null : COMMANDS.help);

if (!handler) {
    die(`Unknown command "${command}". Try: weave help`);
}

// Wrapped, because the synchronous commands return undefined and calling .catch on that
// throws after they have already succeeded — an error report for a command that worked.
Promise.resolve()
    .then(handler)
    .catch((err) => {
        process.stderr.write(`\n${err?.stack ?? err}\n`);
        process.exit(1);
    });
