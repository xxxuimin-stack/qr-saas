/** Whether a new booking collides with appointments already saved that day. */
const ACTIVE = new Set(["unconfirmed", "pending", "confirmed", "in_progress"]);

function slotClash(existing, { startMs, endMs, providerId, stylistCount, exceptId }) {
  const overlapping = [];
  for (const a of existing || []) {
    if (!a || !ACTIVE.has(a.status) || (exceptId && a.id === exceptId)) continue;
    const st0 = Number(a.startMs);
    if (!Number.isFinite(st0)) continue;
    const as = st0 - (Number(a.travelBefore) || 0) * 60000;
    const ae = st0 + ((Number(a.duration) || 30) + (Number(a.buffer) || 0)) * 60000;
    if (as < endMs && ae > startMs) overlapping.push(a);
  }
  if (providerId) return overlapping.some((a) => a.providerId === providerId);
  const taken = new Set(overlapping.map((a) => a.providerId).filter(Boolean));
  const openCount = overlapping.filter((a) => !a.providerId).length;
  const seats = Number(stylistCount) || 0;
  return seats <= 0 ? openCount > 0 : taken.size + openCount >= seats;
}

module.exports = { slotClash };
