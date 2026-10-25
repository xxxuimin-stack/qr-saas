// Business hours helper — supports up to 2 ranges per day and overnight ranges (e.g. 18:00–02:00).
// Storage format: hours[day] = ["09:00","17:00"] or ["06:00","14:00","18:00","02:00"] (flat pairs). [] = closed.
export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

export function rangesFor(hours, dayKey) {
  const h = (hours || {})[dayKey] || [];
  const out = [];
  for (let i = 0; i + 1 < h.length; i += 2) if (h[i] && h[i + 1]) out.push([h[i], h[i + 1]]);
  return out;
}
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Ranges of a day as minutes from that day's midnight; end can pass 1440 (= continues into the next day).
 *  A range that closes earlier than it opens is overnight. A 2nd shift that starts before the 1st shift ends
 *  (e.g. 8AM–8PM then 12AM–11AM) is the next day's early morning, continuing this day's schedule. */
export function spansFor(hours, dayKey) {
  const out = []; let base = 0, lastEnd = -1;
  for (const [o, c] of rangesFor(hours, dayKey)) {
    let s = toMin(o) + base, e = toMin(c) + base;
    if (lastEnd >= 0 && s < lastEnd) { s += 1440; e += 1440; base += 1440; }
    if (e <= s) e += 1440;
    out.push([s, e]); lastEnd = e;
  }
  return out;
}
const fromMin = (m) => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

/** { open, closesAt, opensAt } for a given local Date */
export function openStatus(hours, now = new Date()) {
  if (!hours || !Object.keys(hours).length) return { open: true, closesAt: null, opensAt: null, always: true };
  const cur = toMin(hhmm(now));
  const today = DAY_KEYS[now.getDay()], yday = DAY_KEYS[(now.getDay() + 6) % 7];
  for (const [s, e] of spansFor(hours, yday)) if (cur + 1440 >= s && cur + 1440 <= e) return { open: true, closesAt: fromMin(e), opensAt: null };
  for (const [s, e] of spansFor(hours, today)) if (cur >= s && cur <= e) return { open: true, closesAt: fromMin(e), opensAt: null };
  // next opening (any span starting later, including a day's after-midnight 2nd shift)
  let best = null;
  for (let i = -1; i < 8; i++) {
    const k = DAY_KEYS[(now.getDay() + i + 7) % 7];
    for (const [s] of spansFor(hours, k)) { const at = s + i * 1440; if (at > cur && (best === null || at < best)) best = at; }
  }
  if (best !== null) return { open: false, closesAt: null, opensAt: fromMin(best), opensDay: Math.floor(best / 1440) };
  return { open: false, closesAt: null, opensAt: null };
}
export function fmt12(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
}
export function hoursLine(hours, dayKey) {
  const r = rangesFor(hours, dayKey);
  const sp = spansFor(hours, dayKey);
  return r.length ? r.map(([o, c], i) => `${fmt12(o)} – ${fmt12(c)}${sp[i][1] > 1440 ? (sp[i][0] >= 1440 ? " (after midnight)" : " (next day)") : ""}`).join(", ") : "Closed";
}
