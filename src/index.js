// Worker の入口。HTTP と Cron の2つの経路がある。
//
//   fetch     Webhook を受け取る / 退避の一覧と再送
//   scheduled 配送待ちを掃いて再試行する
//
// 受け取りの経路では、送信元への応答を何よりも優先する。署名検証と
// KV への書き込みだけを待ち、配送は waitUntil に逃がす。転送先が
// 遅くても、送信元には常に速く 200 が返る。

import { isDue } from "./backoff.js";
import { ConfigError, loadEndpoints } from "./config.js";
import { attemptDelivery, createDelivery, decideNext } from "./delivery.js";
import { eventIdentity, newDeliveryId } from "./identity.js";
import { verify } from "./signature.js";
import { Store } from "./store.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** 配送の結果を反映する。decideNext の判断をそのまま実行するだけ。 */
async function applyOutcome(store, endpointId, decision) {
  const { action, delivery } = decision;
  if (action === "done") {
    await store.deletePending(endpointId, delivery.deliveryId);
  } else if (action === "dead") {
    await store.deletePending(endpointId, delivery.deliveryId);
    await store.putDead(endpointId, delivery);
  } else {
    await store.putPending(endpointId, delivery);
  }
}

/** 1件を配送し、結果を反映する。 */
async function deliverOnce(store, endpoint, delivery, now, fetchImpl) {
  const result = await attemptDelivery(
    delivery,
    { url: endpoint.targetUrl, headers: endpoint.headers },
    fetchImpl,
  );
  const decision = decideNext(delivery, result, now);
  await applyOutcome(store, endpoint.id, decision);
  return decision;
}

async function handleHook(request, endpoint, store, ctx, now, fetchImpl) {
  const body = await request.text();

  if (endpoint.secret) {
    const provided = request.headers.get(endpoint.signatureHeader);
    if (!(await verify(endpoint.secret, body, provided))) {
      // 署名が合わないものは受け取らない。ここだけは 401 を返す。
      return json({ error: "signature verification failed" }, 401);
    }
  }

  const { id: eventId, source } = await eventIdentity(
    request.headers,
    body,
    endpoint.idHeaders,
  );

  // 既に受け取っているなら、そこで終わる。送信元には成功を返す。
  // ここで 200 を返さないと、送信元は再送を続ける。
  if (await store.hasSeen(endpoint.id, eventId)) {
    return json({ status: "duplicate", eventId });
  }

  const delivery = createDelivery({
    deliveryId: newDeliveryId(),
    eventId,
    body,
    contentType: request.headers.get("content-type"),
    receivedAt: now,
  });

  // 配送待ちとして記録してから応答する。ここまでが「落とさない」の担保。
  await store.putPending(endpoint.id, delivery);
  await store.markSeen(endpoint.id, eventId, delivery.deliveryId);

  // 1回目の配送は応答を待たせない。成功しても失敗しても 202 を返す。
  ctx.waitUntil(deliverOnce(store, endpoint, delivery, now, fetchImpl));

  return json(
    { status: "accepted", deliveryId: delivery.deliveryId, eventId, eventIdSource: source },
    202,
  );
}

async function handleDeadLetters(endpoint, store, url) {
  const limit = Number(url.searchParams.get("limit") || 100);
  const items = await store.listDead(endpoint.id, Math.min(limit, 1000));
  return json({
    endpoint: endpoint.id,
    count: items.length,
    // 本文は大きいことがあるので一覧では返さない。個別に取りに来てもらう。
    items: items.map(({ body, ...rest }) => ({ ...rest, bodyBytes: body?.length ?? 0 })),
  });
}

async function handleReplay(endpoint, store, deliveryId, ctx, now, fetchImpl) {
  const dead = await store.getDead(endpoint.id, deliveryId);
  if (!dead) return json({ error: "not found" }, 404);

  // 試行回数を戻して配送待ちへ返す。退避したまま消さないのは、
  // 再送が失敗したときに元が残っていないと困るため。
  const revived = { ...dead, attempts: 0, nextAt: now, lastError: null, lastStatus: null };
  await store.putPending(endpoint.id, revived);
  ctx.waitUntil(
    deliverOnce(store, endpoint, revived, now, fetchImpl).then(async (decision) => {
      if (decision.action === "done") await store.deleteDead(endpoint.id, deliveryId);
    }),
  );
  return json({ status: "replaying", deliveryId });
}

export default {
  async fetch(request, env, ctx) {
    let endpoints;
    try {
      endpoints = loadEndpoints(env);
    } catch (error) {
      if (error instanceof ConfigError) {
        return json({ error: `設定エラー: ${error.message}` }, 500);
      }
      throw error;
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const store = new Store(env.WEBHOOKS);
    const now = Date.now();

    if (parts.length === 0) {
      return json({
        name: "durable-webhook",
        endpoints: [...endpoints.keys()],
      });
    }

    const [root, id, ...rest] = parts;
    const endpoint = endpoints.get(id);
    if (!endpoint) return json({ error: "unknown endpoint" }, 404);

    if (root === "hook" && request.method === "POST" && rest.length === 0) {
      return handleHook(request, endpoint, store, ctx, now, env.FETCH || fetch);
    }
    if (root === "dead-letters" && request.method === "GET" && rest.length === 0) {
      return handleDeadLetters(endpoint, store, url);
    }
    if (root === "dead-letters" && request.method === "POST" && rest[1] === "replay") {
      return handleReplay(endpoint, store, rest[0], ctx, now, env.FETCH || fetch);
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    const endpoints = loadEndpoints(env);
    const store = new Store(env.WEBHOOKS);
    const now = Date.now();

    for (const endpoint of endpoints.values()) {
      const pending = await store.listPending(endpoint.id);
      // 期限が来ているものだけを拾う。まだ待つべきものは触らない。
      const due = pending.filter((p) => isDue(p, now));
      for (const delivery of due) {
        ctx.waitUntil(deliverOnce(store, endpoint, delivery, now, env.FETCH || fetch));
      }
    }
  },
};
