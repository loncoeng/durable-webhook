// Establishing that the sender is who it says it is, with HMAC-SHA256.
//
// Verification is not required. Some senders do not sign at all, and requiring
// it would mean those senders could not be used. It happens only where a
// secret is configured.
//
// The comparison is constant-time. A plain === takes a different amount of
// time depending on how many characters matched, and that is enough to guess a
// valid signature one character at a time.

const encoder = new TextEncoder();

/**
 * The HMAC-SHA256 of the body, in hex.
 *
 * @param {string} secret
 * @param {string} body
 * @returns {Promise<string>}
 */
export async function sign(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compare length and contents without the elapsed time differing.
 *
 * The point is the absence of an early return. Mismatched lengths still run to
 * the end.
 */
export function timingSafeEqual(a, b) {
  const left = encoder.encode(a ?? "");
  const right = encoder.encode(b ?? "");
  // The length difference goes into the result. Returning here would leak it.
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Whether the signature that arrived is the right one.
 *
 * Some senders prefix it, as in `sha256=`, so the prefix comes off.
 *
 * @param {string} secret
 * @param {string} body
 * @param {string|null} provided the signature as read from the header
 */
export async function verify(secret, body, provided) {
  if (!provided) return false;
  const cleaned = provided.includes("=") ? provided.split("=").pop() : provided;
  const expected = await sign(secret, body);
  return timingSafeEqual(expected, cleaned.trim().toLowerCase());
}
