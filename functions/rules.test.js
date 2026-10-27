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
