// The attachment a client may claim on a message.
//
// An upload id it knows, plus a display name. The URL is DERIVED here — a client cannot
// point a message anywhere but /api/uploads — and the mime must be one the uploads module
// can actually have produced.
//
// In core rather than in a module because three modules carry messages (text-chat, dm and
// bubbles) and modules must not import each other. It was two identical copies before the
// third arrived; one list of what an attachment may be is the point of having a rule.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function cleanAttachment(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id ?? '');
    if (!UUID.test(id)) return null;
    const mime = String(raw.mime ?? '');
    if (!IMAGE_MIMES.includes(mime)) return null;
    const bytes = Number(raw.bytes);
    const name = String(raw.name ?? 'image').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) || 'image';
    return {
        id, mime, name,
        url: `/api/uploads/${id}`,
        bytes: Number.isFinite(bytes) && bytes > 0 ? Math.min(bytes, 50_000_000) : 0,
    };
}
