// Emoji reactions on channel messages.
//
// The lightweight shape every big messenger converged on: one row per
// (message, person, emoji), toggled; aggregates are computed on read and every change is
// broadcast as a small delta that clients apply locally. Nothing is denormalised, so
// there is nothing to drift. Unicode emoji only — custom uploads are a media pipeline,
// not a reaction.

/** Discord caps a message at 20 distinct emoji; smaller suits a small crew's screens. */
const MAX_DISTINCT = 12;

/**
 * A plausible single emoji: short, visible, no whitespace or control characters. ZWJ
 * families ("👨‍👩‍👧‍👦") run long in UTF-16, hence 16 units rather than 2.
 */
const acceptableEmoji = (e) =>
    typeof e === 'string' && e.length >= 1 && e.length <= 16
    && !/[\s\u0000-\u001f\u007f]/.test(e);

export function register(ctx) {
    ctx.db.migrate();
    const db = ctx.db.handle;

    const messageOf = db.prepare('SELECT id, channel_id AS channelId FROM chat_messages WHERE id = ?');
    const remove = db.prepare('DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?');
    const add = db.prepare('INSERT INTO chat_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)');
    const distinct = db.prepare('SELECT COUNT(DISTINCT emoji) AS n FROM chat_reactions WHERE message_id = ?');
    const countOf = db.prepare('SELECT COUNT(*) AS n FROM chat_reactions WHERE message_id = ? AND emoji = ?');

    // A small sliding budget per account: reacting is cheap, so the limit only exists to
    // stop a script from turning the toggle into a broadcast hose.
    const budgets = new Map();   // userId -> [timestamps]
    const withinBudget = (userId) => {
        const now = Date.now();
        const past = (budgets.get(userId) ?? []).filter((t) => now - t < 10_000);
        past.push(now);
        budgets.set(userId, past);
        return past.length <= 20;
    };

    ctx.ws.on('react', ({ ws, msg, send, fail, broadcast }) => {
        const peer = ctx.peers.get(ws.cid);
        if (!peer) return;
        const emoji = msg.emoji;
        if (!acceptableEmoji(emoji)) {
            return fail(ws, 'bad_emoji', 'That is not an emoji this server accepts.');
        }
        const message = messageOf.get(String(msg.messageId ?? ''));
        if (!message) return fail(ws, 'no_message', 'That message does not exist.');
        if (!withinBudget(peer.userId)) {
            return fail(ws, 'rate_limited', 'Slow down with the reactions.');
        }

        // Toggle: a delete that removed nothing means this is an add.
        let on = false;
        if (remove.run(message.id, peer.userId, emoji).changes === 0) {
            if (distinct.get(message.id).n >= MAX_DISTINCT) {
                return fail(ws, 'too_many', `A message holds at most ${MAX_DISTINCT} different emoji.`);
            }
            add.run(message.id, peer.userId, emoji, Date.now());
            on = true;
        }

        const count = countOf.get(message.id, emoji).n;
        send('accepted', { messageId: message.id, emoji, on });
        // Global, like messages themselves: any open timeline showing this message needs
        // the delta, and standing elsewhere is exactly when you are browsing history.
        broadcast('changed', {
            messageId: message.id,
            channelId: message.channelId,
            emoji,
            count,
            on,
            username: peer.username,
        });
    });

    // Aggregates for a page of history. The client asks right after fetching messages;
    // answering here rather than inside text-chat's route keeps this module removable.
    ctx.http.route('GET', '/api/reactions', ({ query, session, json }) => {
        const ids = String(query.messageIds ?? '').split(',').filter(Boolean).slice(0, 200);
        if (!ids.length) return json(200, { reactions: {} });

        const marks = ids.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT message_id AS messageId, emoji, COUNT(*) AS count,
                   MAX(user_id = ?) AS mine, MIN(created_at) AS first
            FROM chat_reactions
            WHERE message_id IN (${marks})
            GROUP BY message_id, emoji
            ORDER BY first
        `).all(session.userId, ...ids);

        const reactions = {};
        for (const r of rows) {
            (reactions[r.messageId] ??= []).push({ emoji: r.emoji, count: r.count, mine: r.mine === 1 });
        }
        json(200, { reactions });
    });
}
