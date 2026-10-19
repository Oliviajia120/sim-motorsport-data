import assert from "node:assert/strict";
import {
  ZIC_TEMPLATE,
  coachingChannelKeys,
  deltaVsDistance,
  formatSigned,
  markersForLap,
  parseSplitDocument,
  sectorTableFromSpans,
  serializeSplitDocument,
  spansFromSplits,
  spansFromTemplate,
  timeAtFraction,
  topSectorLosses,
  type LapProfile,
  type Sample,
} from "./telemetry.ts";

function lap(num: number, duration: number, total: number): LapProfile {
  const steps = 200;
  const times: number[] = [];
  const dist: number[] = [];
  for (let i = 0; i <= steps; i++) {
    times.push((duration * i) / steps);
    dist.push((total * i) / steps);
  }
  return { num, startMs: 0, endMs: duration * 1000, duration, times, dist, total, source: "gps" };
}

const length = 4200;
const placed = spansFromTemplate(ZIC_TEMPLATE, length);
const corners = placed.spans.filter((span) => span.kind === "corner");

assert.equal(corners.length, 11);
assert.deepEqual(
  corners.map((span) => span.id),
  ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11"],
);
assert.equal(placed.spans[0]?.from, 0);
assert.equal(placed.spans[placed.spans.length - 1]?.to, 1);
for (let i = 1; i < placed.spans.length; i++) {
  assert.ok(Math.abs(placed.spans[i]!.from - placed.spans[i - 1]!.to) < 1e-9, `gap before ${placed.spans[i]!.id}`);
}
const c1 = corners[0]!;
assert.ok(Math.abs(c1.from - 157 / length) < 1e-9);
assert.equal(c1.turn, "RIGHT");
assert.equal(c1.brake, c1.from);
assert.equal(corners[2]?.turn, "LEFT");
assert.equal(corners[5]?.apexMode, "lean");
assert.equal(corners[5]?.brake, null);
assert.equal(corners.find((span) => span.id === "C7")?.from, corners.find((span) => span.id === "C6")?.to);

const fast = lap(1, 100, length);
const slow = lap(2, 102, length);
const rows = sectorTableFromSpans([fast, slow], placed.spans);
assert.equal(rows.length, placed.spans.length);
const c1Row = rows.find((row) => row.id === "C1")!;
assert.ok(c1Row.times[1]! > c1Row.times[0]!, "slower lap loses time in C1");
assert.equal(c1Row.bestLap, 1);
assert.equal(c1Row.bestIndex, 0);
const losses = topSectorLosses(rows, 0, 1, 3);
assert.equal(losses.length, 3);
assert.ok(losses[0]!.delta >= losses[1]!.delta);

const delta = deltaVsDistance(fast, slow, 20);
assert.equal(delta[0]?.delta, 0);
assert.ok(Math.abs(delta[delta.length - 1]!.delta - 2) < 1e-6);
assert.ok(delta[10]!.delta > 0, "positive delta means behind the reference");
assert.equal(formatSigned(0.258), "+0.258");
assert.equal(formatSigned(-0.087), "−0.087");

const legacy = parseSplitDocument(JSON.stringify([0.25, 0.5, 0.75]));
assert.equal(legacy?.templateId, "manual");
assert.equal(legacy?.spans.length, 4);
const round = parseSplitDocument(serializeSplitDocument({ v: 2, templateId: "zic", lapLengthM: length, spans: placed.spans }));
assert.equal(round?.spans.filter((span) => span.kind === "corner").length, 11);

const keys = coachingChannelKeys([
  { key: "GPS Speed", label: "GPS Speed" },
  { key: "Front Brake", label: "Front Brake" },
  { key: "Rear Brake", label: "Rear Brake" },
  { key: "Twist Grip", label: "Throttle Twist Grip" },
  { key: "Lean", label: "Lean Angle" },
  { key: "RPM", label: "Engine RPM" },
]);
assert.equal(keys.brake, "Front Brake");
assert.equal(keys.throttle, "Twist Grip");
assert.equal(keys.lean, "Lean");
assert.equal(keys.speed, "GPS Speed");

const markerLap = lap(3, 80, 4000);
const brake: Sample[] = [];
const speed: Sample[] = [];
for (let t = 0; t <= 80; t += 0.1) {
  const braking = t >= 20 && t <= 28;
  brake.push({ t, v: braking ? Math.min(10, (t - 20) * 4) : 0 });
  const inCorner = t >= 20 && t <= 32;
  speed.push({ t, v: inCorner ? 70 + Math.abs(t - 26) * 8 : 200 });
}
const spans = spansFromSplits([]);
const window = {
  id: "C3",
  label: "C3",
  kind: "corner" as const,
  from: 18 / 80,
  to: 34 / 80,
  apex: 26 / 80,
  brake: 20 / 80,
  turn: "LEFT" as const,
  apexMode: "speed" as const,
};
assert.equal(spans.length, 0);
const hits = markersForLap(markerLap, [window], {
  brake,
  brakeUnit: "bar",
  speed,
  speedScale: 1,
  lean: null,
  leanScale: 1,
});
const brakeHit = hits.find((hit) => hit.kind === "brake");
const apexHit = hits.find((hit) => hit.kind === "apex");
assert.ok(brakeHit && Math.abs(brakeHit.t - 20.2) < 0.35, `brake onset ${brakeHit?.t}`);
assert.ok(apexHit && Math.abs(apexHit.t - 26) < 0.35, `apex ${apexHit?.t}`);
assert.ok(Math.abs(timeAtFraction(markerLap, 0.5) - 40) < 1e-6);

const shortLap = spansFromTemplate(ZIC_TEMPLATE, 3000);
assert.equal(shortLap.scaled, true);
assert.equal(shortLap.spans[shortLap.spans.length - 1]?.to, 1);
assert.ok(shortLap.spans.every((span) => span.to <= 1 && span.from >= 0 && span.to > span.from));

console.log("coaching maths ok");
