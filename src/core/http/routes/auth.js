// Authentication routes.
//
// Rate limiting is in memory, keyed by BOTH the username and the client address, and
// either being over the limit blocks. Keying on one alone is a hole in each direction:
// by IP only, an attacker rotating addresses walks straight through; by username only,
// they enumerate accounts freely and can lock a known user out at will.
//
// The previous server persisted every failed attempt to SQLite with no index and no
// pruning, and a pen-test run grew the database to hundreds of thousands of rows. In
// memory is the right store for something this ephemeral.

import crypto from 'node:crypto';
import { hash as argonHash } from '@node-rs/argon2';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { HttpError } from '../server.js';
import {
    createUser, verifyPassword, verifyRecovery, setPassword, setSecurityQuestion,
    UserError, getUserById, touchLastSeen, normalise,
    validateUsername, validateDisplayName, validatePassword, validateRecovery,
    validateQuestionId, validateSecurityAnswer, recoveryQuestionFor, securityQuestionOf,
} from '../../users/index.js';
import { SECURITY_QUESTIONS, normaliseAnswer } from '../../auth/questions.js';
import { checkInvite, redeemInvite, InviteError } from '../../invites/index.js';
import { revokeAllForUser } from '../../auth/index.js';
import { audit as writeAudit } from '../../admin/audit.js';
import { describeDevice } from '../../auth/devices.js';
import { SESSION_REVOKED_CLOSE_CODE } from '../../ws/handlers/core.js';

const WINDOW_SEC = 15 * 60;

// Forced-reset tickets: proof that the old password was just presented, good for one
// complete-reset call within ten minutes. In memory on purpose — a restart voids them
// and the user simply signs in again.
const resetTickets = new Map();

const limiters = {
    login: new RateLimiterMemory({ points: 10, duration: WINDOW_SEC }),
    register: new RateLimiterMemory({ points: 10, duration: WINDOW_SEC }),
    recover: new RateLimiterMemory({ points: 5, duration: WINDOW_SEC }),
    // Guessing the current password from INSIDE a session is a real attack — a borrowed
    // laptop, an unlocked screen — and the one guess the login limiter never sees, because
    // the attacker never touches the login form.
    changePassword: new RateLimiterMemory({ points: 5, duration: WINDOW_SEC }),
    setup: new RateLimiterMemory({ points: 10, duration: WINDOW_SEC }),
};

/** Check every key without consuming. Consumption happens only on failure. */
async function assertNotThrottled(limiter, keys) {
    for (const key of keys.filter(Boolean)) {
        const state = await limiter.get(key);
        if (state && state.consumedPoints >= limiter.points) {
            const mins = Math.ceil(state.msBeforeNext / 60000);
            throw new HttpError(429, `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
        }
    }
}

async function penalise(limiter, keys) {
    await Promise.all(keys.filter(Boolean).map((k) => limiter.consume(k).catch(() => {})));
}

/** Never distinguish "no such account" from "wrong password" to the caller. */
const BAD_CREDENTIALS = 'Username or password is not correct.';

export function registerAuthRoutes({ router, db, log, auth, setup, settings, peers }) {
    const publicUser = (user, token) => ({
        token,
        user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            avatar: user.avatar,
            // Carried from the first response so the client paints the right dot on the
            // very first frame, rather than showing everybody as online for the half
            // second before /api/me lands.
            status: user.status ?? 'online',
            isAdmin: user.isAdmin,
            // Whether this account sees the stream-quality reporting controls. Carried on
            // the first response so the room can decide about them on the first paint,
            // rather than briefly showing or hiding them until /api/me lands.
            isTester: user.isTester,
        },
    });

    // ── First-run setup ──────────────────────────────────────────────────────
    // Exists only while there is no administrator. Once one exists this returns 410,
    // so the window cannot be reopened by anyone who kept the URL.
    router.register('core', 'POST', '/api/setup', async ({ req, body, ip, json }) => {
        if (!setup.required) {
            throw new HttpError(410, 'Setup has already been completed on this server.');
        }
        await assertNotThrottled(limiters.setup, [ip]);

        const verdict = setup.verify(body?.code);
        if (!verdict.ok) {
            await penalise(limiters.setup, [ip]);
            log.warn({ evt: 'setup.bad_code', ip }, 'Rejected setup code');
            throw new HttpError(401, verdict.reason);
        }

        let user;
        try {
            user = await createUser(db, {
                username: body?.username,
                displayName: body?.displayName || body?.username,
                password: body?.password,
                recoveryPhrase: body?.recoveryPhrase,
                securityQuestion: body?.securityQuestion,
                securityAnswer: body?.securityAnswer,
                isAdmin: true,
            });
        } catch (err) {
            if (err instanceof UserError) throw new HttpError(400, err.message, { field: err.field });
            throw err;
        }

        setup.clear();
        log.info({ evt: 'setup.completed', user: user.username },
            `First administrator created: ${user.username}`);
        db.prepare('INSERT INTO audit_log (actor_id, action, target) VALUES (?, ?, ?)')
            .run(user.id, 'SETUP_COMPLETED', user.username);

        json(201, publicUser(user, auth.issue(user.id, 'client', req.headers['user-agent'])));
    }, { auth: 'none', maxBytes: 8_000 });

    // ── Register ─────────────────────────────────────────────────────────────
    router.register('core', 'POST', '/api/auth/register', async ({ req, body, ip, json }) => {
        await assertNotThrottled(limiters.register, [ip]);

        const invite = checkInvite(db, body?.inviteCode);
        if (!invite.ok) {
            await penalise(limiters.register, [ip]);
            throw new HttpError(403, invite.reason);
        }

        let user;
        try {
            // Two phases, because argon2 is async and better-sqlite3 transactions are
            // synchronous: hash and validate first, then let the claim run purely
            // synchronous work. Redemption and creation are still one transaction, so
            // two people racing the last use of a code cannot both get an account.
            const insertUser = await createUserPrepared(db, body);
            user = redeemInvite(db, body.inviteCode, insertUser);
        } catch (err) {
            if (err instanceof UserError) throw new HttpError(400, err.message, { field: err.field });
            if (err instanceof InviteError) throw new HttpError(403, err.message);
            throw err;
        }

        log.info({ evt: 'auth.registered', user: user.username }, `New account: ${user.username}`);
        json(201, publicUser(user, auth.issue(user.id, 'client', req.headers['user-agent'])));
    }, { auth: 'none', maxBytes: 8_000 });

    // ── Login ────────────────────────────────────────────────────────────────
    router.register('core', 'POST', '/api/auth/login', async ({ body, req, ip, json }) => {
        const username = String(body?.username ?? '').trim().toLowerCase();
        await assertNotThrottled(limiters.login, [ip, username && `u:${username}`]);

        const user = await verifyPassword(db, username, body?.password);
        if (!user) {
            await penalise(limiters.login, [ip, username && `u:${username}`]);
            log.info({ evt: 'auth.login_failed', ip }, 'Failed login');
            throw new HttpError(401, BAD_CREDENTIALS);
        }

        touchLastSeen(db, user.id);

        // An admin forced a reset: the old password just PROVED the account, but no
        // session is issued until its owner chooses a new password. The ticket is the
        // proof carried into that one next step — short-lived, single-use, in memory.
        if (db.prepare('SELECT must_reset FROM users WHERE id = ?').get(user.id)?.must_reset === 1) {
            const ticket = crypto.randomBytes(24).toString('base64url');
            resetTickets.set(ticket, { userId: user.id, expires: Date.now() + 10 * 60_000 });
            log.info({ evt: 'auth.reset_required', user: user.username },
                `${user.username} signed in against a forced reset`);
            return json(200, { resetRequired: true, ticket, username: user.username });
        }

        const wantsAdminCookie = body?.forAdminPanel === true;
        const token = auth.issue(user.id, wantsAdminCookie ? 'admin' : 'client', req.headers['user-agent']);

        log.info({ evt: 'auth.login', user: user.username }, `${user.username} signed in`);

        if (wantsAdminCookie) {
            if (!user.isAdmin) throw new HttpError(403, 'This account is not an administrator.');
            // HttpOnly cookie for the browser panel. The token is deliberately NOT in the
            // response body: script on the page must not be able to read it, which is the
            // whole reason the admin panel uses a cookie rather than a bearer token.
            json(200, { user: publicUser(user).user }, { 'Set-Cookie': auth.cookieFor(token) });
            return;
        }
        json(200, publicUser(user, token));
    }, { auth: 'none', maxBytes: 4_000 });

    router.register('core', 'POST', '/api/auth/complete-reset', async ({ body, req, json }) => {
        const held = resetTickets.get(String(body?.ticket ?? ''));
        if (!held || held.expires < Date.now()) {
            throw new HttpError(401, 'That reset window has closed. Sign in again.');
        }
        resetTickets.delete(body.ticket);

        try {
            await setPassword(db, held.userId, body?.password);
        } catch (err) {
            if (err instanceof UserError) throw new HttpError(400, err.message, { field: err.field });
            throw err;
        }
        db.prepare('UPDATE users SET must_reset = 0 WHERE id = ?').run(held.userId);

        const user = getUserById(db, held.userId);
        const token = auth.issue(user.id, 'client', req.headers['user-agent']);
        log.info({ evt: 'auth.reset_completed', user: user.username },
            `${user.username} chose a new password after a forced reset`);
        json(200, publicUser(user, token));
    }, { auth: 'none', maxBytes: 4_000 });

    // ── Recovery ─────────────────────────────────────────────────────────────
    // One step: prove the phrase and set the new password together. A separate
    // reset-token step adds a state machine without adding security here, because the
    // phrase is the only factor either way.
    router.register('core', 'POST', '/api/auth/recover', async ({ req, body, ip, json }) => {
        const username = String(body?.username ?? '').trim().toLowerCase();
        await assertNotThrottled(limiters.recover, [ip, username && `u:${username}`]);

        // `answer` for a question-based account, `recoveryPhrase` for a legacy one.
        const secret = body?.answer ?? body?.recoveryPhrase;
        const user = await verifyRecovery(db, username, secret, body?.questionId ?? null);
        if (!user) {
            await penalise(limiters.recover, [ip, username && `u:${username}`]);
            log.info({ evt: 'auth.recover_failed', ip }, 'Failed recovery attempt');
            // Deliberately does not say which half was wrong, and reads the same whether
            // or not the account exists.
            throw new HttpError(401, 'That answer is not correct.');
        }

        try {
            await setPassword(db, user.id, body?.newPassword);
        } catch (err) {
            if (err instanceof UserError) throw new HttpError(400, err.message, { field: err.field });
            throw err;
        }

        // Anyone already signed in as this account is signed out: if the password needed
        // recovering, existing sessions are exactly what you want gone.
        const revoked = revokeAllForUser(db, user.id);
        log.warn({ evt: 'auth.recovered', user: user.username, revoked },
            `${user.username} recovered their account; ${revoked} session(s) revoked`);

        json(200, publicUser(user, auth.issue(user.id, 'client', req.headers['user-agent'])));
    }, { auth: 'none', maxBytes: 4_000 });

    // ── Security questions ───────────────────────────────────────────────────
    // Unauthenticated: the sign-up form needs this before an account exists.
    router.register('core', 'GET', '/api/auth/questions', ({ json }) => {
        json(200, { questions: SECURITY_QUESTIONS });
    }, { auth: 'none' });

    /**
     * Step one of a password reset: which question does this account use?
     *
     * ALWAYS answers, even for a username with no account. Returning an error for unknown
     * names would turn this into a membership directory for an invite-only server — the
     * exact thing invite-only registration exists to prevent. An unknown name gets a
     * question derived from the name itself, so it is stable across attempts and the
     * answer simply never matches.
     */
    router.register('core', 'POST', '/api/auth/recovery-question', async ({ body, ip, json }) => {
        const username = String(body?.username ?? '').trim().toLowerCase();
        await assertNotThrottled(limiters.recover, [ip]);

        if (!username) throw new HttpError(400, 'Enter your username.');

        const salt = settings.get('core.recoverySalt') ?? 'weave';
        const question = recoveryQuestionFor(db, username, salt);

        json(200, { question });
    }, { auth: 'none', maxBytes: 1_000 });

    // ── Logout ───────────────────────────────────────────────────────────────
    router.register('core', 'POST', '/api/auth/logout', ({ req, session, json }) => {
        const header = req.headers.authorization ?? '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
        if (bearer) auth.revoke(bearer);

        log.info({ evt: 'auth.logout', user: session.username }, `${session.username} signed out`);
        json(200, { ok: true }, { 'Set-Cookie': auth.cookieFor('', { clear: true }) });
    });

    // ── Who am I ─────────────────────────────────────────────────────────────
    router.register('core', 'GET', '/api/me', ({ session, json }) => {
        const user = getUserById(db, session.userId);
        if (!user) throw new HttpError(401, 'This account no longer exists.');
        json(200, { user });
    });

    // ── Your own credentials ─────────────────────────────────────────────────
    //
    // The self-service half of what an administrator and the recovery flow could already
    // do. Until these existed, the only way to change your own password was to go to the
    // sign-in screen and claim you had forgotten it — which signs you out everywhere and
    // reads, in the log and to an administrator, as an account that got into trouble.

    router.register('core', 'POST', '/api/me/password', async ({ body, ip, session, json }) => {
        const keys = [ip, `u:${session.username}`];
        await assertNotThrottled(limiters.changePassword, keys);

        // Presenting the old password is what makes this different from recovery, where the
        // security answer is the proof. A session that happens to be open is not proof of
        // anything: the whole point of this screen is the moment somebody walks away from one.
        const current = String(body?.currentPassword ?? '');
        const verified = await verifyPassword(db, session.username, current);
        if (!verified) {
            await penalise(limiters.changePassword, keys);
            log.warn({ evt: 'auth.change_password_refused', user: session.username, ip },
                `${session.username} gave the wrong current password`);
            throw new HttpError(401, 'That password is not correct.', { field: 'currentPassword' });
        }

        // The one moment both are in hand, so it costs nothing to name a change that would
        // otherwise report success and change nothing at all.
        if (String(body?.newPassword ?? '') === current) {
            throw new HttpError(400, 'That is already your password.', { field: 'newPassword' });
        }

        try {
            await setPassword(db, session.userId, body?.newPassword);
        } catch (err) {
            if (err instanceof UserError) throw new HttpError(400, err.message, { field: err.field });
            throw err;
        }
        // An account an administrator had flagged has now done the one thing the flag was
        // waiting for, so it stops standing between them and their next sign-in.
        db.prepare('UPDATE users SET must_reset = 0 WHERE id = ?').run(session.userId);

        // Whoever knew the old password is signed out — usually the entire reason somebody
        // changes it — and the device asking is not, which would otherwise mean signing
        // yourself out for your own good housekeeping. The client names its own connection
        // rather than the server guessing which socket belongs to an HTTP request.
        const revoked = auth.revokeOthers(session.userId, session.tokenHash);
        const closed = peers?.closeForUser?.(session.userId, {
            exceptCid: typeof body?.cid === 'string' ? body.cid : null,
            code: SESSION_REVOKED_CLOSE_CODE,
            reason: 'password changed',
        }) ?? 0;

        writeAudit(db, {
            actorId: session.userId, action: 'SELF_PASSWORD_CHANGE', target: session.username,
        });
        log.warn({ evt: 'auth.password_changed', user: session.username, revoked, closed },
            `${session.username} changed their own password; ${revoked} other session(s) revoked`);

        json(200, { ok: true, sessionsRevoked: revoked, disconnected: closed });
    }, { maxBytes: 4_000 });

    router.register('core', 'POST', '/api/me/security-question', async ({ body, session, json }) => {
        // A bearer token, not the administration console's cookie. This route replaces the
        // answer that can RESET the password, and it does so without asking for a password —
        // so it is the one route where a cookie riding along on a request somebody did not
        // mean to make would be worth having.
        if (session.kind !== 'client') {
            throw new HttpError(403, 'Change your security question from the Weave app.');
        }

        try {
            await setSecurityQuestion(db, session.userId, body?.questionId, body?.answer);
        } catch (err) {
            if (err instanceof UserError) throw new HttpError(400, err.message, { field: err.field });
            throw err;
        }

        // Sessions are deliberately left alone. No password changed, and signing somebody's
        // other devices out for choosing a better question would punish exactly the
        // housekeeping this screen exists to encourage.
        writeAudit(db, {
            actorId: session.userId, action: 'SELF_RECOVERY_CHANGE', target: session.username,
        });
        log.warn({ evt: 'auth.security_question_changed', user: session.username },
            `${session.username} changed their security question`);

        json(200, { ok: true, question: securityQuestionOf(db, session.userId) });
    }, { maxBytes: 4_000 });

    // Which question this account uses, answered truthfully because it is answering to the
    // account itself. Null means one was never chosen — a legacy passphrase account, which
    // choosing a question converts.
    router.register('core', 'GET', '/api/me/security-question', ({ session, json }) => {
        json(200, { question: securityQuestionOf(db, session.userId) });
    });

    // ── Your own devices ─────────────────────────────────────────────────────
    //
    // Sessions have always been stored with enough detail to list; what was missing was a
    // way to name one. The table is keyed by the token's hash, which this server treats as
    // the secret it is a hash of, so until every row had an opaque id the only handle on a
    // session was the one thing that must never be served.

    router.register('core', 'GET', '/api/me/sessions', ({ session, json }) => {
        const sessions = auth.sessionsFor(session.userId).map((row) => ({
            id: row.id,
            // Which row is the one reading this. Everything on this screen is a decision
            // about a device, and the first thing anybody needs to know is which is theirs.
            current: row.id === session.sessionId,
            device: describeDevice(row.userAgent, row.kind),
            kind: row.kind,
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt,
        }));
        json(200, { sessions });
    });

    router.register('core', 'DELETE', '/api/me/sessions/:id', ({ params, session, json }) => {
        // Signing out the device you are holding, from a list, is not what anybody means by
        // it: the app would carry on looking signed in until its next request failed. Sign
        // out is a button of its own and does this properly.
        if (params.id === session.sessionId) {
            throw new HttpError(400, 'That is this device. Use Sign out instead.');
        }

        // The account is part of the lookup rather than something checked afterwards, so an
        // id belonging to somebody else simply matches nothing — the same answer as an id
        // that never existed, which is also what stops this being a way to discover whose
        // id it is.
        if (!auth.revokeById(session.userId, params.id)) {
            throw new HttpError(404, 'That session has already gone.');
        }

        // The token is dead, but a socket it is already holding would keep working until it
        // next reconnected. Signing a device out has to mean now.
        const closed = peers?.closeForUser?.(session.userId, {
            sessionId: params.id,
            code: SESSION_REVOKED_CLOSE_CODE,
            reason: 'session signed out',
        }) ?? 0;

        log.info({ evt: 'auth.session_revoked', user: session.username, closed },
            `${session.username} signed out one of their other devices`);

        json(200, { ok: true, disconnected: closed });
    });}

/**
 * Hash credentials up front and return a synchronous factory the invite transaction can
 * call.
 *
 * argon2 is async and better-sqlite3 transactions are synchronous, so hashing cannot
 * happen inside the claim — and it should not anyway: holding a write transaction open
 * for the duration of a key-derivation function would block every other writer.
 */
async function createUserPrepared(db, body) {
    const username = validateUsername(body?.username);
    const displayName = validateDisplayName(body?.displayName || username);
    validatePassword(body?.password);

    const lower = normalise(username);
    if (db.prepare('SELECT 1 FROM users WHERE username_lower = ?').get(lower)) {
        throw new UserError('That username is already taken.', 'username');
    }

    const passwordHash = await argonHash(body.password);

    // A chosen question with an answer, or a legacy passphrase. Same hashed column; the
    // question id records which.
    let recoveryHash = null;
    let questionId = null;
    if (body?.securityQuestion || body?.securityAnswer) {
        questionId = validateQuestionId(body.securityQuestion);
        recoveryHash = await argonHash(validateSecurityAnswer(body.securityAnswer));
    } else if (body?.recoveryPhrase) {
        recoveryHash = await argonHash(validateRecovery(body.recoveryPhrase));
    }

    const id = crypto.randomUUID();

    return () => {
        db.prepare(`
            INSERT INTO users (id, username, username_lower, display_name, password_hash,
                               recovery_hash, recovery_question, is_admin)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `).run(id, username, lower, displayName, passwordHash, recoveryHash, questionId);
        return getUserById(db, id);
    };
}
