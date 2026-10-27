const test = require("node:test");
const assert = require("node:assert/strict");
const { slotClash } = require("./slotlock");

const at = (h, m = 0) => Date.parse(`2026-10-28T0${h}:${String(m).padStart(2, "0")}:00+08:00`);

test("same stylist cannot take an overlapping time", () => {
  const existing = [{ id: "a", status: "confirmed", providerId: "bea", startMs: at(2), duration: 60 }];
  assert.equal(slotClash(existing, { startMs: at(2, 30), endMs: at(3, 30), providerId: "bea", stylistCount: 2 }), true);
});

test("a different stylist can take that time", () => {
  const existing = [{ id: "a", status: "confirmed", providerId: "bea", startMs: at(2), duration: 60 }];
  assert.equal(slotClash(existing, { startMs: at(2), endMs: at(3), providerId: "mia", stylistCount: 2 }), false);
});

test("cancelled bookings do not block the slot", () => {
  const existing = [{ id: "a", status: "cancelled", providerId: "bea", startMs: at(2), duration: 60 }];
  assert.equal(slotClash(existing, { startMs: at(2), endMs: at(3), providerId: "bea", stylistCount: 1 }), false);
});

test("an open booking fills the last free stylist", () => {
  const existing = [{ id: "a", status: "pending", providerId: "bea", startMs: at(2), duration: 60 }];
  assert.equal(slotClash(existing, { startMs: at(2), endMs: at(3), providerId: null, stylistCount: 1 }), true);
  assert.equal(slotClash(existing, { startMs: at(2), endMs: at(3), providerId: null, stylistCount: 2 }), false);
});
