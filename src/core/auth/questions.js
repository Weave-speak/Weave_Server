// Security questions.
//
// These are a weak factor and it is worth being honest about why they are here anyway:
// Weave collects no email address, so there is no reset link to send. The alternatives are
// a passphrase nobody writes down, or asking an administrator every time. A question at
// least gives someone a fighting chance of getting back in on their own.
//
// The set is deliberately small and fixed. A free-text question invites "what is my
// password?" and questions whose answers are on anyone's public profile. These were chosen
// against three tests: the answer does not change over a lifetime, it is not on a social
// media profile, and it is not guessable from a shortlist. That rules out the classics —
// mother's maiden name, first school, birth city — which are all either public record or
// have a few hundred plausible values.
//
// Ids are stable forever. Reordering or rewording the list must never change an id, or
// everyone who chose that question is locked out.

export const SECURITY_QUESTIONS = Object.freeze([
    { id: 'first_pet', text: 'What was the name of your first pet?' },
    { id: 'childhood_friend', text: 'What was the first name of your closest childhood friend?' },
    { id: 'first_concert', text: 'What was the first live band or artist you saw?' },
    { id: 'oldest_cousin', text: "What is your oldest cousin's first name?" },
    { id: 'first_employer', text: 'What was the name of your first employer?' },
    { id: 'childhood_nickname', text: 'What nickname did your family call you as a child?' },
    { id: 'first_car', text: 'What was the make and model of your first car?' },
    { id: 'favourite_teacher', text: 'What was the surname of your favourite teacher?' },
]);

const BY_ID = new Map(SECURITY_QUESTIONS.map((q) => [q.id, q]));

export const isQuestionId = (id) => BY_ID.has(id);
export const questionText = (id) => BY_ID.get(id)?.text ?? null;

/**
 * Normalise an answer before hashing.
 *
 * Case and surrounding whitespace are discarded because nobody reproduces their own
 * capitalisation months later, and "Biscuit " failing against "biscuit" is a support
 * request rather than a security win. Internal spacing is collapsed for the same reason.
 * Accents are left alone: stripping them would quietly widen the answer space.
 */
export const normaliseAnswer = (answer) =>
    String(answer ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export const MIN_ANSWER_LENGTH = 2;
export const MAX_ANSWER_LENGTH = 100;

/**
 * Pick a question for a username that has no account.
 *
 * This is the whole reason account enumeration does not work here. "Forgot password" has
 * to reveal which question to ask, so a real username returning a question and an unknown
 * one returning an error would map the entire membership of a private server.
 *
 * Instead every username gets a question. For an unknown one it is derived from the name
 * itself, so it is stable across attempts — asking twice and getting different questions
 * would give the game away just as effectively as an error.
 *
 * `salt` should be per-installation, so the same username does not produce the same
 * question on two different servers.
 */
export function decoyQuestionFor(username, salt) {
    const material = `${salt}:${String(username ?? '').trim().toLowerCase()}`;

    // FNV-1a. Not a security primitive and does not need to be — it only has to be
    // deterministic and evenly spread. The secret is the salt, not the function.
    let hash = 0x811c9dc5;
    for (let i = 0; i < material.length; i += 1) {
        hash = Math.imul(hash ^ material.charCodeAt(i), 0x01000193) >>> 0;
    }
    return SECURITY_QUESTIONS[hash % SECURITY_QUESTIONS.length];
}
