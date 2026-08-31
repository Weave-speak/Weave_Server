// What kind of image is this, really?
//
// Decided by the file's own magic bytes, never by a filename or a declared Content-Type:
// both are supplied by whoever is uploading, and neither has any bearing on what the
// bytes actually are. A server that trusts the declaration will happily store an
// executable called portrait.png.
//
// Lives in core rather than in the uploads module because avatars need the same check and
// the core must not import a module. The module imports this instead, so there is one
// list of what Weave accepts rather than two that drift.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Signatures we accept. Anything not on this list is refused outright. */
export const SIGNATURES = [
    {
        ext: 'png',
        mime: 'image/png',
        test: (b) => b.subarray(0, 8).equals(PNG_MAGIC),
    },
    {
        ext: 'jpg',
        mime: 'image/jpeg',
        test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    },
    {
        ext: 'gif',
        mime: 'image/gif',
        test: (b) => b.subarray(0, 4).toString('ascii') === 'GIF8',
    },
    {
        ext: 'webp',
        mime: 'image/webp',
        test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF'
            && b.subarray(8, 12).toString('ascii') === 'WEBP',
    },
];

/** The signature this buffer matches, or null. Never throws on a truncated buffer. */
export function sniffImage(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    for (const sig of SIGNATURES) {
        try {
            if (sig.test(buffer)) return sig;
        } catch {
            // A truncated or malformed buffer is simply not a match.
        }
    }
    return null;
}

/** The sentence a person should read when their file is refused. */
export const IMAGE_REFUSAL = 'That does not look like a PNG, JPEG, GIF or WebP image.';
