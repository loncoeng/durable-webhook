// 管理系の経路（退避の一覧と再送）に対する認証。
//
// この2つは受け取りの経路と性格が違う。署名は「送信元が本物か」を
// 確かめるもので、送信元しか鍵を持たない。一方こちらは運用者が叩く。
// 送信元の鍵で守るわけにいかないので、別の鍵を用意する。
//
// 特に再送は、外から叩けると転送先で二重処理を起こせる。このツールが
// 防ぐために作られた事故を、外から起こせることになる。

import { timingSafeEqual } from "./signature.js";

/**
 * 管理系の経路を許してよいか判定する。
 *
 * 通ってよければ null を返す。駄目なら理由を持った Response を返す。
 *
 * ADMIN_TOKEN が未設定のときは通さない。設定し忘れた運用者に対して
 * 開いたまま動くより、動かない方がいい。開いていることには誰も
 * 気付けないが、動かないことにはすぐ気付く。
 */
export function checkAdmin(request, env) {
  const expected = typeof env.ADMIN_TOKEN === "string" ? env.ADMIN_TOKEN.trim() : "";
  if (!expected) return { ok: false, status: 503, error: "ADMIN_TOKEN が未設定" };

  const provided = extractToken(request.headers.get("authorization"));
  if (!provided) return { ok: false, status: 401, error: "認証が必要" };
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, error: "認証に失敗" };
  }
  return { ok: true };
}

/** "Bearer xxx" から xxx を取り出す。形式が違えば null。 */
function extractToken(header) {
  if (typeof header !== "string") return null;
  const match = header.trim().match(/^Bearer[ \t]+(.+)$/i);
  return match ? match[1].trim() || null : null;
}
