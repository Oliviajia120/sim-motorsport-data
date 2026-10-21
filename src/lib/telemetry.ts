import type { XrkChannel, XrkLog } from "aim-xrk";

export type Sample = { t: number; v: number };

export type LapProfile = {
  num: number;
  startMs: number;
  endMs: number;
  /** Official lap length, seconds. */
  duration: number;
  /** Seconds from lap start, monotonic. */
  times: number[];
  /** Cumulative metres, same length as times. */
  dist: number[];
  total: number;
  source: "gps" | "speed";
};

export type PrepChannel = {
  key: string;
  label: string;
  unit: string;
  scale: number;
  channel: XrkChannel;
};

export type PreparedLog = {
  fileName: string;
  vehicle: string;
  rider: string;
  when: string;
  track: string;
  channels: PrepChannel[];
  laps: LapProfile[];
  distanceNote: string;
};

const LAP_COLORS = [
  "#e85d04",
  "#f0c14d",
  "#3ddc97",
  "#5eb1ff",
  "#c084fc",
  "#fb7185",
  "#94a3b8",
  "#f97316",
];

export function lapColor(index: number): string {
  return LAP_COLORS[index % LAP_COLORS.length]!;
}

export function formatLap(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "−" : "";
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = (abs - m * 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${sign}${m}:${s}` : `${sign}${s}`;
}

function channelMax(ch: XrkChannel): number {
  let max = 0;
  const step = Math.max(1, Math.floor(ch.values.length / 500));
  for (let i = 0; i < ch.values.length; i += step) {
    const v = ch.values[i] as number;
    if (v > max) max = v;
  }
  return max;
}

function isSpeedName(name: string): boolean {
  return /speed/i.test(name) && !/rate|accur|fix/i.test(name);
}

export function displayScale(ch: XrkChannel): { unit: string; scale: number } {
  if (!isSpeedName(ch.name)) return { unit: ch.units || "", scale: 1 };
  if (/km\/h|kmh/i.test(ch.units || "")) return { unit: "km/h", scale: 1 };
  const max = channelMax(ch);
  if (max > 0 && max < 130) return { unit: "km/h", scale: 3.6 };
  return { unit: ch.units || "km/h", scale: 1 };
}

function labelFor(ch: XrkChannel): string {
  if (ch.func && ch.func.trim()) return ch.func.trim();
  return ch.name.replaceAll("_", " ");
}

export function sliceChannel(ch: XrkChannel, startMs: number, endMs: number): Sample[] {
  const tc = ch.timecodes;
  const values = ch.values;
  let lo = 0;
  let hi = tc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tc[mid]! < startMs) lo = mid + 1;
    else hi = mid;
  }
  const out: Sample[] = [];
  for (let i = lo; i < tc.length && tc[i]! <= endMs; i++) {
    const v = values[i] as number;
    if (v == null || Number.isNaN(v)) continue;
    out.push({ t: (tc[i]! - startMs) / 1000, v });
  }
  return out;
}

function findChannel(
  channels: Record<string, XrkChannel>,
  test: (ch: XrkChannel) => boolean,
): XrkChannel | undefined {
  return Object.values(channels).find(test);
}

function isGpsPositionName(name: string): boolean {
  return !/acc|accel|brake|\bg\b|speed|angle|lean|rpm/i.test(name);
}

/** Latitude channel. Exact GPS name wins, so a "Longitudinal G" channel is not longitude. */
export function findLatChannel(channels: Iterable<XrkChannel>): XrkChannel | undefined {
  const list = [...channels];
  return (
    list.find((ch) => ch.name === "GPS Latitude") ??
    list.find((ch) => isGpsPositionName(ch.name) && /lat/i.test(ch.name) && !/lateral/i.test(ch.name))
  );
}

/** Longitude channel. Exact GPS name wins over other "long…" names such as longitudinal G. */
export function findLonChannel(channels: Iterable<XrkChannel>): XrkChannel | undefined {
  const list = [...channels];
  return (
    list.find((ch) => ch.name === "GPS Longitude") ??
    list.find((ch) => isGpsPositionName(ch.name) && (/lon/i.test(ch.name) || /long/i.test(ch.name)))
  );
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** One accepted GPS sample. `d` is metres along the lap from the first fix. */
export type GpsFix = { t: number; lat: number; lon: number; d: number };

/**
 * Pair latitude and longitude by sample index.
 * Drops null-island and out-of-range fixes, and any step longer than 80 m, matching lap distance.
 */
export function gpsTrack(lat: Sample[], lon: Sample[]): GpsFix[] {
  const n = Math.min(lat.length, lon.length);
  const track: GpsFix[] = [];
  let acc = 0;
  let prevLat = 0;
  let prevLon = 0;
  let hasPrev = false;
  for (let i = 0; i < n; i++) {
    const la = lat[i]!.v;
    const lo = lon[i]!.v;
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
    if (Math.abs(la) < 0.01 && Math.abs(lo) < 0.01) continue;
    const t = lat[i]!.t;
    if (hasPrev) {
      const step = haversine(prevLat, prevLon, la, lo);
      if (step > 80) continue;
      acc += step;
    }
    track.push({ t, lat: la, lon: lo, d: acc });
    prevLat = la;
    prevLon = lo;
    hasPrev = true;
  }
  return track;
}

/** GPS position at `metres` along `track`. Latitude and longitude are interpolated. */
export function fixAtMetres(track: readonly GpsFix[], metres: number): GpsFix | null {
  if (!track.length) return null;
  const first = track[0]!;
  const last = track[track.length - 1]!;
  if (metres <= first.d) return { ...first };
  if (metres >= last.d) return { ...last };
  let lo = 0;
  let hi = track.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.d < metres) lo = mid + 1;
    else hi = mid;
  }
  const b = track[lo]!;
  const a = track[Math.max(0, lo - 1)]!;
  const span = b.d - a.d;
  const u = span > 1e-6 ? (metres - a.d) / span : 0;
  return {
    t: a.t + u * (b.t - a.t),
    lat: a.lat + u * (b.lat - a.lat),
    lon: a.lon + u * (b.lon - a.lon),
    d: metres,
  };
}

function profileFromPoints(
  lapNum: number,
  startMs: number,
  endMs: number,
  duration: number,
  times: number[],
  dist: number[],
  source: "gps" | "speed",
): LapProfile | null {
  if (times.length < 2 || dist[dist.length - 1]! < 50) return null;
  const total = dist[dist.length - 1]!;
  if (times[0]! > 0.05) {
    times.unshift(0);
    dist.unshift(0);
  }
  const lastT = times[times.length - 1]!;
  if (duration - lastT > 0.02) {
    times.push(duration);
    dist.push(total);
  }
  return { num: lapNum, startMs, endMs, duration, times, dist, total, source };
}

function profileFromGps(
  lapNum: number,
  startMs: number,
  endMs: number,
  duration: number,
  lat: Sample[],
  lon: Sample[],
): LapProfile | null {
  const track = gpsTrack(lat, lon);
  return profileFromPoints(
    lapNum,
    startMs,
    endMs,
    duration,
    track.map((fix) => fix.t),
    track.map((fix) => fix.d),
    "gps",
  );
}

function profileFromSpeed(
  lapNum: number,
  startMs: number,
  endMs: number,
  duration: number,
  speed: Sample[],
  rawIsMetresPerSecond: boolean,
): LapProfile | null {
  if (speed.length < 2) return null;
  const times: number[] = [speed[0]!.t];
  const dist: number[] = [0];
  let acc = 0;
  for (let i = 1; i < speed.length; i++) {
    const dt = speed[i]!.t - speed[i - 1]!.t;
    if (dt <= 0 || dt > 2) continue;
    const ms = rawIsMetresPerSecond ? speed[i]!.v : speed[i]!.v / 3.6;
    if (ms < 0 || ms > 120) continue;
    acc += ms * dt;
    times.push(speed[i]!.t);
    dist.push(acc);
  }
  return profileFromPoints(lapNum, startMs, endMs, duration, times, dist, "speed");
}

export function prepareLog(log: XrkLog, fileName: string): PreparedLog {
  const channels = Object.values(log.channels)
    .filter((ch) => ch.timecodes.length > 1)
    .map((ch) => {
      const display = displayScale(ch);
      return {
        key: ch.name,
        label: labelFor(ch),
        unit: display.unit,
        scale: display.scale,
        channel: ch,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const lat = findLatChannel(Object.values(log.channels));
  const lon = findLonChannel(Object.values(log.channels));
  const speed = findChannel(log.channels, (ch) => isSpeedName(ch.name));
  const speedIsMs = speed ? displayScale(speed).scale === 3.6 : true;

  const laps: LapProfile[] = [];
  let usedGps = 0;
  let usedSpeed = 0;
  for (const lap of log.laps) {
    const duration = (lap.endTime - lap.startTime) / 1000;
    if (duration < 5) continue;
    let profile: LapProfile | null = null;
    if (lat && lon) {
      profile = profileFromGps(
        lap.num,
        lap.startTime,
        lap.endTime,
        duration,
        sliceChannel(lat, lap.startTime, lap.endTime),
        sliceChannel(lon, lap.startTime, lap.endTime),
      );
    }
    if (!profile && speed) {
      profile = profileFromSpeed(
        lap.num,
        lap.startTime,
        lap.endTime,
        duration,
        sliceChannel(speed, lap.startTime, lap.endTime),
        speedIsMs,
      );
    }
    if (!profile) continue;
    if (profile.source === "gps") usedGps += 1;
    else usedSpeed += 1;
    laps.push(profile);
  }

  const meta = log.metadata ?? {};
  const vehicle = String(meta.Vehicle ?? meta.vehicle ?? "—");
  const rider = String(meta.Driver ?? "").trim() || "—";
  const when = [meta["Log Date"], meta["Log Time"]].map((item) => String(item ?? "").trim()).filter(Boolean).join(" ");
  const track = String(meta.Venue ?? meta.Track ?? meta.track ?? "Session");
  const speedUnit = String(meta["Speed Unit"] ?? "").trim();
  const converted = /converted/i.test(speedUnit) ? ` Logged speed was ${speedUnit}.` : "";
  const distanceNote =
    (usedGps > 0
      ? "Splits follow GPS distance along the lap, so a sector is the same piece of track on every lap."
      : usedSpeed > 0
        ? "No usable latitude/longitude. Splits follow distance integrated from speed."
        : "This file has no GPS position or speed, so sectors cannot be placed.") + converted;

  return { fileName, vehicle, rider, when, track, channels, laps, distanceNote };
}

export function timeAtFraction(
  profile: Pick<LapProfile, "times" | "dist" | "total" | "duration">,
  fraction: number,
): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return profile.duration;
  const target = fraction * profile.total;
  const { dist, times } = profile;
  let lo = 0;
  let hi = dist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return times[0] ?? 0;
  const d0 = dist[lo - 1]!;
  const d1 = dist[lo]!;
  const span = d1 - d0;
  const u = span > 1e-6 ? (target - d0) / span : 0;
  return times[lo - 1]! + u * (times[lo]! - times[lo - 1]!);
}

export function fractionAtTime(
  profile: Pick<LapProfile, "times" | "dist" | "total" | "duration">,
  timeSec: number,
): number {
  if (timeSec <= 0) return 0;
  if (timeSec >= profile.duration) return 1;
  const { times, dist, total } = profile;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < timeSec) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0 || total <= 0) return 0;
  const t0 = times[lo - 1]!;
  const t1 = times[lo]!;
  const span = t1 - t0;
  const u = span > 1e-6 ? (timeSec - t0) / span : 0;
  const d = dist[lo - 1]! + u * (dist[lo]! - dist[lo - 1]!);
  return Math.min(1, Math.max(0, d / total));
}

export type SectorKind = "corner" | "link" | "plain";
export type TurnHand = "LEFT" | "RIGHT";
export type ApexMode = "speed" | "lean";

/** One piece of the lap, as a fraction of GPS distance. Fractions match across laps. */
export type NamedSector = {
  id: string;
  label: string;
  kind: SectorKind;
  from: number;
  to: number;
  apex: number | null;
  brake: number | null;
  turn: TurnHand | null;
  apexMode: ApexMode;
};

export type SectorRow = NamedSector & {
  index: number;
  /** Seconds per lap index in the same order as the input profiles. */
  times: number[];
  best: number;
  /** Index into the laps array that produced `best`. */
  bestIndex: number;
  bestLap: number;
};

export type TrackCorner = {
  id: string;
  fromM: number;
  toM: number;
  apexM: number;
  brakeM: number | null;
  turn: TurnHand;
  apexMode: ApexMode;
};

export type TrackTemplate = {
  id: string;
  name: string;
  corners: TrackCorner[];
};

export type SplitDocument = {
  v: 2;
  templateId: string;
  /** Lap length used to turn template metres into fractions. 0 if unknown. */
  lapLengthM: number;
  spans: NamedSector[];
};

export type SavedTemplate = {
  name: string;
  spans: NamedSector[];
  lapLengthM: number;
};

/**
 * Zhuhai International Circuit corners C1–C11.
 * Distances are metres from the start/finish along the GPS path of the reference
 * coaching lap (brake onset, apex, and the corner window).
 */
export const ZIC_TEMPLATE: TrackTemplate = {
  id: "zic",
  name: "ZIC C1–C11",
  corners: [
    { id: "C1", fromM: 157, toM: 535, apexM: 435, brakeM: 157, turn: "RIGHT", apexMode: "speed" },
    { id: "C2", fromM: 678, toM: 928, apexM: 828, brakeM: null, turn: "RIGHT", apexMode: "speed" },
    { id: "C3", fromM: 946, toM: 1212, apexM: 1112, brakeM: 946, turn: "LEFT", apexMode: "speed" },
    { id: "C4", fromM: 1334, toM: 1584, apexM: 1484, brakeM: null, turn: "RIGHT", apexMode: "speed" },
    { id: "C5", fromM: 1595, toM: 1871, apexM: 1771, brakeM: 1595, turn: "RIGHT", apexMode: "speed" },
    { id: "C6", fromM: 1981, toM: 2162, apexM: 2131, brakeM: null, turn: "RIGHT", apexMode: "lean" },
    { id: "C7", fromM: 2162, toM: 2431, apexM: 2397, brakeM: 2162, turn: "LEFT", apexMode: "speed" },
    { id: "C8", fromM: 2431, toM: 2681, apexM: 2581, brakeM: null, turn: "LEFT", apexMode: "speed" },
    { id: "C9", fromM: 2906, toM: 3234, apexM: 3134, brakeM: 2906, turn: "RIGHT", apexMode: "speed" },
    { id: "C10", fromM: 3431, toM: 3625, apexM: 3581, brakeM: null, turn: "LEFT", apexMode: "lean" },
    { id: "C11", fromM: 3625, toM: 3941, apexM: 3841, brakeM: 3625, turn: "RIGHT", apexMode: "speed" },
  ],
};

const TEMPLATE_LIBRARY: TrackTemplate[] = [ZIC_TEMPLATE];

export function builtinTemplates(): TrackTemplate[] {
  return TEMPLATE_LIBRARY;
}

export function templateById(id: string): TrackTemplate | undefined {
  return TEMPLATE_LIBRARY.find((item) => item.id === id);
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

export function formatSigned(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (Math.abs(seconds) < 0.0005) return "0.000";
  const sign = seconds > 0 ? "+" : "−";
  return sign + Math.abs(seconds).toFixed(3);
}

export function turnTag(turn: TurnHand | null): string {
  if (turn === "LEFT") return "L";
  if (turn === "RIGHT") return "R";
  return "";
}

export function sectorLabel(span: NamedSector): string {
  const tag = turnTag(span.turn);
  return tag && span.kind === "corner" ? `${span.label} ${tag}` : span.label;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function plainSpan(index: number, from: number, to: number): NamedSector {
  return {
    id: `S${index}`,
    label: `S${index}`,
    kind: "plain",
    from,
    to,
    apex: null,
    brake: null,
    turn: null,
    apexMode: "speed",
  };
}

export function spansFromSplits(splits: number[]): NamedSector[] {
  const edges = [...splits]
    .filter((value) => typeof value === "number" && value > 0.012 && value < 0.988)
    .sort((a, b) => a - b);
  const bounds = [0];
  for (const edge of edges) {
    if (edge - bounds[bounds.length - 1]! < 0.008) continue;
    bounds.push(edge);
  }
  if (1 - bounds[bounds.length - 1]! < 0.008) bounds.pop();
  bounds.push(1);
  if (bounds.length < 3) return [];
  const spans: NamedSector[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    spans.push(plainSpan(i + 1, bounds[i]!, bounds[i + 1]!));
  }
  return spans;
}

function linkSpan(id: string, label: string, from: number, to: number): NamedSector {
  return {
    id,
    label,
    kind: "link",
    from,
    to,
    apex: null,
    brake: null,
    turn: null,
    apexMode: "speed",
  };
}

export function spansFromTemplate(
  template: TrackTemplate,
  lapLengthM: number,
): { spans: NamedSector[]; lapLengthM: number; scaled: boolean } {
  const length = Math.max(1, lapLengthM);
  const corners = [...template.corners].sort((a, b) => a.fromM - b.fromM);
  const maxM = corners.reduce((max, corner) => Math.max(max, corner.toM, corner.apexM), 0);
  let scale = 1;
  let scaled = false;
  if (maxM > length * 0.985) {
    scale = (length * 0.97) / maxM;
    scaled = true;
  }
  const metres = (value: number) => value * scale;
  type Piece = NamedSector & { fromM: number; toM: number };
  const pieces: Piece[] = [];
  let cursor = 0;
  let prevId = "S/F";
  for (const corner of corners) {
    let fromM = metres(corner.fromM);
    const toM = Math.max(fromM + 5, metres(corner.toM));
    if (fromM > cursor + 8) {
      pieces.push({
        ...linkSpan(`${prevId}-${corner.id}`, prevId === "S/F" ? `to ${corner.id}` : `${prevId}–${corner.id}`, 0, 0),
        fromM: cursor,
        toM: fromM,
      });
    } else {
      fromM = cursor;
    }
    const apexM = Math.min(toM - 1, Math.max(fromM + 1, metres(corner.apexM)));
    const brakeM = corner.brakeM == null ? null : Math.min(toM - 1, Math.max(fromM, metres(corner.brakeM)));
    pieces.push({
      id: corner.id,
      label: corner.id,
      kind: "corner",
      from: 0,
      to: 0,
      apex: apexM / length,
      brake: brakeM == null ? null : brakeM / length,
      turn: corner.turn,
      apexMode: corner.apexMode,
      fromM,
      toM,
    });
    cursor = toM;
    prevId = corner.id;
  }
  if (length - cursor > 8) {
    pieces.push({
      ...linkSpan(`${prevId}-out`, `${prevId} out`, 0, 0),
      fromM: cursor,
      toM: length,
    });
  } else if (pieces.length) {
    pieces[pieces.length - 1]!.toM = length;
  }
  const spans = pieces.map((piece) => ({
    id: piece.id,
    label: piece.label,
    kind: piece.kind,
    from: clamp01(piece.fromM / length),
    to: clamp01(piece.toM / length),
    apex: piece.apex,
    brake: piece.brake,
    turn: piece.turn,
    apexMode: piece.apexMode,
  }));
  if (spans.length) {
    spans[0]!.from = 0;
    spans[spans.length - 1]!.to = 1;
  }
  return { spans, lapLengthM: length, scaled };
}

export function sectorTableFromSpans(
  laps: readonly Pick<LapProfile, "num" | "times" | "dist" | "total" | "duration">[],
  spans: readonly NamedSector[],
): SectorRow[] {
  return spans.map((span, index) => {
    const times = laps.map((lap) => timeAtFraction(lap, span.to) - timeAtFraction(lap, span.from));
    let best = Infinity;
    let bestIndex = 0;
    times.forEach((time, lapIndex) => {
      if (time > 0.05 && time < best) {
        best = time;
        bestIndex = lapIndex;
      }
    });
    return {
      ...span,
      index: index + 1,
      times,
      best: Number.isFinite(best) ? best : NaN,
      bestIndex,
      bestLap: laps[bestIndex]?.num ?? 0,
    };
  });
}

export function sectorTable(laps: LapProfile[], splits: number[]): SectorRow[] {
  return sectorTableFromSpans(laps, spansFromSplits(splits));
}

export function moveSpanEdge(spans: readonly NamedSector[], edge: number, fraction: number): NamedSector[] {
  if (edge < 0 || edge >= spans.length - 1) return spans.map((span) => ({ ...span }));
  const next = spans.map((span) => ({ ...span }));
  const lo = next[edge]!.from + 0.006;
  const hi = next[edge + 1]!.to - 0.006;
  if (!(hi > lo)) return next;
  const at = Math.min(hi, Math.max(lo, fraction));
  next[edge]!.to = at;
  next[edge + 1]!.from = at;
  for (const span of [next[edge]!, next[edge + 1]!]) {
    if (span.apex != null) span.apex = Math.min(span.to - 0.001, Math.max(span.from + 0.001, span.apex));
    if (span.brake != null) span.brake = Math.min(span.to - 0.001, Math.max(span.from, span.brake));
  }
  return next;
}

export function removeSpanEdge(spans: readonly NamedSector[], edge: number): NamedSector[] {
  if (edge < 0 || edge >= spans.length - 1) return spans.map((span) => ({ ...span }));
  const next = spans.map((span) => ({ ...span }));
  const left = next[edge]!;
  const right = next[edge + 1]!;
  left.to = right.to;
  if (left.apex == null) left.apex = right.apex;
  if (left.brake == null) left.brake = right.brake;
  next.splice(edge + 1, 1);
  if (next.every((span) => span.kind !== "corner")) {
    return next.map((span, index) => ({ ...span, id: `S${index + 1}`, label: `S${index + 1}`, kind: "plain" as const }));
  }
  return next;
}

function isSector(value: unknown): value is NamedSector {
  if (!value || typeof value !== "object") return false;
  const span = value as Partial<NamedSector>;
  return (
    typeof span.id === "string" &&
    typeof span.label === "string" &&
    (span.kind === "corner" || span.kind === "link" || span.kind === "plain") &&
    typeof span.from === "number" &&
    typeof span.to === "number" &&
    span.to > span.from
  );
}

function cleanSpan(span: NamedSector): NamedSector {
  const from = clamp01(span.from);
  const to = clamp01(span.to);
  return {
    id: span.id,
    label: span.label,
    kind: span.kind,
    from,
    to: Math.max(from + 0.002, to),
    apex: typeof span.apex === "number" ? clamp01(span.apex) : null,
    brake: typeof span.brake === "number" ? clamp01(span.brake) : null,
    turn: span.turn === "LEFT" || span.turn === "RIGHT" ? span.turn : null,
    apexMode: span.apexMode === "lean" ? "lean" : "speed",
  };
}

export function parseSplitDocument(raw: string | null): SplitDocument | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "number")) {
      return { v: 2, templateId: "manual", lapLengthM: 0, spans: spansFromSplits(parsed) };
    }
    if (!parsed || typeof parsed !== "object") return null;
    const doc = parsed as Partial<SplitDocument>;
    if (doc.v !== 2 || !Array.isArray(doc.spans)) return null;
    const spans = doc.spans.filter(isSector).map(cleanSpan);
    if (spans.length) {
      spans[0]!.from = 0;
      spans[spans.length - 1]!.to = 1;
    }
    return {
      v: 2,
      templateId: typeof doc.templateId === "string" ? doc.templateId : "manual",
      lapLengthM: typeof doc.lapLengthM === "number" && doc.lapLengthM > 0 ? doc.lapLengthM : 0,
      spans,
    };
  } catch {
    return null;
  }
}

export function serializeSplitDocument(doc: SplitDocument): string {
  return JSON.stringify(doc);
}

export function parseSavedTemplates(raw: string | null): SavedTemplate[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Partial<SavedTemplate>;
      if (typeof row.name !== "string" || !row.name.trim() || !Array.isArray(row.spans)) return [];
      const spans = row.spans.filter(isSector).map(cleanSpan);
      if (!spans.length) return [];
      return [
        {
          name: row.name.trim().slice(0, 40),
          spans,
          lapLengthM: typeof row.lapLengthM === "number" ? row.lapLengthM : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function serializeSavedTemplates(list: readonly SavedTemplate[]): string {
  return JSON.stringify(list);
}

export type DeltaPoint = { metres: number; delta: number };

/** Cumulative time of `lap` minus `ref` at the same fraction of each lap. Positive means `lap` is behind. */
export function deltaVsDistance(ref: LapProfile, lap: LapProfile, steps = 240): DeltaPoint[] {
  const count = Math.max(20, Math.round(steps));
  const points: DeltaPoint[] = [];
  for (let i = 0; i <= count; i++) {
    const fraction = i / count;
    points.push({
      metres: fraction * ref.total,
      delta: timeAtFraction(lap, fraction) - timeAtFraction(ref, fraction),
    });
  }
  return points;
}

export function topSectorLosses(
  rows: readonly SectorRow[],
  refIndex: number,
  lapIndex: number,
  limit = 3,
): { row: SectorRow; delta: number }[] {
  return rows
    .map((row) => ({ row, delta: (row.times[lapIndex] ?? NaN) - (row.times[refIndex] ?? NaN) }))
    .filter((item) => Number.isFinite(item.delta) && item.delta > 0.0005)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, limit);
}

export type CoachingKeys = {
  brake?: string;
  throttle?: string;
  lean?: string;
  speed?: string;
};

function haystack(channel: { key: string; label: string }): string {
  return `${channel.label} ${channel.key}`;
}

function firstChannel(
  channels: readonly { key: string; label: string }[],
  tests: readonly RegExp[],
  reject?: RegExp,
): string | undefined {
  for (const test of tests) {
    const hit = channels.find((channel) => {
      const name = haystack(channel);
      if (reject && reject.test(name)) return false;
      return test.test(name);
    });
    if (hit) return hit.key;
  }
  return undefined;
}

/** Brake, throttle, and lean keys, matched to AiM / RaceStudio channel names. */
export function coachingChannelKeys(channels: readonly { key: string; label: string }[]): CoachingKeys {
  const brake =
    firstChannel(channels, [
      /front[\s_-]*brake|brake[\s_-]*front/i,
      /brake[\s_-]*(press|pressure)/i,
      /\bbrake\b/i,
    ]) ??
    firstChannel(channels, [/brake/i]) ??
    firstChannel(channels, [/long(?:itudinal)?[\s_-]*g\b/i, /long[\s_-]*accel/i]);
  const throttle = firstChannel(channels, [/twist[\s_-]*grip/i, /throttle/i, /\btps\b/i]);
  const lean = firstChannel(channels, [/lean[\s_-]*angle/i, /bike[\s_-]*angle/i, /\blean\b/i, /roll[\s_-]*angle/i]);
  const speed =
    firstChannel(channels, [/gps[\s_-]*speed/i]) ??
    firstChannel(channels, [/speed/i], /rate|accur|fix|gps[\s_-]*(lat|lon|heading|alt)/i);
  return { brake, throttle, lean, speed };
}

export function isCoachingChannel(channel: { key: string; label: string }): boolean {
  const keys = coachingChannelKeys([channel]);
  return Boolean(keys.brake || keys.throttle || keys.lean);
}

export type MarkerHit = {
  id: string;
  label: string;
  kind: "brake" | "apex";
  t: number;
  fraction: number;
};

export type MarkerInput = {
  brake: Sample[] | null;
  brakeUnit: string;
  speed: Sample[] | null;
  speedScale: number;
  lean: Sample[] | null;
  leanScale: number;
};

function samplesBetween(samples: Sample[], t0: number, t1: number): Sample[] {
  return samples.filter((sample) => sample.t >= t0 && sample.t <= t1 && Number.isFinite(sample.v));
}

function brakeThreshold(unit: string, peak: number): number | null {
  if (!Number.isFinite(peak) || peak <= 0) return null;
  if (/bar|psi|kpa|mpa/i.test(unit)) {
    if (peak < 1.5) return null;
    return Math.max(0.8, peak * 0.12);
  }
  if (/%|percent/i.test(unit)) {
    if (peak < 5) return null;
    return Math.max(3, peak * 0.12);
  }
  if (peak < 1) return null;
  return peak * 0.15;
}

/** Longitudinal G is +accel / −brake. Brake-on is the drop through a negative threshold. */
function longGBrakeOnset(window: Sample[]): number | null {
  let peak = 0;
  for (const sample of window) if (sample.v < peak) peak = sample.v;
  if (peak > -0.2) return null;
  const threshold = peak < -5 ? peak * 0.12 : Math.min(-0.15, peak * 0.25);
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const curr = window[i]!;
    if (prev.v > threshold && curr.v <= threshold) return curr.t;
  }
  if (window[0]!.v <= threshold) return window[0]!.t;
  return null;
}

function brakeOnset(samples: Sample[], t0: number, t1: number, unit: string): number | null {
  const window = samplesBetween(samples, t0, t1);
  if (window.length < 4 || !(t1 > t0)) return null;
  if (/^g$/i.test(unit.trim())) return longGBrakeOnset(window);
  let peak = 0;
  for (const sample of window) if (sample.v > peak) peak = sample.v;
  const threshold = brakeThreshold(unit, peak);
  if (threshold == null) return null;
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const curr = window[i]!;
    if (prev.v < threshold && curr.v >= threshold) return curr.t;
  }
  if (window[0]!.v >= threshold) return window[0]!.t;
  return null;
}

function extremeTime(
  samples: Sample[],
  t0: number,
  t1: number,
  scale: number,
  mode: "min" | "maxAbs",
): number | null {
  const window = samplesBetween(samples, t0, t1);
  if (!window.length) return null;
  let bestScore = mode === "min" ? Infinity : -Infinity;
  let bestT: number | null = null;
  for (const sample of window) {
    const value = sample.v * scale;
    if (!Number.isFinite(value)) continue;
    if (mode === "min" && value < 5) continue;
    const score = mode === "min" ? value : Math.abs(value);
    const better = mode === "min" ? score < bestScore : score > bestScore;
    if (better) {
      bestScore = score;
      bestT = sample.t;
    }
  }
  return bestT;
}

export function markersForLap(lap: LapProfile, spans: readonly NamedSector[], input: MarkerInput): MarkerHit[] {
  const hits: MarkerHit[] = [];
  for (const span of spans) {
    if (span.kind !== "corner") continue;
    const t0 = timeAtFraction(lap, span.from);
    const t1 = timeAtFraction(lap, span.to);
    let apexT: number | null = null;
    if (span.apexMode === "lean" && input.lean?.length) {
      apexT = extremeTime(input.lean, t0, t1, input.leanScale, "maxAbs");
    }
    if (apexT == null && input.speed?.length && span.apexMode !== "lean") {
      apexT = extremeTime(input.speed, t0, t1, input.speedScale, "min");
    }
    if (apexT == null && span.apex != null) apexT = timeAtFraction(lap, span.apex);
    if (apexT != null) {
      hits.push({
        id: span.id,
        label: span.label,
        kind: "apex",
        t: apexT,
        fraction: fractionAtTime(lap, apexT),
      });
    }
    const searchFrom = timeAtFraction(lap, Math.max(0, (span.brake ?? span.from) - 0.012));
    const searchTo = apexT != null ? Math.max(searchFrom, Math.min(t1, apexT)) : t1;
    let brakeT = input.brake?.length ? brakeOnset(input.brake, searchFrom, searchTo, input.brakeUnit) : null;
    if (brakeT == null && span.brake != null) brakeT = timeAtFraction(lap, span.brake);
    if (brakeT != null && span.brake != null) {
      hits.push({
        id: span.id,
        label: span.label,
        kind: "brake",
        t: brakeT,
        fraction: fractionAtTime(lap, brakeT),
      });
    } else if (brakeT != null && input.brake?.length) {
      hits.push({
        id: span.id,
        label: span.label,
        kind: "brake",
        t: brakeT,
        fraction: fractionAtTime(lap, brakeT),
      });
    }
  }
  return hits;
}

export function idealSeconds(rows: SectorRow[]): number {
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.best) ? row.best : 0), 0);
}

export function equalSplits(count: number): number[] {
  const n = Math.max(2, Math.min(12, Math.round(count)));
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(i / n);
  return out;
}

export function downsample(samples: Sample[], maxPoints: number): Sample[] {
  if (samples.length <= maxPoints) return samples;
  const step = samples.length / maxPoints;
  const out: Sample[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(samples[Math.floor(i * step)]!);
  const last = samples[samples.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
