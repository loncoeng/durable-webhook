// 配送の状態遷移に対する検査。
//
// このプロジェクトの中心。「いつ再試行して、いつ諦めて、諦めたものを
// どう扱うか」がここで決まる。decideNext を保存処理から切り離してあるので、
// KV も HTTP もなしで検査できる。

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

test("成功したら配送待ちから外す", () => {
  const decision = decideNext(pending(), ok, NOW);
  assert.equal(decision.action, "done");
  assert.equal(decision.delivery.attempts, 1);
});

test("5xx は一時的とみなして再試行する", () => {
  const decision = decideNext(pending(), serverError, NOW);
  assert.equal(decision.action, "retry");
  assert.equal(decision.delivery.nextAt, NOW + BACKOFF_MS[0]);
});

test("通信エラーも再試行する", () => {
  // 相手が落ちているだけのことが多い。内容の問題ではない。
  assert.equal(decideNext(pending(), networkError, NOW).action, "retry");
});

test("4xx は再試行せず退避する", () => {
  // 転送先が「この内容は受け取れない」と言っている。
  // 何度送っても結果は変わらないので、回数を無駄にしない。
  const decision = decideNext(pending(), clientError, NOW);
  assert.equal(decision.action, "dead");
  assert.equal(decision.delivery.nextAt, null);
  assert.match(decision.reason, /422/);
});

test("408 と 429 は 4xx でも再試行する", () => {
  // 時間を空ければ通る種類の 4xx。ここを一律に扱うと取りこぼす。
  for (const status of [408, 429]) {
    const result = { ok: false, status, error: `HTTP ${status}`, retryable: true };
    assert.equal(decideNext(pending(), result, NOW).action, "retry", `status=${status}`);
  }
});

test("再試行の間隔は回を追うごとに広がる", () => {
  // 等間隔にしない。一時的な不調は早く拾い、長期の障害では無駄に叩かない。
  let delivery = pending();
  const waits = [];
  for (let i = 0; i < BACKOFF_MS.length; i += 1) {
    const decision = decideNext(delivery, serverError, NOW);
    waits.push(decision.delivery.nextAt - NOW);
    delivery = decision.delivery;
  }
  assert.deepEqual(waits, BACKOFF_MS);
  for (let i = 1; i < waits.length; i += 1) {
    assert.ok(waits[i] > waits[i - 1], "間隔が広がっていない");
  }
});

test("上限まで試したら退避する", () => {
  let delivery = pending();
  let decision;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    decision = decideNext(delivery, serverError, NOW);
    delivery = decision.delivery;
  }
  assert.equal(decision.action, "dead");
  assert.equal(delivery.attempts, MAX_ATTEMPTS);
});

test("退避しても本文は保持する", () => {
  // 消してしまうと後から再送できない。捨てるかどうかは人間が決める。
  const decision = decideNext(pending(), clientError, NOW);
  assert.equal(decision.delivery.body, '{"hello":"world"}');
  assert.equal(decision.delivery.eventId, "e1");
});

test("最後の結果を記録する", () => {
  // なぜ届かなかったのかが残っていないと、人間が判断できない。
  const decision = decideNext(pending(), serverError, NOW);
  assert.equal(decision.delivery.lastStatus, 503);
  assert.equal(decision.delivery.lastError, "HTTP 503");
  assert.equal(decision.delivery.lastAttemptAt, NOW);
});

test("元の配送レコードを書き換えない", () => {
  // 呼び出し側が古い値を持ち続けても壊れないようにする。
  const original = pending();
  decideNext(original, serverError, NOW);
  assert.equal(original.attempts, 0);
  assert.equal(original.lastError, null);
});

// --- attemptDelivery ---

test("転送先へ POST し、配送IDと試行回数を渡す", async () => {
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
  // 「今から何回目か」を渡す。受け取る側が再送だと気付ける。
  assert.equal(seen.init.headers["x-durable-webhook-attempt"], "3");
  assert.equal(seen.init.headers["x-token"], "t");
});

test("5xx は retryable として返す", async () => {
  const fake = async () => new Response("", { status: 502 });
  const result = await attemptDelivery(pending(), { url: "https://example.com" }, fake);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});

test("4xx は retryable でないと返す", async () => {
  const fake = async () => new Response("", { status: 400 });
  const result = await attemptDelivery(pending(), { url: "https://example.com" }, fake);
  assert.equal(result.retryable, false);
});

test("例外は通信の失敗として扱う", async () => {
  const fake = async () => { throw new Error("connection refused"); };
  const result = await attemptDelivery(pending(), { url: "https://example.com" }, fake);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.error, /connection refused/);
});

test("中断はタイムアウトとして記録する", async () => {
  const fake = async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  const result = await attemptDelivery(pending(), { url: "https://example.com" }, fake);
  assert.equal(result.error, "timeout");
  assert.equal(result.retryable, true);
});
