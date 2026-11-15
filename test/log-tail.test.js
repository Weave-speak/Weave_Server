// Reading the end of the log.
//
// A bug report attaches the tail of the server's log, and the administration console shows
// it. Both go through tailLog, so what it returns is what an administrator is told the
// server was doing — a line quietly missing from it is a line missing from the diagnosis.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tailLog, logFiles } from '../src/core/log/tail.js';

function logDirWith(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-tail-'));
    fs.writeFileSync(path.join(dir, 'weave.log.2026-11-15.1'), lines.map((l) => `${l}\n`).join(''));
    return dir;
}
const entry = (n) => JSON.stringify({ msg: `line ${n}` });

test('a log that fits in the window is returned whole, first line included', () => {
    // The first line of a file is complete. Only a read that starts partway through one is
    // cut off mid-line, and this read starts at the beginning.
    const dir = logDirWith([entry(1), entry(2), entry(3)]);
    assert.deepEqual(tailLog(dir).entries.map((e) => e.msg), ['line 1', 'line 2', 'line 3']);
});

test('a log with a single line is not reported as empty', () => {
    // What a server that has only just started has written.
    const dir = logDirWith([entry(1)]);
    assert.deepEqual(tailLog(dir).entries.map((e) => e.msg), ['line 1']);
});

test('only the last N lines are returned, newest last', () => {
    const dir = logDirWith(Array.from({ length: 10 }, (_, i) => entry(i + 1)));
    assert.deepEqual(tailLog(dir, 3).entries.map((e) => e.msg), ['line 8', 'line 9', 'line 10']);
});

test('a log larger than the window is read from the end, and its cut-off first line dropped', () => {
    // 600 KB of lines against a 512 KB window: the read begins partway into some line, and
    // that fragment must not be handed back as an entry.
    const filler = 'x'.repeat(1000);
    const lines = Array.from({ length: 600 }, (_, i) => JSON.stringify({ msg: `line ${i + 1}`, filler }));
    const dir = logDirWith(lines);

    const { entries, truncated } = tailLog(dir, 2000);
    assert.equal(truncated, true);
    assert.equal(entries.at(-1).msg, 'line 600');
    assert.ok(entries.every((e) => typeof e.msg === 'string' && e.msg.startsWith('line ')),
        'no fragment of a line comes back as an entry');
});

test('a line that is not JSON is kept as plain text, not lost', () => {
    const dir = logDirWith([entry(1), 'a stray line from somewhere else', entry(2)]);
    assert.deepEqual(tailLog(dir).entries.map((e) => e.msg),
        ['line 1', 'a stray line from somewhere else', 'line 2']);
});

test('no log yet means an empty answer, not an error', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'weave-tail-'));
    assert.deepEqual(tailLog(empty), { entries: [], file: null, truncated: false });
    assert.deepEqual(tailLog(path.join(empty, 'does-not-exist')), { entries: [], file: null, truncated: false });
    assert.deepEqual(logFiles(null), []);
});
