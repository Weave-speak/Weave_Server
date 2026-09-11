// Turning a user-agent string into something a person would recognise.
//
// The list of your own devices only does its job if you can tell which row is the laptop
// you are worried about. "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36…"
// does not do that job, and neither does a truncated version of it.
//
// Deliberately coarse. Browser and operating system are what somebody actually uses to
// recognise a device; an exact Chrome build number is noise, and parsing user agents
// precisely is a famously losing game. Anything unrecognised says so plainly rather than
// guessing, because a wrong name on this screen means signing out the wrong device.

const SYSTEMS = [
    [/Windows NT/i, 'Windows'],
    [/iPhone|iPad|iPod/i, 'iOS'],
    [/Mac OS X|Macintosh/i, 'macOS'],
    [/Android/i, 'Android'],
    [/CrOS/i, 'ChromeOS'],
    [/Linux|X11/i, 'Linux'],
];

// Order matters: every one of these ships a user agent claiming to be several of the
// others. Edge says Chrome, Chrome says Safari, and Safari says Gecko.
const BROWSERS = [
    [/Edg\//i, 'Edge'],
    [/OPR\/|Opera/i, 'Opera'],
    [/Firefox\//i, 'Firefox'],
    [/Chrome\/|Chromium\//i, 'Chrome'],
    [/Safari\//i, 'Safari'],
];

const firstMatch = (table, value) => table.find(([pattern]) => pattern.test(value))?.[1] ?? null;

/**
 * A short phrase naming a device, from its user agent and the kind of session it is.
 *
 * @param {string|null} userAgent  as sent at sign-in, or null for a session from before
 *                                 these were recorded
 * @param {string}      kind       'client' (the app) or 'admin' (the console's cookie)
 */
export function describeDevice(userAgent, kind = 'client') {
    if (kind === 'admin') return 'Admin console';

    const ua = String(userAgent ?? '').trim();
    // Sessions issued before user agents were recorded, and anything that sent none.
    if (!ua) return 'Unknown device';

    const system = firstMatch(SYSTEMS, ua);

    // The desktop app is Chromium underneath, so it would otherwise be listed as "Chrome"
    // alongside somebody's actual browser — the two things on this screen most worth
    // telling apart.
    const browser = /Electron\//i.test(ua) ? 'Weave desktop' : firstMatch(BROWSERS, ua);

    if (browser && system) return `${browser} on ${system}`;
    return browser ?? system ?? 'Unknown device';
}
