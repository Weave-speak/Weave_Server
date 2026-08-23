// Migration runner.
//
// The previous Weave had no migrations at all: `CREATE TABLE IF NOT EXISTS` ran at
// import time, which quietly means no column can ever change and no deployed database
// can ever be corrected. This exists so that is never true again.
//
// Migrations are NAMESPACED rather than tracked by SQLite's single `user_version`
// integer, because modules own their own tables and version them on their own
// schedule. The core migrates under 'core'; a module migrates under its own id. A
// module that is disabled simply does not migrate — its tables sit untouched until it
// comes back, which is what makes "disable is not destroy" true at the storage layer.

import fs from 'node:fs';
import path from 'node:path';

export class MigrationError extends Error {}

const LEDGER = `
CREATE TABLE IF NOT EXISTS _migrations (
    namespace   TEXT    NOT NULL,
    version     INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    checksum    TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (namespace, version)
)`;

/** Cheap, stable content hash. Detects an edited migration, not an adversary. */
function checksum(text) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    }
    return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

/**
 * Read `NNN_name.sql` files from a directory, ordered by their numeric prefix.
 * The prefix is the version; gaps are fine, duplicates are not.
 */
export function readMigrations(dir) {
    if (!fs.existsSync(dir)) return [];

    const seen = new Map();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    return files.map((file) => {
        const match = /^(\d+)[_-](.+)\.sql$/.exec(file);
        if (!match) {
            throw new MigrationError(
                `Migration "${file}" is misnamed. Use NNN_description.sql, e.g. 001_initial.sql`,
            );
        }
        const version = Number(match[1]);
        if (seen.has(version)) {
            throw new MigrationError(
                `Two migrations share version ${version} in ${dir}: "${seen.get(version)}" and "${file}"`,
            );
        }
        seen.set(version, file);

        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        return { version, name: match[2], file, sql, checksum: checksum(sql) };
    }).sort((a, b) => a.version - b.version);
}

/**
 * Apply every unapplied migration for one namespace.
 *
 * Each migration runs inside a transaction together with its ledger row, so a failure
 * leaves no half-applied schema and no false record of success. Returns what it did,
 * so callers can log it and `weave doctor` can report it.
 */
export function migrate(db, namespace, dir, log) {
    db.exec(LEDGER);

    const migrations = readMigrations(dir);
    if (migrations.length === 0) return { namespace, applied: [], alreadyAt: 0 };

    const applied = db.prepare(
        'SELECT version, name, checksum FROM _migrations WHERE namespace = ? ORDER BY version',
    ).all(namespace);
    const appliedBy = new Map(applied.map((row) => [row.version, row]));

    // An edited migration means the database and the code disagree about what the
    // schema is. That is worth stopping for — silently ignoring it is how a server
    // ends up with a schema nobody can reproduce.
    for (const m of migrations) {
        const prior = appliedBy.get(m.version);
        if (prior && prior.checksum !== m.checksum) {
            throw new MigrationError(
                `Migration ${namespace}/${m.file} changed after it was applied `
                + `(recorded ${prior.checksum}, file is now ${m.checksum}). `
                + 'Migrations are immutable once released — add a new one instead.',
            );
        }
    }

    const record = db.prepare(
        'INSERT INTO _migrations (namespace, version, name, checksum) VALUES (?, ?, ?, ?)',
    );

    const pending = migrations.filter((m) => !appliedBy.has(m.version));
    const done = [];

    for (const m of pending) {
        const run = db.transaction(() => {
            db.exec(m.sql);
            record.run(namespace, m.version, m.name, m.checksum);
        });
        try {
            run();
        } catch (err) {
            throw new MigrationError(
                `Migration ${namespace}/${m.file} failed and was rolled back: ${err.message}`,
                { cause: err },
            );
        }
        done.push(m.version);
        log?.info({ evt: 'db.migrated', namespace, version: m.version, name: m.name },
            `Applied ${namespace} migration ${m.version} (${m.name})`);
    }

    const highest = migrations.at(-1).version;
    return { namespace, applied: done, alreadyAt: highest };
}

/** Current applied version per namespace, for diagnostics and the admin UI. */
export function migrationStatus(db) {
    db.exec(LEDGER);
    return db.prepare(`
        SELECT namespace, MAX(version) AS version, COUNT(*) AS count
        FROM _migrations GROUP BY namespace ORDER BY namespace
    `).all();
}
