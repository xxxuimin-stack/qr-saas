const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const rules = fs.readFileSync(path.join(__dirname, "../firestore.rules"), "utf8");
const statusFn = rules.slice(rules.indexOf("function onlyStatusChanged()"), rules.indexOf("function onlyStatusChanged()") + 900);

test("order updates cannot change the bill from the client", () => {
  assert.match(rules, /allow update: if \(isOwner\(storeId\) \|\| memberOf\(storeId\)\) && onlyStatusChanged\(\)/);
  for (const field of ["total", "subtotal", "items", "paid", "payment", "discounts", "customerUid"]) {
    assert.equal(statusFn.includes(`'${field}'`), false, field);
  }
});


test("duty documents are limited to heartbeat fields and must match their document ID", () => {
  assert.match(rules, /match \/duty\/\{id\}[\s\S]*?request\.resource\.data\.staffId == id/);
  assert.match(rules, /allow delete: if false;/);
  assert.match(rules, /affectedKeys\(\)\s*\.hasOnly\(\['name', 'roles', 'screen', 'visible', 'at', 'atMs', 'delivering', 'returning', 'off'\]\)/);
});

test("shift opening facts cannot be changed by later client updates", () => {
  const block = rules.slice(rules.indexOf("match /shifts/{id}"), rules.indexOf("match /feedback/{id}"));
  assert.match(block, /allow create: if memberOf\(storeId\)/);
  assert.match(block, /startingCash is number/);
  assert.match(block, /affectedKeys\(\)\s*\.hasOnly\(\['status', 'closedBy', 'closedByName', 'closedAt', 'countedCash', 'expectedCash', 'variance', 'tally', 'closeNote', 'updatedAt'\]\)/);
  const update = block.slice(block.indexOf("allow update:"), block.indexOf("allow delete:"));
  for (const field of ["openedBy", "openedByName", "openedAt", "startingCash", "createdAt", "note"]) {
    assert.equal(update.includes(`'${field}'`), false, field);
  }
});
