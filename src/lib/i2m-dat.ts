import type { XrkChannel, XrkLap, XrkLog } from "aim-xrk";

/**
 * I2M Chrome / DataLog Pro `.dat` sessions are text, not a Danas export.
 * Checked against a multi-session Zhuhai log and the official Danas demo
 * (`demoSession.dat` from i2m.it): both use the same record tags.
 *
 * `$GPS` is NMEA-style. Latitude and longitude are ddmm.mmmm / dddmm.mmmm.
 * Speed is knots (ground speed from the fixes agrees with ×1.852). The
 * index counts in 10 ms steps: GPS time-of-day advances 0.100 s when the
 * index advances by 10, and `$VALUE` rows step by 1 (100 Hz) or 5 (20 Hz).
 *
 * `$VALUE` columns, after the index, are shared with the demo:
 * 1–2 and 8–13 are the analog slots, 3–5 are pulse periods (65535 = no
 * pulse), 6–7 are unused floats, 14 and the last column are free-running
 * counters. The first eight channels named in `$SETTINGS` map onto analog
 * fields 8, 9, 10, 11, 12, 13, 1, 2. A 10-bit input is 0 V at `min` and
 * 5 V (count 1023) at `max`, which is what Danas applies. On the demo the
 * first channel is `tps` and count 128 becomes 100%. On the Zhuhai log the
 * first channel is `APS` (accelerator position) with max 512, and count 200
 * becomes 100%.
 *
 * The number block inside `$SETTINGS` is the bike, not channels: rear
 * circumference (mm), pinion teeth, crown teeth, front circumference (mm),
 * two pulse counts, six stock gear-ratio bins, and a trailing integer.
 * Rear speed is field 4: circumference × 39062.5 Hz / period. That clock
 * (10 MHz / 256) lands within about 1 km/h of GPS on the Zhuhai log.
 * Field 3 is the same clock through the pinion (circumference × pinion /
 * crown) and is a few percent high on that bike. Field 5 moves with gear
 * but has no timebase in the file, so it stays a raw period.
 *
 * Logged lean and pitch on the Zhuhai file are constant, so lean is the
 * steady-state GPS value atan(v · yaw / g), smoothed and clamped to ±65°.
 * Nothing in `$SETTINGS` is named brake; longitudinal G is the change in
 * GPS speed, positive accelerating and negative braking.
 */

const INDEX_MS = 10;
const KNOTS_TO_KMH = 1.852;
const SPEED_CLOCK_HZ = 39062.5;
const ADC_FULL_SCALE = 1023;
const NO_PULSE = 65535;
const G = 9.80665;

/** Analog slots for the first eight `$SETTINGS` channels, 0-based in the value row. */
const ANALOG_AT = [7, 8, 9, 10, 11, 12, 0, 1];
const PINION_AT = 2;
const REAR_AT = 3;
const RPM_AT = 4;
/** Channels named after the bike block. Counters at fields 14 and 21 are skipped. */
const EXTRA_AT = [15, 16, 17, 18, 19];

const ZIC_SF = { lat: 22.3671, lon: 113.5601 };
const ZIC_CENTER = { lat: 22.367194, lon: 113.55639 };

type ChannelDef = { name: string; min: number; max: number };
type Bike = {
  rearMm: number;
  pinion: number;
  crown: number;
  frontMm: number;
  pulses1: number;
  pulses2: number;
};
type Fix = { t: number; lat: number; lon: number; speed: number; alt: number };
type Row = { t: number; cols: number[] };
type Session = {
  rider: string;
  date: string;
  bike: Bike | null;
  channels: ChannelDef[];
  gps: Fix[];
  rows: Row[];
  laps: { start: number; end: number; complete: boolean }[];
};

const EMPTY =
  "This I2M file has no usable GPS trace. A Chrome / DataLog .dat is text: $NEW SESSION, $DATE, $PILOTA, $SETTINGS, then $GPS and $VALUE rows.";

function makeChannel(name: string, units: string, timecodes: Float64Array, values: Float64Array): XrkChannel {
  return {
    name,
    shortName: name,
    units,
    decPts: 3,
    interpolate: true,
    func: name,
    sourceType: 0,
    sourceChannelId: 0,
    deviceTag: "i2m",
    calValue1: 0,
    calValue2: 0,
    displayRangeMin: 0,
    displayRangeMax: 0,
    timecodes,
    values,
  };
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function nmea(dm: string, hemi: string): number {
  const v = Number(dm);
  if (!Number.isFinite(v)) return NaN;
  const deg = Math.floor(Math.abs(v) / 100);
  const min = Math.abs(v) - deg * 100;
  if (min >= 60) return NaN;
  let dec = deg + min / 60;
  if (hemi === "S" || hemi === "W") dec = -dec;
  return dec;
}

function num(token: string | undefined): number {
  if (token == null || token.trim() === "") return NaN;
  const v = Number(token);
  return Number.isFinite(v) ? v : NaN;
}

function isNum(token: string): boolean {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token.trim());
}

function parseDate(token: string): string {
  const digits = token.replace(/\D/g, "");
  if (digits.length < 6) return "";
  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const year = Number(digits.slice(4, 6));
  if (day < 1 || day > 31 || month < 1 || month > 12) return "";
  return `20${String(year).padStart(2, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTod(token: string): string {
  const v = Number(token);
  if (!Number.isFinite(v)) return "";
  const whole = Math.floor(v);
  const h = Math.floor(whole / 10000);
  const m = Math.floor((whole % 10000) / 100);
  const s = whole % 100;
  if (h > 23 || m > 59 || s > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseSettings(line: string): { channels: ChannelDef[]; bike: Bike | null } {
  const tokens = line.split(",").slice(1).map((token) => token.trim());
  const channels: ChannelDef[] = [];
  let bike: Bike | null = null;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (!token) {
      i += 1;
      continue;
    }
    if (isNum(token)) {
      const nums: number[] = [];
      while (i < tokens.length && isNum(tokens[i] ?? "") && nums.length < 13) {
        nums.push(Number(tokens[i]));
        i += 1;
      }
      if (nums.length === 13 && !bike) {
        bike = {
          rearMm: nums[0]!,
          pinion: nums[1]!,
          crown: nums[2]!,
          frontMm: nums[3]!,
          pulses1: nums[4]!,
          pulses2: nums[5]!,
        };
      }
      continue;
    }
    const min = num(tokens[i + 1]);
    const max = num(tokens[i + 2]);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      channels.push({ name: token, min, max });
      i += 3;
      continue;
    }
    i += 1;
  }
  return { channels, bike };
}

function scaleAdc(raw: number, min: number, max: number): number {
  if (!Number.isFinite(raw) || raw >= NO_PULSE) return NaN;
  return min + (raw / ADC_FULL_SCALE) * (max - min);
}

function periodKmh(count: number, metresPerRev: number, pulses: number): number {
  if (!(count > 0) || count >= NO_PULSE || !(metresPerRev > 0)) return NaN;
  const per = pulses > 0 ? pulses : 1;
  return (SPEED_CLOCK_HZ / count / per) * metresPerRev * 3.6;
}

function displayName(channel: ChannelDef, slot: number): string {
  const name = channel.name.trim() || "Channel";
  if (slot === 0 && /^aps$/i.test(name)) return "APS Throttle";
  return name;
}

function unitsFor(channel: ChannelDef, slot: number): string {
  if (slot === 0 && /^(?:aps|tps)$|throttle|accelerat/i.test(channel.name)) return "%";
  return "";
}

function smooth(values: number[], radius: number): number[] {
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++) {
      sum += values[k]!;
      n += 1;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

/** Steady-state lean, degrees, positive to the right. */
function leanFromGps(points: readonly Fix[]): number[] {
  const n = points.length;
  const heading = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const step = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
    if (step < 0.4) {
      heading[i] = heading[i - 1]!;
      continue;
    }
    const lat = (prev.lat * Math.PI) / 180;
    const dLat = ((curr.lat - prev.lat) * Math.PI) / 180;
    const dLon = ((curr.lon - prev.lon) * Math.PI) / 180 * Math.cos(lat);
    heading[i] = Math.atan2(dLon, dLat);
  }
  const raw = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    let d = heading[i]! - heading[i - 1]!;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    const dt = (points[i]!.t - points[i - 1]!.t) / 1000;
    const v = points[i]!.speed / 3.6;
    if (dt <= 0.02 || v < 8) continue;
    const deg = (Math.atan((v * (d / dt)) / G) * 180) / Math.PI;
    raw[i] = Math.max(-65, Math.min(65, deg));
  }
  return smooth(raw, 2);
}

/** Positive accelerating, negative braking, in G. */
function longGFromGps(points: readonly Fix[]): number[] {
  const raw = new Array<number>(points.length).fill(0);
  for (let i = 0; i < points.length; i++) {
    const i0 = Math.max(0, i - 2);
    const i1 = Math.min(points.length - 1, i + 2);
    const dt = (points[i1]!.t - points[i0]!.t) / 1000;
    if (dt <= 0.05) continue;
    const dv = (points[i1]!.speed - points[i0]!.speed) / 3.6;
    raw[i] = Math.max(-2, Math.min(2, dv / dt / G));
  }
  return smooth(raw, 2);
}

function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function isZhuhai(points: readonly Fix[]): boolean {
  if (points.length < 3) return false;
  const lat = median(points.map((point) => point.lat));
  const lon = median(points.map((point) => point.lon));
  return haversine(lat, lon, ZIC_CENTER.lat, ZIC_CENTER.lon) < 3000;
}

type Gate = { lat: number; lon: number; radius: number; minTravel: number };

function chooseGate(points: readonly Fix[], zhuhai: boolean): Gate | null {
  if (zhuhai) {
    let best: Fix | null = null;
    let bestD = Infinity;
    for (const point of points) {
      if (point.speed < 80) continue;
      const d = haversine(point.lat, point.lon, ZIC_SF.lat, ZIC_SF.lon);
      if (d < bestD) {
        bestD = d;
        best = point;
      }
    }
    if (best && bestD < 80) return { lat: best.lat, lon: best.lon, radius: 20, minTravel: 3000 };
  }
  const fast = points.find((point) => point.speed > 80);
  if (!fast) return null;
  return { lat: fast.lat, lon: fast.lon, radius: 25, minTravel: 2000 };
}

function lapSpans(points: readonly Fix[], zhuhai: boolean): { start: number; end: number; complete: boolean }[] {
  if (points.length < 2) return [];
  const gate = chooseGate(points, zhuhai);
  const hits: number[] = [];
  if (gate) {
    let travel = 0;
    let outside = false;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const curr = points[i]!;
      const step = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
      if (step < 80) travel += step;
      const fromGate = haversine(curr.lat, curr.lon, gate.lat, gate.lon);
      if (travel > gate.minTravel * 0.45 && fromGate > gate.radius * 2) outside = true;
      if (outside && travel > gate.minTravel && fromGate < gate.radius && curr.speed > 50) {
        hits.push(i);
        travel = 0;
        outside = false;
      }
    }
  }
  if (hits.length >= 2) {
    const spans = [];
    for (let i = 0; i < hits.length - 1; i++) {
      spans.push({ start: points[hits[i]!]!.t, end: points[hits[i + 1]!]!.t, complete: true });
    }
    return spans;
  }
  return [{ start: points[0]!.t, end: points[points.length - 1]!.t, complete: false }];
}

function parseSessions(text: string): Session[] {
  const sessions: Session[] = [];
  let current: Session | null = null;
  const open = () => {
    current = { rider: "", date: "", bike: null, channels: [], gps: [], rows: [], laps: [] };
    sessions.push(current);
  };
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("$NEW SESSION")) {
      open();
      continue;
    }
    if (!current || !line.startsWith("$")) continue;
    const kind = line.slice(0, line.indexOf(",") > 0 ? line.indexOf(",") : line.length);
    if (kind === "$DATE") {
      current.date = parseDate(line.split(",")[1] ?? "");
    } else if (kind === "$PILOTA") {
      current.rider = (line.split(",")[1] ?? "").trim();
    } else if (kind === "$SETTINGS") {
      const parsed = parseSettings(line);
      current.channels = parsed.channels;
      current.bike = parsed.bike;
    } else if (kind === "$GPS") {
      const p = line.split(",");
      const index = num(p[1]);
      const fix = (p[2] ?? "").trim();
      if (fix && fix.toUpperCase() !== "A") continue;
      const lat = nmea(p[3] ?? "", (p[4] ?? "").trim());
      const lon = nmea(p[5] ?? "", (p[6] ?? "").trim());
      const knots = num(p[7]);
      if (!Number.isFinite(index) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const speed = Number.isFinite(knots) ? Math.max(0, knots) * KNOTS_TO_KMH : NaN;
      if (!Number.isFinite(speed) || speed > 400) continue;
      current.gps.push({ t: index, lat, lon, speed, alt: num(p[9]) });
    } else if (kind === "$VALUE") {
      const p = line.split(",");
      const index = num(p[1]);
      if (!Number.isFinite(index)) continue;
      const cols = p.slice(2).map((token) => num(token));
      if (cols.length && !Number.isFinite(cols[cols.length - 1]!)) cols.pop();
      current.rows.push({ t: index, cols });
    }
  }
  return sessions.filter((session) => session.gps.length >= 2 || session.rows.length >= 2);
}

function stampSessions(sessions: Session[]) {
  let timeline = 0;
  for (const session of sessions) {
    const indexes = [...session.gps.map((point) => point.t), ...session.rows.map((row) => row.t)];
    if (!indexes.length) continue;
    const min = Math.min(...indexes);
    const max = Math.max(...indexes);
    const shift = min * INDEX_MS < timeline ? timeline - min * INDEX_MS + INDEX_MS : 0;
    for (const point of session.gps) point.t = point.t * INDEX_MS + shift;
    for (const row of session.rows) row.t = row.t * INDEX_MS + shift;
    timeline = max * INDEX_MS + shift + INDEX_MS;
    session.gps.sort((a, b) => a.t - b.t);
    session.rows.sort((a, b) => a.t - b.t);
  }
}

type Built = { name: string; units: string; times: number[]; values: number[] };

function pushSample(series: Built, t: number, value: number) {
  if (!Number.isFinite(value)) return;
  series.times.push(t);
  series.values.push(value);
}

function finish(series: Built | null): [string, XrkChannel] | null {
  if (!series || series.times.length < 2) return null;
  return [series.name, makeChannel(series.name, series.units, Float64Array.from(series.times), Float64Array.from(series.values))];
}

function rangeOf(values: number[]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min;
}

/** Parse an I2M Chrome / DataLog `.dat` into the same log shape as AiM and Dragy. */
export function parseDat(text: string, fileName: string): XrkLog {
  if (!text.includes("$GPS")) throw new Error(EMPTY);
  const sessions = parseSessions(text);
  const gpsCount = sessions.reduce((sum, session) => sum + session.gps.length, 0);
  if (gpsCount < 2) throw new Error(EMPTY);
  stampSessions(sessions);

  const allGps = sessions.flatMap((session) => session.gps);
  const zhuhai = isZhuhai(allGps);
  for (const session of sessions) session.laps = lapSpans(session.gps, zhuhai);
  const complete = sessions.flatMap((session) => session.laps.filter((lap) => lap.complete));
  const laps = (complete.length ? complete : sessions.flatMap((session) => session.laps))
    .filter((lap) => lap.end - lap.start >= 1000)
    .sort((a, b) => a.start - b.start);

  const defs = sessions.find((session) => session.channels.length)?.channels ?? [];
  const bike = sessions.find((session) => session.bike)?.bike ?? null;
  const brakeNamed = defs.some((channel) => /freno|brake/i.test(channel.name));
  const notes: string[] = [];

  const series = new Map<string, Built>();
  const take = (name: string, units: string) => {
    let built = series.get(name);
    if (!built) {
      built = { name, units, times: [], values: [] };
      series.set(name, built);
    }
    return built;
  };

  const gpsSpeed = take("GPS Speed", "km/h");
  const lat = take("GPS Latitude", "deg");
  const lon = take("GPS Longitude", "deg");
  const alt = take("GPS Altitude", "m");
  for (const point of allGps) {
    pushSample(gpsSpeed, point.t, point.speed);
    pushSample(lat, point.t, point.lat);
    pushSample(lon, point.t, point.lon);
    pushSample(alt, point.t, point.alt);
  }

  const gpsLean = take("GPS Lean", "deg");
  leanFromGps(allGps).forEach((value, index) => pushSample(gpsLean, allGps[index]!.t, value));

  if (!brakeNamed) {
    const gSeries = take("Longitudinal G", "G");
    longGFromGps(allGps).forEach((value, index) => pushSample(gSeries, allGps[index]!.t, value));
    notes.push("No channel is named brake. Longitudinal G is the change in GPS speed, negative while braking.");
  }

  const rear = bike && bike.rearMm > 200 && bike.rearMm < 4000 ? take("Rear Speed", "km/h") : null;
  const pinion =
    bike && bike.rearMm > 200 && bike.pinion >= 5 && bike.crown >= 5 ? take("Pinion Speed", "km/h") : null;
  const rpm = take("RPM Period", "count");
  const analogSeries = defs.slice(0, 8).map((channel, slot) => take(displayName(channel, slot), unitsFor(channel, slot)));
  const extraSeries = defs.slice(8).map((channel) => take(channel.name.trim() || "Channel", ""));

  for (const session of sessions) {
    const sessionBike = session.bike ?? bike;
    for (const row of session.rows) {
      const cols = row.cols;
      if (rear && sessionBike) {
        pushSample(rear, row.t, periodKmh(cols[REAR_AT] ?? NaN, sessionBike.rearMm / 1000, sessionBike.pulses2));
      }
      if (pinion && sessionBike) {
        const metres = (sessionBike.rearMm / 1000) * (sessionBike.pinion / sessionBike.crown);
        pushSample(pinion, row.t, periodKmh(cols[PINION_AT] ?? NaN, metres, sessionBike.pulses1));
      }
      const period = cols[RPM_AT] ?? NaN;
      if (period > 0 && period < NO_PULSE) pushSample(rpm, row.t, period);
      defs.slice(0, 8).forEach((channel, slot) => {
        const at = ANALOG_AT[slot];
        if (at == null) return;
        pushSample(analogSeries[slot]!, row.t, scaleAdc(cols[at] ?? NaN, channel.min, channel.max));
      });
      defs.slice(8).forEach((channel, slot) => {
        const at = EXTRA_AT[slot];
        if (at == null) return;
        pushSample(extraSeries[slot]!, row.t, scaleAdc(cols[at] ?? NaN, channel.min, channel.max));
      });
    }
  }

  let useLoggedLean = false;
  for (const channel of defs.slice(8)) {
    const built = series.get(channel.name.trim());
    if (!built) continue;
    if (/lean|pitch/i.test(channel.name) && rangeOf(built.values) < 1) {
      series.delete(channel.name.trim());
      notes.push(`Logged ${channel.name.trim()} does not move, so it is left out.`);
      continue;
    }
    if (/lean/i.test(channel.name) && rangeOf(built.values) >= 1) useLoggedLean = true;
  }
  if (!useLoggedLean) {
    const derived = series.get("GPS Lean");
    if (derived) {
      derived.name = "Lean Angle";
      series.set("Lean Angle", derived);
    }
    notes.push("Lean Angle is derived from GPS speed and heading, positive to the right.");
  }
  series.delete("GPS Lean");
  notes.push("RPM Period is the engine pulse period in timer counts, not rpm.");
  if (rear) notes.push("Rear Speed converts the wheel-speed period with the circumference in $SETTINGS and a 39062.5 Hz timer.");
  if (pinion) notes.push("Pinion Speed uses that timer with the sprocket ratio in $SETTINGS.");

  const channels: Record<string, XrkChannel> = {};
  const order = [
    "GPS Speed",
    "GPS Latitude",
    "GPS Longitude",
    "GPS Altitude",
    "Lean Angle",
    "Longitudinal G",
    "Rear Speed",
    "Pinion Speed",
    ...analogSeries.map((item) => item.name),
    ...extraSeries.map((item) => item.name),
    "RPM Period",
  ];
  for (const name of order) {
    const built = finish(series.get(name) ?? null);
    if (built && !channels[built[0]]) channels[built[0]] = built[1];
  }

  const first = sessions.find((session) => session.gps.length) ?? sessions[0]!;
  const tod = parseTod(
    text
      .split(/\r?\n/)
      .find((line) => line.startsWith("$GPS,"))
      ?.split(",")[8] ?? "",
  );
  const rider = sessions.map((session) => session.rider).find(Boolean) ?? "";
  const stem = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "Session";

  const xrkLaps: XrkLap[] = laps.map((lap, index) => ({
    num: index + 1,
    startTime: lap.start,
    endTime: lap.end,
  }));

  return {
    channels,
    laps: xrkLaps,
    metadata: {
      Vehicle: "I2M Chrome",
      Driver: rider,
      Venue: zhuhai ? "Zhuhai International Circuit" : stem,
      "Log Date": first.date,
      "Log Time": tod,
      Source: "I2M DAT",
      "Speed Unit": "knots, converted to km/h",
      Notes: notes.join(" "),
    },
  };
}
