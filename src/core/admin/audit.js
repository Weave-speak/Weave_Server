// The audit log: what an administrator did, to whom, and when.
//
// Extracted from the admin HTTP routes because moderation arrives over the WEBSOCKET, and
// until now no WebSocket action wrote an audit row at all — including adminMove, which has
// been able to relocate anyone on the server since it was written. An action powerful
// enough to need `auth: 'admin'` is an action worth a row.

export const audit = (db, { actorId = null, action, target = null, detail = null }) => {
    db.prepare('INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, ?, ?, ?)')
        .run(actorId, action, target, detail);
};
