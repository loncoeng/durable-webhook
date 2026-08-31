// 「同じイベントかどうか」を決める。
//
// 送信元は再送してくる。転送先が二重に処理すると、課金が2回走ったり
// 通知が2回飛んだりする。受け取った時点で弾くのが一番安全で、
// そのためには「同じ」の定義が要る。
//
// 送信元がイベントIDを付けているならそれを使う。付けていない相手も
// いるので、その場合は本文のハッシュで代用する。
//
// 本文ハッシュには弱点がある。中身が同じで意味が違う2つのイベント
// （例: 同じ内容の「いいね」が別々に2回）を同一視してしまう。それでも、
// 二重配送より取りこぼしの方がましな場面は多い。どちらを選ぶかは
// 設定で決められるようにしてある。

const encoder = new TextEncoder();

/** 本文の SHA-256 を16進で返す。 */
export async function hashBody(body) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * このイベントを一意に指す文字列を決める。
 *
 * @param {Headers} headers
 * @param {string} body
 * @param {string[]} idHeaders 優先順に見るヘッダ名
 * @returns {Promise<{ id: string, source: "header"|"body-hash" }>}
 */
export async function eventIdentity(headers, body, idHeaders = []) {
  for (const name of idHeaders) {
    const value = headers.get(name);
    if (value && value.trim()) {
      return { id: value.trim(), source: "header" };
    }
  }
  return { id: await hashBody(body), source: "body-hash" };
}

/** 配送1件を指す ID。重複排除とは別で、こちらは常に一意。 */
export function newDeliveryId() {
  return crypto.randomUUID();
}
