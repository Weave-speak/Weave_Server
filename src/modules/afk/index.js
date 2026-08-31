// Automatic move to an away channel after a stretch of inactivity.
//
// Two signals, and the more truthful one wins.
//
//   OS IDLE TIME, when the client can see it. The desktop shell reads seconds since the
//   last keyboard or mouse input anywhere on that machine and reports it on the heartbeat.
//   This is what the module always wanted: it counts input to EVERY application, so
//   somebody writing code in another window is at their desk.
//
//   MICROPHONE SILENCE, otherwise. mediasoup's AudioLevelObserver reads real per-packet
//   levels off the RTP stream, so it depends on no client being honest about itself, and
//   muting needs no special case — muting genuinely pauses the producer, no RTP flows, and
//   that reads as silence exactly as it should.
//
// They are combined rather than chosen between: activity is the LATER of "last spoke" and
// "last touched the machine", because either is evidence of a person. A browser reports no
// idle time at all — it cannot see input to other windows and there is no approximation
// worth making — so it simply keeps the older behaviour.
//
// A client that stops reporting goes STALE rather than sticking. Trusting a last-known
// idle figure forever would let a crashed or hostile client pin somebody active
// permanently, which is the one way a self-reported signal can be worse than none.
//
// Three exemptions matter more than the timer does:
//
//   Anyone sharing a screen or camera is never moved. A person presenting to the group
//   is the least idle participant in the room, and they are precisely the one who will
//   not be talking.
//
//   Anyone with no microphone at all is never moved WHEN silence is all we have. With a
//   real idle signal there is something to measure, so the exemption stops applying —
//   otherwise every listener with a broken mic would be permanently exempt.
//
//   Anyone who has opted out, per account.
//
// What none of this can see is somebody watching a video in ANOTHER application. At the
// operating system's level that is identical to an empty chair. The one case Weave can
// answer it does: a client watching a stream inside Weave reports itself as active.

import { HOOKS } from '../../core/hooks/index.js';
import { SLOTS } from '../../core/peers/index.js';
import { reportedIdleMs, activeSince, exemptionFor } from './policy.js';

const SWEEP_INTERVAL_MS = 60_000;

export function register(ctx) {
    ctx.db.migrate();
    const db = ctx.db.handle;

    ctx.settings.define('idleMinutes', {
        type: 'number', integer: true, min: 1, max: 1440,
        label: 'Move after (minutes of inactivity)',
        help: 'How long somebody must be inactive before being moved to the away channel. '
            + 'The desktop app reports keyboard and mouse idleness; for browser clients this '
            + 'is measured as silence on their microphone instead.',
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

    const isExempt = (peer, now) => exemptionFor(peer, { optedOut, slots: SLOTS, now });

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
                const exempt = isExempt(peer, now);
                if (exempt) continue;

                const spoke = lastActive.get(peer.cid) ?? peer.joinedAt;
                const since = activeSince({ peer, spoke, now });
                if (now - since < threshold) continue;

                const touched = reportedIdleMs(peer, now);

                ctx.log.info(
                    {
                        evt: 'afk.moved', user: peer.username, idleMs: now - since,
                        signal: touched === null ? 'mic-silence' : 'os-idle',
                    },
                    `Moving ${peer.username} to ${away.name} after ${Math.round((now - since) / 60000)} minutes of inactivity`,
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
