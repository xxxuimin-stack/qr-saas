// Massage & Spa runs on the salon engine — on screen it says "therapist" / "spa" instead of "stylist" / "salon".
const MAPS = {};
MAPS.freelance = [[/\bStylists\b/g, "Team"], [/\bstylists\b/g, "team"], [/\bStylist app\b/g, "My jobs"], [/\bStylist\b/g, "Team member"], [/\bstylist\b/g, "team member"], [/\bSTYLIST\b/g, "TEAM"],
  [/\bthe salon\b/g, "the studio"], [/\bThe salon\b/g, "The studio"], [/\bat the salon\b/gi, "on site"], [/\bAt the salon\b/g, "On site"], [/\bSalon\b(?! \/)/g, "Studio"], [/\bsalon\b/g, "studio"], [/💇/g, "🎨"], [/\bhaircut\b/gi, "service"], [/\bHome service\b/g, "On location"], [/\bhome service\b/g, "on location"]];
const MAP = [[/\bStylists\b/g, "Therapists"], [/\bstylists\b/g, "therapists"], [/\bStylist\b/g, "Therapist"], [/\bstylist\b/g, "therapist"], [/\bSTYLIST\b/g, "THERAPIST"],
  [/\bthe salon\b/g, "the spa"], [/\bThe salon\b/g, "The spa"], [/\bat the salon\b/gi, "at the spa"], [/\bAt the salon\b/g, "At the spa"], [/\bSalon\b(?! \/)/g, "Spa"], [/\bsalon\b/g, "spa"], [/💇/g, "💆"], [/\bhaircut\b/gi, "service"]];
let on = false, obs = null;
MAPS.spa = MAP;
let CUR = MAP;
const fix = (t) => { let o = t; for (const [re, to] of CUR) o = o.replace(re, to); return o; };
function walk(node) {
  if (node.nodeType === 3) { const v = node.nodeValue; if (v && /stylist|salon|💇|haircut|home service/i.test(v)) { const n = fix(v); if (n !== v) node.nodeValue = n; } return; }
  if (node.nodeType !== 1 || /^(SCRIPT|STYLE|TEXTAREA)$/.test(node.nodeName) || node.isContentEditable || node.closest?.("[data-nowording]")) return;
  for (const a of ["placeholder", "title", "aria-label"]) { const v = node.getAttribute?.(a); if (v && /stylist|salon/i.test(v)) node.setAttribute(a, fix(v)); }
  for (const c of node.childNodes) walk(c);
}
/** call once the store is known; no-op for other business types */
export function applyWording(store) {
  if (on || !MAPS[store?.businessType]) return;
  on = true; CUR = MAPS[store.businessType]; walk(document.body);
  const t0 = document.title; if (/salon/i.test(t0)) document.title = fix(t0);
  obs = new MutationObserver((ms) => { for (const m of ms) { if (m.type === "characterData") walk(m.target); else m.addedNodes.forEach(walk); } });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
}
