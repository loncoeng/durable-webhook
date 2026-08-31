// 設定の読み込みに対する検査。
//
// 設定の誤りに気付くのが「Webhook が届かない」という形になるのは最悪で、
// そのときにはもうイベントを取りこぼしている。起動時に落とす。

import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadEndpoints } from "../src/config.js";

const env = (endpoints) => ({ ENDPOINTS: JSON.stringify(endpoints) });

test("最小の設定を読める", () => {
  const map = loadEndpoints(env([{ id: "line", targetUrl: "https://app.example.com/in" }]));
  assert.equal(map.size, 1);
  assert.equal(map.get("line").targetUrl, "https://app.example.com/in");
  assert.equal(map.get("line").secret, null);
  assert.deepEqual(map.get("line").idHeaders, []);
});

test("省略した項目に既定値が入る", () => {
  const endpoint = loadEndpoints(env([{ id: "a", targetUrl: "https://e.example.com" }])).get("a");
  assert.deepEqual(endpoint.headers, {});
  assert.equal(endpoint.signatureHeader, null);
});

test("ENDPOINTS が無ければ落とす", () => {
  assert.throws(() => loadEndpoints({}), ConfigError);
});

test("JSON として壊れていれば落とす", () => {
  assert.throws(() => loadEndpoints({ ENDPOINTS: "{ broken" }), ConfigError);
});

test("配列でなければ落とす", () => {
  assert.throws(() => loadEndpoints({ ENDPOINTS: '{"id":"a"}' }), ConfigError);
});

test("空の配列は落とす", () => {
  // 設定した気になって1件も無い、という事故を防ぐ。
  assert.throws(() => loadEndpoints(env([])), ConfigError);
});

test("id が無ければ落とす", () => {
  assert.throws(() => loadEndpoints(env([{ targetUrl: "https://e.example.com" }])), ConfigError);
});

test("id に URL で困る文字があれば落とす", () => {
  // id はパスに入る。区切りや空白が混ざると経路が壊れる。
  for (const id of ["a/b", "a b", "a?b", "日本語", ""]) {
    assert.throws(
      () => loadEndpoints(env([{ id, targetUrl: "https://e.example.com" }])),
      ConfigError,
      `id=${JSON.stringify(id)} が通ってしまった`,
    );
  }
});

test("id が重複していれば落とす", () => {
  // 後勝ちで黙って上書きすると、片方の Webhook が消える。
  assert.throws(
    () => loadEndpoints(env([
      { id: "a", targetUrl: "https://one.example.com" },
      { id: "a", targetUrl: "https://two.example.com" },
    ])),
    ConfigError,
  );
});

test("targetUrl が無ければ落とす", () => {
  assert.throws(() => loadEndpoints(env([{ id: "a" }])), ConfigError);
});

test("targetUrl が URL でなければ落とす", () => {
  assert.throws(() => loadEndpoints(env([{ id: "a", targetUrl: "not a url" }])), ConfigError);
});

test("http と https 以外は落とす", () => {
  assert.throws(
    () => loadEndpoints(env([{ id: "a", targetUrl: "ftp://e.example.com" }])),
    ConfigError,
  );
});

test("secret があるのに signatureHeader が無ければ落とす", () => {
  // どのヘッダを見ればよいか決まらない。黙って検証を飛ばすと、
  // 検証しているつもりで素通しになる。
  assert.throws(
    () => loadEndpoints(env([{ id: "a", targetUrl: "https://e.example.com", secret: "s" }])),
    ConfigError,
  );
});

test("secret と signatureHeader が揃っていれば通る", () => {
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
