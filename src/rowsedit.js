// Tiny list editor for settings: rows of inputs with "+ Add" and ✕.
// fields: [{ k, label, type: "text"|"number"|"select"|"check"|"days", options: [[v,l]], ph, w }]
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
const rid = () => Math.random().toString(36).slice(2, 8);

function cell(f, v) {
  const lab = `<span class="small muted" style="display:block">${esc(f.label)}</span>`;
  if (f.type === "select") return `<label style="flex:${f.w || 1}">${lab}<select data-f="${f.k}">${f.options.map(([o, l]) => `<option value="${esc(o)}" ${String(v ?? f.options[0][0]) === String(o) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  if (f.type === "check") return `<label class="check small" style="flex:${f.w || 1};align-self:end;margin:0 0 10px"><input type="checkbox" data-f="${f.k}" ${v ? "checked" : ""}/> ${esc(f.label)}</label>`;
  if (f.type === "days") return `<div style="flex:${f.w || 3}">${lab}<div class="row wrap" style="gap:4px">${DAYS.map(([d, l]) => `<label class="check small" style="margin:0 6px 0 0"><input type="checkbox" data-day="${d}" ${(v || []).includes(d) ? "checked" : ""}/>${l}</label>`).join("")}</div></div>`;
  return `<label style="flex:${f.w || 1};min-width:70px">${lab}<input data-f="${f.k}" type="${f.type || "text"}" ${f.type === "number" ? 'min="0"' : ""} value="${esc(v ?? "")}" placeholder="${esc(f.ph || "")}"/></label>`;
}

/** mount into host; returns () => rows (values read from the DOM) */
export function rowsEditor(host, rows, fields, { addLabel = "+ Add", max = 30 } = {}) {
  host.innerHTML = `<div data-list></div><button type="button" class="btn sm ghost" data-add>${esc(addLabel)}</button>`;
  const list = host.querySelector("[data-list]");
  const add = (r = {}) => {
    if (list.children.length >= max) return;
    const el = document.createElement("div");
    el.className = "row wrap"; el.dataset.id = r.id || rid();
    el.style.cssText = "gap:8px;align-items:flex-end;border-bottom:1px solid var(--line);padding:6px 0;margin-bottom:6px";
    el.innerHTML = fields.map((f) => cell(f, r[f.k])).join("") + `<button type="button" class="btn sm ghost" data-del title="Remove" style="margin-bottom:6px">✕</button>`;
    el.querySelector("[data-del]").onclick = () => el.remove();
    list.appendChild(el);
  };
  (rows || []).forEach(add);
  host.querySelector("[data-add]").onclick = () => add({});
  return () => [...list.children].map((el) => {
    const o = { id: el.dataset.id };
    fields.forEach((f) => {
      if (f.type === "days") o[f.k] = [...el.querySelectorAll("[data-day]:checked")].map((c) => c.dataset.day);
      else { const i = el.querySelector(`[data-f="${f.k}"]`); o[f.k] = f.type === "check" ? i.checked : f.type === "number" ? (i.value === "" ? null : Number(i.value)) : i.value.trim(); }
    });
    return o;
  });
}
