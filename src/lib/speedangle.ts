import type { XrkChannel, XrkLap, XrkLog } from "aim-xrk";

/**
 * SpeedAngle R4 `.sa` logs are plain text.
 * The trace section is CSV at 10 Hz. Column order is the R4 manual:
 * latitude, longitude, lean angle (+right/−left), a second angle,
 * longitudinal G (+accel/−brake), a second G, speed, max angle of the
 * previous turn (−255 filler), satellites, signal validity, and the
 * finish/sector mark (`F` finish, a digit the sector, `0` none).
 *
 * Those indexes match the public converter at
 * github.com/torqu3e/speedangle-to-racechrono, which was written against
 * real logs. A ZIC R4 export checked here agrees: trace speed matches GPS
 * ground speed as miles per hour (and the timer's top speed, which is
 * already km/h). Both G columns are integer counts of 0.02 G. The ±1.5 G
 * sensor range is ±75 counts, and the speed change on that log matches ÷50
 * once the accelerometer's short lead over GPS speed is allowed for.
 *
 * `<timer #unit=KM/h>` is the unit of the timer summary only. An explicit
 * unit field (`Unit: MPH`, `#UNIT=KMH`) still wins for the trace. Otherwise
 * a moving GPS trace is compared with the logged speed. Anything left over
 * is kept as km/h, which is what this viewer shows.
 */

const SAMPLE_MS = 100;
const MPH_TO_KMH = 1.609344;
/** R4 longitudinal G is stored as counts of 0.02 G. */
const G_COUNTS_PER_G = 50;

type Trace = {
  lat: number;
  lon: number;
  lean: number;
  angle2: number;
  longG: number;
  g2: number;
  speed: number;
  prevAngle: number;
  sats: number;
  valid: number;
  finish: boolean;
};

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
    deviceTag: "speedangle",
    calValue1: 0,
    calValue2: 0,
    displayRangeMin: 0,
    displayRangeMax: 0,
    timecodes,
    values,
  };
}

function parseTraceLine(line: string): Trace | null {
  const parts = line.trim().split(",").map((part) => part.trim());
  if (parts.length < 11) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (!parts[0]!.includes(".") || !parts[1]!.includes(".")) return null;
  const nums: number[] = [];
  for (let i = 2; i <= 9; i++) {
    const value = Number(parts[i]);
    if (!Number.isFinite(value)) return null;
    nums.push(value);
  }
  const mark = parts[10]!;
  const finish = /^f(?:l|inish)?$/i.test(mark);
  if (!finish && !/^\d+$/.test(mark)) return null;
  return {
    lat,
    lon,
    lean: nums[0]!,
    angle2: nums[1]!,
    longG: nums[2]!,
    g2: nums[3]!,
    speed: nums[4]!,
    prevAngle: nums[5]!,
    sats: nums[6]!,
    valid: nums[7]!,
    finish,
  };
}

/** Longest contiguous run of trace rows. Blank lines stay inside the run. */
function traceRun(lines: readonly string[]): { rows: Trace[]; start: number } {
  let current: Trace[] = [];
  let currentStart = 0;
  let best: Trace[] = [];
  let bestStart = 0;
  const take = () => {
    if (current.length > best.length) {
      best = current;
      bestStart = currentStart;
    }
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const row = parseTraceLine(line);
    if (!row) {
      if (current.length) take();
      continue;
    }
    if (!current.length) currentStart = i;
    current.push(row);
  }
  if (current.length) take();
  return { rows: best, start: bestStart };
}

function field(preamble: string, keys: readonly string[]): string {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const raw of preamble.split(/\r?\n/)) {
    const line = raw.trim().replace(/^#/, "").trim();
    const match = line.match(/^([A-Za-z][A-Za-z0-9 _-]{0,24})\s*[:=]\s*(.+)$/);
    if (!match) continue;
    if (wanted.has(match[1]!.trim().toLowerCase())) return match[2]!.trim();
  }
  return "";
}

function headerSpeedUnit(preamble: string): "mph" | "kmh" | null {
  // Drop the timer block first. Its `#unit=` attribute is the summary
  // display unit (average and top speed are already in that unit).
  const source = preamble.replace(/<timer\b[^>]*>[\s\S]*?<\/timer>/gi, "");
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim().replace(/^#/, "").trim();
    const match = line.match(/^(?:speed[\s_-]*)?unit\s*[:=]\s*([a-z0-9/]+)/i);
    if (!match) continue;
    if (/mph/i.test(match[1]!)) return "mph";
    if (/km|kph/i.test(match[1]!)) return "kmh";
  }
  return null;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Multiplier that turns the logged speed number into km/h, using GPS ground speed. */
function inferredSpeed(rows: readonly Trace[]): { factor: number; note: string } {
  const ratios: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const curr = rows[i]!;
    if (Math.abs(prev.lat) < 0.01 && Math.abs(prev.lon) < 0.01) continue;
    if (Math.abs(curr.lat) < 0.01 && Math.abs(curr.lon) < 0.01) continue;
    const step = haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
    if (step < 0.4 || step > 80 || curr.speed < 15) continue;
    ratios.push(((step / (SAMPLE_MS / 1000)) * 3.6) / curr.speed);
  }
  if (ratios.length < 20) return { factor: 1, note: "km/h" };
  ratios.sort((a, b) => a - b);
  const mid = ratios[Math.floor(ratios.length / 2)]!;
  if (mid > 1.35 && mid < 1.9) return { factor: MPH_TO_KMH, note: "mph converted to km/h" };
  if (mid > 3 && mid < 4.3) return { factor: 3.6, note: "m/s converted to km/h" };
  return { factor: 1, note: "km/h" };
}

function speedToKmh(preamble: string, rows: readonly Trace[]): { factor: number; note: string } {
  const declared = headerSpeedUnit(preamble);
  if (declared === "mph") return { factor: MPH_TO_KMH, note: "mph converted to km/h" };
  if (declared === "kmh") return { factor: 1, note: "km/h" };
  return inferredSpeed(rows);
}

function whenFrom(value: string): { date: string; time: string } {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { date: "", time: "" };
  const last = parts[parts.length - 1]!;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(last) && parts.length > 1) {
    return { date: parts.slice(0, -1).join(" "), time: last };
  }
  if (value.includes(":")) return { date: "", time: value.trim() };
  return { date: value.trim(), time: "" };
}

/** R4's default download name is `ID MMDDYY HHMMSS.sa`. */
function whenFromFileName(fileName: string): { date: string; time: string } {
  const match = fileName.match(/(?:^|[^\d])(\d{2})(\d{2})(\d{2})[^\d]+(\d{2})(\d{2})(\d{2})(?:[^\d]|$)/);
  if (!match) return { date: "", time: "" };
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { date: "", time: "" };
  return {
    date: `20${String(year).padStart(2, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time: `${match[4]}:${match[5]}:${match[6]}`,
  };
}

function bareTrack(preamble: string): string {
  for (const raw of preamble.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /[=:]/.test(line)) continue;
    if (/^[A-Za-z][A-Za-z0-9 ]{0,14}$/.test(line)) return line;
  }
  return "";
}

function fileStem(fileName: string): string {
  return fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "Session";
}

function finiteSeries(values: number[]): Float64Array | null {
  if (!values.some((value) => Number.isFinite(value))) return null;
  return Float64Array.from(values);
}

function lapsFromFinishes(rows: readonly Trace[]): XrkLap[] {
  const finishes: number[] = [];
  rows.forEach((row, index) => {
    if (row.finish) finishes.push(index);
  });
  const laps: XrkLap[] = [];
  for (let i = 0; i < finishes.length - 1; i++) {
    const start = finishes[i]!;
    const end = finishes[i + 1]!;
    if (end <= start) continue;
    laps.push({ num: laps.length + 1, startTime: start * SAMPLE_MS, endTime: end * SAMPLE_MS });
  }
  if (!laps.length && rows.length >= 2) {
    laps.push({ num: 1, startTime: 0, endTime: (rows.length - 1) * SAMPLE_MS });
  }
  return laps;
}

/** Parse a SpeedAngle `.sa` export into the same log shape as AiM and Dragy. */
export function parseSa(text: string, fileName: string): XrkLog {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const { rows, start } = traceRun(lines);
  if (rows.length < 2) {
    throw new Error(
      "This SpeedAngle file has no usable trace. An .sa log is text: a header, the track record, then 10 Hz rows of latitude, longitude, lean, G, and speed.",
    );
  }
  const preamble = lines.slice(0, start).join("\n");
  const speed = speedToKmh(preamble, rows);
  const times = Float64Array.from(rows, (_, index) => index * SAMPLE_MS);
  const channels: Record<string, XrkChannel> = {};
  const add = (name: string, units: string, values: number[]) => {
    const series = finiteSeries(values);
    if (!series) return;
    channels[name] = makeChannel(name, units, times, series);
  };
  add(
    "GPS Speed",
    "km/h",
    rows.map((row) => row.speed * speed.factor),
  );
  add(
    "Lean Angle",
    "deg",
    rows.map((row) => row.lean),
  );
  add(
    "Longitudinal G",
    "G",
    rows.map((row) => row.longG / G_COUNTS_PER_G),
  );
  add(
    "GPS Latitude",
    "deg",
    rows.map((row) => row.lat),
  );
  add(
    "GPS Longitude",
    "deg",
    rows.map((row) => row.lon),
  );
  add(
    "Angle",
    "deg",
    rows.map((row) => row.angle2),
  );
  add(
    "G 2",
    "G",
    rows.map((row) => row.g2 / G_COUNTS_PER_G),
  );
  add(
    "Max Angle Previous Turn",
    "deg",
    rows.map((row) => (row.prevAngle === -255 ? Number.NaN : row.prevAngle)),
  );
  add(
    "Satellites",
    "",
    rows.map((row) => row.sats),
  );
  add(
    "GPS Valid",
    "",
    rows.map((row) => row.valid),
  );

  const rider = field(preamble, ["id", "rider", "driver", "user"]);
  const track = field(preamble, ["t", "track", "venue", "track name", "trk"]) || bareTrack(preamble) || fileStem(fileName);
  const version = field(preamble, ["v", "fw", "firmware", "r4", "version"]);
  const stamped = whenFrom(field(preamble, ["d", "date", "time", "log time", "log date"]));
  const named = whenFromFileName(fileName);
  const date = stamped.date || named.date;
  const time = stamped.time || named.time;

  return {
    channels,
    laps: lapsFromFinishes(rows),
    metadata: {
      Vehicle: version ? `SpeedAngle ${version}` : "SpeedAngle",
      Driver: rider,
      Venue: track,
      "Log Date": date,
      "Log Time": time,
      Source: "SpeedAngle SA",
      "Speed Unit": speed.note,
    },
  };
}
