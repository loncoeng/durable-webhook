// Everything that reads or writes KV lives here.
//
// Key construction does not get scattered. If the storage ever moves to Queues
// or D1, this is the only file that has to change.
//
// Every write gets a TTL. Without one, abandoned pending deliveries pile up in
// KV forever. The dead letters get a longer one because noticing them takes a
// person longer.

export const TTL = {
  seen: 24 * 60 * 60,        // 24 hours; a retry later than that is unheard of
  pending: 7 * 24 * 60 * 60, // 7 days; the backoff runs out after six and a bit hours
  dead: 30 * 24 * 60 * 60,   // 30 days; how long a person gets to decide
};

const key = {
  seen: (endpoint, eventId) => `seen:${endpoint}:${eventId}`,
  pending: (endpoint, deliveryId) => `pending:${endpoint}:${deliveryId}`,
  dead: (endpoint, deliveryId) => `dead:${endpoint}:${deliveryId}`,
};

export class Store {
  constructor(kv) {
    this.kv = kv;
  }

  // --- deduplication ---

  async hasSeen(endpoint, eventId) {
    return (await this.kv.get(key.seen(endpoint, eventId))) !== null;
  }

  async markSeen(endpoint, eventId, deliveryId) {
    await this.kv.put(key.seen(endpoint, eventId), deliveryId, {
      expirationTtl: TTL.seen,
    });
  }

  // --- pending ---

  async putPending(endpoint, delivery) {
    await this.kv.put(
      key.pending(endpoint, delivery.deliveryId),
      JSON.stringify(delivery),
      { expirationTtl: TTL.pending },
    );
  }

  async getPending(endpoint, deliveryId) {
    const raw = await this.kv.get(key.pending(endpoint, deliveryId));
    return raw ? JSON.parse(raw) : null;
  }

  async deletePending(endpoint, deliveryId) {
    await this.kv.delete(key.pending(endpoint, deliveryId));
  }

  /**
   * List the pending deliveries.
   *
   * A KV list returns at most a thousand keys at a time. Rather than trying to
   * clear everything in one cron run, there is a limit and the rest waits for
   * the next one. A backlog only has to shrink, not vanish.
   */
  async listPending(endpoint, limit = 100) {
    const { keys } = await this.kv.list({
      prefix: `pending:${endpoint}:`,
      limit,
    });
    const found = [];
    for (const k of keys) {
      const raw = await this.kv.get(k.name);
      if (raw) found.push(JSON.parse(raw));
    }
    return found;
  }

  // --- dead letters ---

  async putDead(endpoint, delivery) {
    await this.kv.put(
      key.dead(endpoint, delivery.deliveryId),
      JSON.stringify(delivery),
      { expirationTtl: TTL.dead },
    );
  }

  async getDead(endpoint, deliveryId) {
    const raw = await this.kv.get(key.dead(endpoint, deliveryId));
    return raw ? JSON.parse(raw) : null;
  }

  async deleteDead(endpoint, deliveryId) {
    await this.kv.delete(key.dead(endpoint, deliveryId));
  }

  async listDead(endpoint, limit = 100) {
    const { keys } = await this.kv.list({
      prefix: `dead:${endpoint}:`,
      limit,
    });
    const found = [];
    for (const k of keys) {
      const raw = await this.kv.get(k.name);
      if (raw) found.push(JSON.parse(raw));
    }
    return found;
  }
}
