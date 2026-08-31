// KV への読み書きをここに閉じ込める。
//
// キーの組み立てを散らばらせない。あとで保存先を Queues や D1 に
// 移すことになったとき、触るのがこのファイルだけで済む。
//
// TTL を必ず付ける。付けないと、放置された配送待ちが KV に永久に
// 積み上がる。退避だけ長めにしてあるのは、人間が気付くまでに
// 時間がかかるため。

export const TTL = {
  seen: 24 * 60 * 60,        // 24時間。これを超える再送はまず来ない
  pending: 7 * 24 * 60 * 60, // 7日。バックオフを尽くしても6時間強で終わる
  dead: 30 * 24 * 60 * 60,   // 30日。人間が判断するまでの猶予
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

  // --- 重複排除 ---

  async hasSeen(endpoint, eventId) {
    return (await this.kv.get(key.seen(endpoint, eventId))) !== null;
  }

  async markSeen(endpoint, eventId, deliveryId) {
    await this.kv.put(key.seen(endpoint, eventId), deliveryId, {
      expirationTtl: TTL.seen,
    });
  }

  // --- 配送待ち ---

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
   * 配送待ちを列挙する。
   *
   * KV の list は1回で1000件までしか返さない。Cron の1回の実行で
   * 全部を捌こうとせず、上限を設けて次回に回す。溜まっていても
   * 少しずつ減らせればよい。
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

  // --- 退避 ---

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
