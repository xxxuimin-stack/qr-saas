// Menu / Services editor: categories (left) + items (right)
import { planLim, planName, limitNote } from "../planui.js";
import { db, call } from "../firebase.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp, writeBatch,
} from "firebase/firestore";
import { esc, money, html, toast, openModal, closeModal, confirmDialog } from "../ui.js";
import { uploadImage, uploadItemImage } from "../upload.js";

export function renderMenuPage(root, ctx) {
  const { storeId, store, labels, mode } = ctx;
  const catCol = collection(db, "stores", storeId, "categories");
  const itemCol = collection(db, "stores", storeId, "items");

  let categories = [];
  let items = [];
  let selectedCat = null;
  let pub = null; // publicStores doc (what customers see)

  root.innerHTML = `
    <div class="syncbar" id="syncBar" hidden></div>
    <div class="tile row between wrap" style="gap:10px;margin-bottom:14px;align-items:center"><div><b>⬆ Add many at once</b><div class="small muted">Import your whole ${esc(labels.items === "Menu" ? "menu" : "service list")} from a spreadsheet (CSV).</div></div><button class="btn ghost sm" id="csvImport" type="button" title="Add many at once from a spreadsheet">⬆ Import CSV</button></div>
    <div class="split">
      <aside class="tile pane">
        <div class="row between"><h3>Categories</h3><button class="btn sm" id="addCat" type="button">+ Add</button></div>
        <ul class="catlist" id="catList"></ul>
      </aside>
      <section class="tile pane">
        <div class="row between">
          <h3 id="itemsTitle">${esc(labels.items)}</h3>
          <div class="row"><span id="limItems"></span><button class="btn sm" id="addItem" type="button">+ Add ${esc(labels.items === "Menu" ? "item" : "service")}</button></div>
        </div>
        <p class="small muted" id="itemsHint"></p>
        <div id="itemList" class="itemlist"></div>
      </section>
    </div>`;

  const unsubs = [];
  unsubs.push(onSnapshot(query(catCol, orderBy("sortOrder")), (snap) => {
    categories = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!selectedCat || !categories.find((c) => c.id === selectedCat)) selectedCat = categories[0]?.id || null;
    drawCats();
    drawItems();
    drawSync();
  }));
  unsubs.push(onSnapshot(query(itemCol, orderBy("sortOrder")), (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    { const el = root.querySelector("#limItems"); if (el) el.innerHTML = limitNote(ctx, "items", items.length); }
    drawCats();
    drawItems();
    drawSync();
  }));

  // ---------------- customer page sync check ----------------
  if (store?.slug) unsubs.push(onSnapshot(doc(db, "publicStores", store.slug), (d) => { pub = d.exists() ? d.data() : null; drawSync(); }, () => {}));
  function drawSync() {
    const bar = root.querySelector("#syncBar"); if (!bar) return;
    const shown = categories.filter((c) => c.active !== false && store?.settings?.salonTypes?.[c.id] !== false);
    const expected = items.filter((it) => shown.some((c) => c.id === it.categoryId)).length;
    const live = (pub?.items || []).length;
    const ok = pub && live === expected;
    bar.hidden = false;
    bar.className = "syncbar " + (ok ? "ok" : "warn");
    bar.innerHTML = ok
      ? `<span>✅ Customer page is up to date · ${live} showing</span><a class="btn ghost sm" href="/m/${esc(store.slug)}" target="_blank">View ↗</a>`
      : `<span>⚠️ Customer page shows <b>${live}</b> of <b>${expected}</b> ${esc(labels.items.toLowerCase())}.</span><button class="btn sm" type="button" data-refresh>🔄 Refresh customer page</button>`;
    bar.querySelector("[data-refresh]")?.addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Refreshing…";
      try { const r = await call("refreshPublicStore", {}); toast(`Customer page updated · ${r.items} showing`); }
      catch (err) { toast("Refresh failed: " + (err.message || err) + " — redeploy the functions (npm run deploy:all).", "error"); e.target.disabled = false; e.target.textContent = "🔄 Refresh customer page"; }
    });
  }

  // ---------------- categories ----------------
  function drawCats() {
    const ul = root.querySelector("#catList");
    ul.innerHTML = "";
    if (!categories.length) ul.innerHTML = `<li class="muted small">No categories yet. Click "+ Add".</li>`;
    categories.forEach((c, i) => {
      const count = items.filter((it) => it.categoryId === c.id).length;
      const li = html(`
        <li class="cat ${c.id === selectedCat ? "active" : ""} ${c.active === false ? "off" : ""}">
          <span class="name">${esc(c.name)} <span class="muted small">(${count})</span></span>
          <span class="acts">
            <button title="Move up" data-up ${i === 0 ? "disabled" : ""}>↑</button>
            <button title="Move down" data-down ${i === categories.length - 1 ? "disabled" : ""}>↓</button>
            <button title="Edit" data-edit>✎</button>
          </span>
        </li>`);
      li.querySelector(".name").onclick = () => { selectedCat = c.id; drawCats(); drawItems(); };
      li.querySelector("[data-up]").onclick = () => swapOrder(i, i - 1);
      li.querySelector("[data-down]").onclick = () => swapOrder(i, i + 1);
      li.querySelector("[data-edit]").onclick = () => catForm(c);
      ul.appendChild(li);
    });
  }

  async function swapOrder(a, b) {
    if (b < 0 || b >= categories.length) return;
    const batch = writeBatch(db);
    batch.update(doc(catCol, categories[a].id), { sortOrder: b + 1 });
    batch.update(doc(catCol, categories[b].id), { sortOrder: a + 1 });
    // normalize all so there are no duplicates
    categories.forEach((c, i) => {
      if (i !== a && i !== b) batch.update(doc(catCol, c.id), { sortOrder: i + 1 });
    });
    await batch.commit();
  }

  function catForm(cat) {
    const body = html(`
      <div>
        <label>Category name</label>
        <input name="name" value="${esc(cat?.name || "")}" placeholder="e.g. Drinks" />
        <label>Subtitle (optional)</label>
        <input name="description" value="${esc(cat?.description || "")}" placeholder="e.g. Fried rice + egg your way" maxlength="60" />
        <label>Station (where items in this category are prepared)</label>
        <select name="station"><option value="kitchen" ${(cat?.station || "kitchen") === "kitchen" ? "selected" : ""}>🍳 Kitchen</option><option value="barista" ${cat?.station === "barista" ? "selected" : ""}>☕ Barista (drinks, pastry)</option><option value="counter" ${cat?.station === "counter" ? "selected" : ""}>🧾 Counter (ready-made, retail)</option></select>
        ${mode === "table" ? `<label class="check"><input type="checkbox" name="adult" ${cat?.adult ? "checked" : ""}/> 🔞 18+ (beer / liquor) — only on the 18+ menu & VIP rooms, dine-in only</label>` : ""}
        <label class="check"><input type="checkbox" name="active" ${cat?.active !== false ? "checked" : ""}/> Visible to customers</label>
      </div>`);
    body.querySelector("[name=adult]")?.addEventListener("change", (e) => { if (e.target.checked) body.querySelector("[name=station]").value = "barista"; });
    const foot = html(`<div class="row between">
      <span>${cat ? `<button class="btn ghost danger-text" type="button" data-del>Delete</button>` : ""}</span>
      <span class="row"><button class="btn ghost" type="button" data-cancel>Cancel</button><button class="btn" type="button" data-save>Save</button></span>
    </div>`);
    foot.querySelector("[data-cancel]").onclick = closeModal;
    foot.querySelector("[data-save]").onclick = async () => {
      const name = body.querySelector("[name=name]").value.trim();
      const description = body.querySelector("[name=description]").value.trim();
      const station = body.querySelector("[name=station]").value;
      const active = body.querySelector("[name=active]").checked;
      const adult = !!body.querySelector("[name=adult]")?.checked;
      if (!name) return toast("Enter a category name", "error");
      if (cat) await updateDoc(doc(catCol, cat.id), { name, description, station, active, adult, updatedAt: serverTimestamp() });
      else {
        const ref = await addDoc(catCol, { name, description, station, active, adult, sortOrder: categories.length + 1, createdAt: serverTimestamp() });
        selectedCat = ref.id;
      }
      closeModal();
      toast("Saved");
    };
    foot.querySelector("[data-del]")?.addEventListener("click", async () => {
      const count = items.filter((it) => it.categoryId === cat.id).length;
      const ok = await confirmDialog(count ? `"${cat.name}" has ${count} item(s). They will be deleted too. Continue?` : `Delete "${cat.name}"?`);
      if (!ok) return;
      const batch = writeBatch(db);
      items.filter((it) => it.categoryId === cat.id).forEach((it) => batch.delete(doc(itemCol, it.id)));
      batch.delete(doc(catCol, cat.id));
      await batch.commit();
      closeModal();
      toast("Deleted");
    });
    openModal({ title: cat ? "Edit category" : "New category", body, footer: foot });
    setTimeout(() => body.querySelector("[name=name]").focus(), 50);
  }
  root.querySelector("#addCat").onclick = () => catForm(null);

  // ---------------- items ----------------
  function drawItems() {
    const list = root.querySelector("#itemList");
    const cat = categories.find((c) => c.id === selectedCat);
    root.querySelector("#itemsTitle").textContent = cat ? cat.name : labels.items;
    root.querySelector("#itemsHint").textContent = cat
      ? `${labels.items} under "${cat.name}". Toggle Available to mark sold out.`
      : "Create a category first.";
    list.innerHTML = "";
    const rows = items.filter((it) => it.categoryId === selectedCat);
    if (!rows.length) list.innerHTML = `<p class="muted small">Nothing here yet. Click "+ Add".</p>`;
    rows.forEach((it, i) => {
      const row = html(`
        <div class="item mi ${it.available === false ? "off" : ""}">
          <div class="thumb">${it.imageUrl ? `<img src="${esc(it.thumbUrl || it.imageUrl)}" alt="" loading="lazy" />` : mode === "salon" ? "✂️" : mode === "laundry" ? "🧺" : "🍽️"}</div>
          <div class="info">
            <div class="n">${esc(it.name)} ${it.options?.length ? `<span class="tag">${it.options.length} option${it.options.length > 1 ? "s" : ""}</span>` : ""}</div>
            <div class="d muted small">${esc(it.description || "")}</div>
          </div>
          <div class="price">${it.retail ? `<span class="pill">🛍 product${it.stock != null ? ` · ${it.stock} left` : ""}</span> ` : ""}${mode === "salon" && !Number(it.price) ? `<span class="muted small">Price on consult</span>` : money(it.price, store.settings?.currency)}${it.unit && it.unit !== "piece" ? `<span class="muted small">/${esc(it.unit)}</span>` : ""}</div>
          <label class="switch" title="Available"><input type="checkbox" ${it.available !== false ? "checked" : ""}/><span></span></label>
          <span class="acts">
            <button data-up title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
            <button data-down title="Move down" ${i === rows.length - 1 ? "disabled" : ""}>↓</button>
            <button data-edit title="Edit">✎ Edit</button>
          </span>
        </div>`);
      row.querySelector(".switch input").onchange = (e) =>
        updateDoc(doc(itemCol, it.id), { available: e.target.checked, updatedAt: serverTimestamp() });
      row.querySelector("[data-edit]").onclick = () => itemForm(it);
      row.querySelector("[data-up]").onclick = () => swapItems(rows, i, i - 1);
      row.querySelector("[data-down]").onclick = () => swapItems(rows, i, i + 1);
      list.appendChild(row);
    });
  }

  async function swapItems(rows, a, b) {
    if (b < 0 || b >= rows.length) return;
    const batch = writeBatch(db);
    const order = rows.map((r) => r.id);
    [order[a], order[b]] = [order[b], order[a]];
    order.forEach((id, i) => batch.update(doc(itemCol, id), { sortOrder: i + 1 }));
    await batch.commit();
  }

  function itemForm(it) {
    if (!selectedCat && !it) return toast("Create a category first", "error");
    const isBooking = mode === "booking" || mode === "salon";
    const isPickup = mode === "pickup" || mode === "laundry";
    const body = html(`
      <div class="form2">
        <div class="span2"><label>Name</label><input name="name" value="${esc(it?.name || "")}" placeholder="e.g. Iced Latte" /></div>
        <div><label>Price (${esc(store.settings?.currency || "PHP")})</label><input name="price" type="number" min="0" step="0.01" value="${it?.price ?? ""}" /></div>
        <div><label>Regular price <span class="muted small">(combos — shown crossed out)</span></label><input name="compareAt" type="number" min="0" step="0.01" value="${it?.compareAt ?? ""}" placeholder="optional" /></div>
        <div><label>Category</label>
          <select name="categoryId">${categories.map((c) => `<option value="${c.id}" ${(it?.categoryId || selectedCat) === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
        </div>
        ${isPickup ? `<div><label>Priced per</label><select name="unit"><option value="piece" ${it?.unit === "piece" ? "selected" : ""}>piece</option><option value="kg" ${it?.unit === "kg" ? "selected" : ""}>kg</option><option value="load" ${it?.unit === "load" ? "selected" : ""}>load</option>${mode === "laundry" ? `<option value="estimate" ${it?.unit === "estimate" ? "selected" : ""}>estimate (quote after inspection, e.g. dry clean)</option>` : ""}</select></div>` : ""}
        ${mode === "table" ? `<div><label>Station</label><select name="station"><option value="">Same as category</option><option value="kitchen" ${it?.station === "kitchen" ? "selected" : ""}>🍳 Kitchen</option><option value="barista" ${it?.station === "barista" ? "selected" : ""}>☕ Barista</option><option value="counter" ${it?.station === "counter" ? "selected" : ""}>🧾 Counter</option></select></div>` : ""}
        ${isBooking ? `<div><label>Duration (minutes, estimate)</label><input name="durationMinutes" type="number" min="5" step="5" value="${it?.durationMinutes ?? 30}" /><label class="check small" style="margin-top:4px"><input type="checkbox" name="wholeDay" ${it?.wholeDay ? "checked" : ""}/> Whole day — blocks the date (events, weddings)</label></div>` : ""}
        ${mode === "salon" ? `<div><label>Staff pay for this service</label><div class="row" style="gap:6px"><select name="payType" style="max-width:120px"><option value="fixed" ${it?.staffPay?.type !== "percent" ? "selected" : ""}>₱ fixed</option><option value="percent" ${it?.staffPay?.type === "percent" ? "selected" : ""}>% of price</option></select><input name="payValue" type="number" min="0" step="0.5" value="${it?.staffPay?.value ?? 0}" /></div></div>
          <div class="span2"><label>Price by hair length / size <span class="muted small">(optional — one per line: name | price | minutes)</span></label><textarea name="variants" rows="3" placeholder="Short | 350 | 45&#10;Medium | 450 | 60&#10;Long | 600 | 75">${esc((it?.variants || []).map((v) => `${v.label} | ${v.price} | ${v.duration || ""}`).join("\n"))}</textarea><p class="small muted" style="margin:4px 0 0">Clients pick one when booking. Leave empty to use the price above.</p></div>
          <div><label>Rebook reminder after (weeks, 0 = none)</label><input name="rebookWeeks" type="number" min="0" max="52" value="${it?.rebookWeeks ?? 0}" /></div>
          <div class="span2"><label class="check"><input type="checkbox" name="retail" ${it?.retail ? "checked" : ""}/> 🛍 Retail product (shampoo, serum…) — sold at the counter checkout, not bookable</label><label class="check"><input type="checkbox" name="sellOnline" ${it?.sellOnline ? "checked" : ""}/> 🛒 Customers can add it when booking (prints, frames, lashes, contact lenses…)</label></div>
          <div><label>Stock on hand (products only, blank = not tracked)</label><input name="stock" type="number" min="0" value="${it?.stock ?? ""}" /></div>` : ""}
        ${mode === "table" ? `<div class="span2"><label>🍽 Plating checklist for Dispatch <span class="muted small">(one per line — kitchen items only)</span></label><textarea name="plating" rows="4" placeholder="1 cup rice&#10;Fried egg&#10;Side: tomato &amp; cucumber&#10;Garnish: spring onion">${esc((it?.plating || []).join("\n"))}</textarea>
          <div class="row" style="gap:8px;margin-top:6px;align-items:center"><span class="small muted">Plating photo (optional)</span><input type="file" accept="image/*" data-pfile style="max-width:220px"/><input name="platingPhoto" value="${esc(it?.platingPhoto || "")}" placeholder="…or image URL" style="flex:1"/></div></div>` : ""}
        <div class="span2"><label>Description (optional)</label><input name="description" value="${esc(it?.description || "")}" placeholder="Short description" /></div>
        <div class="span2"><label>Photo (optional)</label>
          <div class="row" style="align-items:flex-start">
            <div class="imgprev" data-prev>${it?.imageUrl ? `<img src="${esc(it.imageUrl)}" alt=""/>` : `<span class="muted small">No photo</span>`}</div>
            <div class="stack" style="flex:1">
              <input type="file" accept="image/*" data-file />
              <input name="imageUrl" value="${esc(it?.imageUrl || "")}" placeholder="…or paste an image URL" />
              <div class="small muted" data-upstatus></div>
            </div>
          </div></div>
        <div class="span2">
          <div class="row between"><label style="margin:0">Options / add-ons</label><button class="btn ghost sm" type="button" data-addopt>+ Option group</button></div>
          <p class="small muted">e.g. Size (16oz +0, 22oz +20), Add-ons (Extra shot +30, Oat milk +25)</p>
          <div data-opts class="opts"></div>
        </div>
        <div class="span2"><label class="check"><input type="checkbox" name="available" ${it?.available !== false ? "checked" : ""}/> Available (uncheck = sold out)</label></div>
      </div>`);

    // ----- options editor -----
    const optsEl = body.querySelector("[data-opts]");
    let options = JSON.parse(JSON.stringify(it?.options || []));
    function drawOpts() {
      optsEl.innerHTML = "";
      options.forEach((g, gi) => {
        const box = html(`
          <div class="optgroup">
            <div class="row">
              <input placeholder="Group name (e.g. Size)" value="${esc(g.name)}" data-gname style="flex:1" />
              <label class="check small"><input type="checkbox" data-greq ${g.required ? "checked" : ""}/> Required</label>
              <label class="check small"><input type="checkbox" data-gmulti ${g.multi ? "checked" : ""}/> Multi-select</label>
              <button class="btn ghost sm" type="button" data-gdel title="Remove group">✕</button>
            </div>
            <div data-choices></div>
            <button class="btn ghost sm" type="button" data-addchoice>+ Choice</button>
          </div>`);
        box.querySelector("[data-gname]").oninput = (e) => (g.name = e.target.value);
        box.querySelector("[data-greq]").onchange = (e) => (g.required = e.target.checked);
        box.querySelector("[data-gmulti]").onchange = (e) => (g.multi = e.target.checked);
        box.querySelector("[data-gdel]").onclick = () => { options.splice(gi, 1); drawOpts(); };
        box.querySelector("[data-addchoice]").onclick = () => { g.choices.push({ label: "", add: 0 }); drawOpts(); };
        const ch = box.querySelector("[data-choices]");
        g.choices.forEach((c, ci) => {
          const r = html(`<div class="row choice">
            <input placeholder="Choice (e.g. 22oz)" value="${esc(c.label)}" data-cl style="flex:1" />
            <span class="muted small">+</span><input type="number" step="0.01" value="${c.add ?? 0}" data-ca style="width:90px" />
            <button class="btn ghost sm" type="button" data-cdel>✕</button></div>`);
          r.querySelector("[data-cl]").oninput = (e) => (c.label = e.target.value);
          r.querySelector("[data-ca]").oninput = (e) => (c.add = Number(e.target.value || 0));
          r.querySelector("[data-cdel]").onclick = () => { g.choices.splice(ci, 1); drawOpts(); };
          ch.appendChild(r);
        });
        optsEl.appendChild(box);
      });
    }
    // photo upload: uploads immediately and puts the URL in the field
    body.querySelector("[data-pfile]")?.addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return; toast("Uploading plating photo…");
      try { const url = await uploadImage(storeId, `plating-${it?.id || Date.now()}`, f, { max: 900 }); body.querySelector("[name=platingPhoto]").value = typeof url === "string" ? url : url?.url || ""; toast("Plating photo uploaded"); } catch (err) { toast(err.message, "error"); }
    });
    let photoJob = null;
    body.querySelector("[data-file]").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const st = body.querySelector("[data-upstatus]"); st.className = "upstatus busy"; st.textContent = "⏳ Uploading photo… don't close this yet";
      const prev = body.querySelector("[data-prev]"); prev.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="" style="opacity:.45"/><span class="upbadge">Uploading…</span>`;
      photoJob = (async () => {
        try {
          const id = it?.id || ("new-" + Date.now());
          const { url, thumbUrl } = await uploadItemImage(storeId, id, f);
          body.querySelector("[name=imageUrl]").value = url; body.dataset.thumb = thumbUrl;
          prev.innerHTML = `<img src="${url}" alt=""/>`;
          st.className = "upstatus ok"; st.textContent = "✓ Photo uploaded";
        } catch (err) { st.className = "upstatus err"; st.textContent = "⚠️ Upload failed: " + (err.message || err.code); prev.innerHTML = `<span class="muted small">No photo</span>`; }
      })();
      await photoJob; photoJob = null;
    };
    body.querySelector("[data-addopt]").onclick = () => { options.push({ name: "", required: false, multi: false, choices: [{ label: "", add: 0 }] }); drawOpts(); };
    drawOpts();

    const foot = html(`<div class="row between">
      <span>${it ? `<button class="btn ghost danger-text" type="button" data-del>Delete</button>` : ""}</span>
      <span class="row"><button class="btn ghost" type="button" data-cancel>Cancel</button><button class="btn" type="button" data-save>Save</button></span>
    </div>`);
    foot.querySelector("[data-cancel]").onclick = closeModal;
    foot.querySelector("[data-save]").onclick = async (ev) => {
      if (photoJob) { const b = ev.currentTarget; b.disabled = true; b.textContent = "Waiting for photo…"; await photoJob; b.disabled = false; b.textContent = "Save"; }
      const g = (n) => body.querySelector(`[name=${n}]`);
      const data = {
        name: g("name").value.trim(),
        price: Number(g("price").value),
        compareAt: Number(g("compareAt")?.value) > Number(g("price").value) ? Number(g("compareAt").value) : null,
        categoryId: g("categoryId").value,
        description: g("description").value.trim(),
        imageUrl: g("imageUrl").value.trim() || null,
        thumbUrl: body.dataset.thumb && g("imageUrl").value.trim() ? body.dataset.thumb : (g("imageUrl").value.trim() === (it?.imageUrl || "") ? it?.thumbUrl || null : null),
        unit: g("unit")?.value || "piece",
        station: g("station")?.value || null,
        ...(g("plating") ? { plating: g("plating").value.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 12), platingPhoto: g("platingPhoto").value.trim() || null } : {}),
        durationMinutes: g("wholeDay")?.checked ? Math.max(480, Number(g("durationMinutes").value) || 600) : g("durationMinutes") ? Number(g("durationMinutes").value) || null : null, wholeDay: !!g("wholeDay")?.checked,
        ...(g("payType") ? { staffPay: { type: g("payType").value, value: Number(g("payValue").value || 0) } } : {}),
        ...(g("variants") ? { variants: g("variants").value.split("\n").map((ln) => ln.split("|").map((x) => x.trim())).filter(([l, p]) => l && p !== undefined && p !== "" && Number(p) >= 0).slice(0, 8).map(([l, p, d]) => ({ label: l.slice(0, 30), price: Number(p), duration: Number(d) || null })) } : {}),
        ...(g("rebookWeeks") ? { rebookWeeks: Number(g("rebookWeeks").value || 0), retail: g("retail").checked, sellOnline: g("retail").checked && !!g("sellOnline")?.checked, stock: g("stock").value === "" ? null : Number(g("stock").value) } : {}),
        available: g("available").checked,
        options: options
          .filter((o) => o.name.trim())
          .map((o) => ({ name: o.name.trim(), required: !!o.required, multi: !!o.multi, choices: o.choices.filter((c) => c.label.trim()).map((c) => ({ label: c.label.trim(), add: Number(c.add || 0) })) }))
          .filter((o) => o.choices.length),
        updatedAt: serverTimestamp(),
      };
      if (!data.name) return toast("Enter a name", "error");
      if (!(data.price >= 0)) return toast("Enter a price", "error");
      if (it) await updateDoc(doc(itemCol, it.id), data);
      else {
        const lim = (planLim(ctx).items || 0);
        if (lim && items.length >= lim) return toast(`The ${planName(ctx)} plan has up to ${lim} ${labels.items.toLowerCase()}. Add “+20 items” or upgrade in Billing.`, "error");
        const n = items.filter((x) => x.categoryId === data.categoryId).length;
        await addDoc(itemCol, { ...data, sortOrder: n + 1, createdAt: serverTimestamp() });
      }
      closeModal();
      toast("Saved");
    };
    foot.querySelector("[data-del]")?.addEventListener("click", async () => {
      if (!(await confirmDialog(`Delete "${it.name}"?`))) return;
      await deleteDoc(doc(itemCol, it.id));
      closeModal();
      toast("Deleted");
    });
    openModal({ title: it ? `Edit ${it.name}` : `New ${labels.items === "Menu" ? "item" : "service"}`, body, footer: foot, wide: true });
    setTimeout(() => body.querySelector("[name=name]").focus(), 50);
  }
  root.querySelector("#addItem").onclick = () => itemForm(null);

  // ---------------- CSV import ----------------
  const salon = mode === "salon";
  const noun = labels.items === "Menu" ? "menu items" : labels.items.toLowerCase();
  const COLS = ["category", "name", "price", "description", "available", ...(salon ? ["duration_minutes"] : []), "compare_at_price"];
  root.querySelector("#csvImport").onclick = () => {
    const sample = salon ? [["Hair", "Haircut", "250", "Wash, cut and blow-dry", "yes", "45", ""], ["Nails", "Gel manicure", "450", "", "yes", "60", "550"]] : [["Coffee", "Iced latte", "120", "Double shot, fresh milk", "yes", "140"], ["Pastry", "Ensaymada", "65", "", "yes", ""]];
    const body = html(`<div>
      <p class="small">Add many ${esc(noun)} at once. Make a sheet in Excel / Google Sheets with these columns, then <b>File → Download → CSV</b>.</p>
      <div class="code small" style="white-space:pre-wrap">${esc(COLS.join(","))}</div>
      <p class="small muted">Only <b>name</b> and <b>price</b> are required. New categories are created automatically. <b>available</b>: yes/no (blank = yes).</p>
      <div class="row wrap"><button class="btn ghost sm" type="button" data-tpl>⬇ Download template</button><label class="btn sm" style="cursor:pointer;margin:0">Choose CSV file<input type="file" accept=".csv,text/csv" data-file hidden/></label></div>
      <label class="check" style="margin-top:10px"><input type="checkbox" data-upd checked/> Update existing ${esc(noun)} with the same name (instead of adding duplicates)</label>
      <div data-prev style="margin-top:10px"></div></div>`);
    const foot = html(`<div class="row"><button class="btn ghost" type="button" data-x>Cancel</button><button class="btn" type="button" data-go disabled>Import</button></div>`);
    foot.querySelector("[data-x]").onclick = closeModal;
    body.querySelector("[data-tpl]").onclick = () => {
      const csv = [COLS, ...sample].map((r) => r.map(csvCell).join(",")).join("\r\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv" })); a.download = `${store.slug || "menu"}-template.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    let plan = null;
    body.querySelector("[data-file]").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rows = parseCSV(await f.text()).filter((r) => r.some((c) => c.trim()));
      const head = (rows.shift() || []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
      const ix = (...ks) => ks.map((k) => head.indexOf(k)).find((i) => i >= 0) ?? -1;
      const I = { cat: ix("category", "categories"), name: ix("name", "item", "service"), price: ix("price"), desc: ix("description", "desc"), avail: ix("available", "active"), dur: ix("duration_minutes", "duration", "minutes"), cmp: ix("compare_at_price", "compare_at", "original_price") };
      const box = body.querySelector("[data-prev]");
      if (I.name < 0 || I.price < 0) { box.innerHTML = `<div class="alert error">The first row must be the column names, with at least <b>name</b> and <b>price</b>.</div>`; plan = null; foot.querySelector("[data-go]").disabled = true; return; }
      const errs = [], good = [];
      rows.forEach((r, n) => {
        const name = (r[I.name] || "").trim().slice(0, 80), price = Number(String(r[I.price] || "").replace(/[₱,\s]/g, ""));
        if (!name) return errs.push(`Row ${n + 2}: missing name`);
        if (!(price >= 0) || String(r[I.price] || "").trim() === "") return errs.push(`Row ${n + 2} (${name}): price is not a number`);
        const cmp = I.cmp >= 0 ? Number(String(r[I.cmp] || "").replace(/[₱,\s]/g, "")) : 0;
        good.push({ cat: (I.cat >= 0 ? r[I.cat] : "").trim().slice(0, 40) || "Other", name, price, description: I.desc >= 0 ? (r[I.desc] || "").trim().slice(0, 300) : "", available: I.avail < 0 || !/^(no|n|false|0|off|sold ?out)$/i.test((r[I.avail] || "").trim()), durationMinutes: I.dur >= 0 ? Number(r[I.dur]) || null : undefined, compareAt: cmp > price ? cmp : null });
      });
      const catByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c]));
      const newCats = [...new Set(good.map((g) => g.cat))].filter((c) => !catByName.has(c.toLowerCase()));
      const upd = body.querySelector("[data-upd]").checked;
      const existing = new Map(items.map((i) => [i.name.trim().toLowerCase(), i]));
      const nUpd = upd ? good.filter((g) => existing.has(g.name.toLowerCase())).length : 0, nNew = good.length - nUpd;
      const lim = (planLim(ctx).items || 0), over = lim && items.length + nNew > lim;
      plan = over || !good.length ? null : { good, newCats, upd };
      box.innerHTML = `<div class="alert ${over || !good.length ? "error" : "ok"}"><b>${good.length}</b> ready — ${nNew} new, ${nUpd} to update${newCats.length ? ` · ${newCats.length} new categor${newCats.length > 1 ? "ies" : "y"}: ${esc(newCats.join(", "))}` : ""}${over ? `<br>Your plan allows ${lim} ${esc(noun)} — you'd have ${items.length + nNew}. Upgrade in Billing or remove rows.` : ""}</div>
        ${errs.length ? `<div class="alert warn small"><b>${errs.length} row${errs.length > 1 ? "s" : ""} skipped:</b><br>${errs.slice(0, 8).map(esc).join("<br>")}${errs.length > 8 ? "<br>…" : ""}</div>` : ""}
        ${good.length ? `<div class="small" style="max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:6px 10px">${good.slice(0, 50).map((g) => `<div class="row between"><span>${esc(g.cat)} · <b>${esc(g.name)}</b>${g.available ? "" : " <span class='muted'>(sold out)</span>"}</span><span>${money(g.price)}</span></div>`).join("")}${good.length > 50 ? `<div class="muted">…and ${good.length - 50} more</div>` : ""}</div>` : ""}`;
      foot.querySelector("[data-go]").disabled = !plan;
    };
    body.querySelector("[data-upd]").onchange = () => body.querySelector("[data-file]").dispatchEvent(new Event("change"));
    foot.querySelector("[data-go]").onclick = async (e) => {
      if (!plan) return; e.target.disabled = true; e.target.textContent = "Importing…";
      try {
        const catByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));
        const writes = [];
        plan.newCats.forEach((name, i) => { const ref = doc(catCol); catByName.set(name.toLowerCase(), ref.id); writes.push((b) => b.set(ref, { name, description: "", station: null, active: true, adult: false, sortOrder: categories.length + i + 1, createdAt: serverTimestamp() })); });
        const existing = new Map(items.map((i) => [i.name.trim().toLowerCase(), i]));
        const perCat = {};
        for (const g of plan.good) {
          const categoryId = catByName.get(g.cat.toLowerCase());
          const data = { name: g.name, price: g.price, categoryId, description: g.description, available: g.available, compareAt: g.compareAt, ...(g.durationMinutes !== undefined ? { durationMinutes: g.durationMinutes } : {}), updatedAt: serverTimestamp() };
          const ex = plan.upd ? existing.get(g.name.toLowerCase()) : null;
          if (ex) writes.push((b) => b.update(doc(itemCol, ex.id), data));
          else { perCat[categoryId] = (perCat[categoryId] ?? items.filter((x) => x.categoryId === categoryId).length) + 1; const so = perCat[categoryId]; writes.push((b) => b.set(doc(itemCol), { ...data, imageUrl: null, thumbUrl: null, unit: "piece", options: [], sortOrder: so, createdAt: serverTimestamp() })); }
        }
        for (let i = 0; i < writes.length; i += 400) { const b = writeBatch(db); writes.slice(i, i + 400).forEach((w) => w(b)); await b.commit(); }
        closeModal(); toast(`Imported ${plan.good.length} ${noun}`);
      } catch (err) { toast(err.message, "error"); e.target.disabled = false; e.target.textContent = "Import"; }
    };
    openModal({ title: `Import ${noun} from CSV`, body, footer: foot, wide: true });
  };

  return () => unsubs.forEach((u) => u());
}

// CSV helpers (handles quotes, commas and new lines inside quotes)
function csvCell(v) { const t = String(v ?? ""); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }
export function parseCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = String(text).replace(/^\ufeff/, "");
  const first = text.split(/\r?\n/)[0] || "", delim = !first.includes(",") && first.includes(";") ? ";" : ","; // Excel in some locales saves with ;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
