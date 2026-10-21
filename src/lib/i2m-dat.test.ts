import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { coachingChannelKeys, prepareLog } from "./telemetry.ts";
import { parseDat } from "./i2m-dat.ts";

const fixture = readFileSync(new URL("./fixtures/i2m-chrome-sample.dat", import.meta.url), "utf8");
const parsed = parseDat(fixture, "sample_6200.dat");

assert.equal(parsed.metadata["Driver"], "I2M");
assert.equal(parsed.metadata["Log Date"], "2024-09-09");
assert.equal(parsed.metadata["Log Time"], "11:39:57");
assert.equal(parsed.metadata["Venue"], "Zhuhai International Circuit");
assert.equal(parsed.metadata["Vehicle"], "I2M Chrome");
assert.match(String(parsed.metadata["Speed Unit"]), /knots, converted/);
assert.match(String(parsed.metadata["Notes"]), /RPM Period/);
assert.match(String(parsed.metadata["Notes"]), /Lean Angle does not move/);

const speed = parsed.channels["GPS Speed"]!;
const lat = parsed.channels["GPS Latitude"]!;
const lon = parsed.channels["GPS Longitude"]!;
assert.ok(speed.values.length >= 8);
assert.ok(Math.abs(speed.values[0]! - 56.41 * 1.852) < 1e-9);
assert.ok(Math.abs(lat.values[0]! - (22 + 21.8016 / 60)) < 1e-9);
assert.ok(Math.abs(lon.values[0]! - (113 + 33.6202 / 60)) < 1e-9);

const throttle = parsed.channels["APS Throttle"]!;
assert.equal(throttle.units, "%");
const throttleAt = throttle.values[throttle.timecodes.indexOf(1319386 * 10)];
assert.ok(Math.abs(throttleAt! - (141 / 1023) * 512) < 1e-9);

const analog2 = parsed.channels["2ANALOG"]!;
const analog2At = analog2.values[analog2.timecodes.indexOf(1319386 * 10)];
assert.ok(Math.abs(analog2At! - (-900 + 582)) < 1e-6);

const lambda = parsed.channels["LAMBDA INT."]!;
const lambdaAt = lambda.values[lambda.timecodes.indexOf(1319386 * 10)];
assert.ok(Math.abs(lambdaAt! - (8 + (272 / 1023) * 14)) < 1e-9);

const rear = parsed.channels["Rear Speed"]!;
const rearAt = rear.values[rear.timecodes.indexOf(1319386 * 10)];
assert.ok(Math.abs(rearAt! - 1.95 * (39062.5 / 2248) * 3.6) < 1e-6);
assert.equal(rear.units, "km/h");

const rpm = parsed.channels["RPM Period"]!;
assert.equal(rpm.units, "count");
assert.ok(rpm.values.includes(5770));
assert.equal(parsed.channels["Pitch Angle"], undefined);
assert.ok(parsed.channels["Lean Angle"]);
assert.equal(parsed.channels["Lean Angle"]!.units, "deg");

const coach = coachingChannelKeys(
  Object.values(parsed.channels).map((channel) => ({ key: channel.name, label: channel.name })),
);
assert.equal(coach.throttle, "APS Throttle");
assert.equal(coach.lean, "Lean Angle");
assert.equal(coach.brake, "Longitudinal G");
assert.equal(coach.speed, "GPS Speed");

const scaled = parseDat(
  [
    "$NEW SESSION",
    "$SETTINGS,tps,0,804,forcella,0,100",
    "$GPS,1000,A,2222.0000,N,11333.0000,E,10,120000.000,10",
    "$GPS,1010,A,2222.0100,N,11333.0000,E,10,120000.100,10",
    "$VALUE,1000,0,0,1000,2000,3000,0,0,128",
    "$VALUE,1005,0,0,1000,2000,3000,0,0,128",
    "$VALUE,1010,0,0,65535,65535,65535,0,0,1",
  ].join("\n"),
  "demo-shape.dat",
);
const tps = scaled.channels["tps"]!;
assert.ok(Math.abs(tps.values[0]! - (128 / 1023) * 804) < 1e-9);
assert.ok(Math.abs(tps.values[0]! - 100.6) < 0.1);
const rearScaled = scaled.channels["Rear Speed"];
assert.equal(rearScaled, undefined);

const sentinels = parseDat(
  [
    "$NEW SESSION",
    "$SETTINGS,APS,0,512,1950,16,38,1980,1,1,26.666,32,40,53.333,80,160,61",
    "$GPS,0,A,1000.0000,N,01000.0000,E,20,100000.000,5",
    "$GPS,10,A,1000.0100,N,01000.0000,E,20,100000.100,5",
    "$VALUE,0,0,0,1000,65535,4000,0,0,200",
    "$VALUE,5,0,0,1000,1800,4000,0,0,0",
    "$VALUE,10,0,0,1000,2000,4000,0,0,0",
  ].join("\n"),
  "sentinel.dat",
);
assert.equal(sentinels.channels["Rear Speed"]!.values.length, 2);
assert.ok(Math.abs(sentinels.channels["Rear Speed"]!.values[0]! - 1.95 * (39062.5 / 1800) * 3.6) < 1e-6);
assert.ok(Math.abs(sentinels.channels["Rear Speed"]!.values[1]! - 1.95 * (39062.5 / 2000) * 3.6) < 1e-6);
assert.ok(Math.abs(sentinels.channels["APS Throttle"]!.values[0]! - (200 / 1023) * 512) < 1e-9);

function outAndBack(): string {
  const lines = [
    "$NEW SESSION",
    "$DATE,010124,",
    "$PILOTA,Short,",
    "$GPS,0,A,0000.0000,N,00000.0000,E,0.5,000000.000,0",
  ];
  const stepM = 200 / 3.6 / 10;
  let lat = 0;
  let index = 10;
  const leg = Math.ceil(2200 / stepM);
  const push = (dir: number, count: number) => {
    for (let i = 0; i < count; i++) {
      lat += dir * (stepM / 111320);
      const dm = lat >= 0 ? lat * 60 : lat * 60;
      const hemi = lat >= 0 ? "N" : "S";
      const abs = Math.abs(dm);
      const deg = Math.floor(abs / 60);
      const min = abs - deg * 60;
      const token = `${String(deg).padStart(2, "0")}${min.toFixed(4)}`;
      lines.push(`$GPS,${index},A,${token},${hemi},00000.0000,E,108,000000.000,0`);
      index += 10;
    }
  };
  for (let trip = 0; trip < 3; trip++) {
    push(1, leg);
    push(-1, leg);
  }
  lines.push("$NEW SESSION", "$PILOTA,Blip,", "$GPS,0,A,0000.0000,N,00000.0000,E,1,000001.000,0", "$GPS,10,A,0000.0010,N,00000.0000,E,1,000001.100,0");
  return lines.join("\n");
}

const lapped = parseDat(outAndBack(), "laps.dat");
assert.equal(lapped.metadata["Driver"], "Short");
assert.ok(lapped.laps.length >= 2, `expected complete laps, got ${lapped.laps.length}`);
for (const lap of lapped.laps) {
  const seconds = (lap.endTime - lap.startTime) / 1000;
  assert.ok(seconds > 30, `short session leaked into laps (${seconds.toFixed(1)} s)`);
}
const prepared = prepareLog(lapped, "laps.dat");
assert.ok(prepared.laps.length >= 2);

function arc(): string {
  const lines = ["$NEW SESSION", "$SETTINGS,APS,0,512"];
  const radius = 40;
  const speed = 80 / 3.6;
  const dt = 0.1;
  const w = speed / radius;
  for (let i = 0; i < 40; i++) {
    const a = -w * i * dt;
    const east = radius * Math.sin(a);
    const northM = radius * (1 - Math.cos(a));
    const lat = northM / 111320;
    const lon = east / (111320 * Math.cos((lat * Math.PI) / 180));
    const latAbs = Math.abs(lat * 60);
    const lonAbs = Math.abs(lon * 60);
    const latTok = `${String(Math.floor(latAbs / 60)).padStart(2, "0")}${(latAbs % 60).toFixed(4)}`;
    const lonTok = `${String(Math.floor(lonAbs / 60)).padStart(3, "0")}${(lonAbs % 60).toFixed(4)}`;
    const latHemi = lat >= 0 ? "N" : "S";
    const lonHemi = lon >= 0 ? "E" : "W";
    lines.push(`$GPS,${i * 10},A,${latTok},${latHemi},${lonTok},${lonHemi},43.2,120000.000,0`);
  }
  return lines.join("\n");
}

const turned = parseDat(arc(), "right.dat");
const leans = [...turned.channels["Lean Angle"]!.values];
const mid = leans.slice(8, 30);
const mean = mid.reduce((sum, value) => sum + value, 0) / mid.length;
assert.ok(mean > 8, `right turn should lean positive, mean ${mean.toFixed(1)}`);

assert.throws(() => parseDat("not a session\n", "nope.dat"), /no usable GPS/);
