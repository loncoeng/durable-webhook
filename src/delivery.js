// 配送そのもの。1件を転送先へ送り、結果に応じて次の状態を決める。
//
// ここが状態機械の中心になる。
//
//   受け取り → 配送待ち ─成功→ 消す
//                  │
//                  └─失敗→ 回数を増やして待つ ─上限→ 退避
//
// 失敗の扱いを分けているのが要点。4xx は転送先が「この内容は受け取れない」
// と言っているので、何度送っても同じ。再試行せず退避へ回す。5xx や
// ネットワークエラーは一時的なことが多いので再試行する。

import { isExhausted, nextAttemptAt } from "./backoff.js";

/** 転送先へ送るときのタイムアウト。応答しない相手で実行時間を使い切らない。 */
export const TIMEOUT_MS = 10_000;

/**
 * 1回だけ配送を試みる。
 *
 * @returns {Promise<{ ok: boolean, status: number|null, error: string|null, retryable: boolean }>}
 */
export async function attemptDelivery(delivery, target, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers: {
        "content-type": delivery.contentType || "application/json",
        "x-durable-webhook-delivery": delivery.deliveryId,
        "x-durable-webhook-attempt": String(delivery.attempts + 1),
        ...(target.headers || {}),
      },
      body: delivery.body,
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
      // 4xx は内容の問題。送り直しても結果は変わらない。
      // 408 と 429 だけは例外で、時間を空ければ通る。
      retryable:
        response.ok ||
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 429,
    };
  } catch (error) {
    // 通信の失敗とタイムアウト。相手が落ちているだけのことが多い。
    return {
      ok: false,
      status: null,
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 配送の結果から、次にどうするかを決める。
 *
 * 保存や削除はここでは行わない。判断だけを返し、実行は呼び出し側に
 * 任せる。こうしておくと、この関数を KV なしで検査できる。
 *
 * @returns {{ action: "done"|"retry"|"dead", delivery: object, reason: string }}
 */
export function decideNext(delivery, result, now) {
  const attempts = delivery.attempts + 1;
  const updated = {
    ...delivery,
    attempts,
    lastStatus: result.status,
    lastError: result.error,
    lastAttemptAt: now,
  };

  if (result.ok) {
    return { action: "done", delivery: updated, reason: "配送に成功" };
  }

  if (!result.retryable) {
    return {
      action: "dead",
      delivery: { ...updated, nextAt: null },
      reason: `転送先が ${result.status} を返した。内容の問題なので再試行しない`,
    };
  }

  if (isExhausted(attempts)) {
    return {
      action: "dead",
      delivery: { ...updated, nextAt: null },
      reason: `${attempts} 回試して届かなかった`,
    };
  }

  return {
    action: "retry",
    delivery: { ...updated, nextAt: nextAttemptAt(attempts, now) },
    reason: result.error || "一時的な失敗",
  };
}

/** 受け取った時点の配送レコードを作る。 */
export function createDelivery({ deliveryId, eventId, body, contentType, receivedAt }) {
  return {
    deliveryId,
    eventId,
    body,
    contentType: contentType || "application/json",
    receivedAt,
    attempts: 0,
    nextAt: receivedAt,
    lastStatus: null,
    lastError: null,
    lastAttemptAt: null,
  };
}
