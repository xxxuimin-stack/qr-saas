// Web Push without extra packages (RFC 8291 aes128gcm + RFC 8292 VAPID), Node 20 crypto + fetch.
// Keys are made once and kept in Firestore (platformPrivate/push — no client can read it).
const crypto = require("crypto");

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function makePush(db) {
  let cached = null;
  async function keys() {
    if (cached) return cached;
    const ref = db.doc("platformPrivate/push");
    let k = (await ref.get()).data();
    if (!k?.privateJwk) {
      const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = privateKey.export({ format: "jwk" });
      k = { privateJwk: jwk, publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), createdAt: Date.now() };
      await ref.set(k);
    }
    cached = { ...k, key: crypto.createPrivateKey({ key: k.privateJwk, format: "jwk" }) };
    return cached;
  }
  async function vapidHeader(endpoint) {
    const k = await keys();
    const aud = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
    const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://taptayo.com" }));
    const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: k.key, dsaEncoding: "ieee-p1363" });
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${k.publicKey}`;
  }
  function encrypt(sub, payload) {
    const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
    const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey();
    const shared = ecdh.computeSecret(uaPublic);
    const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
    const salt = crypto.randomBytes(16);
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
    const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
    const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
    const enc = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
    const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, enc]);
  }
  /** send one push; returns "ok" | "gone" | "error" */
  async function sendOne(sub, data, { ttl = 600, urgency = "high", topic } = {}) {
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(ttl), Urgency: urgency, Authorization: await vapidHeader(sub.endpoint), ...(topic ? { Topic: String(topic).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}) },
        body: encrypt(sub, JSON.stringify(data)),
      });
      if (res.status === 404 || res.status === 410) return "gone";
      return res.ok ? "ok" : "error";
    } catch { return "error"; }
  }
  return { keys, sendOne, encrypt };
}
module.exports = { makePush };
