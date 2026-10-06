// Tests for deciding whether two events are the same event.
//
// Get this wrong and the same payment notification is forwarded twice, or two
// separate events collapse into one. Both do real damage at the destination.

import assert from "node:assert/strict";
import test from "node:test";

import { eventIdentity, hashBody, newDeliveryId } from "../src/identity.js";

const headers = (obj) => new Headers(obj);

test("the event id comes from the configured header", async () => {
  const result = await eventIdentity(
    headers({ "x-github-delivery": "abc-123" }),
    "{}",
    ["x-github-delivery"],
  );
  assert.equal(result.id, "abc-123");
  assert.equal(result.source, "header");
});

test("headers are read in the order given", async () => {
  // Which header to use differs by sender, so the order is configurable.
  const result = await eventIdentity(
    headers({ "x-second": "two", "x-first": "one" }),
    "{}",
    ["x-first", "x-second"],
  );
  assert.equal(result.id, "one");
});

test("an empty header is skipped for the next one", async () => {
  const result = await eventIdentity(
    headers({ "x-first": "   ", "x-second": "two" }),
    "{}",
    ["x-first", "x-second"],
  );
  assert.equal(result.id, "two");
});

test("with no header, the body hash stands in", async () => {
  const body = '{"event":"ping"}';
  const result = await eventIdentity(headers({}), body, ["x-missing"]);
  assert.equal(result.source, "body-hash");
  assert.equal(result.id, await hashBody(body));
});

test("the same body gives the same hash", async () => {
  assert.equal(await hashBody("same"), await hashBody("same"));
});

test("a different body gives a different hash", async () => {
  assert.notEqual(await hashBody('{"a":1}'), await hashBody('{"a":2}'));
});

test("the hash is 64 hex characters", async () => {
  assert.match(await hashBody("x"), /^[0-9a-f]{64}$/);
});

test("every delivery id is different", () => {
  // Unlike the event id, this one is unique per delivery. It is what tells two
  // attempts at the same event apart.
  const ids = new Set([newDeliveryId(), newDeliveryId(), newDeliveryId()]);
  assert.equal(ids.size, 3);
});
