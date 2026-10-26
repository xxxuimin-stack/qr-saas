// Checkout idempotency key. Only the shape is checked here; the lock lives in Firestore.
function orderKeyId(raw) {
  const s = String(raw || "").trim().replace(/-/g, "");
  if (!/^[A-Za-z0-9_]{8,80}$/.test(s)) return null;
  return s;
}

module.exports = { orderKeyId };
