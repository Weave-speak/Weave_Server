// Automatic move to an away channel after a stretch of silence.
//
// The signal is server-measured. mediasoup's AudioLevelObserver reads real per-packet
// audio levels off the RTP stream, so nothing here depends on a client reporting
// honestly about itself, and muting needs no special case — muting genuinely pauses the
// producer, no RTP flows, and that reads as silence exactly as it should.
//
// Two exemptions matter more than the timer does:
//
//   Anyone sharing a screen or camera is never moved. A person presenting to the group
//   is the least idle participant in the room, and they are precisely the one who will
//   not be talking.
//
//   Anyone with no microphone at all is never moved. There is nothing to measure, and
//   moving them would punish having no working mic rather than being away.
//
// This is mic silence, not general inactivity. Discord and TeamSpeak both key their
// equivalents off keyboard and mouse idleness, which a browser cannot see. When the
// native client lands it can report OS idle time and this module should prefer that;
// the exemptions above are what make the weaker signal tolerable until then.

import { HOOKS } from '../../core/hooks/index.js';
import { SLOTS } from '../../core/peers/index.js';

const SWEEP_INTERVAL_MS = 60_000;

export function register(ctx) {
    ctx.db.migrate();
    const db = ctx.db.handle;

    ctx.settings.define('idleMinutes', {
        type: 'number', integer: true, min: 1, max: 1440,
        label: 'Move after (minutes of silence)',
        help: 'How long a microphone must be quiet before its owner is moved to the away channel.',
    }, 20);

    ctx.settings.define('enabled', {
        type: 'boolean',
        label: 'Move idle people automatically',
        help: 'Turn off to keep the away channel but never move anyone into it.',
    }, true);

    // cid -> last moment we saw evidence of life.
    const lastActive = new Map();
    const stamp = (cid) => { if (cid) lastActive.set(cid, Date.now()); };

    ctx.hooks.on(HOOKS.MIC_ACTIVITY, ({ cid }) => stamp(cid));
    ctx.hooks.on(HOOKS.PEER_JOIN, ({ peer }) => stamp(peer.cid));
    // Choosing a channel is a deliberate act, so it counts as activity. Without this,
    // someone who joins and immediately moves somewhere quiet starts already half-idle.
    ctx.hooks.on(HOOKS.PEER_MOVE, ({ peer }) => stamp(peer.cid));
    ctx.hooks.on(HOOKS.PEER_LEAVE, ({ peer }) => lastActive.delete(peer.cid));

    // Per-account, stored server-side. The previous version trusted a flag the client
    // sent on every join, which meant the exemption lived on one device and quietly
    // stopped applying anywhere else.
    const optedOut = new Set(
        db.prepare('SELECT user_id FROM afk_optouts').all().map((r) => r.user_id),
    );

    const isExempt = (peer) => {
        if (peer.producers.has(SLOTS.SCREEN) || peer.producers.has(SLOTS.WEBCAM)) return 'sharing';
        if (!peer.producers.has(SLOTS.AUDIO)) return 'no microphone';
        if (optedOut.has(peer.userId)) return 'opted out';
        return null;
    };

    ctx.http.route('GET', '/api/afk/opt-out', ({ session, json }) => {
        json(200, { optedOut: optedOut.has(session.userId) });
    });

    ctx.http.route('POST', '/api/afk/opt-out', ({ body, session, json }) => {
        const want = body?.optedOut === true;
        if (want) {
            db.prepare('INSERT OR IGNORE INTO afk_optouts (user_id) VALUES (?)').run(session.userId);
            optedOut.add(session.userId);
        } else {
            db.prepare('DELETE FROM afk_optouts WHERE user_id = ?').run(session.userId);
            optedOut.delete(session.userId);
        }
        json(200, { optedOut: want });
    }, { maxBytes: 1_000 });

    /** The channel to move people into: the first one marked as an away channel. */
    const awayChannel = () => ctx.actions.listChannels().find((c) => c.kind === 'afk') ?? null;

    const sweep = () => {
        if (!ctx.settings.get('enabled')) return;

        const away = awayChannel();
        if (!away) {
            // Nowhere to move people to. Say so once per sweep rather than failing quietly.
            ctx.log.debug({ evt: 'afk.no_channel' },
                'No channel is marked as an away channel, so nobody can be moved');
            return;
        }

        const threshold = ctx.settings.get('idleMinutes') * 60_000;
        const now = Date.now();

        for (const channel of ctx.actions.listChannels()) {
            if (channel.id === away.id) continue;

            for (const peer of ctx.peers.inChannel(channel.id)) {
                const exempt = isExempt(peer);
                if (exempt) continue;

                const since = lastActive.get(peer.cid) ?? peer.joinedAt;
                if (now - since < threshold) continue;

                ctx.log.info(
                    { evt: 'afk.moved', user: peer.username, idleMs: now - since },
                    `Moving ${peer.username} to ${away.name} after ${Math.round((now - since) / 60000)} minutes of silence`,
                );
                ctx.actions.movePeer(peer.cid, away.id, 'afk_timeout');
                stamp(peer.cid);
            }
        }
    };

    const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    timer.unref();
    ctx.onUnload(() => clearInterval(timer));

    ctx.admin.panel({ id: 'afk', label: 'Away handling', order: 40 });
}
