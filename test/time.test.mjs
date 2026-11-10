import { test } from "node:test";
import assert from "node:assert/strict";
import { t, parseTime, timeStr, add, sub, cmp, secs, fromSeconds, frameDuration, frameDurationCanonical } from "../dist/time.js";

test("parses whole-second and rational FCPXML time strings", () => {
  assert.deepEqual(parseTime("150s"), { num: 150, den: 1 });
  assert.deepEqual(parseTime("150/30s"), { num: 5, den: 1 }); // reduced!
  assert.deepEqual(parseTime("1/60s"), { num: 1, den: 60 });
  assert.throws(() => parseTime("abc"));
  assert.throws(() => parseTime("1.5s"));
});

test("renders canonical strings", () => {
  assert.equal(timeStr(t(5)), "5s");
  assert.equal(timeStr(t(1, 60)), "1/60s");
  assert.equal(timeStr(parseTime("150/30s")), "5s");
});

test("rational arithmetic stays exact", () => {
  const a = parseTime("50/1s"), b = parseTime("5/30s");
  assert.equal(secs(add(a, b)), 50.166666666666664);
  assert.equal(cmp(t(1, 3), t(2, 6)), 0);
  assert.equal(secs(sub(t(1, 2), t(1, 3))), secs(t(1, 6)));
});

test("frameDuration handles integer and NTSC rates (Apple canonical)", () => {
  assert.equal(timeStr(frameDuration(30)), "1/30s");
  assert.equal(timeStr(frameDuration(29.97)), "100/2997s");
  assert.equal(timeStr(frameDurationCanonical(23.976)), "100/2398s");
});

test("fromSeconds snaps to frame grid", () => {
  assert.equal(timeStr(fromSeconds(10.05, 30)), "301/30s");
  assert.equal(timeStr(fromSeconds(0, 60)), "0s");
});
