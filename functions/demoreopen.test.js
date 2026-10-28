const test = require("node:test");
const assert = require("node:assert/strict");
const { demoShouldReopen } = require("./demoreopen");

test("a closed demo shop reopens", () => {
  assert.equal(demoShouldReopen({ acceptOrders: false, locked: false }, { demo: true, acceptOrders: false }), true);
});

test("a real shop stays closed", () => {
  assert.equal(demoShouldReopen({ acceptOrders: false }, { demo: false, acceptOrders: false }), false);
});

test("a locked demo stays closed", () => {
  assert.equal(demoShouldReopen({ acceptOrders: false, locked: true }, { demo: true, acceptOrders: false }), false);
});
