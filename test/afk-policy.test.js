// When somebody counts as away.
//
// The interesting cases are all about a signal being ABSENT rather than being large:
// a browser that cannot report idle time at all, a client that has stopped reporting, and
// a listener with no microphone whose keyboard is nevertheless observable. Getting any of
// those wrong is invisible in normal use and then moves the wrong person at the wrong
// moment, which is precisely the sort of thing nobody reports as a bug — they just stop
// trusting the feature.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    reportedIdleMs, activeSince, exemptionFor, REPORT_TTL_MS,
} from '../src/modules/afk/policy.js';

const SLOTS = { AUDIO: 'audio', SCREEN: 'screen', WEBCAM: 'webcam' };
const NOW = 1_000_000_000;

/** A peer with a microphone and nothing else going on. */
const peerWith = (extra = {}) => ({
    userId: 'u1',
    username: 'kestrel',
    producers: new Map([['audio', {}]]),
    idleMs: null,
    idleReportedAt: null,
    ...extra,
});

// ── the report itself ────────────────────────────────────────────────────────

test('a client that cannot see OS input reports nothing, which is not zero', () => {
    // Every browser. Reading this as "0ms idle" would pin every web client permanently
    // active and silently switch the feature off for them.
    assert.equal(reportedIdleMs(peerWith(), NOW), null);
    assert.equal(reportedIdleMs(peerWith({ idleMs: 5000 }), NOW), null, 'no timestamp, no report');
    assert.equal(reportedIdleMs(peerWith({ idleReportedAt: NOW }), NOW), null, 'no value, no report');
    assert.equal(reportedIdleMs(null, NOW), null);
});

test('the time since a report arrived was also idle, and is added', () => {
    // A report of two minutes that landed thirty seconds ago describes somebody who has
    // now been idle for two and a half.
    const peer = peerWith({ idleMs: 120_000, idleReportedAt: NOW - 30_000 });
    assert.equal(reportedIdleMs(peer, NOW), 150_000);
});

test('a client that stopped reporting goes stale rather than sticking', () => {
    // The failure this prevents: a crashed or hostile client whose last word was "active"
    // keeping its owner exempt forever. Believing a stale figure is the one way a
    // self-reported signal is worse than no signal at all.
    const fresh = peerWith({ idleMs: 0, idleReportedAt: NOW - (REPORT_TTL_MS - 1000) });
    assert.notEqual(reportedIdleMs(fresh, NOW), null);

    const stale = peerWith({ idleMs: 0, idleReportedAt: NOW - (REPORT_TTL_MS + 1000) });
    assert.equal(reportedIdleMs(stale, NOW), null, 'falls back to the older signal');
});

test('a report from the future is refused rather than trusted', () => {
    // Clocks disagree, and a negative age would otherwise subtract from the idle time.
    const peer = peerWith({ idleMs: 0, idleReportedAt: NOW + 60_000 });
    assert.equal(reportedIdleMs(peer, NOW), null);
});

// ── combining the two signals ────────────────────────────────────────────────

test('with no idle report, activity is exactly what it always was', () => {
    const spoke = NOW - 300_000;
    assert.equal(activeSince({ peer: peerWith(), spoke, now: NOW }), spoke);
});

test('touching the machine counts even while saying nothing', () => {
    // The whole point of the change. Silent for ten minutes, mouse moved a second ago.
    const peer = peerWith({ idleMs: 1000, idleReportedAt: NOW });
    const spoke = NOW - 600_000;
    assert.equal(activeSince({ peer, spoke, now: NOW }), NOW - 1000);
});

test('speaking counts even while not touching the machine', () => {
    // The reverse, and the reason the two are combined rather than chosen between: a
    // person talking with their hands off the keyboard is present. Taking the earlier
    // signal would move whichever half happened to be quiet.
    const peer = peerWith({ idleMs: 600_000, idleReportedAt: NOW });
    const spoke = NOW - 1000;
    assert.equal(activeSince({ peer, spoke, now: NOW }), spoke);
});

test('idle on both counts is idle', () => {
    const peer = peerWith({ idleMs: 600_000, idleReportedAt: NOW });
    const spoke = NOW - 900_000;
    const since = activeSince({ peer, spoke, now: NOW });
    assert.equal(since, NOW - 600_000);
    assert.ok(NOW - since >= 600_000, 'ten minutes idle by the more generous of the two');
});

// ── exemptions ───────────────────────────────────────────────────────────────

test('somebody presenting is never moved', () => {
    for (const slot of ['screen', 'webcam']) {
        const peer = peerWith({ producers: new Map([[slot, {}]]) });
        assert.equal(exemptionFor(peer, { optedOut: new Set(), slots: SLOTS, now: NOW }), 'sharing');
    }
});

test('no microphone exempts you only while silence is all we have', () => {
    const optedOut = new Set();
    const noMic = peerWith({ producers: new Map() });

    // Nothing to measure: leaving them alone beats punishing a broken microphone.
    assert.equal(exemptionFor(noMic, { optedOut, slots: SLOTS, now: NOW }), 'no microphone');

    // But their keyboard is observable, so there IS something to measure. Keeping the
    // exemption would mean the better signal made the feature apply to fewer people.
    const noMicButReporting = peerWith({
        producers: new Map(), idleMs: 0, idleReportedAt: NOW,
    });
    assert.equal(exemptionFor(noMicButReporting, { optedOut, slots: SLOTS, now: NOW }), null);
});

test('an opt-out is per account and outranks the timer', () => {
    const peer = peerWith();
    assert.equal(exemptionFor(peer, { optedOut: new Set(['u1']), slots: SLOTS, now: NOW }), 'opted out');
    assert.equal(exemptionFor(peer, { optedOut: new Set(['someone-else']), slots: SLOTS, now: NOW }), null);
});
