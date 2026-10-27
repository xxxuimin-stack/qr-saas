const test = require("node:test");
const assert = require("node:assert/strict");
const { paymentDecision } = require("./adminpay");

test("a pending payment can be applied once", () => {
  assert.equal(paymentDecision("pending"), "apply");
});

test("confirming the same payment again does not apply", () => {
  assert.equal(paymentDecision("confirmed"), "already");
  assert.equal(paymentDecision("comp"), "already");
});

test("a rejected payment cannot be activated", () => {
  assert.equal(paymentDecision("rejected"), "blocked");
  assert.equal(paymentDecision(undefined), "blocked");
});
