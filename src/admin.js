// Authentication for the admin paths: listing dead letters and replaying one.
//
// These two have a different character from the receiving path. A signature
// establishes that the sender is who it says it is, and only the sender holds
// that key. These paths are for whoever operates this, so the sender's key is
// not available to protect them and they get a key of their own.
//
// Replay in particular: reachable from outside, it can make the destination
// process an event twice. It would mean the accident this tool exists to
// prevent could be caused from outside it.

import { timingSafeEqual } from "./signature.js";

/**
 * Decide whether an admin request may proceed.
 *
 * Returns null when it may. Otherwise a Response carrying the reason.
 *
 * With ADMIN_TOKEN unset, nothing gets through. For an operator who forgot to
 * set it, not working beats working wide open: nobody notices an open door,
 * everybody notices a closed one.
 */
export function checkAdmin(request, env) {
  const expected = typeof env.ADMIN_TOKEN === "string" ? env.ADMIN_TOKEN.trim() : "";
  if (!expected) return { ok: false, status: 503, error: "ADMIN_TOKEN is not set" };

  const provided = extractToken(request.headers.get("authorization"));
  if (!provided) return { ok: false, status: 401, error: "authentication required" };
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, error: "authentication failed" };
  }
  return { ok: true };
}

/** Pull xxx out of "Bearer xxx". Anything else is null. */
function extractToken(header) {
  if (typeof header !== "string") return null;
  const match = header.trim().match(/^Bearer[ \t]+(.+)$/i);
  return match ? match[1].trim() || null : null;
}
