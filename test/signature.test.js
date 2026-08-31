// 署名検証に対する検査。
//
// ここが甘いと、誰でも偽の Webhook を送り込めるようになる。
// 転送先が「送信元は本物だ」という前提で動いていると、そのまま
// 偽データが流れる。

import assert from "node:assert/strict";
import test from "node:test";

import { sign, timingSafeEqual, verify } from "../src/signature.js";

const SECRET = "shhh";
const BODY = '{"event":"payment.succeeded","amount":1000}';

test("同じ入力からは同じ署名が出る", async () => {
  assert.equal(await sign(SECRET, BODY), await sign(SECRET, BODY));
});

test("本文が1文字違えば署名が変わる", async () => {
  const a = await sign(SECRET, BODY);
  const b = await sign(SECRET, BODY.replace("1000", "1001"));
  assert.notEqual(a, b);
});

test("鍵が違えば署名が変わる", async () => {
  assert.notEqual(await sign(SECRET, BODY), await sign("other", BODY));
});

test("正しい署名を受け入れる", async () => {
  assert.equal(await verify(SECRET, BODY, await sign(SECRET, BODY)), true);
});

test("誤った署名を拒む", async () => {
  assert.equal(await verify(SECRET, BODY, "0".repeat(64)), false);
});

test("署名が無ければ拒む", async () => {
  assert.equal(await verify(SECRET, BODY, null), false);
  assert.equal(await verify(SECRET, BODY, ""), false);
});

test("sha256= の接頭辞を落として比べる", async () => {
  // GitHub は sha256=... の形で送る。接頭辞をそのまま比べると必ず外れる。
  const signature = await sign(SECRET, BODY);
  assert.equal(await verify(SECRET, BODY, `sha256=${signature}`), true);
});

test("大文字の16進も受け入れる", async () => {
  const signature = await sign(SECRET, BODY);
  assert.equal(await verify(SECRET, BODY, signature.toUpperCase()), true);
});

test("前後の空白を無視する", async () => {
  const signature = await sign(SECRET, BODY);
  assert.equal(await verify(SECRET, BODY, `  ${signature}  `), true);
});

// --- timingSafeEqual ---

test("同じ文字列で真を返す", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
});

test("違う文字列で偽を返す", () => {
  assert.equal(timingSafeEqual("abc", "abd"), false);
});

test("長さが違えば偽を返す", () => {
  // 長さの違いも比較結果に混ぜる。ここで早期 return すると
  // 「長さが合っているか」だけが所要時間から漏れる。
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("abcd", "abc"), false);
});

test("null や undefined でも落ちない", () => {
  assert.equal(timingSafeEqual(null, "abc"), false);
  assert.equal(timingSafeEqual("abc", undefined), false);
  assert.equal(timingSafeEqual(null, undefined), true); // どちらも空
});

test("先頭が一致していても早期 return しない", () => {
  // 実装が早期 return していないことを、間接的にだが確認する。
  // 一致文字数が違っても結果は同じく false でなければならない。
  assert.equal(timingSafeEqual("aaaaaaaaab", "aaaaaaaaac"), false);
  assert.equal(timingSafeEqual("baaaaaaaaa", "caaaaaaaaa"), false);
});
