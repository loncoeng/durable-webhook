// エンドポイントの設定。
//
// 環境変数 ENDPOINTS に JSON で持たせる。転送先の URL や署名の
// シークレットは Secrets に置くべきものなので、コードにも
// wrangler.toml にも書かない。
//
// 起動時に検証して、壊れていれば早く落とす。設定の誤りに気付くのが
// 「Webhook が届かない」という形になるのは最悪で、そのときには
// もうイベントを取りこぼしている。

/**
 * @typedef {object} Endpoint
 * @property {string}   id         URL の一部になる。/hook/:id
 * @property {string}   targetUrl  転送先
 * @property {string=}  secret     HMAC の鍵。無ければ署名検証をしない
 * @property {string=}  signatureHeader 署名が入るヘッダ名
 * @property {string[]=} idHeaders  イベントIDを探すヘッダ（優先順）
 * @property {object=}  headers    転送時に付ける追加ヘッダ
 */

export class ConfigError extends Error {}

/**
 * 環境変数から設定を読む。
 *
 * @param {object} env
 * @returns {Map<string, Endpoint>}
 */
export function loadEndpoints(env) {
  const raw = env?.ENDPOINTS;
  if (!raw) {
    throw new ConfigError("ENDPOINTS が設定されていない");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`ENDPOINTS が JSON として読めない: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new ConfigError("ENDPOINTS は配列でなければならない");
  }

  const map = new Map();
  for (const [index, item] of parsed.entries()) {
    const where = `ENDPOINTS[${index}]`;
    if (!item || typeof item !== "object") {
      throw new ConfigError(`${where} がオブジェクトでない`);
    }
    if (!item.id || typeof item.id !== "string") {
      throw new ConfigError(`${where}.id が無い`);
    }
    // id は URL に入る。パス区切りや空白が混ざると経路が壊れる。
    if (!/^[A-Za-z0-9_-]+$/.test(item.id)) {
      throw new ConfigError(`${where}.id に使えるのは英数字とハイフンとアンダースコアだけ: ${item.id}`);
    }
    if (map.has(item.id)) {
      throw new ConfigError(`${where}.id が重複している: ${item.id}`);
    }
    if (!item.targetUrl || typeof item.targetUrl !== "string") {
      throw new ConfigError(`${where}.targetUrl が無い`);
    }
    try {
      const url = new URL(item.targetUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("http または https でない");
      }
    } catch (error) {
      throw new ConfigError(`${where}.targetUrl が URL として読めない: ${error.message}`);
    }
    // 署名の鍵があるのにヘッダ名が無いと、どこを見ればよいか決まらない。
    if (item.secret && !item.signatureHeader) {
      throw new ConfigError(`${where}: secret があるなら signatureHeader も要る`);
    }

    map.set(item.id, {
      id: item.id,
      targetUrl: item.targetUrl,
      secret: item.secret || null,
      signatureHeader: item.signatureHeader || null,
      idHeaders: Array.isArray(item.idHeaders) ? item.idHeaders : [],
      headers: item.headers && typeof item.headers === "object" ? item.headers : {},
    });
  }

  if (map.size === 0) {
    throw new ConfigError("ENDPOINTS が空");
  }
  return map;
}
