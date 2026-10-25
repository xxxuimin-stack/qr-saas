// Plan limits in the owner app (the server enforces the same numbers)
import { limitsFor, limitMode, planOf, PLANS, LIMIT_LABEL, UNLIMITED } from "./plans.js";
export const planLim = (ctx) => limitsFor(ctx?.sub, limitMode(ctx?.store));
export const planName = (ctx) => PLANS[planOf(ctx?.sub)]?.name || "Free";
/** true (and a message) when adding `adding` more would pass the plan limit */
export function overLimit(ctx, key, have, adding = 1, toast) {
  const lim = planLim(ctx)[key];
  if (lim == null || lim >= UNLIMITED || have + adding <= lim) return false;
  toast?.(`The ${planName(ctx)} plan has up to ${lim} ${LIMIT_LABEL[key] || key} (you have ${have}). Upgrade or add more in Billing.`, "error");
  return true;
}
export function limitNote(ctx, key, have) {
  const lim = planLim(ctx)[key];
  if (lim == null || lim >= UNLIMITED) return "";
  return `<span class="small ${have >= lim ? "" : "muted"}" style="${have >= lim ? "color:#B42318;font-weight:600" : ""}">${have} of ${lim} ${LIMIT_LABEL[key] || key} · ${planName(ctx)} plan${have >= lim ? ` — <a href="#billing">get more</a>` : ""}</span>`;
}
