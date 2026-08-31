// Core route registration.
//
// Everything here belongs to the 'core' owner, which is never disabled. A route that
// could reasonably be switched off belongs in a module instead.

import { HttpError } from '../server.js';
import { registerAuthRoutes } from './auth.js';
import { registerAdminRoutes } from './admin.js';
import { registerProfileRoutes } from './profile.js';
import { registerAdminStatic } from '../static.js';
import { registerInvitePage } from './invite-page.js';
import {
    listChannels, visibleChannels, getChannel, createChannel, updateChannel, deleteChannel,
    isMember, addMember, listMembers, ChannelError,
} from '../../channels/index.js';
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
    // everyone at once instead of on their next sign-in. PER RECIPIENT, because a
    // private room's membership flag differs by viewer.
    const { peers } = deps;
    const announceChannels = () => {
        for (const peer of peers?.all ?? []) {
            ws?.send(peer.ws, 'channels', { channels: visibleChannels(db, peer.userId) });
        }
    };

    registerAuthRoutes(deps);
    registerAdminRoutes(deps);
    registerProfileRoutes(deps);
    registerAdminStatic(deps);
    registerInvitePage(deps);

    // ── Channels ─────────────────────────────────────────────────────────────
    // Readable by any signed-in user: the client builds its sidebar from this rather
    // than from a hardcoded list, which is the entire point of channels being data.
    router.register('core', 'GET', '/api/channels', ({ session, json }) => {
        json(200, { channels: visibleChannels(db, session.userId) });
    });

    router.register('core', 'POST', '/api/channels', ({ body, session, json }) => {
        const wantPrivate = Boolean(body?.private);
        // Public rooms are the server's furniture: administrators arrange those. A
        // PRIVATE room is a huddle — any member may start one, provided the module
        // that gives huddles their lifecycle (the expiry reaper) is running.
        if (!wantPrivate && !session.isAdmin) {
            throw new HttpError(403, 'Only an administrator can create public rooms.');
        }
        if (wantPrivate && !moduleHost.enabled.includes('private-channels')) {
            throw new HttpError(403, 'Private rooms are switched off on this server.');
        }
        try {
            const channel = createChannel(db, {
                ...(body ?? {}),
                private: wantPrivate,
                createdBy: wantPrivate ? session.userId : null,
                // A huddle is never the landing room and never anyone's furniture.
                ...(wantPrivate ? { isDefault: false, kind: 'both' } : {}),
            });
            log.info({ evt: 'channel.created', channel: channel.name, by: session.username, private: wantPrivate },
                `${session.username} created ${wantPrivate ? 'private ' : ''}channel "${channel.name}"`);
            announceChannels();
            json(201, { channel: wantPrivate ? { ...channel, member: true } : channel });
        } catch (err) { throw asHttp(err); }
    }, { maxBytes: 4_000 });

    // ── private-room membership ──────────────────────────────────────────────
    // Members add members: there are no roles, and a huddle you are in is yours to
    // grow. Non-members get the same 404 for "no such room" and "not your room".

    router.register('core', 'GET', '/api/channels/:id/members', ({ params, session, json }) => {
        const channel = getChannel(db, params.id);
        if (!channel?.private || !isMember(db, channel.id, session.userId)) {
            throw new HttpError(404, 'No such room.');
        }
        json(200, { members: listMembers(db, channel.id) });
    });

    router.register('core', 'POST', '/api/channels/:id/members', ({ params, body, session, json }) => {
        const channel = getChannel(db, params.id);
        if (!channel?.private || !isMember(db, channel.id, session.userId)) {
            throw new HttpError(404, 'No such room.');
        }
        const target = db.prepare('SELECT id, username FROM users WHERE id = ? AND is_disabled = 0')
            .get(String(body?.userId ?? ''));
        if (!target) throw new HttpError(404, 'No such person.');
        addMember(db, channel.id, target.id, session.userId);
        log.info({ evt: 'channel.member_added', channel: channel.name, target: target.username, by: session.username },
            `${session.username} added ${target.username} to "${channel.name}"`);
        announceChannels();
        json(200, { ok: true, members: listMembers(db, channel.id) });
    }, { maxBytes: 1_000 });

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
            users: listUsers(db).map(({ id, username, displayName, avatar, status }) =>
                ({ id, username, displayName, avatar, status })),
        });
    });

    router.register('core', 'GET', '/api/users/:id', ({ params, json }) => {
        const user = getUserById(db, params.id);
        if (!user) throw new HttpError(404, 'No such user.');
        const { id, username, displayName, avatar, status } = user;
        json(200, { user: { id, username, displayName, avatar, status } });
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
