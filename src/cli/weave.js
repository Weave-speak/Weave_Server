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
import { fileURLToPath } from 'node:url';
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

/**
 * Read one line, hiding it if asked.
 *
 * When stdin is not a terminal — a pipe, a heredoc, an automated install — this reads a
 * line rather than prompting. That is what makes these commands scriptable without a
 * --password flag, which would put the password in the process list for anyone running
 * `ps` at the wrong moment.
 */
/**
 * Lines from a pipe, buffered.
 *
 * A prompt that needs a TTY simply ignores piped input, so these commands could not be
 * scripted at all. Reading from stdin instead is what makes an automated install or a
 * heredoc work, without a --password flag that would put the password in the process list.
 *
 * The buffering matters: closing a readline interface tears down the shared stdin, so
 * reading one line per prompt made the second prompt find nothing. Everything is read
 * once and handed out in order.
 */
let pipedLines = null;
async function pipedLine(question) {
    if (!pipedLines) {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    }
    if (!pipedLines.length) die(`Nothing left on stdin for: ${question.trim()}`);
    return pipedLines.shift().trim();
}

async function ask(question, { silent = false } = {}) {
    if (!process.stdin.isTTY) {
        return pipedLine(question);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!silent) {
        const answer = await rl.question(question);
        rl.close();
        return answer.trim();
    }

    // readline has no masking of its own; muting the output stream is the usual approach.
    process.stdout.write(question);
    rl.output.write = () => {};
    const answer = await rl.question('');
    rl.output.write = process.stdout.write.bind(process.stdout);
    rl.close();
    // The typed newline was swallowed with the input, so put one back.
    console.log();
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

    async modules() {
        const config = withConfig();
        const db = withDatabase(config);

        const action = argv[1];
        const id = argv[2];

        // Read the manifests from disk rather than asking a running server, so this works
        // when the server is down — or when the module you need to turn off is the reason
        // it will not start.
        const dir = fileURLToPath(new URL('../modules', import.meta.url));
        const installed = fs.existsSync(dir)
            ? fs.readdirSync(dir, { withFileTypes: true })
                .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'module.json')))
                .map((e) => JSON.parse(fs.readFileSync(path.join(dir, e.name, 'module.json'), 'utf8')))
            : [];

        const stored = new Map(
            db.prepare("SELECT key, value FROM settings WHERE key LIKE 'module.%.enabled'").all()
                .map((r) => [r.key.slice(7, -8), JSON.parse(r.value)]),
        );
        const isOn = (m) => stored.get(m.id) ?? m.defaultEnabled !== false;

        if (!action || action === 'list') {
            process.stdout.write('\nModules\n═══════\n\n');
            for (const m of installed.sort((a, b) => a.id.localeCompare(b.id))) {
                process.stdout.write(`  ${isOn(m) ? '●' : '○'} ${m.id.padEnd(16)} ${m.name}\n`);
                if (m.description) process.stdout.write(`      ${m.description}\n`);
            }
            process.stdout.write('\n  ● enabled   ○ disabled\n');
            process.stdout.write('\n  weave modules enable <id>\n  weave modules disable <id>\n\n');
            db.close();
            return;
        }

        if (action !== 'enable' && action !== 'disable') {
            die(`Unknown action "${action}". Use: list, enable, disable`);
        }
        if (!id) die(`Which module? Try: weave modules ${action} <id>`);

        const module = installed.find((m) => m.id === id);
        if (!module) {
            die(`No module named "${id}". Installed: ${installed.map((m) => m.id).join(', ') || '(none)'}`);
        }

        db.prepare(`
            INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(`module.${id}.enabled`, JSON.stringify(action === 'enable'));
        db.close();

        process.stdout.write(`\n${id} will be ${action}d.\n\n`);
        // The loader reads this at startup. The admin console can do it live; changing the
        // stored setting from outside the process cannot.
        process.stdout.write('Restart for it to take effect:  sudo systemctl restart weave\n\n');
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

  weave modules                List modules and whether they are on.
    enable <id> | disable <id> Change it. Takes effect on restart; the admin
                               console can do it live.

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
