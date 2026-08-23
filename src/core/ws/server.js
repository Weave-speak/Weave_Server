// The signalling WebSocket.
//
// Connections start UNAUTHENTICATED. A socket may send exactly one thing before it has
// a session — `hello` — and everything else is refused until it does. The previous
// server let an unauthenticated socket send any message and simply returned silence,
// which is indistinguishable from a bug when you are the one debugging it.
//
// Every connection carries a correlation id from the moment it opens. The client shows
// it in the connection panel, and both sides stamp it on every log line, so "it broke
// last night" becomes one grep.

import { WebSocketServer } from 'ws';
import { newCorrelationId } from '../log/index.js';

/** Client-initiated heartbeat interval, and how long we tolerate silence. */
const HEARTBEAT_TIMEOUT_MS = 70_000;
const SWEEP_INTERVAL_MS = 20_000;

/** Deliberate leave, so the server can announce immediately rather than waiting out the grace window. */
export const LEAVE_CLOSE_CODE = 4000;

/** Per-socket message budget. The old server had no WS rate limiting whatsoever. */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 300;

export function createWsServer({ registry, log, config, onDisconnect }) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
    const sockets = new Set();

    function send(ws, type, payload = {}) {
        if (ws.readyState !== ws.OPEN) return false;
        ws.send(JSON.stringify({ type, ...payload }));
        return true;
    }

    function fail(ws, code, message, detail) {
        send(ws, 'error', { code, message, ...(detail ? { detail } : {}) });
    }

    /** Send to every socket for which `predicate` holds. */
    function broadcast(type, payload, predicate = () => true) {
        let sent = 0;
        for (const ws of sockets) {
            if (ws.readyState === ws.OPEN && predicate(ws)) {
                ws.send(JSON.stringify({ type, ...payload }));
                sent += 1;
            }
        }
        return sent;
    }

    wss.on('connection', (ws, req) => {
        ws.cid = newCorrelationId();
        ws.session = null;
        ws.lastSeen = Date.now();
        ws.rate = { count: 0, since: Date.now() };
        ws.log = log.child({ cid: ws.cid });
        sockets.add(ws);

        ws.log.info({ evt: 'ws.open' }, 'WebSocket opened');
        // Sent before anything else so a client can show the id even if the join fails.
        send(ws, 'hello', { cid: ws.cid, instance: config.instanceName });

        ws.on('message', async (raw) => {
            ws.lastSeen = Date.now();

            // Rate limit before parsing: a flood must not cost us JSON.parse per message.
            const now = Date.now();
            if (now - ws.rate.since > RATE_WINDOW_MS) ws.rate = { count: 0, since: now };
            ws.rate.count += 1;
            if (ws.rate.count > RATE_MAX_MESSAGES) {
                ws.log.warn({ evt: 'ws.rate_limited', count: ws.rate.count }, 'Socket exceeded its message budget');
                fail(ws, 'rate_limited', 'Too many messages. Slow down.');
                ws.close(1008, 'rate limited');
                return;
            }

            let msg;
            try {
                msg = JSON.parse(raw);
            } catch {
                fail(ws, 'bad_json', 'Message was not valid JSON.');
                return;
            }
            if (typeof msg?.type !== 'string') {
                fail(ws, 'bad_message', 'Message needs a "type".');
                return;
            }

            const entry = registry.get(msg.type);
            if (!entry) {
                // An explicit refusal, not silence. If a module is disabled, this is
                // exactly how the client finds out its feature is unavailable.
                fail(ws, 'unknown_type', `This server does not handle "${msg.type}".`, {
                    hint: 'The feature may be disabled on this server.',
                });
                return;
            }

            if (entry.auth !== 'none' && !ws.session) {
                fail(ws, 'unauthenticated', 'Join before sending this.');
                return;
            }
            if (entry.auth === 'admin' && !ws.session?.isAdmin) {
                fail(ws, 'forbidden', 'This action requires an administrator account.');
                return;
            }

            try {
                await entry.handler({ ws, msg, send: (t, p) => send(ws, t, p), fail, broadcast, log: ws.log });
            } catch (err) {
                ws.log.error({ evt: 'ws.handler_failed', type: msg.type, module: entry.owner, err },
                    `Handler for "${msg.type}" threw`);
                fail(ws, 'internal_error', 'Something went wrong handling that.');
            }
        });

        ws.on('close', (code) => {
            sockets.delete(ws);
            ws.log.info({ evt: 'ws.close', code, deliberate: code === LEAVE_CLOSE_CODE },
                `WebSocket closed (${code})`);
            try {
                onDisconnect?.(ws, code);
            } catch (err) {
                ws.log.error({ evt: 'ws.disconnect_handler_failed', err },
                    'Disconnect handling threw; the socket is gone either way');
            }
        });

        ws.on('error', (err) => {
            ws.log.warn({ evt: 'ws.error', err }, 'WebSocket error');
        });
    });

    // Browsers never surface protocol ping/pong to JS, so the client sends its own
    // heartbeat and this sweeps sockets that have gone quiet. A half-open connection
    // through a tunnel looks identical to a healthy one until you check.
    const sweep = setInterval(() => {
        const cutoff = Date.now() - HEARTBEAT_TIMEOUT_MS;
        for (const ws of sockets) {
            if (ws.lastSeen < cutoff) {
                ws.log.info({ evt: 'ws.stale' }, 'No traffic within the heartbeat window; closing');
                ws.terminate();
                sockets.delete(ws);
            }
        }
    }, SWEEP_INTERVAL_MS);
    sweep.unref();

    return {
        handleUpgrade(req, socket, head) {
            wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
        },
        send,
        broadcast,
        get count() { return sockets.size; },
        sockets,
        async close() {
            clearInterval(sweep);
            for (const ws of sockets) ws.close(1001, 'server shutting down');
            await new Promise((resolve) => wss.close(resolve));
        },
    };
}
