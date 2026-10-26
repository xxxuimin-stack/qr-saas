const test = require("node:test");
const assert = require("node:assert/strict");
const { orderKeyId } = require("./orderkey");

test("accepts a checkout id", () => {
  assert.equal(orderKeyId("c0abc1234"), "c0abc1234");
});

test("strips dashes from a uuid", () => {
  assert.equal(orderKeyId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), "aaaaaaaabbbbccccddddeeeeeeeeeeee");
});

test("rejects short, empty, and path-like keys", () => {
  assert.equal(orderKeyId(""), null);
  assert.equal(orderKeyId("short"), null);
  assert.equal(orderKeyId("../stores/other"), null);
  assert.equal(orderKeyId("bad key!!"), null);
});
