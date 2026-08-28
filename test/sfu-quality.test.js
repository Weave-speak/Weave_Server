// Reporting bad media without becoming noise.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isNewlyPoor, watchQuality, POOR_SCORE } from '../src/core/sfu/quality.js';

test('one bad sample is not a verdict', () => {
    // A consumer that has existed for a few hundred milliseconds is legitimately bad.
    assert.equal(isNewlyPoor([3]), false);
    assert.equal(isNewlyPoor([10, 3]), false, 'nor is one bad sample after a good one');
});

test('two consecutive bad samples are reported', () => {
    assert.equal(isNewlyPoor([10, 3, 2]), true);
});

test('a consumer that stays bad is reported once, not every sample', () => {
    // Thirty identical warnings would bury whatever came after them.
    assert.equal(isNewlyPoor([10, 3, 2]), true);
    assert.equal(isNewlyPoor([3, 2, 1]), false, 'already reported: it was bad before too');
});

test('a recovery re-arms the report', () => {
    assert.equal(isNewlyPoor([2, 10, 9]), false, 'good again, nothing to say');
    assert.equal(isNewlyPoor([9, 2, 1]), true, 'and a fresh slide is worth saying again');
});

test('the threshold is the boundary, not near it', () => {
    assert.equal(isNewlyPoor([10, POOR_SCORE, POOR_SCORE]), false, 'exactly at it is acceptable');
    assert.equal(isNewlyPoor([10, POOR_SCORE - 1, POOR_SCORE - 1]), true);
});

test('the watch logs a poor consumer and rolls it up for the admin view', () => {
    const lines = [];
    const listeners = [];
    const consumer = {
        on: (evt, fn) => { if (evt === 'score') listeners.push(fn); },
        observer: { on: () => {} },
    };

    const watch = watchQuality({ log: { warn: (fields, msg) => lines.push({ fields, msg }) } });
    watch.observe(consumer, { listener: 'ada', speaker: 'grace', slot: 'audio' });

    for (const fn of listeners) { fn({ score: 10 }); fn({ score: 2 }); fn({ score: 1 }); }

    assert.equal(lines.length, 1, 'reported once');
    assert.match(lines[0].msg, /ada is receiving grace's audio badly/);
    assert.equal(watch.snapshot().worstConsumerScore, 1);
    assert.equal(watch.snapshot().poorEvents, 1);
});
