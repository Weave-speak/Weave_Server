// `weave add-sound` — seeding the join/leave sound library with no admin account and
// no HTTP call, the same "reading the data directory IS the authorisation" principle
// every other command in this file relies on.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { freePort, startWithRetry } from './helpers.js';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli', 'weave.js');

/** A minimal but genuine OGG file — enough for sniff() to recognise it. */
const oggBytes = () => Buffer.concat([Buffer.from('OggS', 'ascii'), Buffer.alloc(64, 3)]);

function runCli(args, env) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const out = []; const err = [];
        child.stdout.on('data', (d) => out.push(String(d)));
        child.stderr.on('data', (d) => err.push(String(d)));
        child.on('exit', (code) => resolve({ code, stdout: out.join(''), stderr: err.join('') }));
    });
}

test('add-sound writes a real row and file, and refuses whatever is not audio', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-addsound-'));
    const dataDir = path.join(dir, 'data');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    // Boot once, for real, so the personas module's own migration actually runs —
    // exactly what the command itself tells you to do if this step is skipped.
    const httpPort = await freePort();
    const mediaPort = await freePort();
    const env = {
        WEAVE_HTTP_PORT: String(httpPort),
        WEAVE_HTTP_BIND: '127.0.0.1',
        WEAVE_MEDIA_PORT: String(mediaPort),
        WEAVE_ANNOUNCED_ADDRESS: '127.0.0.1',
        WEAVE_DATA_DIR: dataDir,
        WEAVE_LOG_DIR: path.join(dir, 'logs'),
        WEAVE_LOG_LEVEL: 'silent',
    };
    const app = await startWithRetry(async () => env);

    const setupCode = fs.readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim();
    const setup = await fetch(`http://127.0.0.1:${httpPort}/api/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: setupCode, username: 'admin', password: 'a-long-enough-password' }),
    }).then((r) => r.json());

    await fetch(`http://127.0.0.1:${httpPort}/api/admin/modules/personas/enable`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${setup.token}` },
    });

    // Stopped before the CLI touches the same SQLite file directly — two processes
    // holding it open at once is exactly the kind of thing worth not risking.
    await app.stop('test');

    const cliEnv = { ...process.env, WEAVE_DATA_DIR: dataDir };

    const soundFile = path.join(dir, 'arrival.ogg');
    fs.writeFileSync(soundFile, oggBytes());
    const added = await runCli(['add-sound', soundFile, '--name', 'Arrival Chime'], cliEnv);
    assert.equal(added.code, 0, added.stderr || added.stdout);
    assert.match(added.stdout, /Added "Arrival Chime"/);

    const db = new Database(path.join(dataDir, 'weave.db'), { readonly: true });
    const row = db.prepare('SELECT name, extension, mime, bytes FROM persona_sounds').get();
    db.close();
    assert.equal(row.name, 'Arrival Chime');
    assert.equal(row.extension, 'ogg');
    assert.equal(row.mime, 'audio/ogg');
    assert.equal(row.bytes, oggBytes().length);

    const soundsDir = path.join(dataDir, 'sounds');
    const written = fs.readdirSync(soundsDir);
    assert.equal(written.length, 1, 'the audio bytes were written to disk, not just the DB row');
    assert.ok(written[0].endsWith('.ogg'));

    // Whatever the declared name of the file, the bytes are what decide.
    const bogus = path.join(dir, 'not-audio.mp3');
    fs.writeFileSync(bogus, Buffer.from('definitely not an audio file'));
    const refused = await runCli(['add-sound', bogus], cliEnv);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stdout + refused.stderr, /does not look like an OGG, MP3 or WAV/);
    // Nothing from the refused attempt landed anywhere.
    assert.equal(countSounds(dataDir), 1);
});

function countSounds(dataDir) {
    const db = new Database(path.join(dataDir, 'weave.db'), { readonly: true });
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM persona_sounds').get();
    db.close();
    return n;
}
