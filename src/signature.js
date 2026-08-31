// 送信元が本物かを HMAC-SHA256 で確かめる。
//
// 検証は必須にしない。署名を付けない送信元があるためで、必須にすると
// そういう相手を扱えなくなる。設定されているときだけ検証する。
//
// 比較には定数時間の関数を使う。素朴な === だと、一致した文字数によって
// 処理時間が変わり、そこから正しい署名を1文字ずつ推測できてしまう。

const encoder = new TextEncoder();

/**
 * 本文の HMAC-SHA256 を16進で返す。
 *
 * @param {string} secret
 * @param {string} body
 * @returns {Promise<string>}
 */
export async function sign(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 長さと内容を、経過時間で差が出ない形で比べる。
 *
 * 早期 return を書かないのが要点。長さが違う場合も最後まで回す。
 */
export function timingSafeEqual(a, b) {
  const left = encoder.encode(a ?? "");
  const right = encoder.encode(b ?? "");
  // 長さの違いも結果に含める。ここで return すると長さが漏れる。
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * 送られてきた署名が正しいか。
 *
 * 送信元によって `sha256=` のような接頭辞を付けるものがあるので落とす。
 *
 * @param {string} secret
 * @param {string} body
 * @param {string|null} provided ヘッダから取り出した署名
 */
export async function verify(secret, body, provided) {
  if (!provided) return false;
  const cleaned = provided.includes("=") ? provided.split("=").pop() : provided;
  const expected = await sign(secret, body);
  return timingSafeEqual(expected, cleaned.trim().toLowerCase());
}
