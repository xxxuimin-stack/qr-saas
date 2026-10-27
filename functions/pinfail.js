/** Next PIN-failure record. Parallel guesses must share one counter or the lockout never trips. */
function pinFailNext(prev, now, max = 10, lockMs = 15 * 60000) {
  const lockedUntil = Number(prev?.lockedUntil) || 0;
  if (lockedUntil > now) return { locked: true, count: Number(prev?.count) || 0, lockedUntil };
  const n = (Number(prev?.count) || 0) + 1;
  if (n >= max) return { locked: true, count: 0, lockedUntil: now + lockMs };
  return { locked: false, count: n, lockedUntil: 0 };
}

module.exports = { pinFailNext };
