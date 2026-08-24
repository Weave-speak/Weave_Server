// Core route registration.
//
// Everything here belongs to the 'core' owner, which is never disabled. A route that
// could reasonably be switched off belongs in a module instead.

import { HttpError } from '../server.js';
import { registerAuthRoutes } from './auth.js';
import { registerAdminRoutes } from './admin.js';
import { registerAdminStatic } from '../static.js';
import { listChannels, getChannel, createChannel, updateChannel, deleteChannel, ChannelError } from '../../channels/index.js';
import { createInvite, listInvites, revokeInvite, InviteError } from '../../invites/index.js';
import { listUsers, getUserById } from '../../users/index.js';

/** Turn a domain error into the right status without leaking internals. */
function asHttp(err) {
    if (err instanceof ChannelError) return new HttpError(400, err.message, err.field ? { field: err.field } : undefined);
    if (err instanceof InviteError) return new HttpError(400, err.message);
    return err;
}

export function registerCoreRoutes(deps) {
    const { router, db, log, moduleHost, ws } = deps;

    // Every connected client rebuilds its sidebar from this. Sent after any channel
    // change, so a room created in the admin console — or from the client — appears for
    // everyone at once instead of on their next sign-in.
    const announceChannels = () => ws?.broadcast('channels', { channels: listChannels(db) });

    registerAuthRoutes(deps);
    registerAdminRoutes(deps);
    registerAdminStatic(deps);

    // ── Channels ─────────────────────────────────────────────────────────────
    // Readable by any signed-in user: the client builds its sidebar from this rather
    // than from a hardcoded list, which is the entire point of channels being data.
    router.register('core', 'GET', '/api/channels', ({ json }) => {
        json(200, { channels: listChannels(db) });
    });

    router.register('core', 'POST', '/api/channels', ({ body, session, json }) => {
        try {
            const channel = createChannel(db, body ?? {});
            log.info({ evt: 'channel.created', channel: channel.name, by: session.username },
                `${session.username} created channel "${channel.name}"`);
            announceChannels();
            json(201, { channel });
        } catch (err) { throw asHttp(err); }
    }, { auth: 'admin', maxBytes: 4_000 });

    router.register('core', 'PUT', '/api/channels/:id', ({ params, body, session, json }) => {
        if (!getChannel(db, params.id)) throw new HttpError(404, 'No such channel.');
        try {
            const channel = updateChannel(db, params.id, body ?? {});
            log.info({ evt: 'channel.updated', channel: channel.name, by: session.username },
                `${session.username} updated channel "${channel.name}"`);
            announceChannels();
            json(200, { channel });
        } catch (err) { throw asHttp(err); }
    }, { auth: 'admin', maxBytes: 4_000 });

    router.register('core', 'DELETE', '/api/channels/:id', ({ params, session, json }) => {
        const channel = getChannel(db, params.id);
        if (!channel) throw new HttpError(404, 'No such channel.');
        try {
            deleteChannel(db, params.id);
            log.warn({ evt: 'channel.deleted', channel: channel.name, by: session.username },
                `${session.username} deleted channel "${channel.name}"`);
            announceChannels();
            json(200, { ok: true });
        } catch (err) { throw asHttp(err); }
    }, { auth: 'admin' });

    // ── Invites ──────────────────────────────────────────────────────────────
    // Any signed-in member may mint one. Registration is invite-only with no open mode,
    // so this is how a community grows; restricting it to admins would make every new
    // member a support request.
    router.register('core', 'POST', '/api/invites', ({ body, session, json }) => {
        try {
            const invite = createInvite(db, {
                createdBy: session.userId,
                maxUses: Number(body?.maxUses ?? 1),
                expiresInHours: body?.expiresInHours === null ? null : Number(body?.expiresInHours ?? 168),
                note: body?.note ? String(body.note).slice(0, 200) : null,
            });
            log.info({ evt: 'invite.created', by: session.username }, `${session.username} created an invite`);
            json(201, { invite });
        } catch (err) { throw asHttp(err); }
    }, { maxBytes: 2_000 });

    router.register('core', 'GET', '/api/invites', ({ json }) => {
        json(200, { invites: listInvites(db) });
    }, { auth: 'admin' });

    router.register('core', 'DELETE', '/api/invites/:code', ({ params, session, json }) => {
        if (!revokeInvite(db, params.code)) throw new HttpError(404, 'No such invite code.');
        log.info({ evt: 'invite.revoked', by: session.username }, `${session.username} revoked an invite`);
        json(200, { ok: true });
    }, { auth: 'admin' });

    // ── Users ────────────────────────────────────────────────────────────────
    // Signed-in only. The previous server exposed the live roster to anyone, on any
    // HTTP method, with no authentication at all.
    router.register('core', 'GET', '/api/users', ({ json }) => {
        json(200, {
            users: listUsers(db).map(({ id, username, displayName, avatar }) =>
                ({ id, username, displayName, avatar })),
        });
    });

    router.register('core', 'GET', '/api/users/:id', ({ params, json }) => {
        const user = getUserById(db, params.id);
        if (!user) throw new HttpError(404, 'No such user.');
        const { id, username, displayName, avatar } = user;
        json(200, { user: { id, username, displayName, avatar } });
    });

    // ── Modules ──────────────────────────────────────────────────────────────
    // The module manager. Enabling and disabling happen with the server running.
    router.register('core', 'GET', '/api/admin/modules', ({ json }) => {
        json(200, { modules: moduleHost.installed });
    }, { auth: 'admin' });

    router.register('core', 'POST', '/api/admin/modules/:id/:action', async ({ params, session, json }) => {
        const { id, action } = params;
        if (action !== 'enable' && action !== 'disable') {
            throw new HttpError(400, 'Action must be "enable" or "disable".');
        }
        try {
            const changed = action === 'enable' ? await moduleHost.enable(id) : await moduleHost.disable(id);
            log.warn({ evt: `module.${action}d`, module: id, by: session.username },
                `${session.username} ${action}d module "${id}"`);
            json(200, { ok: true, changed, modules: moduleHost.installed });
        } catch (err) {
            throw new HttpError(400, err.message);
        }
    }, { auth: 'admin' });
}
