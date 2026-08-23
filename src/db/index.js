// SQLite access.
//
// better-sqlite3 is synchronous, which is a real constraint: every query blocks the
// event loop, and the event loop is also carrying signalling for everyone in a call.
// Queries here must stay small and indexed. Anything that would scan a large table
// belongs behind a cursor or a background task, not in a request handler.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate, migrationStatus } from './migrate.js';

export function openDatabase(cfg, log) {
    fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });

    const db = new Database(cfg.dbPath);

    // Write-ahead logging: readers do not block the writer, which matters because a
    // voice server does many small reads while someone is joining.
    db.pragma('journal_mode = WAL');

    // Without this, any concurrent write throws SQLITE_BUSY immediately instead of
    // waiting. The old schema set WAL but never this, so a backup running against a
    // live server could surface as a user-visible error.
    db.pragma('busy_timeout = 5000');

    // Off by default in SQLite, and never enabled in the previous Weave — which is why
    // its cascades were hand-rolled and its orphan rows accumulated.
    db.pragma('foreign_keys = ON');

    // Durability compromise appropriate for WAL: survives process crash, and only risks
    // the last transactions on sudden power loss. A voice server is not a ledger.
    db.pragma('synchronous = NORMAL');

    log?.debug({ evt: 'db.open', path: cfg.dbPath }, 'Database opened');
    return db;
}

/** Apply the core schema. Modules migrate themselves through their own context. */
export function migrateCore(db, log) {
    const dir = path.join(import.meta.dirname, 'migrations');
    return migrate(db, 'core', dir, log);
}

/**
 * Online backup. Uses SQLite's own backup API rather than copying the file, because
 * copying a WAL database while it is being written produces a corrupt result that
 * looks fine until you try to restore it.
 */
export async function backup(db, cfg, label = 'manual') {
    fs.mkdirSync(cfg.backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(cfg.backupsDir, `${label}-${stamp}.db`);
    await db.backup(dest);
    return { path: dest, bytes: fs.statSync(dest).size };
}

/** Integrity check, for `weave doctor` and the post-update self-test. */
export function checkIntegrity(db) {
    const result = db.pragma('integrity_check', { simple: true });
    return { ok: result === 'ok', detail: result };
}

export { migrate, migrationStatus };
