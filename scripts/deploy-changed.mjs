// Smart deploy: only the Cloud Functions whose code actually changed since the last deploy from this computer.
//   npm run deploy:changed              → work out what changed, show the list, deploy it (in small batches)
//   npm run deploy:changed -- --dry     → only show what would be deployed
//   npm run deploy:changed -- --all     → deploy every function (and record them)
//   npm run deploy:changed -- --mark    → record the current code as "already deployed" (use right after a full deploy)
//
// How it decides: functions/index.js is split into its top-level pieces (each exports.X, function, const…).
// A function is redeployed when its own code, or any helper it uses (directly or through other helpers),
// or the shared setup (requires, global options, package.json, the local modules it loads) changed.
// When unsure it deploys more, never less. The record lives in .deploy/functions.json on this computer.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const PROJ = (() => { const i = process.argv.indexOf("--project"); return i > 0 ? process.argv[i + 1] : ""; })(); // "staging" → the test project

const ROOT = new URL("../", import.meta.url);
const read = (p) => (existsSync(new URL(p, ROOT)) ? readFileSync(new URL(p, ROOT), "utf8") : "");
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const has = (k) => process.argv.includes(k);
const SNAP = new URL(`.deploy/functions${PROJ && PROJ !== "default" ? "-" + PROJ : ""}.json`, ROOT); // a separate record per project (live / staging)

// ---- split index.js into top-level chunks
const src = read("functions/index.js");
const lines = src.split("\n");
const STARTER = /^(exports\.|async function |function |const |let |var |class |module\.|setGlobalOptions|db\.settings|admin\.|if |\/\*\*|\/\/)/;
const chunks = []; let cur = null, pendingComments = [];
for (const l of lines) {
  const top = l && !/^\s/.test(l) && !/^[}\])]/.test(l);
  if (top && /^(\/\*\*|\/\/)/.test(l)) { pendingComments.push(l); continue; } // doc comments belong to the next piece
  if (top && STARTER.test(l)) { cur = { text: [...pendingComments, l].join("\n"), head: l }; pendingComments = []; chunks.push(cur); }
  else if (cur) cur.text += "\n" + l;
}
if (cur && pendingComments.length) cur.text += "\n" + pendingComments.join("\n");
// local modules a chunk requires (./plans.js …): their content counts as part of the chunk
for (const c of chunks) for (const m of c.text.matchAll(/require\(["']\.\/([\w./-]+)["']\)/g)) c.text += "\n/*dep:" + m[1] + ":" + sha(read("functions/" + m[1])) + "*/";
// names each chunk declares
const declared = (c) => {
  const h = c.head; let m;
  if ((m = /^exports\.(\w+)/.exec(h))) return { exp: m[1], names: [m[1]] };
  if ((m = /^(?:async )?function\*?\s+(\w+)/.exec(h))) return { names: [m[1]] };
  if ((m = /^class\s+(\w+)/.exec(h))) return { names: [m[1]] };
  if ((m = /^(?:const|let|var)\s+\{([^}]*)\}/.exec(h))) return { names: m[1].split(",").map((x) => x.split(":").pop().trim()).filter(Boolean) };
  if ((m = /^(?:const|let|var)\s+(\w+)/.exec(h))) return { names: [m[1]] };
  return { names: [] }; // setup code (global options, db.settings, admin.initializeApp…) → affects everything
};
for (const c of chunks) Object.assign(c, declared(c));
const byName = new Map(); for (const c of chunks) for (const n of c.names) byName.set(n, c);
const globalText = chunks.filter((c) => !c.names.length).map((c) => c.text).join("\n") + read("functions/package.json") + read("functions/package-lock.json")
  + read("functions/.env") + read(`functions/.env.${PROJ === "staging" ? "taptayo-staging" : "orderqr-62446"}`); // secrets/settings changed (e.g. TURNSTILE_SECRET) → redeploy (only a hash is saved, never the values)
const GLOBAL = sha(globalText);
// direct deps: top-level names mentioned in the chunk
const words = (t) => new Set(t.match(/[A-Za-z_$][\w$]*/g) || []);
for (const c of chunks) { const w = words(c.text); c.deps = [...byName.keys()].filter((n) => w.has(n) && !c.names.includes(n)).map((n) => byName.get(n)); }
// effective hash of an export = its code + every helper it reaches + the shared setup
const exportsList = chunks.filter((c) => c.exp);
const eff = {};
for (const e of exportsList) {
  const seen = new Set([e]), stack = [e];
  while (stack.length) for (const d of stack.pop().deps) if (!seen.has(d)) { seen.add(d); stack.push(d); }
  eff[e.exp] = sha(GLOBAL + [...seen].map((c) => c.text).sort().join("\n\u0000"));
}

const snap = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, "utf8")) : {};
const save = (obj) => { mkdirSync(new URL(".deploy/", ROOT), { recursive: true }); writeFileSync(SNAP, JSON.stringify(obj, null, 1)); };
const all = Object.keys(eff);
const changed = has("--all") ? all : all.filter((n) => snap[n] !== eff[n]);
const removed = Object.keys(snap).filter((n) => !eff[n]);

if (has("--mark")) { save(eff); console.log(`Recorded ${all.length} functions as deployed. Next "deploy:changed" will only send what changes from now on.`); process.exit(0); }
if (!Object.keys(snap).length && !has("--all")) console.log("First run on this computer: no record yet, so every function will be deployed once. After this, only changes are sent.\n(If you JUST did a full deploy, stop now — Ctrl+C — and run:  npm run deploy:changed -- --mark)\n");
console.log(changed.length ? `${changed.length} of ${all.length} functions changed:\n  ${changed.join(", ")}` : `No function changed (${all.length} checked) — nothing to deploy.`);
if (removed.length) console.log(`\nRemoved from the code (still live — delete when ready):\n  npx firebase functions:delete ${removed.join(" ")} --region asia-southeast1`);
if (has("--dry") || !changed.length) process.exit(0);

// deploy in batches (same quota-safe batching as deploy-functions.mjs), record each batch that succeeds
const size = 10, wait = changed.length > size ? 70 : 0;
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const run = (b) => spawnSync(`npx firebase deploy${PROJ ? " --project " + PROJ : ""} --only ${b.map((n) => "functions:" + n).join(",")}`, { stdio: "inherit", shell: true }).status === 0;
const failed = [];
for (let i = 0; i < changed.length; i += size) {
  const batch = changed.slice(i, i + size);
  console.log(`\n=== ${i + 1}–${i + batch.length} of ${changed.length}: ${batch.join(", ")}`);
  let ok = run(batch);
  if (!ok) { console.log(`Failed — waiting ${wait + 30}s and retrying once…`); await sleep(wait + 30); ok = run(batch); }
  if (ok) { for (const n of batch) snap[n] = eff[n]; for (const n of removed) delete snap[n]; save(snap); } else failed.push(...batch);
  if (i + size < changed.length) { console.log(`Waiting ${wait}s (Google quota)…`); await sleep(wait); }
}
if (failed.length) { console.log(`\nNot deployed (${failed.length}): ${failed.join(", ")}\nJust run "npm run deploy:changed" again — it retries only these.`); process.exit(1); }
console.log("\nDone ✓ — only the changed functions were deployed.");
