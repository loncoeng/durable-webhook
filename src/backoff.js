// 再試行の間隔を決める。
//
// 等間隔にしない。一時的な不調なら早い再試行で拾えるし、長期の障害で
// 1分おきに叩き続けるのは相手にも自分にも無駄でしかない。前half は短く、
// 後half は長く空ける。
//
// 上限を超えたものは捨てずに退避する。捨てるかどうかは人間が決める。

/** 試行 n 回目の後、次に試みるまでの待ち時間（ミリ秒）。 */
export const BACKOFF_MS = [
  60_000,        // 1分
  5 * 60_000,    // 5分
  15 * 60_000,   // 15分
  60 * 60_000,   // 1時間
  6 * 60 * 60_000, // 6時間
];

export const MAX_ATTEMPTS = BACKOFF_MS.length + 1; // 初回 + 再試行5回

/**
 * 次に配送を試みる時刻を返す。もう試さないなら null。
 *
 * @param {number} attempts これまでに試した回数（初回配送を含む）
 * @param {number} now      現在時刻（ミリ秒）
 * @returns {number|null}
 */
export function nextAttemptAt(attempts, now) {
  if (attempts < 1) {
    throw new RangeError("attempts は 1 以上でなければならない");
  }
  const index = attempts - 1;
  if (index >= BACKOFF_MS.length) return null;
  return now + BACKOFF_MS[index];
}

/** これ以上試さないかどうか。 */
export function isExhausted(attempts) {
  return attempts >= MAX_ATTEMPTS;
}

/**
 * 配送待ちが、今の時刻で試行対象になるか。
 *
 * nextAt を過ぎているものだけを拾う。Cron は数分おきに回るので、
 * 少し過ぎている程度は普通に起こる。
 */
export function isDue(pending, now) {
  return typeof pending?.nextAt === "number" && pending.nextAt <= now;
}
