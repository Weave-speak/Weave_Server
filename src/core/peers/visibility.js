// Who may know where a peer is standing.
//
// Presence is global — everyone sees everyone ONLINE — but a private room's occupants are
// a secret kept from non-members. The mask is surgical: the peer stays visible, their
// LOCATION becomes "nowhere". A non-member sees the same thing they would see for someone
// who deliberately left every room, which is exactly the amount of nothing a locked door
// should reveal.
//
// Every roster frame flows through here at SEND time, per recipient. Masking at the edge
// rather than in storage means members and non-members can receive the same event and each
// learn only what they are entitled to.

import { getChannel, isMember } from '../channels/index.js';

/**
 * The peer as ONE viewer may see them.
 *
 * `view` is a publicView; the viewer is a userId (null for "no viewer", which masks —
 * failing closed). Standing in a public room, or in no room, passes through untouched.
 */
export function viewFor(db, view, viewerUserId) {
    if (!view.channelId) return view;
    const channel = getChannel(db, view.channelId);
    if (!channel?.private) return view;
    if (viewerUserId && (view.userId === viewerUserId || isMember(db, channel.id, viewerUserId))) {
        return view;
    }
    return { ...view, channelId: null };
}

/** A whole snapshot, masked for one viewer. */
export const snapshotFor = (db, views, viewerUserId) =>
    views.map((v) => viewFor(db, v, viewerUserId));
