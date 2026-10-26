// Deploy Cloud Functions in small batches so we stay under Google's
// "mutation requests per minute" quota (HTTP 429 "Quota exceeded").
//   node scripts/deploy-functions.mjs              → all functions, 10 per batch
//   node scripts/deploy-functions.mjs --from 41    → resume from function #41 (shown in the log)
//   node scripts/deploy-functions.mjs --only a,b   → just these functions
//   node scripts/deploy-functions.mjs --size 8 --wait 75
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const PROJ = (() => { const i = process.argv.indexOf("--project"); return i > 0 ? process.argv[i + 1] : ""; })(); // "staging" → the test project

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const size = Number(arg("--size", 10)), wait = Number(arg("--wait", 70)), from = Number(arg("--from", 1));
const src = readFileSync(new URL("../functions/index.js", import.meta.url), "utf8");
let names = [...new Set([...src.matchAll(/^exports\.([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]))];
if (arg("--only")) names = arg("--only").split(",").map((s) => s.trim()).filter(Boolean);
const list = names.slice(from - 1);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const run = (batch) => spawnSync(`npx firebase deploy${PROJ ? " --project " + PROJ : ""} --only ${batch.map((n) => "functions:" + n).join(",")}`, { stdio: "inherit", shell: true }).status === 0;

console.log(`Deploying ${list.length} of ${names.length} functions, ${size} at a time, ${wait}s apart.`);
const failed = [];
for (let i = 0; i < list.length; i += size) {
  const batch = list.slice(i, i + size), first = from + i;
  console.log(`\n=== Batch #${first}–${first + batch.length - 1}: ${batch.join(", ")}`);
  let ok = run(batch);
  if (!ok) { console.log(`Batch failed — waiting ${wait + 30}s and retrying once…`); await sleep(wait + 30); ok = run(batch); }
  if (!ok) { failed.push(...batch); console.log(`Still failing. Resume later with: node scripts/deploy-functions.mjs --from ${first}`); }
  if (i + size < list.length) { console.log(`Waiting ${wait}s (quota)…`); await sleep(wait); }
}
if (failed.length) { console.log(`\nNot deployed (${failed.length}): ${failed.join(",")}\nRetry with: node scripts/deploy-functions.mjs --only ${failed.join(",")}`); process.exit(1); }
console.log("\nAll functions deployed ✓");
// remember what's live so "npm run deploy:changed" only sends what changes from now on
if (!arg("--only") && from === 1) spawnSync(`node scripts/deploy-changed.mjs --mark${PROJ ? " --project " + PROJ : ""}`, { stdio: "inherit", shell: true });
