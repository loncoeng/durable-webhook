// 管理系の経路の認証に対する検査。
//
// ここが緩いと、退避の一覧から運用の中身が見え、再送を外から叩かれる。
// 再送を叩かれると転送先で二重処理が起きる。このツールが防ぐために
// 作られた事故を、外から起こせることになる。

import assert from "node:assert/strict";
import test from "node:test";

import { checkAdmin } from "../src/admin.js";

const TOKEN = "s3cr3t-admin-token";
const req = (authorization) =>
  new Request("https://example.com/dead-letters/demo", {
    headers: authorization === undefined ? {} : { authorization },
  });

test("正しいトークンを通す", () => {
  assert.deepEqual(checkAdmin(req(`Bearer ${TOKEN}`), { ADMIN_TOKEN: TOKEN }), { ok: true });
});

test("誤ったトークンを拒む", () => {
  const result = checkAdmin(req("Bearer wrong"), { ADMIN_TOKEN: TOKEN });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("ヘッダが無ければ拒む", () => {
  assert.equal(checkAdmin(req(undefined), { ADMIN_TOKEN: TOKEN }).status, 401);
});

test("Bearer でない形式は拒む", () => {
  for (const header of ["Basic abc", TOKEN, "Bearer", "Bearer   "]) {
    const result = checkAdmin(req(header), { ADMIN_TOKEN: TOKEN });
    assert.equal(result.ok, false, `${JSON.stringify(header)} が通ってしまった`);
  }
});

test("Bearer の大小は問わない", () => {
  // 送る側の実装によって bearer だったり BEARER だったりする。
  for (const prefix of ["bearer", "BEARER", "BeArEr"]) {
    assert.equal(checkAdmin(req(`${prefix} ${TOKEN}`), { ADMIN_TOKEN: TOKEN }).ok, true);
  }
});

test("前後の空白を無視する", () => {
  assert.equal(checkAdmin(req(`  Bearer  ${TOKEN}  `), { ADMIN_TOKEN: TOKEN }).ok, true);
});

// --- 未設定のときの振る舞い ---

test("ADMIN_TOKEN が未設定なら、正しく見えるトークンでも通さない", () => {
  // 開いたまま動くより、動かない方がいい。開いていることには誰も
  // 気付けないが、動かないことにはすぐ気付く。
  for (const env of [{}, { ADMIN_TOKEN: "" }, { ADMIN_TOKEN: "   " }, { ADMIN_TOKEN: null }]) {
    const result = checkAdmin(req("Bearer anything"), env);
    assert.equal(result.ok, false, `${JSON.stringify(env)} で通ってしまった`);
    assert.equal(result.status, 503);
  }
});

test("未設定のとき、空のヘッダで通ってしまわない", () => {
  // 「未設定」と「トークンが空」が一致してしまう実装だと素通しになる。
  assert.equal(checkAdmin(req(undefined), {}).ok, false);
  assert.equal(checkAdmin(req("Bearer "), { ADMIN_TOKEN: "" }).ok, false);
});
