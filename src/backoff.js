// How long to wait between attempts.
//
// Deliberately uneven. A brief wobble is caught by an early retry, and
// hammering a long outage once a minute wastes both ends. The early steps are
// short and the later ones are far apart.
//
// Anything past the last attempt is set aside rather than dropped. Throwing it
// away is a decision for a person.

/** After attempt n, how long to wait before the next one (milliseconds). */
export const BACKOFF_MS = [
  60_000,        // 1 minute
  5 * 60_000,    // 5 minutes
  15 * 60_000,   // 15 minutes
  60 * 60_000,   // 1 hour
  6 * 60 * 60_000, // 6 hours
];

export const MAX_ATTEMPTS = BACKOFF_MS.length + 1; // the first one, plus 5 retries

/**
 * When to try delivering next, or null if there is to be no next time.
 *
 * @param {number} attempts how many attempts have been made, the first included
 * @param {number} now      the current time in milliseconds
 * @returns {number|null}
 */
export function nextAttemptAt(attempts, now) {
  if (attempts < 1) {
    throw new RangeError("attempts must be at least 1");
  }
  const index = attempts - 1;
  if (index >= BACKOFF_MS.length) return null;
  return now + BACKOFF_MS[index];
}

/** Whether there is anything left to try. */
export function isExhausted(attempts) {
  return attempts >= MAX_ATTEMPTS;
}

/**
 * Whether a pending delivery is due at the given time.
 *
 * Only the ones whose nextAt has passed. Cron runs every few minutes, so being
 * somewhat past it is the normal case rather than a late one.
 */
export function isDue(pending, now) {
  return typeof pending?.nextAt === "number" && pending.nextAt <= now;
}
