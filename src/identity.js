// What makes two events the same event.
//
// Senders retry. A destination that processes one twice charges twice, or
// notifies twice. Rejecting it the moment it arrives is the safest place to do
// it, and that needs a definition of "the same".
//
// Where the sender attaches an event id, that is the definition. Plenty of
// senders attach nothing, and for those a hash of the body stands in.
//
// The body hash has a weakness: two events with identical content but
// different meaning — the same "like" sent twice, separately — are treated as
// one. Even so, there are many situations where a duplicate delivery is worse
// than a lost one. Which way to lean is configurable.

const encoder = new TextEncoder();

/** The SHA-256 of the body, in hex. */
export async function hashBody(body) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Settle on a string that identifies this event.
 *
 * @param {Headers} headers
 * @param {string} body
 * @param {string[]} idHeaders header names to look at, in order
 * @returns {Promise<{ id: string, source: "header"|"body-hash" }>}
 */
export async function eventIdentity(headers, body, idHeaders = []) {
  for (const name of idHeaders) {
    const value = headers.get(name);
    if (value && value.trim()) {
      return { id: value.trim(), source: "header" };
    }
  }
  return { id: await hashBody(body), source: "body-hash" };
}

/** The id of one delivery. Unrelated to deduplication, and always unique. */
export function newDeliveryId() {
  return crypto.randomUUID();
}
