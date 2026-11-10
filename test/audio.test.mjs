import { test } from "node:test";
import assert from "node:assert/strict";
import { gainForTarget } from "../dist/workflow/audio.js";
import { keptRegionsFromSilences } from "../dist/workflow/audio.js";
import { secs, t } from "../dist/time.js";

test("gain math: -20 LUFS -> -16 LUFS target = 10^(4/20)", () => {
  const g = gainForTarget(-20, -16);
  assert.ok(Math.abs(g - 1.5848931924611136) < 1e-12);
});

test("gain math: louder-than-target source reduces gain", () => {
  const g = gainForTarget(-12, -16);
  assert.ok(g < 1 && Math.abs(g - Math.pow(10, -0.2)) < 1e-12);
});

test("kept regions invert silence with padding and snap to fps", () => {
  const silences = [
    { start: 10, end: 15, duration: 5 },
    { start: 15.5, end: 20.25, duration: 4.75 }, // back-to-back with padding merge
  ];
  const regions = keptRegionsFromSilences(silences, t(30), 0.1, 30);
  const s = regions.map((r) => [+secs(r.start).toFixed(3), +secs(r.duration).toFixed(3)]);
  // region 1: 0 .. 9.9 ; then a short 0.3s region and the tail to 30 (padding splits)
  assert.deepEqual(s[0], [0, 9.9]);
  assert.ok(s.length >= 2);
  const end = s[s.length - 1];
  assert.ok(end[0] + end[1] <= 30.001);
});
