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
  const n = Math.min(lat.length, lon.length);
  const times: number[] = [];
  const dist: number[] = [];
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
    times.push(t);
    dist.push(acc);
    prevLat = la;
    prevLon = lo;
    hasPrev = true;
  }
  return profileFromPoints(lapNum, startMs, endMs, duration, times, dist, "gps");
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

  const lat = findChannel(
    log.channels,
    (ch) => ch.name === "GPS Latitude" || (/lat/i.test(ch.name) && !/acc|lateral/i.test(ch.name)),
  );
  const lon = findChannel(
    log.channels,
    (ch) =>
      ch.name === "GPS Longitude" ||
      ((/lon/i.test(ch.name) || /long/i.test(ch.name)) && !/acc/i.test(ch.name)),
  );
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
  const track = String(meta.Venue ?? meta.Track ?? meta.track ?? "Session");
  const distanceNote =
    usedGps > 0
      ? "Splits follow GPS distance along the lap, so a sector is the same piece of track on every lap."
      : usedSpeed > 0
        ? "No usable latitude/longitude. Splits follow distance integrated from speed."
        : "This file has no GPS position or speed, so sectors cannot be placed.";

  return { fileName, vehicle, track, channels, laps, distanceNote };
}

export function timeAtFraction(profile: LapProfile, fraction: number): number {
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

export function fractionAtTime(profile: LapProfile, timeSec: number): number {
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

export type SectorRow = {
  index: number;
  from: number;
  to: number;
  /** Seconds per lap index in the same order as the input profiles. */
  times: number[];
  best: number;
  bestLap: number;
};

export function sectorTable(laps: LapProfile[], splits: number[]): SectorRow[] {
  const bounds = [0, ...[...splits].sort((a, b) => a - b), 1];
  const rows: SectorRow[] = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const from = bounds[s]!;
    const to = bounds[s + 1]!;
    const times = laps.map((lap) => timeAtFraction(lap, to) - timeAtFraction(lap, from));
    let best = Infinity;
    let bestLap = laps[0]?.num ?? 0;
    times.forEach((t, i) => {
      if (t < best) {
        best = t;
        bestLap = laps[i]!.num;
      }
    });
    rows.push({
      index: s + 1,
      from,
      to,
      times,
      best: Number.isFinite(best) ? best : NaN,
      bestLap,
    });
  }
  return rows;
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
