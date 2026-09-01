# durable-webhook

[![test](https://github.com/lon-coeng/durable-webhook/actions/workflows/test.yml/badge.svg)](https://github.com/lon-coeng/durable-webhook/actions/workflows/test.yml)

*[日本語版 / Japanese version](README.ja.md)*

A webhook relay on Cloudflare Workers that **accepts fast and delivers stubbornly.**

Runs on the free tier. No dependencies at runtime.

---

## The problem

A webhook sender — LINE, Stripe, GitHub — gives you a few seconds to return `200`.
Miss that window and it retries a handful of times, then gives up. Your app,
meanwhile, is occasionally down: thirty seconds during a deploy, a database hiccup,
an unlucky cold start.

```
sender → your app (down)
         ↓
       500, or nothing at all
         ↓
       sender retries a few times, then stops
         ↓
       that event is gone
```

The fix is to stop treating *receiving* and *delivering* as one act. Receive always.
Deliver later, and keep trying.

## What it does

```
POST /hook/:id
  ↓  verify the signature, if one is configured
  ↓  seen this event id before? → return 200 and stop
  ↓  write the delivery to KV
  ↓  return 202                       ← tens of milliseconds
  ↓
  (in the background) attempt delivery
  ↓  failed? leave it pending
  ↓
Cron sweeps pending deliveries and retries with growing backoff
  ↓  out of attempts? move to dead letters — never discard
  ↓
GET  /dead-letters/:id          list what did not make it
POST /dead-letters/:id/:did/replay   send it again
     ^ both are operator routes, and require ADMIN_TOKEN
```

## Decisions worth explaining

**A `200` means "received", not "delivered."** Conflating them makes a slow
destination look like a failure to the sender, which starts the retry storm you were
trying to avoid.

**Retries live in Cron, not in the request.** A Worker has an execution limit. You
cannot wait an hour inside one invocation. Pending deliveries go to KV; a scheduled
job sweeps them.

**Backoff grows: 1m → 5m → 15m → 1h → 6h.** Even intervals are wrong in both
directions. A momentary blip clears in a minute; an outage lasting hours does not
deserve to be hammered every minute.

**Not every failure deserves a retry.** A `4xx` means the destination has looked at
the payload and refused it — sending the same bytes again changes nothing, so it goes
straight to dead letters. `408` and `429` are the exceptions: those clear with time.

**Duplicates are rejected at the door.** Senders resend. If the destination processes
the same event twice, someone gets charged twice. The event id is taken from a header
you configure, or from a hash of the body when the sender provides none.

**Operator routes get their own key.** Listing dead letters and replaying them are
things an operator does, and the sender's signing secret cannot protect them. Replay
especially: reachable from outside, it lets anyone force a duplicate at the
destination — the exact accident this tool exists to prevent. When `ADMIN_TOKEN` is
unset those routes return `503` rather than opening. Nobody notices an endpoint that
is open; everybody notices one that is broken.

**Nothing is ever discarded.** Deliveries that exhaust their attempts are moved to
dead letters and kept, with the body intact, so a human can look and decide. Deleting
them would make the failure invisible, which is the one outcome worse than failing.

## Setup

```sh
npm install
npx wrangler kv namespace create WEBHOOKS   # put the id in wrangler.toml
npx wrangler secret put ENDPOINTS
npx wrangler secret put ADMIN_TOKEN         # for listing and replaying dead letters
npx wrangler deploy
```

`ENDPOINTS` is JSON. It holds destination URLs and signing secrets, so it belongs in
a secret rather than in `wrangler.toml`.

```json
[
  {
    "id": "github",
    "targetUrl": "https://app.example.com/webhooks/github",
    "secret": "the shared secret",
    "signatureHeader": "x-hub-signature-256",
    "idHeaders": ["x-github-delivery"]
  },
  {
    "id": "internal",
    "targetUrl": "https://app.example.com/webhooks/internal",
    "headers": { "authorization": "Bearer ..." }
  }
]
```

Point the sender at `https://<your-worker>.workers.dev/hook/github`.

## Try it

```sh
npx wrangler dev

curl -X POST http://localhost:8787/hook/demo \
  -H 'content-type: application/json' \
  -H 'x-request-id: evt_1' \
  -d '{"hello":"world"}'
# {"status":"accepted","deliveryId":"...","eventId":"evt_1"}

# the same event id again
curl -X POST http://localhost:8787/hook/demo \
  -H 'x-request-id: evt_1' -d '{"hello":"world"}'
# {"status":"duplicate","eventId":"evt_1"}

# dead letters — requires ADMIN_TOKEN
curl http://localhost:8787/dead-letters/demo \
  -H 'authorization: Bearer <ADMIN_TOKEN>'
```

Point `targetUrl` at something that returns `500` and watch the delivery move through
retries into dead letters.

## What it is not

**Not ordered.** Deliveries are independent. Guaranteeing order needs Durable
Objects, and order was not the problem being solved here.

**Not fan-out.** One endpoint, one destination. Multiple destinations would mean
per-destination retry state, and the complexity is not worth it for this.

**Not a queue.** Cloudflare Queues is the right primitive for this and would be
simpler — but it needs a paid plan. KV plus Cron stays inside the free tier. At
real volume, move to Queues.

## Tests

```sh
npm test
```

No install required — the tests use only Node built-ins. They cover the parts that do
not touch an external service: backoff arithmetic, the delivery state machine,
signature verification including constant-time comparison, event identity, and
configuration validation. `fetch` is stubbed. What the network does is Cloudflare's
problem, not this repository's.

## License

MIT. See [LICENSE](LICENSE).
