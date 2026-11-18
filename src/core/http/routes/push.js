// Push subscription routes: a signed-in app telling the server where its device can be
// reached while the app is not running.
//
// Always the CURRENT session's subscription. There is no route that names another
// session's, or lists them: a device registers itself, and it stops being reachable by
// signing out (the row cascades with the session) or by deleting its own.

import { HttpError } from '../server.js';
import { PushError } from '../../push/index.js';

export function registerPushRoutes({ router, push, log }) {
    // `push.webpush` is a core feature, so the routes always exist. If push could not start
    // (its key could not be read or made), they say so plainly instead of vanishing behind
    // a 404 the client would read as an older server.
    const live = () => {
        if (!push) throw new HttpError(503, 'Push is unavailable on this server right now.');
        return push;
    };

    /**
     * Push is for the app. The admin console's cookie session has no device to ring, and
     * a subscription made from it would ring whoever happened to be using that browser.
     */
    const clientSession = (session) => {
        if (session.kind !== 'client') throw new HttpError(403, 'Push is for the Weave app, not the admin console.');
        return session;
    };

    // The application server key a device must subscribe with. Public by nature — it is
    // the half that lets a push service check our signature — but behind sign-in anyway,
    // since nobody without an account has anything to subscribe to.
    router.register('core', 'GET', '/api/push/key', ({ json }) => {
        json(200, { publicKey: live().publicKey });
    });

    router.register('core', 'PUT', '/api/push/subscription', ({ session, body, json }) => {
        clientSession(session);
        let result;
        try {
            result = live().subscribe(session, body);
        } catch (err) {
            if (err instanceof PushError) throw new HttpError(400, err.message);
            throw err;
        }
        if (result.changed) {
            log.info({ evt: 'push.subscribed', user: session.username }, `${session.username} registered a device for push`);
        }
        json(200, { ok: true });
    }, { maxBytes: 4_000 });

    router.register('core', 'DELETE', '/api/push/subscription', ({ session, json }) => {
        clientSession(session);
        const removed = live().unsubscribe(session);
        if (removed) {
            log.info({ evt: 'push.unsubscribed', user: session.username }, `${session.username} removed a device from push`);
        }
        json(200, { ok: true, removed });
    });
}
