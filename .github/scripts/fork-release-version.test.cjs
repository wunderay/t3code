const assert = require("node:assert/strict");
const test = require("node:test");
const { androidVersionCode, forkRelease, nextForkVersion } = require("./fork-release-version.cjs");

const tag = (name, sha = "old") => ({ name, commit: { sha } });

test("the first release of an upstream version gets counter 0", () => {
  assert.equal(nextForkVersion("0.1.10", [tag("v0.1.9"), tag("v0.1.10")], "new"), "0.1.1000");
});

test("later releases count up from the highest in the range", () => {
  const tags = [tag("v0.1.1000"), tag("v0.1.1002"), tag("v0.1.1100"), tag("v0.2.1005")];
  assert.equal(nextForkVersion("0.1.10", tags, "new"), "0.1.1003");
  assert.equal(nextForkVersion("0.1.11", tags, "new"), "0.1.1101");
});

test("nightly, preview and other tags are ignored", () => {
  const tags = [tag("v0.1.1050-nightly.20261120.1"), tag("nightly-v0.1.1099"), tag("v0.1.1001x")];
  assert.equal(nextForkVersion("0.1.10", tags, "new"), "0.1.1000");
});

test("a commit that already has a stable tag is not released again", () => {
  assert.equal(nextForkVersion("0.1.10", [tag("v0.1.1000", "same")], "same"), null);
  assert.equal(nextForkVersion("0.1.10", [tag("v0.1.1000-nightly.1", "same")], "same"), "0.1.1000");
});

test("a full range or an unusual upstream version stops the release", () => {
  assert.throws(() => nextForkVersion("0.1.10", [tag("v0.1.1099")], "new"), /No fork version left/);
  assert.throws(() => nextForkVersion("0.1.10-beta.1", [], "new"), /Unsupported upstream version/);
});

test("only main's tip is released", () => {
  const args = { upstreamVersion: "0.1.10", tags: [tag("v0.1.1000", "old")] };
  assert.deepEqual(forkRelease({ ...args, sha: "new", mainTip: "new" }), { version: "0.1.1001" });
  assert.match(forkRelease({ ...args, sha: "old2", mainTip: "new" }).skip, /no longer the tip/);
  assert.match(forkRelease({ ...args, sha: "old", mainTip: "old" }).skip, /already released/);
});

test("the Android versionCode rises with every fork version", () => {
  assert.equal(androidVersionCode("0.1.1001"), 101001);
  const order = ["0.0.0", "0.1.1001", "0.1.1002", "0.1.1100", "0.2.0", "1.0.0", "20.999.99999"];
  const codes = order.map(androidVersionCode);
  assert.deepEqual(
    [...codes].sort((a, b) => a - b),
    codes,
  );
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.at(-1) <= 2100000000);
  assert.throws(() => androidVersionCode("21.0.0"), /No Android versionCode/);
  assert.throws(() => androidVersionCode("0.1.1001-nightly.1"), /Unsupported fork version/);
});
