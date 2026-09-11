// Naming a device from its user agent.
//
// This is the whole basis on which somebody decides a row in their session list is a
// device they do not recognise and signs it out. Getting it wrong does not produce an
// error; it produces somebody signing out their own phone, or leaving a stranger's laptop
// signed in because it was labelled the same as their desktop.

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeDevice } from '../src/core/auth/devices.js';

const ELECTRON = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'weave-client/0.1.61 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/130.0.0.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const EDGE_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    + 'Version/18.0 Mobile/15E148 Safari/604.1';

test('the desktop app is told apart from the browser it is built on', () => {
    // Electron IS Chromium, so without this the app and somebody's actual Chrome would sit
    // in the list under the same name — the two rows most worth telling apart.
    assert.equal(describeDevice(ELECTRON), 'Weave desktop on Windows');
    assert.equal(describeDevice(CHROME_MAC), 'Chrome on macOS');
});

test('browsers that claim to be other browsers are read in the right order', () => {
    // Edge says Chrome, Chrome says Safari, and Safari says Gecko. Every one of these
    // strings matches more than one pattern.
    assert.equal(describeDevice(EDGE_WINDOWS), 'Edge on Windows');
    assert.equal(describeDevice(SAFARI_IOS), 'Safari on iOS');
    assert.equal(describeDevice(FIREFOX_LINUX), 'Firefox on Linux');
});

test('the administration console names itself, whatever browser it is in', () => {
    // It is a cookie session in a browser, not a device somebody signed in on — and
    // labelling it "Chrome on Windows" alongside their actual Chrome would be a trap.
    assert.equal(describeDevice(CHROME_MAC, 'admin'), 'Admin console');
});

test('an unknown agent says so rather than guessing', () => {
    // Sessions from before user agents were recorded, and anything sending none. A wrong
    // name here means signing out the wrong device.
    assert.equal(describeDevice(null), 'Unknown device');
    assert.equal(describeDevice(''), 'Unknown device');
    assert.equal(describeDevice('   '), 'Unknown device');
    assert.equal(describeDevice('curl/8.4.0'), 'Unknown device');
});

test('half an answer is better than none', () => {
    assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0)'), 'Windows');
    assert.equal(describeDevice('Firefox/131.0'), 'Firefox');
});
