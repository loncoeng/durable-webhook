// Tests for loading the configuration.
//
// The worst way to find out about a mistake in here is "the webhooks aren't
// arriving", because by then events have already been lost. It fails on load.

import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadEndpoints } from "../src/config.js";

const env = (endpoints) => ({ ENDPOINTS: JSON.stringify(endpoints) });

test("the smallest configuration loads", () => {
  const map = loadEndpoints(env([{ id: "line", targetUrl: "https://app.example.com/in" }]));
  assert.equal(map.size, 1);
  assert.equal(map.get("line").targetUrl, "https://app.example.com/in");
  assert.equal(map.get("line").secret, null);
  assert.deepEqual(map.get("line").idHeaders, []);
});

test("what is left out gets a default", () => {
  const endpoint = loadEndpoints(env([{ id: "a", targetUrl: "https://e.example.com" }])).get("a");
  assert.deepEqual(endpoint.headers, {});
  assert.equal(endpoint.signatureHeader, null);
});

test("no ENDPOINTS at all is a failure", () => {
  assert.throws(() => loadEndpoints({}), ConfigError);
});

test("ENDPOINTS that is not JSON is a failure", () => {
  assert.throws(() => loadEndpoints({ ENDPOINTS: "{ broken" }), ConfigError);
});

test("ENDPOINTS that is not an array is a failure", () => {
  assert.throws(() => loadEndpoints({ ENDPOINTS: '{"id":"a"}' }), ConfigError);
});

test("an empty array is a failure", () => {
  // Guards against the accident of feeling configured with nothing configured.
  assert.throws(() => loadEndpoints(env([])), ConfigError);
});

test("a missing id is a failure", () => {
  assert.throws(() => loadEndpoints(env([{ targetUrl: "https://e.example.com" }])), ConfigError);
});

test("an id with characters that break a URL is a failure", () => {
  // The id goes into the path. A separator or a space in it breaks routing.
  // 日本語 is here as the non-ASCII case, and stays in Japanese because that
  // is the input, not a sentence about it.
  for (const id of ["a/b", "a b", "a?b", "日本語", ""]) {
    assert.throws(
      () => loadEndpoints(env([{ id, targetUrl: "https://e.example.com" }])),
      ConfigError,
      `id=${JSON.stringify(id)} was accepted`,
    );
  }
});

test("a duplicate id is a failure", () => {
  // Silently letting the last one win would make one of the webhooks vanish.
  assert.throws(
    () => loadEndpoints(env([
      { id: "a", targetUrl: "https://one.example.com" },
      { id: "a", targetUrl: "https://two.example.com" },
    ])),
    ConfigError,
  );
});

test("a missing targetUrl is a failure", () => {
  assert.throws(() => loadEndpoints(env([{ id: "a" }])), ConfigError);
});

test("a targetUrl that is not a URL is a failure", () => {
  assert.throws(() => loadEndpoints(env([{ id: "a", targetUrl: "not a url" }])), ConfigError);
});

test("anything other than http or https is a failure", () => {
  assert.throws(
    () => loadEndpoints(env([{ id: "a", targetUrl: "ftp://e.example.com" }])),
    ConfigError,
  );
});

test("a secret without a signatureHeader is a failure", () => {
  // There would be nowhere to look for the signature. Skipping the check
  // quietly means passing everything through while believing it is checked.
  assert.throws(
    () => loadEndpoints(env([{ id: "a", targetUrl: "https://e.example.com", secret: "s" }])),
    ConfigError,
  );
});

test("a secret with a signatureHeader is accepted", () => {
  const endpoint = loadEndpoints(env([{
    id: "gh",
    targetUrl: "https://e.example.com",
    secret: "s",
    signatureHeader: "x-hub-signature-256",
    idHeaders: ["x-github-delivery"],
  }])).get("gh");
  assert.equal(endpoint.secret, "s");
  assert.deepEqual(endpoint.idHeaders, ["x-github-delivery"]);
});
