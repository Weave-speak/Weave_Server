// Slash commands.
//
// Deliberately its own message type rather than something that inspects chat messages on
// their way past. The previous server detected commands inside the text-message handler
// and substituted the result before storing it, which meant commands only worked where
// chat worked, and that a command result was indistinguishable from someone typing the
// same text by hand.
//
// Here a command is a separate request with a separate result, so it works on a
// voice-only server, clients can render results differently from ordinary messages, and
// turning chat off does not take dice with it.

import crypto from 'node:crypto';

/** Guards against a request that would produce an absurd number and no useful outcome. */
const ROLL_MAX = 1_000_000_000;

const COMMANDS = new Map();

/**
 * Randomness from crypto, not Math.random.
 *
 * Nothing here is security-critical, but a dice roll people argue over should not be
 * drawn from a predictable sequence, and randomInt costs nothing.
 */
COMMANDS.set('roll', {
    usage: '/roll [sides]',
    describe: 'Roll a die. Defaults to 100.',
    run(args) {
        if (args.length > 1) {
            return { error: 'Usage: /roll [sides] — for example /roll 20' };
        }

        const raw = args[0] ?? '100';
        const sides = Number(raw);

        if (!Number.isInteger(sides) || sides < 1) {
            return { error: `"${raw}" is not a whole number of sides.` };
        }
        if (sides > ROLL_MAX) {
            return { error: `That is more sides than a die can have. The most is ${ROLL_MAX.toLocaleString()}.` };
        }

        const value = crypto.randomInt(1, sides + 1);
        return { text: `rolled ${value} (1–${sides})`, data: { value, sides } };
    },
});

COMMANDS.set('flip', {
    usage: '/flip',
    describe: 'Flip a coin.',
    run(args) {
        if (args.length) return { error: 'Usage: /flip' };
        const heads = crypto.randomInt(0, 2) === 0;
        return { text: `flipped ${heads ? 'heads' : 'tails'}`, data: { heads } };
    },
});

export function register(ctx) {
    ctx.settings.define('enabled', {
        type: 'boolean',
        label: 'Allow slash commands',
        help: 'Turn off to disable /roll and /flip without removing the module.',
    }, true);

    ctx.http.route('GET', '/api/commands', ({ json }) => {
        json(200, {
            commands: [...COMMANDS.entries()].map(([name, c]) => ({
                name, usage: c.usage, describe: c.describe,
            })),
        });
    });

    ctx.ws.on('run', ({ ws, msg, send, fail, broadcast }) => {
        if (!ctx.settings.get('enabled')) {
            return fail(ws, 'disabled', 'Slash commands are turned off on this server.');
        }

        const peer = ctx.peers.get(ws.cid);
        if (!peer) return fail(ws, 'not_joined', 'Join a channel first.');

        const name = String(msg.command ?? '').trim().toLowerCase().replace(/^\//, '');
        const command = COMMANDS.get(name);
        if (!command) {
            return fail(ws, 'unknown_command', `There is no /${name} command.`, {
                available: [...COMMANDS.keys()],
            });
        }

        const args = Array.isArray(msg.args) ? msg.args.map(String).slice(0, 4) : [];
        const result = command.run(args);

        if (result.error) {
            // Only the person who typed it sees a usage error. Broadcasting someone's
            // typo to the whole channel is noise.
            return fail(ws, 'bad_usage', result.error);
        }

        broadcast('result', {
            command: name,
            by: { cid: peer.cid, username: peer.username, displayName: peer.displayName },
            text: result.text,
            data: result.data,
            at: Date.now(),
        }, (sock) => {
            const other = ctx.peers.get(sock.cid);
            return other && other.channelId === peer.channelId;
        });
    });
}
