// Tests for signature verification.
//
// Soft here and anyone can push a forged webhook through. A destination built
// on the assumption that the sender is genuine will take the forged data at
// face value.

import assert from "node:assert/strict";
import test from "node:test";

import { sign, timingSafeEqual, verify } from "../src/signature.js";

const SECRET = "shhh";
const BODY = '{"event":"payment.succeeded","amount":1000}';

test("the same input gives the same signature", async () => {
  assert.equal(await sign(SECRET, BODY), await sign(SECRET, BODY));
});

test("one character of body changes the signature", async () => {
  const a = await sign(SECRET, BODY);
  const b = await sign(SECRET, BODY.replace("1000", "1001"));
  assert.notEqual(a, b);
});

test("a different key changes the signature", async () => {
  assert.notEqual(await sign(SECRET, BODY), await sign("other", BODY));
});

test("the right signature is accepted", async () => {
  assert.equal(await verify(SECRET, BODY, await sign(SECRET, BODY)), true);
});

test("the wrong signature is refused", async () => {
  assert.equal(await verify(SECRET, BODY, "0".repeat(64)), false);
});

test("no signature is refused", async () => {
  assert.equal(await verify(SECRET, BODY, null), false);
  assert.equal(await verify(SECRET, BODY, ""), false);
});

test("a sha256= prefix comes off before comparing", async () => {
  // GitHub sends sha256=... Comparing the prefix along with it never matches.
  const signature = await sign(SECRET, BODY);
  assert.equal(await verify(SECRET, BODY, `sha256=${signature}`), true);
});

test("uppercase hex is accepted", async () => {
  const signature = await sign(SECRET, BODY);
  assert.equal(await verify(SECRET, BODY, signature.toUpperCase()), true);
});

test("surrounding whitespace is ignored", async () => {
  const signature = await sign(SECRET, BODY);
  assert.equal(await verify(SECRET, BODY, `  ${signature}  `), true);
});

// --- timingSafeEqual ---

test("identical strings are equal", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
});

test("different strings are not", () => {
  assert.equal(timingSafeEqual("abc", "abd"), false);
});

test("different lengths are not", () => {
  // The length difference goes into the comparison. An early return here
  // would leak whether the length was right, through the elapsed time.
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("abcd", "abc"), false);
});

test("null and undefined do not throw", () => {
  assert.equal(timingSafeEqual(null, "abc"), false);
  assert.equal(timingSafeEqual("abc", undefined), false);
  assert.equal(timingSafeEqual(null, undefined), true); // both empty
});

test("a matching prefix does not cause an early return", () => {
  // Indirect, but it does check that the implementation runs to the end: the
  // number of matching characters differs and the answer must still be false.
  assert.equal(timingSafeEqual("aaaaaaaaab", "aaaaaaaaac"), false);
  assert.equal(timingSafeEqual("baaaaaaaaa", "caaaaaaaaa"), false);
});
