// Tests for the admin paths' authentication.
//
// Loose here and the dead-letter list shows what is being operated, and the
// replay path is reachable from outside. A replay makes the destination
// process an event twice. It would mean the accident this tool exists to
// prevent could be caused from outside it.

import assert from "node:assert/strict";
import test from "node:test";

import { checkAdmin } from "../src/admin.js";

const TOKEN = "s3cr3t-admin-token";
const req = (authorization) =>
  new Request("https://example.com/dead-letters/demo", {
    headers: authorization === undefined ? {} : { authorization },
  });

test("the right token gets through", () => {
  assert.deepEqual(checkAdmin(req(`Bearer ${TOKEN}`), { ADMIN_TOKEN: TOKEN }), { ok: true });
});

test("the wrong token does not", () => {
  const result = checkAdmin(req("Bearer wrong"), { ADMIN_TOKEN: TOKEN });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("no header at all does not", () => {
  assert.equal(checkAdmin(req(undefined), { ADMIN_TOKEN: TOKEN }).status, 401);
});

test("anything that is not Bearer does not", () => {
  for (const header of ["Basic abc", TOKEN, "Bearer", "Bearer   "]) {
    const result = checkAdmin(req(header), { ADMIN_TOKEN: TOKEN });
    assert.equal(result.ok, false, `${JSON.stringify(header)} was accepted`);
  }
});

test("the case of Bearer does not matter", () => {
  // Depending on who is sending, it arrives as bearer or BEARER.
  for (const prefix of ["bearer", "BEARER", "BeArEr"]) {
    assert.equal(checkAdmin(req(`${prefix} ${TOKEN}`), { ADMIN_TOKEN: TOKEN }).ok, true);
  }
});

test("surrounding whitespace is ignored", () => {
  assert.equal(checkAdmin(req(`  Bearer  ${TOKEN}  `), { ADMIN_TOKEN: TOKEN }).ok, true);
});

// --- what happens when it is not configured ---

test("with ADMIN_TOKEN unset, even a plausible token is refused", () => {
  // Not working beats working wide open: nobody notices an open door,
  // everybody notices a closed one.
  for (const env of [{}, { ADMIN_TOKEN: "" }, { ADMIN_TOKEN: "   " }, { ADMIN_TOKEN: null }]) {
    const result = checkAdmin(req("Bearer anything"), env);
    assert.equal(result.ok, false, `${JSON.stringify(env)} was accepted`);
    assert.equal(result.status, 503);
  }
});

test("unset does not let an empty header through", () => {
  // An implementation where "unset" and "the token is empty" meet is an
  // implementation that passes everything.
  assert.equal(checkAdmin(req(undefined), {}).ok, false);
  assert.equal(checkAdmin(req("Bearer "), { ADMIN_TOKEN: "" }).ok, false);
});
