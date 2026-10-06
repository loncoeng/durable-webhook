// The endpoint configuration.
//
// Carried as JSON in the ENDPOINTS environment variable. Destination URLs and
// signing secrets belong in Secrets, so they are written neither here nor in
// wrangler.toml.
//
// It is validated on load, and a broken configuration fails immediately. The
// worst way to find out about a mistake in here is "the webhooks aren't
// arriving", because by the time that gets noticed events have been lost.

/**
 * @typedef {object} Endpoint
 * @property {string}   id         becomes part of the URL: /hook/:id
 * @property {string}   targetUrl  where it is forwarded
 * @property {string=}  secret     the HMAC key; without it, no signature check
 * @property {string=}  signatureHeader the header the signature arrives in
 * @property {string[]=} idHeaders  headers to look for the event id in, in order
 * @property {object=}  headers    extra headers to add when forwarding
 */

export class ConfigError extends Error {}

/**
 * Read the configuration out of the environment.
 *
 * @param {object} env
 * @returns {Map<string, Endpoint>}
 */
export function loadEndpoints(env) {
  const raw = env?.ENDPOINTS;
  if (!raw) {
    throw new ConfigError("ENDPOINTS is not set");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`ENDPOINTS is not readable as JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new ConfigError("ENDPOINTS must be an array");
  }

  const map = new Map();
  for (const [index, item] of parsed.entries()) {
    const where = `ENDPOINTS[${index}]`;
    if (!item || typeof item !== "object") {
      throw new ConfigError(`${where} is not an object`);
    }
    if (!item.id || typeof item.id !== "string") {
      throw new ConfigError(`${where}.id is missing`);
    }
    // The id goes into a URL. A path separator or a space in it breaks routing.
    if (!/^[A-Za-z0-9_-]+$/.test(item.id)) {
      throw new ConfigError(`${where}.id may only contain letters, digits, hyphens and underscores: ${item.id}`);
    }
    if (map.has(item.id)) {
      throw new ConfigError(`${where}.id is a duplicate: ${item.id}`);
    }
    if (!item.targetUrl || typeof item.targetUrl !== "string") {
      throw new ConfigError(`${where}.targetUrl is missing`);
    }
    try {
      const url = new URL(item.targetUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("not http or https");
      }
    } catch (error) {
      throw new ConfigError(`${where}.targetUrl is not readable as a URL: ${error.message}`);
    }
    // A signing key with no header name leaves nowhere to look for the signature.
    if (item.secret && !item.signatureHeader) {
      throw new ConfigError(`${where}: a secret needs a signatureHeader as well`);
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
    throw new ConfigError("ENDPOINTS is empty");
  }
  return map;
}
