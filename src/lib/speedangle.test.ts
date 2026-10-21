import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ZIC_TEMPLATE,
  coachingChannelKeys,
  deltaVsDistance,
  fractionAtTime,
  markersForLap,
  prepareLog,
  sliceChannel,
  spansFromTemplate,
} from "./telemetry.ts";
import { parseSa } from "./speedangle.ts";

const MPH_KMH = 1.609344;

/**
 * SYNTHETIC SpeedAngle text. Not an R4 export.
 * Columns follow the R4 manual and the public racechrono converter:
 * lat, lon, lean (+right/−left), angle, long G (+accel/−brake), G, speed,
 * previous-turn angle (−255 filler), satellites, validity, F/sector/0.
 * Both G columns are counts of 0.02 G, same as an R4 export.
 */

const LAT0 = 22.367;
const LON0 = 113.591;

function row(lat: number, lon: number, lean: number, longG: number, speed: number, prev: number, mark: string): string {
  return `${lat.toFixed(6)},${lon.toFixed(6)},${lean},0,${longG},${longG},${speed},${prev},12,1,${mark}`;
}

function movingFixture(): { text: string; start1: number } {
  const out = 30;
  const lap1 = 200;
  const lap2 = 220;
  const start1 = out;
  const lines = [
    "# SYNTHETIC SpeedAngle fixture — not an R4 export. Column layout from the R4 manual.",
    "#ID=SYNTHETIC RIDER",
    "#D=10:15:30",
    "#T=ZHUHAI",
    "#UNIT=KMH",
    "#V=R4-TEST",
    "ZHUHAI",
    "4",
    "22.000000,113.000000",
    "22.016000,113.378000,1,1,1,1,10,-255,8,1,F",
    "TRACK SETTING",
    "",
  ];
  let lat = LAT0;
  const push = (count: number, at: (k: number) => { lean: number; g: number; speed: number; prev: number; mark: string }) => {
    for (let k = 0; k < count; k++) {
      const sample = at(k);
      const metres = (sample.speed / 3.6) * 0.1;
      lines.push(row(lat, LON0, sample.lean, sample.g, sample.speed, sample.prev, sample.mark));
      lat += metres / 111320;
      if (lines.length === 24) lines.push("");
    }
  };
  push(out, () => ({ lean: 0, g: 0, speed: 40, prev: -255, mark: "0" }));
  push(1, () => ({ lean: 35, g: 0, speed: 160, prev: 42, mark: "F" }));
  push(lap1 - 1, (k) => {
    const along = k + 1;
    const braking = along >= 40 && along <= 80;
    const corner = along >= 40 && along <= 100;
    const speed = corner ? 70 + Math.abs(along - 70) * 2 : 160;
    return { lean: 35, g: braking ? -50 : along > 80 && along < 100 ? 50 : 0, speed, prev: -255, mark: along === 50 ? "1" : "0" };
  });
  push(1, () => ({ lean: 35, g: 0, speed: 160, prev: -255, mark: "F" }));
  push(lap2 - 1, () => ({ lean: -28, g: 0, speed: 150, prev: -255, mark: "0" }));
  push(1, () => ({ lean: -28, g: 0, speed: 150, prev: -255, mark: "F" }));
  return { text: lines.join("\n"), start1 };
}

const built = movingFixture();
const parsed = parseSa(built.text, "synthetic-zhuhai.sa");
const prepared = prepareLog(parsed, "synthetic-zhuhai.sa");

assert.equal(parsed.metadata["Driver"], "SYNTHETIC RIDER");
assert.equal(parsed.metadata["Venue"], "ZHUHAI");
assert.equal(parsed.metadata["Log Time"], "10:15:30");
assert.equal(parsed.metadata["Vehicle"], "SpeedAngle R4-TEST");
assert.equal(parsed.metadata["Speed Unit"], "km/h");
assert.equal(parsed.laps.length, 2, "finish marks bound the flying laps; the sector digit does not");
assert.equal(parsed.laps[0]?.startTime, built.start1 * 100);
assert.equal(parsed.laps[0]?.endTime, (built.start1 + 200) * 100);
assert.equal(parsed.laps[1]?.endTime! - parsed.laps[1]?.startTime!, 220 * 100);

const speed = parsed.channels["GPS Speed"]!;
const lean = parsed.channels["Lean Angle"]!;
const longG = parsed.channels["Longitudinal G"]!;
assert.equal(speed.units, "km/h");
assert.equal(speed.values[0], 40);
assert.equal(speed.values[built.start1], 160);
assert.equal(lean.values[built.start1], 35);
assert.equal(lean.values[parsed.laps[1]!.startTime / 100 + 5], -28);
assert.equal(longG.values[built.start1 + 40], -1);
assert.equal(longG.units, "G");
assert.equal(parsed.channels["G 2"]!.values[built.start1 + 40], -1);
assert.equal(parsed.channels["G 2"]!.units, "G");
assert.ok(Number.isNaN(parsed.channels["Max Angle Previous Turn"]!.values[0]));
assert.equal(parsed.channels["Max Angle Previous Turn"]!.values[built.start1], 42);
assert.equal(speed.timecodes[1]! - speed.timecodes[0]!, 100);

assert.equal(prepared.track, "ZHUHAI");
assert.equal(prepared.rider, "SYNTHETIC RIDER");
assert.equal(prepared.laps.length, 2);
assert.equal(prepared.laps[0]?.source, "gps");
assert.equal(prepared.laps[0]?.duration, 20);
assert.equal(prepared.laps[1]?.duration, 22);
assert.ok(prepared.laps[0]!.total > 400, `lap length ${prepared.laps[0]?.total}`);
assert.ok(prepared.laps.every((lap) => lap.total > 50));

const keys = coachingChannelKeys(prepared.channels);
assert.equal(keys.speed, "GPS Speed");
assert.equal(keys.lean, "Lean Angle");
assert.equal(keys.brake, "Longitudinal G");
assert.equal(keys.throttle, undefined);

const aimFirst = coachingChannelKeys([
  { key: "Front Brake", label: "Front Brake" },
  { key: "Longitudinal G", label: "Longitudinal G" },
  { key: "Lean Angle", label: "Lean Angle" },
]);
assert.equal(aimFirst.brake, "Front Brake");

const placed = spansFromTemplate(ZIC_TEMPLATE, prepared.laps[0]!.total);
assert.equal(placed.spans.filter((span) => span.kind === "corner").length, 11);
assert.equal(placed.spans[0]?.from, 0);
assert.equal(placed.spans[placed.spans.length - 1]?.to, 1);

const delta = deltaVsDistance(prepared.laps[0]!, prepared.laps[1]!, 24);
assert.equal(delta[0]?.delta, 0);
assert.ok(Math.abs(delta[delta.length - 1]!.delta - 2) < 1e-6, `end delta ${delta[delta.length - 1]?.delta}`);

const gCh = prepared.channels.find((channel) => channel.key === "Longitudinal G")!;
const speedCh = prepared.channels.find((channel) => channel.key === "GPS Speed")!;
const leanCh = prepared.channels.find((channel) => channel.key === "Lean Angle")!;
const lap = prepared.laps[0]!;
const hits = markersForLap(lap, [
  {
    id: "C1",
    label: "C1",
    kind: "corner",
    from: fractionAtTime(lap, 2),
    to: fractionAtTime(lap, 12),
    apex: fractionAtTime(lap, 7),
    brake: fractionAtTime(lap, 4),
    turn: "RIGHT",
    apexMode: "speed",
  },
], {
  brake: sliceChannel(gCh.channel, lap.startMs, lap.endMs),
  brakeUnit: gCh.unit,
  speed: sliceChannel(speedCh.channel, lap.startMs, lap.endMs),
  speedScale: speedCh.scale,
  lean: sliceChannel(leanCh.channel, lap.startMs, lap.endMs),
  leanScale: leanCh.scale,
});
const brakeHit = hits.find((hit) => hit.kind === "brake");
const apexHit = hits.find((hit) => hit.kind === "apex");
assert.ok(brakeHit && Math.abs(brakeHit.t - 4) < 0.2, `brake onset ${brakeHit?.t}`);
assert.ok(apexHit && Math.abs(apexHit.t - 7) < 0.25, `apex ${apexHit?.t}`);

function flat(unitLine: string, loggedSpeed: number, metresPerSample: number, count = 40): string {
  const lines = ["# SYNTHETIC", unitLine].filter(Boolean);
  let lat = 22.01;
  for (let i = 0; i < count; i++) {
    const mark = i === 5 || i === count - 1 ? "F" : "0";
    lines.push(row(lat, 113.5, 10, 0, loggedSpeed, -255, mark));
    lat += metresPerSample / 111320;
  }
  return lines.join("\n");
}

const mphLogged = parseSa(flat("", 100, (100 * MPH_KMH) / 3.6 * 0.1), "plain.sa");
assert.equal(mphLogged.metadata["Speed Unit"], "mph converted to km/h");
assert.ok(Math.abs((mphLogged.channels["GPS Speed"]!.values[10] as number) - 100 * MPH_KMH) < 0.01);

const headerKmh = parseSa(flat("#UNIT=KMH", 100, (100 * MPH_KMH) / 3.6 * 0.1), "plain.sa");
assert.equal(headerKmh.metadata["Speed Unit"], "km/h");
assert.equal(headerKmh.channels["GPS Speed"]!.values[10], 100);

const headerMph = parseSa(flat("#UNIT=MPH", 90, 1), "plain.sa");
assert.equal(headerMph.metadata["Speed Unit"], "mph converted to km/h");
assert.ok(Math.abs((headerMph.channels["GPS Speed"]!.values[3] as number) - 90 * MPH_KMH) < 0.01);

// The timer tag is the summary unit. It must not freeze the trace as km/h.
const timerTagMph = parseSa(
  flat("<timer #unit=KM/h>\n148,267,0,0,51,-72\n</timer>", 100, (100 * MPH_KMH) / 3.6 * 0.1),
  "timer-tag.sa",
);
assert.equal(timerTagMph.metadata["Speed Unit"], "mph converted to km/h");
assert.ok(Math.abs((timerTagMph.channels["GPS Speed"]!.values[10] as number) - 100 * MPH_KMH) < 0.01);

const timerTagKmh = parseSa(
  flat("<timer #unit=KM/h>\n</timer>", 100, (100 / 3.6) * 0.1),
  "timer-tag-kmh.sa",
);
assert.equal(timerTagKmh.metadata["Speed Unit"], "km/h");
assert.equal(timerTagKmh.channels["GPS Speed"]!.values[10], 100);

const named = parseSa(flat("#UNIT=KMH", 80, 2), "RIDER 032519 123013.sa");
assert.equal(named.metadata["Log Date"], "2019-03-25");
assert.equal(named.metadata["Log Time"], "12:30:13");

const noFinish = parseSa(
  ["#T=MISANO", ...Array.from({ length: 80 }, (_, i) => row(22.1 + i * 0.00003, 113.5, 12, 0, 100, -255, "0"))].join("\n"),
  "open.sa",
);
assert.equal(noFinish.laps.length, 1);
assert.equal(noFinish.metadata["Venue"], "MISANO");
assert.equal(prepareLog(noFinish, "open.sa").laps.length, 1);

assert.throws(() => parseSa("# only a header\nno,trace\n", "empty.sa"), /no usable trace/);

// Trimmed from the real ZIC 080626 164027 R4 log. The kept rows include the
// sample 5.4 s after the start of the 102.5 s lap: raw speed 153, raw long G −69.
const zicText = readFileSync(new URL("./fixtures/zic-080626-r4.sa", import.meta.url), "utf8");
const zic = parseSa(zicText, "ZIC 080626 164027.sa");
assert.equal(zic.metadata["Speed Unit"], "mph converted to km/h");
assert.match(zicText, /<timer #unit=KM\/h>/);
const zicLat = zic.channels["GPS Latitude"]!;
const zicLon = zic.channels["GPS Longitude"]!;
const zicHits: number[] = [];
for (let i = 0; i < zicLat.values.length; i++) {
  if (Math.abs((zicLat.values[i] as number) - 22.365419) < 1e-6 && Math.abs((zicLon.values[i] as number) - 113.560616) < 1e-6) {
    zicHits.push(i);
  }
}
assert.equal(zicHits.length, 1);
const at = zicHits[0]!;
assert.ok(Math.abs((zic.channels["GPS Speed"]!.values[at] as number) - 153 * MPH_KMH) < 1e-6, `speed ${zic.channels["GPS Speed"]!.values[at]}`);
assert.ok(Math.abs((zic.channels["Longitudinal G"]!.values[at] as number) - -1.38) < 1e-9);
assert.ok(Math.abs((zic.channels["G 2"]!.values[at] as number) - -1.38) < 1e-9);
assert.equal(zic.channels["GPS Speed"]!.units, "km/h");
assert.equal(zic.channels["Longitudinal G"]!.units, "G");
let peakG = 0;
let peakSpeed = 0;
for (const value of zic.channels["Longitudinal G"]!.values) peakG = Math.max(peakG, Math.abs(value as number));
for (const value of zic.channels["GPS Speed"]!.values) peakSpeed = Math.max(peakSpeed, value as number);
assert.ok(peakG > 1 && peakG < 2, `long G peak ${peakG}`);
assert.ok(Math.abs(peakSpeed - 166 * MPH_KMH) < 1e-6, `speed peak ${peakSpeed}`);
assert.equal(zic.channels["Lean Angle"]!.values[at], 0);

console.log("speedangle parser ok");
