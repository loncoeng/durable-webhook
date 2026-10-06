// The delivery itself: send one to the destination, and decide what state it
// moves to next.
//
// This is the middle of the state machine.
//
//   accepted → pending ─success→ removed
//                 │
//                 └─failure→ count it and wait ─out of attempts→ dead letters
//
// The point is that failures are not all the same. A 4xx is the destination
// saying it cannot accept this content, which will be just as true the tenth
// time — so it goes to the dead letters without being retried. A 5xx or a
// network error is usually temporary, and gets retried.

import { isExhausted, nextAttemptAt } from "./backoff.js";

/** The timeout on a forward. A destination that never answers must not eat the
 *  whole invocation. */
export const TIMEOUT_MS = 10_000;

/**
 * One attempt, and only one.
 *
 * @returns {Promise<{ ok: boolean, status: number|null, error: string|null, retryable: boolean }>}
 */
export async function attemptDelivery(delivery, target, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers: {
        "content-type": delivery.contentType || "application/json",
        "x-durable-webhook-delivery": delivery.deliveryId,
        "x-durable-webhook-attempt": String(delivery.attempts + 1),
        ...(target.headers || {}),
      },
      body: delivery.body,
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
      // A 4xx is about the content, and sending it again changes nothing.
      // 408 and 429 are the exceptions: they go through given some time.
      retryable:
        response.ok ||
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 429,
    };
  } catch (error) {
    // Connection failures and timeouts. Usually the other end is simply down.
    return {
      ok: false,
      status: null,
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Work out what happens next, given how an attempt went.
 *
 * Nothing is saved or removed here. The decision comes back and the caller
 * carries it out, which is what makes this function testable without KV.
 *
 * @returns {{ action: "done"|"retry"|"dead", delivery: object, reason: string }}
 */
export function decideNext(delivery, result, now) {
  const attempts = delivery.attempts + 1;
  const updated = {
    ...delivery,
    attempts,
    lastStatus: result.status,
    lastError: result.error,
    lastAttemptAt: now,
  };

  if (result.ok) {
    return { action: "done", delivery: updated, reason: "delivered" };
  }

  if (!result.retryable) {
    return {
      action: "dead",
      delivery: { ...updated, nextAt: null },
      reason: `the destination returned ${result.status}; that is about the content, so it is not retried`,
    };
  }

  if (isExhausted(attempts)) {
    return {
      action: "dead",
      delivery: { ...updated, nextAt: null },
      reason: `${attempts} attempts, none of which arrived`,
    };
  }

  return {
    action: "retry",
    delivery: { ...updated, nextAt: nextAttemptAt(attempts, now) },
    reason: result.error || "a temporary failure",
  };
}

/** The delivery record as it looks the moment the event is accepted. */
export function createDelivery({ deliveryId, eventId, body, contentType, receivedAt }) {
  return {
    deliveryId,
    eventId,
    body,
    contentType: contentType || "application/json",
    receivedAt,
    attempts: 0,
    nextAt: receivedAt,
    lastStatus: null,
    lastError: null,
    lastAttemptAt: null,
  };
}
