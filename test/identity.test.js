// 「同じイベントか」の判定に対する検査。
//
// ここが崩れると、同じ支払い通知が2回転送されたり、逆に別々の
// イベントが1つに潰れたりする。どちらも転送先で実害が出る。

import assert from "node:assert/strict";
import test from "node:test";

import { eventIdentity, hashBody, newDeliveryId } from "../src/identity.js";

const headers = (obj) => new Headers(obj);

test("指定したヘッダからイベントIDを取る", async () => {
  const result = await eventIdentity(
    headers({ "x-github-delivery": "abc-123" }),
    "{}",
    ["x-github-delivery"],
  );
  assert.equal(result.id, "abc-123");
  assert.equal(result.source, "header");
});

test("ヘッダは指定した順に見る", async () => {
  // 送信元によって使うヘッダが違う。優先順を設定で決められるようにしてある。
  const result = await eventIdentity(
    headers({ "x-second": "two", "x-first": "one" }),
    "{}",
    ["x-first", "x-second"],
  );
  assert.equal(result.id, "one");
});

test("空のヘッダは飛ばして次を見る", async () => {
  const result = await eventIdentity(
    headers({ "x-first": "   ", "x-second": "two" }),
    "{}",
    ["x-first", "x-second"],
  );
  assert.equal(result.id, "two");
});

test("ヘッダが無ければ本文のハッシュを使う", async () => {
  const body = '{"event":"ping"}';
  const result = await eventIdentity(headers({}), body, ["x-missing"]);
  assert.equal(result.source, "body-hash");
  assert.equal(result.id, await hashBody(body));
});

test("同じ本文からは同じハッシュが出る", async () => {
  assert.equal(await hashBody("same"), await hashBody("same"));
});

test("本文が違えばハッシュが変わる", async () => {
  assert.notEqual(await hashBody('{"a":1}'), await hashBody('{"a":2}'));
});

test("ハッシュは64文字の16進", async () => {
  assert.match(await hashBody("x"), /^[0-9a-f]{64}$/);
});

test("配送IDは毎回異なる", () => {
  // イベントIDと違い、こちらは配送1件ごとに一意。
  // 同じイベントを再送したときの区別に要る。
  const ids = new Set([newDeliveryId(), newDeliveryId(), newDeliveryId()]);
  assert.equal(ids.size, 3);
});
