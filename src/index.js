// The Worker's entry point. Two ways in: HTTP and cron.
//
//   fetch     receives webhooks, lists and replays dead letters (ADMIN_TOKEN)
//   scheduled sweeps the pending deliveries and retries them
//
// On the receiving path the response to the sender comes before anything else.
// Only the signature check and the write to KV are awaited; the delivery goes
// to waitUntil. However slow the destination is, the sender always gets a
// prompt 200.

import { checkAdmin } from "./admin.js";
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

/** Write down what happened — nothing but carrying out decideNext's decision. */
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

/** Deliver one, and record the outcome. */
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
      // A signature that does not match is not accepted. This is the one place
      // that answers 401.
      return json({ error: "signature verification failed" }, 401);
    }
  }

  const { id: eventId, source } = await eventIdentity(
    request.headers,
    body,
    endpoint.idHeaders,
  );

  // Already have it: stop here, and tell the sender it went fine. Anything
  // other than a 200 and the sender keeps retrying.
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

  // Recorded as pending before responding. That write is what "nothing gets
  // dropped" actually rests on.
  await store.putPending(endpoint.id, delivery);
  await store.markSeen(endpoint.id, eventId, delivery.deliveryId);

  // The first attempt does not hold up the response. Success or failure, the
  // answer is 202.
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
    // Bodies can be large, so the list leaves them out. Fetch one to see it.
    items: items.map(({ body, ...rest }) => ({ ...rest, bodyBytes: body?.length ?? 0 })),
  });
}

async function handleReplay(endpoint, store, deliveryId, ctx, now, fetchImpl) {
  const dead = await store.getDead(endpoint.id, deliveryId);
  if (!dead) return json({ error: "not found" }, 404);

  // Put the attempt count back and return it to pending. The dead letter stays
  // where it is: if the replay fails too, having lost the original would be
  // the worse outcome.
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
        return json({ error: `configuration error: ${error.message}` }, 500);
      }
      throw error;
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const store = new Store(env.WEBHOOKS);
    const now = Date.now();

    if (parts.length === 0) {
      // Proof of life, and nothing else. The endpoint ids are not listed:
      // whoever operates this configured them and does not need telling, and
      // to anyone outside the list would answer which /hook/:id are live.
      return json({ name: "durable-webhook", status: "ok", endpoints: endpoints.size });
    }

    const [root, id, ...rest] = parts;

    if (root === "hook" && request.method === "POST" && rest.length === 0) {
      const endpoint = endpoints.get(id);
      if (!endpoint) return json({ error: "unknown endpoint" }, 404);
      return handleHook(request, endpoint, store, ctx, now, env.FETCH || fetch);
    }

    // Listing and replaying are for whoever operates this, and a sender's
    // signature cannot protect them, so they get a key of their own. The
    // authentication happens before the id is looked at, so that the
    // difference between 404 and 401 cannot be used to guess a live id.
    if (root === "dead-letters") {
      const auth = checkAdmin(request, env);
      if (!auth.ok) return json({ error: auth.error }, auth.status);

      const endpoint = endpoints.get(id);
      if (!endpoint) return json({ error: "unknown endpoint" }, 404);

      if (request.method === "GET" && rest.length === 0) {
        return handleDeadLetters(endpoint, store, url);
      }
      if (request.method === "POST" && rest[1] === "replay") {
        return handleReplay(endpoint, store, rest[0], ctx, now, env.FETCH || fetch);
      }
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    const endpoints = loadEndpoints(env);
    const store = new Store(env.WEBHOOKS);
    const now = Date.now();

    for (const endpoint of endpoints.values()) {
      const pending = await store.listPending(endpoint.id);
      // Only the ones that are due. The rest are still waiting, and are left
      // alone.
      const due = pending.filter((p) => isDue(p, now));
      for (const delivery of due) {
        ctx.waitUntil(deliverOnce(store, endpoint, delivery, now, env.FETCH || fetch));
      }
    }
  },
};
