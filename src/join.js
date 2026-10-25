// Staff invite page: /join/?i=<token> — the employee sets their own name + PIN (no account needed)
import { call } from "./firebase.js";

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ROLE = { manager: "Manager", crew: "Counter / cashier", kitchen: "Kitchen", barista: "Barista", rider: "Rider", stylist: "Stylist", dispatch: "Dispatch", cleaner: "Caretaker (rooms)" };
const token = new URLSearchParams(location.search).get("i") || "";

function fail(msg) {
  app.innerHTML = `<div class="logo" aria-hidden="true">!</div><h1>Invite not available</h1><div class="err" role="alert">${esc(msg)}</div><p class="small">Ask the shop owner to send you a new invite link.</p>`;
}

async function start() {
  if (!token) return fail("This link is missing the invite code.");
  let inv;
  try { inv = await call("getStaffInvite", { token }); } catch (e) { return fail(e.message); }
  const logo = inv.logoUrl ? `<img class="logo" src="${esc(inv.logoUrl)}" alt="" />` : `<div class="logo" aria-hidden="true">${esc((inv.storeName || "?")[0])}</div>`;
  app.innerHTML = `${logo}<h1>Join ${esc(inv.storeName)}</h1>
    <p>You've been invited to the team as:</p>
    <div class="roles">${inv.roles.map((r) => `<span>${esc(ROLE[r] || r)}</span>`).join("")}</div>
    <form id="f" novalidate>
      <label for="nm">Your name</label><input id="nm" autocomplete="name" maxlength="40" placeholder="e.g. Ben" required />
      <label for="p1">Choose a PIN (4–6 digits)</label><input id="p1" class="pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6" required />
      <label for="p2">Type the PIN again</label><input id="p2" class="pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6" required />
      <p class="small">Keep your PIN to yourself — it's how the shop knows it's you on the shared device.</p>
      <label class="agree" style="display:flex;gap:8px;align-items:flex-start;font-weight:500;font-size:.88rem;margin-top:10px"><input type="checkbox" id="agree" style="width:auto;margin-top:3px"/> <span>I agree to the shop rules: I will <b>not offer or book services for the shop's customers outside the app</b> (no direct or "side" bookings), and customers can report it privately to the owner.</span></label>
      <div id="msg"></div>
      <button type="submit" id="go">Join the team</button>
    </form>
    <p class="small" style="margin-top:12px">Link expires ${esc(new Date(inv.expiresAt).toLocaleDateString("en-PH", { month: "short", day: "numeric" }))}.</p>`;
  const $ = (id) => document.getElementById(id);
  $("nm").focus();
  $("f").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("nm").value.trim(), p1 = $("p1").value.trim(), p2 = $("p2").value.trim();
    const err = (m, el) => { $("msg").innerHTML = `<div class="err" role="alert">${esc(m)}</div>`; el?.focus(); };
    if (name.length < 2) return err("Enter your name.", $("nm"));
    if (!/^\d{4,6}$/.test(p1)) return err("PIN must be 4–6 digits.", $("p1"));
    if (p1 !== p2) return err("The two PINs don't match.", $("p2"));
    if (!$("agree").checked) return err("Please read and agree to the shop rules.", $("agree"));
    $("go").disabled = true; $("go").textContent = "Joining…";
    try {
      const r = await call("acceptStaffInvite", { token, name, pin: p1, agreed: true });
      app.innerHTML = `${logo}<h1>You're in, ${esc(name.split(" ")[0])}! 🎉</h1>
        <div class="ok"><b>Welcome to ${esc(r.storeName)}.</b></div>
        <p><b>How to start your shift:</b></p>
        <ol><li>Use the shop's device (the one at the counter / kitchen).</li><li>Open the staff screen and tap your name.</li><li>Enter the PIN you just chose.</li></ol>
        <p class="small">Forgot your PIN? The owner can reset it in Staff.</p>`;
    } catch (e2) { $("go").disabled = false; $("go").textContent = "Join the team"; err(e2.message); }
  };
}
start();
