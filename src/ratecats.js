// Rating categories per business (shared by the customer pages; the server checks the same keys).
export const RATE_CATS = {
  order: [["food", "🍽 Food"], ["service", "🙋 Service"], ["speed", "⏱ Speed"]],
  laundry: [["cleanliness", "✨ Cleanliness"], ["fragrance", "🌸 Fragrance"], ["folding", "👕 Folding"], ["ontime", "⏰ On time"]],
  appt: [["service", "💆 Service"], ["staff", "🙋 Staff"], ["cleanliness", "✨ Cleanliness"], ["value", "💰 Value"]],
  stay: [["cleanliness", "✨ Cleanliness"], ["accommodation", "🛏 Accommodation"], ["service", "🙋 Service"], ["location", "📍 Location"], ["value", "💰 Value"]],
};
/** star rows → {html, values, bind(root)} */
export function rateRows(kind, initial = 0) {
  const cats = RATE_CATS[kind] || []; const R = Object.fromEntries(cats.map(([k]) => [k, initial]));
  const html = cats.map(([k, l]) => `<div class="c-raterow"><span>${l}</span><div class="c-stars" data-row="${k}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" class="${n <= R[k] ? "on" : ""}">★</button>`).join("")}</div></div>`).join("");
  const bind = (root) => root.querySelectorAll("[data-row]").forEach((r) => r.querySelectorAll("[data-n]").forEach((b) => (b.onclick = () => { R[r.dataset.row] = Number(b.dataset.n); r.querySelectorAll("[data-n]").forEach((x) => x.classList.toggle("on", Number(x.dataset.n) <= R[r.dataset.row])); })));
  const avg = () => { const v = Object.values(R).filter(Boolean); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0; };
  return { html, R, bind, avg, complete: () => Object.values(R).every(Boolean) };
}
