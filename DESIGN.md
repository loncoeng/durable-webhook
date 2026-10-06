# Design notes

Written before the implementation, to settle what was being built. The options
that were turned down are here too, with the reason — otherwise the only thing
left of a decision is the thing that was decided.

## The problem

A webhook sender — LINE, Stripe, GitHub — treats anything slower than a few
seconds as a failure and sends it again. The app on the other end, meanwhile,
goes down: thirty seconds during a deploy, a database that is briefly unwell,
and so on.

What happens then:

```
sender → app (down)
         ↓
       500, or nothing at all
         ↓
       the sender retries a few times and gives up
         ↓
       that event is gone for good
```

Separating **accepting** from **delivering** fixes it. Accepting always
succeeds; delivery happens afterwards, and is retried when it fails.

## The shape of it

```
POST /hook/:id
  ↓
check the signature (if one is configured)
  ↓
check the event id against what has been seen → known: 200, done
  ↓
write it to KV as a delivery to make
  ↓
return 200 immediately              ← everything above, in tens of milliseconds
  ↓
(from ctx.waitUntil) try the first delivery
  ↓
on failure, leave it pending
  ↓
cron sweeps the pending ones and retries with exponential backoff
  ↓
past the last attempt, move it to the dead letters — never drop it
  ↓
GET /dead-letters lists them, POST /dead-letters/:id/replay sends one again
(both are for whoever operates this, so ADMIN_TOKEN closes them)
```

## Decisions

### Accepting and delivering are different things

The `200` the sender gets means "accepted", not "delivered". Conflate the two
and a slow destination makes the sender retry, which is the problem this is
supposed to solve.

### The response is always fast

Only the signature check and the write to KV happen before the response. The
delivery goes to `ctx.waitUntil`. Whether that first attempt succeeds or fails,
the sender sees the same thing.

### Retries belong to cron, not to the request

A Worker has a wall-clock limit. "Wait thirty seconds and try again, then
sixty" cannot happen inside one invocation. The pending deliveries live in KV
and cron sweeps them.

The backoff is 1 minute → 5 → 15 → 1 hour → 6 hours, five attempts. It is
**deliberately not evenly spaced**: a brief wobble is caught by an early retry,
and a long outage is not helped by hammering it.

### The sweep runs every 5 minutes, because the KV free tier says so

**It was every minute to begin with. That was wrong.**

The KV free tier allows 100,000 reads a day, so list looked like it would be
cheap too. It is not: **list is metered with writes, at 1,000 a day** — the
smallest allowance of any operation on the tier. Sweeping every minute is
1,440 a day with no visitors at all, which is over the line.

And KV does not throttle when you cross it. It **returns an error**, so from
that moment the day's retries stop. **Nothing gets delivered and nobody finds
out.**

Five minutes is 288 a day, with room for three endpoints. What that costs is
retry granularity and nothing else: the first delivery is attempted from
`waitUntil` the moment the event arrives, so it is not delayed — the first
backoff step is just 1–5 minutes rather than exactly 1.

**If the plan is to run on a free tier, start by counting the operation with
the smallest allowance.** Reading the headline limit and feeling reassured is
how this one happened.

### The same event is not delivered twice

Senders retry, and a destination that processes an event twice charges twice or
notifies twice. The event id goes into KV, and a known id ends the request
where it started.

Where the id comes from is configured per endpoint. Usually a header —
`X-GitHub-Delivery`, part of `Stripe-Signature`, `X-Line-Delivery`. Where there
is nothing to read, a hash of the body stands in.

### Nothing that was given up on is deleted

Quietly discarding an event that ran out of retries loses it. It goes to the
**dead letters instead, where a person can send it again**. Whether to throw it
away is a decision for a person.

Same call as `gui-report-automation`, which quarantines rather than deletes.

### Signatures are checked, but not required

A sender that signs with HMAC gets checked. Plenty of senders do not sign at
all, so an endpoint with no secret configured passes everything through.
**Requiring a signature would mean some senders could not be used.**

### The admin key is required, which is the opposite

Listing and replaying dead letters is a path an operator uses, and a sender's
signature cannot protect it — the key belongs to someone else entirely. That is
what `ADMIN_TOKEN` is for, and with it **unset the answer is `503`, not "come
in"**.

The two are handled in opposite ways because being unset ends differently. A
missing sender signature is the sender's business, and accepting it widens what
can be received. An open admin path lets anyone outside trigger a replay, and
a replay makes the destination process an event twice. **It would mean the
accident this tool exists to prevent could be caused from outside it.**

Nobody notices an open door. Everybody notices a closed one. Fail towards the
one that gets noticed.

## Turned down

**Cloudflare Queues**

A queue is the right tool for this. It also **needs a paid plan**, and running
on the free tier was a condition, so KV and cron stand in for one. At any real
volume Queues is the move, and the README says so.

**Durable Objects, for ordering**

Keeping deliveries in order needs Durable Objects. But the subject here is not
dropping events, not ordering them. **Widening the problem is how it ends up
unfinished**, so ordering is out of scope.

**Fan-out to several destinations**

Useful, and it means holding retry state per destination, which is where the
complexity jumps. One to one.

## What is stored (KV)

| Key | Holds | TTL |
|---|---|---|
| `seen:<endpoint>:<eventId>` | the dedupe mark | 24 hours |
| `pending:<endpoint>:<deliveryId>` | a delivery to make, with its attempt count and next time | 7 days |
| `dead:<endpoint>:<deliveryId>` | given up on, kept until a person decides | 30 days |

The TTLs are there so that neglect does not grow KV without bound. The dead
letters get longer because noticing them takes longer.

## What is tested

Everything that does not reach an external service.

- the backoff calculation (attempt count → next time)
- the dedupe decision
- signature verification (HMAC-SHA256)
- admin authentication, including that it closes when unconfigured
- the state transitions (accepted → pending → delivered / dead)
- loading and validating configuration

`fetch` is replaced with a stub. The actual HTTP is Cloudflare's to get right,
and there is nothing to learn from testing it here.
