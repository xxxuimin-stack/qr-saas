const test = require("node:test");
const assert = require("node:assert/strict");
const { pinFailNext } = require("./pinfail");

test("ten wrong PINs lock the staff member", () => {
  let rec = { count: 0, lockedUntil: 0 };
  const now = 1_000_000;
  for (let i = 0; i < 9; i++) rec = pinFailNext(rec, now);
  assert.equal(rec.locked, false);
  assert.equal(rec.count, 9);
  rec = pinFailNext(rec, now);
  assert.equal(rec.locked, true);
  assert.equal(rec.lockedUntil, now + 15 * 60000);
});

test("a locked PIN stays locked until the time passes", () => {
  const now = 5_000;
  const rec = pinFailNext({ count: 0, lockedUntil: now + 1000 }, now);
  assert.equal(rec.locked, true);
  assert.equal(rec.lockedUntil, now + 1000);
});
