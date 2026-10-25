// Massage intake: what the client wants and what to avoid (shown to reception and the therapist)
export const PRESSURE = [["light", "Light"], ["medium", "Medium"], ["firm", "Firm"], ["hard", "Hard"]];
export const AREAS = [["head", "Head"], ["neck", "Neck"], ["shoulders", "Shoulders"], ["upper_back", "Upper back"], ["lower_back", "Lower back"], ["arms", "Arms"], ["hands", "Hands"], ["chest", "Chest"], ["stomach", "Stomach"], ["hips", "Hips"], ["legs", "Legs"], ["knees", "Knees"], ["feet", "Feet"]];
export const HEALTH = [["pregnant", "Pregnant"], ["high_blood", "High blood pressure"], ["recent_surgery", "Recent surgery"], ["injury", "Injury / sprain"], ["skin_allergy", "Skin allergy / sensitive skin"], ["varicose", "Varicose veins"], ["heart", "Heart condition"], ["diabetes", "Diabetes"], ["fever", "Fever / feeling sick"]];
export const OIL = [["unscented", "Unscented"], ["lavender", "Lavender"], ["eucalyptus", "Eucalyptus"], ["coconut", "Coconut"], ["no_oil", "No oil (allergic)"]];
const lab = (list, k) => (list.find((x) => x[0] === k) || [k, k])[1];

/** one compact block for staff screens */
export function intakeHTML(x, esc) {
  if (!x) return "";
  const parts = [];
  if (x.pressure) parts.push(`💪 <b>${esc(lab(PRESSURE, x.pressure))}</b> pressure`);
  if (x.focus?.length) parts.push(`🎯 Focus: ${esc(x.focus.map((k) => lab(AREAS, k)).join(", "))}`);
  if (x.focusNote) parts.push(`🎯 Focus: ${esc(x.focusNote)}`);
  if (x.oil) parts.push(`🫙 ${esc(lab(OIL, x.oil))}`);
  if (x.quiet) parts.push("🤫 Quiet session please");
  if (x.firstTime) parts.push("✨ First time");
  const warn = [];
  if (x.avoid?.length) warn.push(`🚫 Avoid: <b>${esc(x.avoid.map((k) => lab(AREAS, k)).join(", "))}</b>`);
  if (x.avoidNote) warn.push(`🚫 ${esc(x.avoidNote)}`);
  if (x.health?.length) warn.push(`⚠️ <b>${esc(x.health.map((k) => lab(HEALTH, k)).join(", "))}</b>`);
  if (x.healthNote) warn.push(`⚠️ ${esc(x.healthNote)}`);
  if (x.note) parts.push(esc(x.note));
  return `<div class="small" style="margin:6px 0;padding:8px 10px;border-radius:10px;background:var(--surface-2, rgba(127,127,127,.08));line-height:1.5">${warn.length ? `<div style="color:var(--danger);font-weight:600">${warn.join("<br>")}</div>` : ""}${parts.length ? `<div>${parts.join(" · ")}</div>` : ""}</div>`;
}

/** customer booking form section — short: pressure + a few notes with examples; returns { el, value() } */
export function intakeForm(saved, esc, onChange = () => {}, fromLast = false) {
  const v = { pressure: null, quiet: false, firstTime: false, focusNote: "", avoidNote: "", healthNote: "", ...(saved || {}) };
  const el = document.createElement("div");
  const draw = () => {
    el.innerHTML = `<div class="c-step"><span>💆</span> Your massage</div>
      ${fromLast ? `<p class="c-hint" style="margin:0 0 4px">Filled in from your last booking. Change anything you like.</p>` : ""}
      <span class="c-sub">Pressure</span><div class="c-chips" data-ik="pressure">${PRESSURE.map(([k, l]) => `<button type="button" class="chip ${v.pressure === k ? "on" : ""}" data-v="${k}" aria-pressed="${v.pressure === k}">${esc(l)}</button>`).join("")}</div>
      <span class="c-sub">Focus on <span class="opt">(optional)</span></span><input data-ikn="focusNote" maxlength="120" value="${esc(v.focusNote)}" placeholder="e.g. shoulders and lower back"/>
      <span class="c-sub">Avoid or be careful with <span class="opt">(optional)</span></span><input data-ikn="avoidNote" maxlength="160" value="${esc(v.avoidNote)}" placeholder="e.g. knee surgery last March, bruise on left arm"/>
      <span class="c-sub">Health notes <span class="opt">(optional · only your therapist and the shop see this)</span></span><input data-ikn="healthNote" maxlength="200" value="${esc(v.healthNote)}" placeholder="e.g. pregnant (5 months), high blood, allergic to oil"/>
      <div class="c-chips" style="margin-top:10px"><button type="button" class="chip ${v.quiet ? "on" : ""}" data-flag="quiet">Quiet session</button><button type="button" class="chip ${v.firstTime ? "on" : ""}" data-flag="firstTime">First time here</button></div>`;
    el.querySelectorAll("[data-ik] [data-v]").forEach((b) => (b.onclick = () => { keepNotes(); v.pressure = v.pressure === b.dataset.v ? null : b.dataset.v; draw(); onChange({ ...v }); }));
    el.querySelectorAll("[data-flag]").forEach((b) => (b.onclick = () => { keepNotes(); v[b.dataset.flag] = !v[b.dataset.flag]; draw(); onChange({ ...v }); }));
    el.querySelectorAll("[data-ikn]").forEach((i) => (i.oninput = () => { keepNotes(); onChange({ ...v }); }));
  };
  const keepNotes = () => el.querySelectorAll("[data-ikn]").forEach((i) => (v[i.dataset.ikn] = i.value.trim()));
  draw();
  return { el, value: () => { keepNotes(); return { ...v }; } };
}
