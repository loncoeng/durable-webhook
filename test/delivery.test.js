// Tests for the delivery state transitions.
//
// The middle of this project: when to retry, when to give up, and what
// happens to what was given up on. decideNext is separate from the saving, so
// all of it can be tested without KV or HTTP.

import assert from "node:assert/strict";
import test from "node:test";

import { BACKOFF_MS, MAX_ATTEMPTS } from "../src/backoff.js";
import { attemptDelivery, createDelivery, decideNext } from "../src/delivery.js";

const NOW = 1_700_000_000_000;

const pending = (overrides = {}) => ({
  ...createDelivery({
    deliveryId: "d1",
    eventId: "e1",
    body: '{"hello":"world"}',
    contentType: "application/json",
    receivedAt: NOW,
  }),
  ...overrides,
});

const ok = { ok: true, status: 200, error: null, retryable: true };
const serverError = { ok: false, status: 503, error: "HTTP 503", retryable: true };
const clientError = { ok: false, status: 422, error: "HTTP 422", retryable: false };
const networkError = { ok: false, status: null, error: "timeout", retryable: true };

test("a success comes off the pending list", () => {
  const decision = decideNext(pending(), ok, NOW);
  assert.equal(decision.action, "done");
  assert.equal(decision.delivery.attempts, 1);
});

test("a 5xx is taken as temporary and retried", () => {
  const decision = decideNext(pending(), serverError, NOW);
  assert.equal(decision.action, "retry");
  assert.equal(decision.delivery.nextAt, NOW + BACKOFF_MS[0]);
});

test("a network error is retried too", () => {
  // Usually the other end is simply down. Nothing to do with the content.
  assert.equal(decideNext(pending(), networkError, NOW).action, "retry");
});

test("a 4xx goes to the dead letters without being retried", () => {
  // The destination is saying it cannot accept this content. Sending it again
  // changes nothing, so the attempts are not spent on it.
  const decision = decideNext(pending(), clientError, NOW);
  assert.equal(decision.action, "dead");
  assert.equal(decision.delivery.nextAt, null);
  assert.match(decision.reason, /422/);
});

test("408 and 429 are retried despite being 4xx", () => {
  // The kind of 4xx that goes through given some time. Treating every 4xx the
  // same way loses these.
  for (const status of [408, 429]) {
    const result = { ok: false, status, error: `HTTP ${status}`, retryable: true };
    assert.equal(decideNext(pending(), result, NOW).action, "retry", `status=${status}`);
  }
});

test("each retry waits longer than the last", () => {
  // Deliberately uneven: catch a wobble early, and do not hammer an outage.
  let delivery = pending();
  const waits = [];
  for (let i = 0; i < BACKOFF_MS.length; i += 1) {
    const decision = decideNext(delivery, serverError, NOW);
    waits.push(decision.delivery.nextAt - NOW);
    delivery = decision.delivery;
  }
  assert.deepEqual(waits, BACKOFF_MS);
  for (let i = 1; i < waits.length; i += 1) {
    assert.ok(waits[i] > waits[i - 1], "the interval did not grow");
  }
});

test("out of attempts means the dead letters", () => {
  let delivery = pending();
  let decision;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    decision = decideNext(delivery, serverError, NOW);
    delivery = decision.delivery;
  }
  assert.equal(decision.action, "dead");
  assert.equal(delivery.attempts, MAX_ATTEMPTS);
});

test("a dead letter keeps its body", () => {
  // Discard it and there is nothing left to replay. Throwing it away is a
  // decision for a person.
  const decision = decideNext(pending(), clientError, NOW);
  assert.equal(decision.delivery.body, '{"hello":"world"}');
  assert.equal(decision.delivery.eventId, "e1");
});

test("the last outcome is recorded", () => {
  // Without why it did not arrive, a person has nothing to decide on.
  const decision = decideNext(pending(), serverError, NOW);
  assert.equal(decision.delivery.lastStatus, 503);
  assert.equal(decision.delivery.lastError, "HTTP 503");
  assert.equal(decision.delivery.lastAttemptAt, NOW);
});

test("the delivery record passed in is not modified", () => {
  // A caller holding on to the old value must not be broken by it.
  const original = pending();
  decideNext(original, serverError, NOW);
  assert.equal(original.attempts, 0);
  assert.equal(original.lastError, null);
});

// --- attemptDelivery ---

test("it POSTs to the destination, carrying the delivery id and attempt", async () => {
  let seen;
  const fake = async (url, init) => {
    seen = { url, init };
    return new Response("ok", { status: 200 });
  };
  const result = await attemptDelivery(
    pending({ attempts: 2 }),
    { url: "https://example.com/in", headers: { "x-token": "t" } },
    fake,
  );
  assert.equal(result.ok, true);
  assert.equal(seen.url, "https://example.com/in");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["x-durable-webhook-delivery"], "d1");
  // Which attempt this is, so the receiving end can tell it is a repeat.
  assert.equal(seen.init.headers["x-durable-webhook-attempt"], "3");
  assert.equal(seen.init.headers["x-token"], "t");
});

test("a 5xx comes back retryable", async () => {
  const fake = async () => new Response("", { status: 502 });
  const result = await attemptDelivery(pending(), { url: "https://example.com" }, fake);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});

test("a 4xx comes back not retryable", async () => {
  const fake = async () => new Response("", { status: 400 });
  const result = await attemptDelivery(pending(), { url: "https://example.com" }, fake);
  assert.equal(result.retryable, false);
});

test("a thrown error counts as a connection failure", async () => {
  const fake = async () => { throw new Error("connection refused"); };
  const result = await attemptDelivery(pending(), { url: "https://example.com" }, fake);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.error, /connection refused/);
});

test("an abort is recorded as a timeout", async () => {
  const fake = async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  const result = await attemptDelivery(pending(), { url: "https://example.com" }, fake);
  assert.equal(result.error, "timeout");
  assert.equal(result.retryable, true);
});
