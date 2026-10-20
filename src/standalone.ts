import { parseXrk, type XrkChannel, type XrkLog } from "aim-xrk";
import { downloadCoachingNote, safeStem, type CoachingNote, type NoteChart } from "./lib/coaching-note";
import {
  coachingChannelKeys,
  deltaVsDistance,
  downsample,
  equalSplits,
  fixAtMetres,
  formatLap,
  formatSigned,
  fractionAtTime,
  gpsTrack,
  idealSeconds,
  isCoachingChannel,
  lapColor,
  markersForLap,
  median,
  moveSpanEdge,
  parseSavedTemplates,
  parseSplitDocument,
  removeSpanEdge,
  sectorLabel,
  sectorTableFromSpans,
  serializeSavedTemplates,
  serializeSplitDocument,
  spansFromSplits,
  spansFromTemplate,
  timeAtFraction,
  topSectorLosses,
  ZIC_TEMPLATE,
  type GpsFix,
  type MarkerHit,
  type NamedSector,
  type Sample,
  type SavedTemplate,
} from "./lib/telemetry";

type LapProfile = {
  num: number;
  startMs: number;
  endMs: number;
  duration: number;
  times: number[];
  dist: number[];
  total: number;
  source: "gps" | "speed";
  side: "A" | "B";
  id: string;
  /** Accepted GPS fixes for this lap. Empty when distance came from speed. */
  path: GpsFix[];
};
type PrepChannel = { key: string; label: string; unit: string; scale: number; channel: XrkChannel };
type Prepared = {
  fileName: string;
  vehicle: string;
  rider: string;
  when: string;
  track: string;
  channels: PrepChannel[];
  laps: LapProfile[];
  distanceNote: string;
};

function isSpeedName(name: string) {
  return /speed/i.test(name) && !/rate|accur|fix/i.test(name);
}

function channelMax(ch: XrkChannel) {
  let max = 0;
  const step = Math.max(1, Math.floor(ch.values.length / 500));
  for (let i = 0; i < ch.values.length; i += step) {
    const v = ch.values[i] as number;
    if (v > max) max = v;
  }
  return max;
}

function displayScale(ch: XrkChannel) {
  if (!isSpeedName(ch.name)) return { unit: ch.units || "", scale: 1 };
  if (/km\/h|kmh/i.test(ch.units || "")) return { unit: "km/h", scale: 1 };
  const max = channelMax(ch);
  if (max > 0 && max < 130) return { unit: "km/h", scale: 3.6 };
  return { unit: ch.units || "km/h", scale: 1 };
}

function sliceChannel(ch: XrkChannel, startMs: number, endMs: number): Sample[] {
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

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
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
  num: number,
  startMs: number,
  endMs: number,
  duration: number,
  times: number[],
  dist: number[],
  source: "gps" | "speed",
  path: GpsFix[] = [],
): LapProfile | null {
  if (times.length < 2 || dist[dist.length - 1]! < 50) return null;
  const total = dist[dist.length - 1]!;
  if (times[0]! > 0.05) {
    times.unshift(0);
    dist.unshift(0);
  }
  if (duration - times[times.length - 1]! > 0.02) {
    times.push(duration);
    dist.push(total);
  }
  return { num, startMs, endMs, duration, times, dist, total, source, side: "A", id: `A${num}`, path };
}

function profileFromGps(num: number, startMs: number, endMs: number, duration: number, lat: Sample[], lon: Sample[]) {
  const path = gpsTrack(lat, lon);
  return profileFromPoints(
    num,
    startMs,
    endMs,
    duration,
    path.map((fix) => fix.t),
    path.map((fix) => fix.d),
    "gps",
    path,
  );
}

function profileFromSpeed(
  num: number,
  startMs: number,
  endMs: number,
  duration: number,
  speed: Sample[],
  rawIsMs: boolean,
) {
  if (speed.length < 2) return null;
  const times = [speed[0]!.t];
  const dist = [0];
  let acc = 0;
  for (let i = 1; i < speed.length; i++) {
    const dt = speed[i]!.t - speed[i - 1]!.t;
    if (dt <= 0 || dt > 2) continue;
    const ms = rawIsMs ? speed[i]!.v : speed[i]!.v / 3.6;
    if (ms < 0 || ms > 120) continue;
    acc += ms * dt;
    times.push(speed[i]!.t);
    dist.push(acc);
  }
  return profileFromPoints(num, startMs, endMs, duration, times, dist, "speed");
}

const NAMED: [RegExp, string][] = [
  [/twist[\s_-]*grip/i, "Throttle Twist Grip"],
  [/tps[\s_-]*vert/i, "Throttle Position Vertical"],
  [/tps[\s_-]*hor/i, "Throttle Position Horizontal"],
  [/rear[\s_-]*shock/i, "Rear Shock Position"],
  [/front[\s_-]*fork/i, "Front Fork Position"],
  [/front[\s_-]*brake|brake[\s_-]*front/i, "Front Brake"],
  [/speed[\s_-]*rear|rear[\s_-]*wheel[\s_-]*speed/i, "Rear Wheel Speed"],
  [/speed[\s_-]*front|front[\s_-]*wheel[\s_-]*speed/i, "Front Wheel Speed"],
  [/^rpm$/i, "Engine RPM"],
  [/bike[\s_-]*angle|lean[\s_-]*angle/i, "Lean Angle"],
  [/^gear$/i, "Gear"],
];

function isLoggerCode(name: string) {
  return /^[0-9]/.test(name) || /^[A-Za-z]{1,4}\d/.test(name);
}

function channelLabel(ch: XrkChannel) {
  const raw = ch.name.trim();
  const name = raw.replaceAll("_", " ");
  for (const [re, label] of NAMED) {
    if (re.test(raw) || re.test(name)) return label;
  }
  const func = ch.func?.trim() || "";
  const generic = /^(number|percent|percentage|distance|time|angle|pressure|temperature|voltage|acceleration|angular rate)$/i;
  if (name && !isLoggerCode(name)) return name;
  if (func && !generic.test(func)) return func;
  return name || func || "Channel";
}

function makeChannel(name: string, units: string, func: string, timecodes: Float64Array, values: Float64Array): XrkChannel {
  return {
    name,
    shortName: name,
    units,
    decPts: 3,
    interpolate: true,
    func,
    sourceType: 0,
    sourceChannelId: 0,
    deviceTag: "dragy",
    calValue1: 0,
    calValue2: 0,
    displayRangeMin: 0,
    displayRangeMax: 0,
    timecodes,
    values,
  };
}

function clockSeconds(stamp: number) {
  const h = Math.floor(stamp / 10000);
  const m = Math.floor((stamp % 10000) / 100);
  return h * 3600 + m * 60 + (stamp % 100);
}

function parseVbo(text: string, fileName: string): XrkLog {
  const lines = text.split(/\r?\n/);
  let section = "";
  const stamps: number[] = [];
  const latMin: number[] = [];
  const lonMin: number[] = [];
  const speed: number[] = [];
  const heading: number[] = [];
  const height: number[] = [];
  const sats: number[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("[")) {
      section = trimmed.toLowerCase();
      continue;
    }
    if (section !== "[data]") continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;
    const lat = Number(parts[2]);
    const lon = Number(parts[3]);
    const vel = Number(parts[4]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(vel)) continue;
    stamps.push(Number(parts[1]));
    sats.push(Number(parts[0]));
    latMin.push(lat);
    lonMin.push(lon);
    speed.push(vel);
    heading.push(Number(parts[5]));
    height.push(parts.length > 6 ? Number(parts[6]) : 0);
  }
  if (stamps.length < 10) throw new Error("This VBO file has no usable data.");
  const n = stamps.length;
  let prev = clockSeconds(stamps[0]!);
  const origin = prev;
  const times = new Float64Array(n);
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sec = clockSeconds(stamps[i]!);
    if (sec < prev - 1000) sec += 86400;
    prev = sec;
    times[i] = (sec - origin) * 1000;
    lat[i] = latMin[i]! / 60;
    lon[i] = -lonMin[i]! / 60;
  }
  let gate = -1;
  for (let i = 0; i < n; i++) {
    if (speed[i]! > 80) {
      gate = i;
      break;
    }
  }
  const laps: XrkLog["laps"] = [];
  if (gate >= 0) {
    let travel = 0;
    let start = gate;
    let outside = false;
    for (let i = gate + 1; i < n; i++) {
      const step = haversine(lat[i - 1]!, lon[i - 1]!, lat[i]!, lon[i]!);
      if (step < 80) travel += step;
      const fromGate = haversine(lat[i]!, lon[i]!, lat[gate]!, lon[gate]!);
      if (travel > 2000 && fromGate > 25) outside = true;
      if (outside && travel > 2000 && fromGate < 25 && speed[i]! > 40) {
        laps.push({ num: laps.length + 1, startTime: times[start]!, endTime: times[i]! });
        start = i;
        travel = 0;
        outside = false;
      }
    }
  }
  if (!laps.length) laps.push({ num: 1, startTime: times[0]!, endTime: times[n - 1]! });
  const track = fileName.replace(/\.[^.]+$/, "").split("_").slice(3).join(" ").trim();
  const channels: Record<string, XrkChannel> = {
    "GPS Speed": makeChannel("GPS Speed", "km/h", "GPS Speed", times, Float64Array.from(speed)),
    "GPS Latitude": makeChannel("GPS Latitude", "deg", "GPS Latitude", times, lat),
    "GPS Longitude": makeChannel("GPS Longitude", "deg", "GPS Longitude", times, lon),
    Heading: makeChannel("Heading", "deg", "Heading", times, Float64Array.from(heading)),
    Height: makeChannel("Height", "m", "Height", times, Float64Array.from(height)),
    Satellites: makeChannel("Satellites", "", "Satellites", times, Float64Array.from(sats)),
  };
  return {
    channels,
    laps,
    metadata: { Vehicle: "Dragy", Venue: track || "Session", Source: "Dragy VBO" },
  };
}

function prepare(log: XrkLog, fileName: string, side: "A" | "B" = "A"): Prepared {
  const channels = Object.values(log.channels)
    .filter((ch) => ch.timecodes.length > 1)
    .map((ch) => {
      const d = displayScale(ch);
      return { key: ch.name, label: channelLabel(ch), unit: d.unit, scale: d.scale, channel: ch };
    })
    .sort((a, b) => {
      const rank = (s: string) => (/twist|throttle|tps/i.test(s) ? 0 : /shock/i.test(s) ? 1 : /fork/i.test(s) ? 2 : /rpm/i.test(s) ? 3 : /speed/i.test(s) ? 4 : 9);
      const d = rank(a.label + a.key) - rank(b.label + b.key);
      return d || a.label.localeCompare(b.label);
    });
  const lat = Object.values(log.channels).find(
    (ch) => ch.name === "GPS Latitude" || (/lat/i.test(ch.name) && !/acc|lateral/i.test(ch.name)),
  );
  const lon = Object.values(log.channels).find(
    (ch) => ch.name === "GPS Longitude" || ((/lon|long/i.test(ch.name) && !/acc/i.test(ch.name))),
  );
  const speed = Object.values(log.channels).find((ch) => isSpeedName(ch.name));
  const speedIsMs = speed ? displayScale(speed).scale === 3.6 : true;
  const laps: LapProfile[] = [];
  let gps = 0;
  let spd = 0;
  for (const lap of log.laps) {
    const duration = (lap.endTime - lap.startTime) / 1000;
    if (duration < 5) continue;
    let profile: LapProfile | null = null;
    if (lat && lon) {
      profile = profileFromGps(lap.num, lap.startTime, lap.endTime, duration, sliceChannel(lat, lap.startTime, lap.endTime), sliceChannel(lon, lap.startTime, lap.endTime));
    }
    if (!profile && speed) {
      profile = profileFromSpeed(lap.num, lap.startTime, lap.endTime, duration, sliceChannel(speed, lap.startTime, lap.endTime), speedIsMs);
    }
    if (!profile) continue;
    profile.side = side;
    profile.id = `${side}${profile.num}`;
    if (profile.source === "gps") gps++;
    else spd++;
    laps.push(profile);
  }
  const meta = log.metadata ?? {};
  const when = [meta["Log Date"], meta["Log Time"]].map((item) => String(item ?? "").trim()).filter(Boolean).join(" ");
  return {
    fileName,
    vehicle: String(meta.Vehicle ?? "—"),
    rider: String(meta.Driver ?? "").trim() || "—",
    when,
    track: String(meta.Venue ?? meta.Track ?? "Session"),
    channels,
    laps,
    distanceNote:
      gps > 0
        ? "Splits follow GPS distance, so each sector is the same piece of track on every lap."
        : spd > 0
          ? "No usable latitude/longitude. Splits follow distance integrated from speed."
          : "No GPS position or speed, so sectors cannot be placed.",
  };
}

function nearest(samples: Sample[], t: number) {
  if (!samples.length) return NaN;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  const a = samples[Math.max(0, lo - 1)]!;
  const b = samples[lo]!;
  return Math.abs(a.t - t) <= Math.abs(b.t - t) ? a.v : b.v;
}

type State = {
  log: Prepared | null;
  compare: Prepared | null;
  keys: string[];
  laps: string[];
  anchor: string | null;
  spans: NamedSector[];
  templateId: string;
  lapLengthM: number;
  place: boolean;
  cursor: number | null;
  equal: number;
  drag: number | null;
  grok: boolean;
};

const state: State = {
  log: null,
  compare: null,
  keys: [],
  laps: [],
  anchor: null,
  spans: [],
  templateId: "manual",
  lapLengthM: 0,
  place: false,
  cursor: null,
  equal: 4,
  drag: null,
  grok: false,
};

const TEMPLATE_STORE = "lap-templates";

type GrokMsg = { role: "user" | "assistant"; content: string };
const grokChat: GrokMsg[] = [];
let grokBusy = false;
let channelQuery = "";
let templateDraft = "";

const app = document.getElementById("app")!;

function fastest(laps: LapProfile[]) {
  return laps.reduce((b, l) => (l.duration < b.duration ? l : b));
}

function everyLap() {
  return [...(state.log?.laps ?? []), ...(state.compare?.laps ?? [])];
}

function lapName(lap: LapProfile) {
  return state.compare ? `${lap.side}${lap.num}` : `L${lap.num}`;
}

function nameOfId(id: string) {
  const lap = everyLap().find((l) => l.id === id);
  return lap ? lapName(lap) : id;
}

function chosen() {
  return everyLap().filter((l) => state.laps.includes(l.id));
}

function anchorLap() {
  const laps = chosen();
  if (!laps.length) return null;
  return laps.find((l) => l.id === state.anchor) ?? fastest(laps);
}

function comparedLaps() {
  const all = everyLap();
  if (all.length < 2) return all;
  const totals = all.map((l) => l.total).sort((a, b) => a - b);
  const median = totals[Math.floor((totals.length - 1) / 2)] || 1;
  const full = all.filter((l) => l.total >= median * 0.85);
  return full.length ? full : all;
}

function loadTemplates(): SavedTemplate[] {
  try {
    return parseSavedTemplates(localStorage.getItem(TEMPLATE_STORE));
  } catch {
    return [];
  }
}

function saveTemplateList(list: SavedTemplate[]) {
  localStorage.setItem(TEMPLATE_STORE, serializeSavedTemplates(list));
}

function saveSplits() {
  if (!state.log) return;
  localStorage.setItem(
    "lap-splits:" + state.log.track,
    serializeSplitDocument({
      v: 2,
      templateId: state.templateId,
      lapLengthM: state.lapLengthM,
      spans: state.spans,
    }),
  );
}

function rulerLength() {
  const pool = comparedLaps();
  const laps = pool.length ? pool : everyLap();
  return median(laps.map((lap) => lap.total));
}

function applyTemplateId(id: string) {
  if (id === "manual") {
    state.templateId = "manual";
    state.spans = spansFromSplits(state.spans.slice(0, -1).map((span) => span.to));
    if (!state.lapLengthM) state.lapLengthM = rulerLength();
    saveSplits();
    return;
  }
  if (id === "zic") {
    const length = rulerLength();
    if (length < 200) return;
    const placed = spansFromTemplate(ZIC_TEMPLATE, length);
    state.templateId = "zic";
    state.spans = placed.spans;
    state.lapLengthM = placed.lapLengthM;
    saveSplits();
    return;
  }
  if (id.startsWith("saved:")) {
    const found = loadTemplates().find((item) => item.name === id.slice(6));
    if (!found) return;
    state.templateId = id;
    state.spans = found.spans.map((span) => ({ ...span }));
    state.lapLengthM = found.lapLengthM || rulerLength();
    saveSplits();
  }
}

function sectorRows(laps: LapProfile[]) {
  if (!state.spans.length || !laps.length) return [];
  return sectorTableFromSpans(laps, state.spans);
}

function sectors() {
  return sectorRows(comparedLaps());
}

function addSplit(fraction: number) {
  if (state.templateId !== "manual") return;
  if (fraction <= 0.015 || fraction >= 0.985) return;
  const edges = state.spans.slice(0, -1).map((span) => span.to);
  if (edges.some((edge) => Math.abs(edge - fraction) < 0.012)) return;
  state.spans = spansFromSplits([...edges, fraction]);
  saveSplits();
}

function reviewPair(): { ref: LapProfile; laps: LapProfile[]; implicit: boolean } | null {
  const selected = chosen();
  const anchor = anchorLap();
  if (!anchor || !selected.length) return null;
  const others = selected.filter((lap) => lap.id !== anchor.id);
  if (others.length) return { ref: anchor, laps: others, implicit: false };
  const pool = comparedLaps().filter((lap) => lap.id !== anchor.id);
  if (!pool.length) return null;
  return { ref: fastest(pool), laps: [anchor], implicit: true };
}

function referenceIndex(laps: LapProfile[]): number {
  const pair = reviewPair();
  if (pair) {
    const index = laps.findIndex((lap) => lap.id === pair.ref.id);
    if (index >= 0) return index;
  }
  if (!laps.length) return -1;
  let best = 0;
  laps.forEach((lap, index) => {
    if (lap.duration < laps[best]!.duration) best = index;
  });
  return best;
}

function distanceText(span: NamedSector): string {
  const length = state.lapLengthM > 0 ? state.lapLengthM : rulerLength();
  if (length > 0 && state.templateId !== "manual") {
    return `${Math.round(span.from * length)}–${Math.round(span.to * length)} m`;
  }
  return `${(span.from * 100).toFixed(0)}–${(span.to * 100).toFixed(0)}%`;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function templateLabel(): string {
  if (state.templateId === "zic") return "ZIC C1–C11";
  if (state.templateId.startsWith("saved:")) return state.templateId.slice(6);
  return "Manual splits";
}

function lapChannel(lap: LapProfile, key: string | undefined): PrepChannel | undefined {
  if (!key) return undefined;
  const source = lap.side === "B" ? state.compare : state.log;
  return source?.channels.find((channel) => channel.key === key);
}

function markerMap(laps: LapProfile[]): Map<string, MarkerHit[]> {
  const map = new Map<string, MarkerHit[]>();
  if (!state.spans.some((span) => span.kind === "corner")) return map;
  const keys = coachingChannelKeys(state.log?.channels ?? []);
  for (const lap of laps) {
    const brake = lapChannel(lap, keys.brake);
    const speed = lapChannel(lap, keys.speed);
    const lean = lapChannel(lap, keys.lean);
    map.set(
      lap.id,
      markersForLap(lap, state.spans, {
        brake: brake ? sliceChannel(brake.channel, lap.startMs, lap.endMs) : null,
        brakeUnit: brake?.unit ?? "",
        speed: speed ? sliceChannel(speed.channel, lap.startMs, lap.endMs) : null,
        speedScale: speed?.scale ?? 1,
        lean: lean ? sliceChannel(lean.channel, lap.startMs, lap.endMs) : null,
        leanScale: lean?.scale ?? 1,
      }),
    );
  }
  return map;
}

function sessionBrief() {
  const log = state.log;
  if (!log) return "No session is open.";
  const laps = comparedLaps();
  const rows = sectors();
  const lines = [
    `File A: ${log.fileName}${state.compare ? `\nFile B: ${state.compare.fileName}` : ""}`,
    `Vehicle: ${log.vehicle}${state.compare ? " vs " + state.compare.vehicle : ""}`,
    `Track: ${log.track}`,
    `Laps: ${laps.map((l) => `${lapName(l)} ${formatLap(l.duration)}`).join(", ")}`,
  ];
  if (!rows.length) lines.push("No splits are set, so there is no theoretical best yet.");
  else {
    const ideal = rows.every((r) => Number.isFinite(r.best)) ? rows.reduce((s, r) => s + r.best, 0) : NaN;
    lines.push(`Template: ${templateLabel()}`);
    lines.push(`Theoretical best: ${formatLap(ideal)}`);
    const refIndex = referenceIndex(laps);
    for (const row of rows) {
      const each = laps
        .map((lap, index) => {
          const time = row.times[index]!;
          const delta =
            refIndex >= 0 && index !== refIndex ? ` (${formatSigned(time - row.times[refIndex]!)} vs ${lapName(laps[refIndex]!)})` : "";
          return `${lapName(lap)} ${formatLap(time)}${delta}`;
        })
        .join(", ");
      lines.push(`${sectorLabel(row)} ${distanceText(row)} best ${formatLap(row.best)} from ${nameOfId(laps[row.bestIndex]!.id)}. ${each}`);
    }
  }
  lines.push("Checked channels. Numbers are min/avg/max in display units. Sector figures are min/avg/max inside that sector.");
  const selected = state.keys
    .map((key) => log.channels.find((ch) => ch.key === key))
    .filter((ch): ch is PrepChannel => !!ch)
    .slice(0, 8);
  if (!selected.length) lines.push("No channels are checked.");
  for (const ch of selected) {
    lines.push(`Channel ${ch.label} [${ch.key}] ${ch.unit || "no unit"}`);
    for (const lap of laps) {
      const own = (lap.side === "B" ? state.compare : log)?.channels.find((item) => item.key === ch.key);
      if (!own) {
        lines.push(`  ${lapName(lap)} not logged in that file`);
        continue;
      }
      const samples = sliceChannel(own.channel, lap.startMs, lap.endMs);
      const summarise = (list: Sample[]) => {
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        let n = 0;
        for (const sample of list) {
          const v = sample.v * own.scale;
          if (!Number.isFinite(v)) continue;
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
          n++;
        }
        return n ? `${min.toFixed(1)}/${(sum / n).toFixed(1)}/${max.toFixed(1)}` : "no samples";
      };
      const parts = rows.map((row) => {
        const from = timeAtFraction(lap, row.from);
        const to = timeAtFraction(lap, row.to);
        return `S${row.index} ${summarise(samples.filter((sample) => sample.t >= from && sample.t <= to))}`;
      });
      lines.push(`  ${lapName(lap)} ${summarise(samples)}${parts.length ? " | " + parts.join(" ") : ""}`);
    }
  }
  return lines.join("\n");
}

function esc(s: string) {
  const amp = String.fromCharCode(38);
  return s.replace(/[&<>"]/g, (c) => {
    if (c === amp) return amp + "amp;";
    if (c === "<") return amp + "lt;";
    if (c === ">") return amp + "gt;";
    return amp + "quot;";
  });
}

function grokPanel() {
  let key = "";
  let model = "grok-4";
  try {
    key = localStorage.getItem("smd-grok-key") || "";
    model = localStorage.getItem("smd-grok-model") || "grok-4";
  } catch { /* private window */ }
  const log = grokChat.map((m) => `<p class="${m.role === "user" ? "me" : "bot"}">${esc(m.content)}</p>`).join("");
  return `<aside class="grok-panel">
    <div class="row"><h2>Grok</h2><button id="grok-close" class="link">Close</button></div>
    <p class="hint">Uses your own xAI API key from <a href="https://console.x.ai" target="_blank" rel="noopener">console.x.ai</a>. The key stays in this browser and is not saved on GitHub.</p>
    <input id="grok-key" type="password" placeholder="xAI API key" value="${esc(key)}" autocomplete="off">
    <input id="grok-model" value="${esc(model)}" autocomplete="off">
    <div class="grok-log">${log || "<p class='hint'>Ask about the open session. The lap times and theoretical best are sent with the question.</p>"}${grokBusy ? "<p class='hint'>Thinking...</p>" : ""}</div>
    <textarea id="grok-q" placeholder="Ask about this session"></textarea>
    <div class="tools">
      <button id="grok-send">Ask</button>
      <button id="grok-brief">Send the session</button>
      <button id="grok-copy">Copy brief</button>
    </div>
  </aside>`;
}

async function askGrok(question: string) {
  const keyEl = document.getElementById("grok-key") as HTMLInputElement | null;
  const modelEl = document.getElementById("grok-model") as HTMLInputElement | null;
  const key = keyEl?.value.trim() || "";
  const model = modelEl?.value.trim() || "grok-4";
  try {
    localStorage.setItem("smd-grok-key", key);
    localStorage.setItem("smd-grok-model", model);
  } catch { /* ignore */ }
  if (!key) {
    grokChat.push({ role: "assistant", content: "Paste an xAI API key first. The login for this chat is not an API key. Create one at console.x.ai. It stays in this browser only." });
    render();
    return;
  }
  grokChat.push({ role: "user", content: question });
  grokBusy = true;
  render();
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a motorcycle racing engineer reading AIM telemetry for a coach. The session below includes every checked channel, with min/avg/max for each lap and again inside each sector. Use those numbers. Do not say a channel is missing when a line starts with Channel and that name. Name the lap and the sector.\n\n" + sessionBrief() },
          ...grokChat,
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    const errText = data?.error?.message || data?.error || "";
    const answer = data?.choices?.[0]?.message?.content;
    grokChat.push({ role: "assistant", content: res.ok && answer ? answer : `Grok did not answer (${res.status}). ${errText || "Check the key and the model name."}` });
  } catch (err) {
    grokChat.push({ role: "assistant", content: err instanceof Error ? err.message : "Could not reach Grok." });
  }
  grokBusy = false;
  render();
}

function render() {
  const log = state.log;
  if (!log) {
    app.innerHTML = `<header class="bar"><h1>Sim Motorsport Data</h1><button id="open">Open file</button></header>
      <main class="empty"><h2>A coach desk for the lap</h2>
      <p>Open an AIM .xrk or a Dragy .vbo. Apply the ZIC C1–C11 template, or drop your own splits. The ideal time is the sum of the fastest pass through each sector.</p>
      <button id="open2">Choose a file</button></main>`;
    document.getElementById("open")!.onclick = pick;
    document.getElementById("open2")!.onclick = pick;
    return;
  }
  const laps = chosen();
  const session = comparedLaps();
  const anchor = anchorLap();
  const rows = sectors();
  const ideal = rows.length && rows.every((r) => Number.isFinite(r.best)) ? idealSeconds(rows) : NaN;
  const bestActual = session.length ? Math.min(...session.map((l) => l.duration)) : NaN;
  const delta = ideal - bestActual;
  const cornerCount = rows.filter((row) => row.kind === "corner").length;
  const makeup = !rows.length
    ? ""
    : cornerCount
      ? `${templateLabel()} · fastest sector from any full lap, straights included`
      : rows.map((row) => `${sectorLabel(row)} ${formatLap(row.best)} from ${nameOfId(session[row.bestIndex]!.id)}`).join("  +  ");
  const skipped = everyLap().length - session.length;
  const deltaText = !rows.length ? "Apply ZIC or add a split" : !Number.isFinite(delta) ? "" : delta < -0.0005 ? `${formatLap(delta)} vs best lap` : delta > 0.0005 ? `+${formatLap(delta)} vs best lap` : "matches the best lap";
  const who = [log.rider !== "—" ? log.rider : "", log.vehicle !== "—" ? log.vehicle : "", log.track].filter(Boolean).join(" · ");
  const coach = coachingChannelKeys(log.channels);
  const missingCoach = [coach.brake ? "" : "brake", coach.throttle ? "" : "throttle", coach.lean ? "" : "lean"].filter(Boolean);
  const savedTemplates = loadTemplates();
  const templateOptions = [
    `<option value="manual">Manual splits</option>`,
    `<option value="zic">ZIC C1–C11</option>`,
    ...savedTemplates.map((item) => `<option value="saved:${esc(item.name)}">${esc(item.name)}</option>`),
  ].join("");

  app.innerHTML = `
    <header class="bar">
      <h1>Sim Motorsport Data</h1>
      <button id="open">Open file</button>
      <button id="compare">${state.compare ? "Remove compare" : "Compare file"}</button>
      <button id="grok">Grok</button>
      <span class="meta">${esc(log.fileName)}${state.compare ? " vs " + esc(state.compare.fileName) : ""} · ${esc(who)}</span>
    </header>
    <div class="layout">
      <aside>
        <h2>Channels</h2>
        <input id="ch-filter" placeholder="Search shock, throttle, fork" value="${esc(channelQuery)}">
        <div class="list" id="channels"></div>
        <div class="row"><h2>Laps</h2><button id="flying" class="link">Flying only</button></div>
        <div id="laps"></div>
      </aside>
      <main>
        <section class="card">
          <div class="idealrow">
            <div>
              <div class="kicker">Theoretical best</div>
              <div class="ideal">${rows.length && session.length ? formatLap(ideal) : "—"}</div>
              <div class="sub">${rows.length ? makeup : deltaText}</div>
              <div class="sub">${rows.length ? `Best full lap ${formatLap(bestActual)} · ${deltaText} · ${session.length} laps` : ""}${skipped > 0 ? ` · ${skipped} short lap${skipped === 1 ? "" : "s"} left out` : ""}</div>
            </div>
            <div class="tools">
              <label class="tmpl">Track <select id="template">${templateOptions}</select></label>
              <button id="apply" class="go">Apply</button>
              <input id="tpl-name" class="tplname" placeholder="Save template" maxlength="40" value="${esc(templateDraft)}">
              <button id="save-tpl">Save</button>
              <button id="export-png">Export PNG</button>
              <button id="export-pdf">Export PDF</button>
              <button id="place" class="${state.place ? "on" : ""}">${state.place ? "Click a graph to drop a split" : "Place on graph"}</button>
              <label>Equal <input id="equal" type="number" min="2" max="12" value="${state.equal}"></label>
              <button id="divide">Divide lap</button>
              <button id="clear">Clear</button>
            </div>
          </div>
          <p class="sub">${log.distanceNote} ${state.templateId === "manual" ? "Manual splits are a percentage of the lap." : `${esc(templateLabel())} is placed on a ${Math.round(state.lapLengthM || rulerLength()).toLocaleString("en-US")} m lap.`}</p>
          <div id="bar" class="splitbar"></div>
          <div id="chips" class="chips"></div>
          <p class="hint">${state.templateId === "manual" ? "Click the bar to add a split. Drag a marker to move it." : "Drag a marker to edit this corner map. Apply Manual splits to go back to percentage sectors."} ${state.compare ? "File B laps are the dashed lines. The theoretical best can use a sector from either file." : "The theoretical best uses every full lap in this session, not only the laps drawn on the graph."}</p>
          <div id="table"></div>
        </section>
        <section class="card delta-card">
          <div class="review">
            <div>
              <div class="kicker">Time delta vs distance</div>
              <p id="delta-legend" class="hint">Positive is behind the reference (lost time). Negative is ahead of the reference (gained time).</p>
              <div id="delta" class="delta-plot"></div>
            </div>
            <div>
              <div class="kicker">Track</div>
              <div id="track" class="track-map"></div>
              <p id="track-caption" class="hint">Hover a graph or drag the map. The dot is that distance along the lap.</p>
            </div>
          </div>
        </section>
        <p class="hint">${missingCoach.length ? `Coaching overlays look for brake, throttle, and lean. This file has no ${listWords(missingCoach)} channel.` : "Brake, throttle, and lean are the default overlays. ▲ brake on, ◆ apex. The track dot uses the same cursor."}</p>
        <p id="readout" class="readout"><span class="hint">Move across a graph. The track dot and channel values follow.</span></p>
        <div id="plots"></div>
      </main>
    </div>
    ${state.grok ? grokPanel() : ""}`;

  document.getElementById("open")!.onclick = pick;
  document.getElementById("compare")!.onclick = () => {
    if (state.compare) {
      state.compare = null;
      state.laps = state.laps.filter((id) => id.startsWith("A"));
      if (!state.anchor || state.anchor.startsWith("B")) state.anchor = state.laps[0] ?? null;
      render();
      return;
    }
    pickTarget = "B";
    picker.click();
  };
  document.getElementById("grok")!.onclick = () => {
    state.grok = !state.grok;
    render();
  };
  document.getElementById("flying")!.onclick = () => {
    const pool = everyLap();
    const q = fastest(pool).duration;
    const flying = pool.filter((l) => l.duration < q * 1.12);
    state.laps = flying.map((l) => l.id);
    state.anchor = fastest(flying).id;
    render();
  };
  document.getElementById("place")!.onclick = () => {
    state.place = !state.place;
    render();
  };
  (document.getElementById("equal") as HTMLInputElement).onchange = (e) => {
    state.equal = Number((e.target as HTMLInputElement).value) || 4;
  };
  const templateSelect = document.getElementById("template") as HTMLSelectElement;
  templateSelect.value = state.templateId;
  document.getElementById("apply")!.onclick = () => {
    applyTemplateId(templateSelect.value);
    render();
  };
  const nameInput = document.getElementById("tpl-name") as HTMLInputElement;
  nameInput.oninput = () => {
    templateDraft = nameInput.value;
  };
  document.getElementById("save-tpl")!.onclick = () => {
    const name = nameInput.value.trim().slice(0, 40);
    if (!name || !state.spans.length) return;
    const next = loadTemplates().filter((item) => item.name !== name);
    next.push({ name, spans: state.spans.map((span) => ({ ...span })), lapLengthM: state.lapLengthM || rulerLength() });
    saveTemplateList(next);
    state.templateId = `saved:${name}`;
    templateDraft = "";
    saveSplits();
    render();
  };
  document.getElementById("export-png")!.onclick = () => void exportNote("png");
  document.getElementById("export-pdf")!.onclick = () => void exportNote("pdf");
  document.getElementById("divide")!.onclick = () => {
    state.templateId = "manual";
    state.spans = spansFromSplits(equalSplits(state.equal));
    if (!state.lapLengthM) state.lapLengthM = rulerLength();
    saveSplits();
    render();
  };
  document.getElementById("clear")!.onclick = () => {
    state.templateId = "manual";
    state.spans = [];
    saveSplits();
    render();
  };

  const chBox = document.getElementById("channels")!;
  const query = channelQuery.trim().toLowerCase();
  for (const ch of log.channels) {
    const hay = `${ch.label} ${ch.key}`.toLowerCase();
    if (query && !hay.includes(query)) continue;
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" ${state.keys.includes(ch.key) ? "checked" : ""}><span title="${esc(ch.label)}">${esc(ch.label)}</span>`;
    label.querySelector("input")!.onchange = () => {
      state.keys = state.keys.includes(ch.key) ? state.keys.filter((k) => k !== ch.key) : [...state.keys, ch.key];
      render();
    };
    chBox.appendChild(label);
  }
  const filter = document.getElementById("ch-filter") as HTMLInputElement;
  filter.oninput = () => {
    channelQuery = filter.value;
    const caret = filter.selectionStart ?? filter.value.length;
    render();
    const again = document.getElementById("ch-filter") as HTMLInputElement | null;
    if (!again) return;
    again.focus();
    again.setSelectionRange(caret, caret);
  };
  if (!chBox.childElementCount) {
    chBox.textContent = "No channel matches that search.";
  }
  const lapBox = document.getElementById("laps")!;
  const paintLaps = (title: string, list: LapProfile[]) => {
    if (state.compare) {
      const heading = document.createElement("h2");
      heading.textContent = title;
      lapBox.appendChild(heading);
    }
    list.forEach((lap) => {
      const row = document.createElement("div");
      row.className = "laprow";
      row.innerHTML = `<label><input type="checkbox" ${state.laps.includes(lap.id) ? "checked" : ""}><i style="background:${colorOf(lap)}"></i><span>${lapName(lap)} ${formatLap(lap.duration)}</span></label><button class="${anchor?.id === lap.id ? "on" : ""}">Ref</button>`;
      row.querySelector("input")!.onchange = () => {
        state.laps = state.laps.includes(lap.id) ? state.laps.filter((id) => id !== lap.id) : [...state.laps, lap.id];
        render();
      };
      row.querySelector("button")!.onclick = () => {
        state.anchor = lap.id;
        render();
      };
      lapBox.appendChild(row);
    });
  };
  paintLaps(log.fileName, log.laps);
  if (state.compare) paintLaps(state.compare.fileName, state.compare.laps);

  const bar = document.getElementById("bar")!;
  const zones = state.spans
    .filter((span) => span.kind === "corner")
    .map((span) => `<div class="zone" style="left:${span.from * 100}%;width:${Math.max(0, span.to - span.from) * 100}%"><span>${esc(span.label)}</span></div>`)
    .join("");
  const marks = state.spans
    .slice(0, -1)
    .map((span, index) => `<div class="mark" data-edge="${index}" style="left:${span.to * 100}%"><b></b><span>${esc(span.kind === "plain" ? String(index + 1) : "")}</span></div>`)
    .join("");
  bar.innerHTML = `<div class="track"></div>${zones}${marks}`;
  const fracOf = (e: PointerEvent) => {
    const r = bar.getBoundingClientRect();
    return Math.min(0.99, Math.max(0.01, (e.clientX - r.left) / Math.max(r.width, 1)));
  };
  const edgeAt = (fraction: number) => {
    let hit = -1;
    let best = 0.014;
    state.spans.forEach((span, index) => {
      if (index >= state.spans.length - 1) return;
      const distance = Math.abs(span.to - fraction);
      if (distance < best) {
        best = distance;
        hit = index;
      }
    });
    return hit;
  };
  bar.onpointerdown = (e) => {
    const fraction = fracOf(e);
    const hit = edgeAt(fraction);
    if (hit >= 0) {
      state.drag = hit;
      bar.setPointerCapture(e.pointerId);
      return;
    }
    addSplit(fraction);
    render();
  };
  bar.onpointermove = (e) => {
    if (state.drag == null) {
      const rect = bar.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(rect.width, 1)));
      seekDistance(fraction);
      return;
    }
    state.spans = moveSpanEdge(state.spans, state.drag, fracOf(e));
    const nodes = bar.querySelectorAll<HTMLElement>(".mark");
    state.spans.slice(0, -1).forEach((span, index) => {
      const node = nodes[index];
      if (node) node.style.left = `${span.to * 100}%`;
    });
  };
  bar.onpointerup = () => {
    if (state.drag == null) return;
    state.drag = null;
    saveSplits();
    render();
  };

  const chips = document.getElementById("chips")!;
  if (state.templateId === "manual") {
    state.spans.slice(0, -1).forEach((span, edge) => {
      const btn = document.createElement("button");
      btn.textContent = `${span.label} ${(span.to * 100).toFixed(0)}% remove`;
      btn.onclick = () => {
        state.spans = removeSpanEdge(state.spans, edge);
        state.templateId = "manual";
        saveSplits();
        render();
      };
      chips.appendChild(btn);
    });
  } else {
    for (const span of state.spans) {
      if (span.kind !== "corner") continue;
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = `${sectorLabel(span)} ${distanceText(span)}`;
      chips.appendChild(chip);
    }
  }

  const xMax = laps.length ? Math.max(...laps.map((l) => l.duration)) : 60;
  const splitTimes = anchor ? state.spans.slice(0, -1).map((span) => timeAtFraction(anchor, span.to)) : [];
  const marksByLap = markerMap(laps);
  const plots = document.getElementById("plots")!;
  const shown = state.keys.map((k) => log.channels.find((c) => c.key === k)).filter((c): c is PrepChannel => !!c).slice(0, 8);
  const anchorIndex = anchor ? laps.findIndex((l) => l.id === anchor.id) : -1;
  type PlotMarker = { t: number; color: string; kind: "brake" | "apex"; lane: number };
  type Drawn = {
    canvas: HTMLCanvasElement;
    wrap: HTMLElement;
    title: string;
    unit: string;
    series: { color: string; samples: Sample[]; scale: number; dash?: boolean }[];
    anchorSamples: Sample[] | null;
    scale: number;
    markers: PlotMarker[];
  };
  const drawn: Drawn[] = [];
  const timeOf = (e: PointerEvent, canvas: HTMLCanvasElement) => {
    const r = canvas.getBoundingClientRect();
    const plotW = r.width - 64;
    if (plotW <= 0) return null;
    const x = Math.min(plotW, Math.max(0, e.clientX - r.left - 52));
    return (x / plotW) * xMax;
  };
  const moveCursor = (t: number) => {
    state.cursor = t;
    const readout = document.getElementById("readout");
    if (readout) {
      readout.replaceChildren();
      const time = document.createElement("div");
      time.className = "readout-time";
      time.textContent = `${t.toFixed(2)} s`;
      readout.appendChild(time);
      for (const p of drawn) {
        const raw = p.anchorSamples ? nearest(p.anchorSamples, t) : NaN;
        const v = raw * p.scale;
        const item = document.createElement("div");
        item.className = "readout-item";
        const name = document.createElement("span");
        name.textContent = p.title;
        const val = document.createElement("b");
        val.textContent = Number.isFinite(v) ? v.toFixed(1) : "—";
        item.append(name, val);
        readout.appendChild(item);
      }
    }
    for (const p of drawn) {
      const raw = p.anchorSamples ? nearest(p.anchorSamples, t) : NaN;
      const v = raw * p.scale;
      const text = Number.isFinite(v) ? v.toFixed(1) : "—";
      draw(p.canvas, p.wrap, p.title, p.unit, p.series, xMax, splitTimes, t, text, p.markers);
    }
    const fraction = anchor ? fractionAtTime(anchor, t) : null;
    redrawDelta(fraction);
    drawTrack(fraction);
    syncChrome(fraction);
  };
  onCursor = moveCursor;
  paintDelta(laps);
  for (const ch of shown) {
    const wrap = document.createElement("div");
    wrap.className = "plot";
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    plots.appendChild(wrap);
    const series = laps.map((lap) => {
      const src = (lap.side === "B" ? state.compare : log)?.channels.find((item) => item.key === ch.key);
      return {
        color: colorOf(lap),
        dash: lap.side === "B",
        samples: src ? downsample(sliceChannel(src.channel, lap.startMs, lap.endMs), 700) : [],
        scale: src?.scale ?? ch.scale,
      };
    });
    const coachTrace = isCoachingChannel(ch) || isSpeedName(ch.key) || isSpeedName(ch.label);
    const plotMarkers: PlotMarker[] = coachTrace
      ? laps.flatMap((lap, lane) =>
          (marksByLap.get(lap.id) ?? []).map((hit) => ({ t: hit.t, color: colorOf(lap), kind: hit.kind, lane })),
        )
      : [];
    const item: Drawn = {
      canvas,
      wrap,
      title: ch.label,
      unit: ch.unit,
      series,
      anchorSamples: anchorIndex >= 0 ? series[anchorIndex]!.samples : null,
      scale: ch.scale,
      markers: plotMarkers,
    };
    drawn.push(item);
    const startValue = state.cursor == null || !item.anchorSamples ? "" : (() => {
      const raw = nearest(item.anchorSamples, state.cursor) * item.scale;
      return Number.isFinite(raw) ? raw.toFixed(1) : "";
    })();
    draw(canvas, wrap, ch.label, ch.unit, series, xMax, splitTimes, state.cursor, startValue, plotMarkers);
    wrap.onpointermove = (e) => {
      const t = timeOf(e, canvas);
      if (t == null) return;
      moveCursor(t);
    };
    wrap.onpointerdown = (e) => {
      const t = timeOf(e, canvas);
      if (t == null) return;
      moveCursor(t);
      if (!state.place || !anchor) return;
      addSplit(fractionAtTime(anchor, t));
      render();
    };
  }
  if (state.cursor != null) moveCursor(state.cursor);
  else {
    drawTrack(null);
    syncChrome(null);
  }

  if (rows.length && session.length) {
    const refIdx = referenceIndex(session);
    const head = `<tr><th>Sector</th><th>Distance</th>${session.map((l) => `<th>${lapName(l)}${session[refIdx]?.id === l.id ? " ref" : ""}</th>`).join("")}<th>Best</th></tr>`;
    const body = rows
      .map((row) => {
        const cells = row.times
          .map((t, i) => {
            const won = i === row.bestIndex;
            let extra = "";
            if (refIdx >= 0 && i !== refIdx && Number.isFinite(t) && Number.isFinite(row.times[refIdx])) {
              const gap = t - row.times[refIdx]!;
              const tone = gap > 0.0005 ? "loss" : gap < -0.0005 ? "gain" : "";
              const word = gap > 0.0005 ? "behind" : gap < -0.0005 ? "ahead" : "level";
              extra = `<span class="d ${tone}">${formatSigned(gap)} ${word}</span>`;
            }
            return `<td class="${won ? "best" : ""}">${formatLap(t)}${extra}</td>`;
          })
          .join("");
        return `<tr class="${row.kind}"><td>${esc(sectorLabel(row))}</td><td>${distanceText(row)}</td>${cells}<td class="best">${nameOfId(session[row.bestIndex]!.id)} ${formatLap(row.best)}</td></tr>`;
      })
      .join("");
    const foot = `<tr class="foot"><td colspan="2">Theoretical best</td>${session.map((l) => `<td>${formatLap(l.duration)}</td>`).join("")}<td class="best">${formatLap(ideal)}</td></tr>`;
    document.getElementById("table")!.innerHTML = `<table>${head}${body}${foot}</table>`;
  }

  if (state.grok) {
    document.getElementById("grok-close")!.onclick = () => {
      state.grok = false;
      render();
    };
    document.getElementById("grok-send")!.onclick = () => {
      const q = (document.getElementById("grok-q") as HTMLTextAreaElement).value.trim();
      if (!q || grokBusy) return;
      void askGrok(q);
    };
    document.getElementById("grok-brief")!.onclick = () => {
      if (grokBusy) return;
      grokChat.length = 0;
      void askGrok("Read this session. The checked channels include throttle, fork and shock, with min/avg/max per lap and per sector. Give the theoretical best, which lap owns each sector, and what those channel numbers show.");
    };
    document.getElementById("grok-copy")!.onclick = async () => {
      try {
        await navigator.clipboard.writeText(sessionBrief());
        grokChat.push({ role: "assistant", content: "Session brief copied. Paste it into the Grok chat if you are not using an API key." });
      } catch {
        grokChat.push({ role: "assistant", content: sessionBrief() });
      }
      render();
    };
  }
}

function draw(
  canvas: HTMLCanvasElement,
  wrap: HTMLElement,
  title: string,
  unit: string,
  series: { color: string; samples: Sample[]; scale: number; dash?: boolean }[],
  xMax: number,
  splitTimes: number[],
  cursor: number | null,
  cursorText: string,
  markers: { t: number; color: string; kind: "brake" | "apex"; lane: number }[] = [],
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = wrap.clientWidth || 800;
  const height = 160;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const bw = Math.floor(width * dpr);
  const bh = Math.floor(height * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = "100%";
  canvas.style.height = height + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pad = { l: 52, r: 12, t: 22, b: 22 };
  const plotW = Math.max(1, width - pad.l - pad.r);
  const plotH = Math.max(1, height - pad.t - pad.b);
  ctx.fillStyle = "#181b1f";
  ctx.fillRect(0, 0, width, height);
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const line of series) {
    for (const p of line.samples) {
      const y = p.v * line.scale;
      if (!Number.isFinite(y)) continue;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  if (!Number.isFinite(yMin)) {
    yMin = 0;
    yMax = 1;
  }
  if (yMax - yMin < 1e-6) {
    yMin -= 1;
    yMax += 1;
  }
  const padY = (yMax - yMin) * 0.08;
  yMin -= padY;
  yMax += padY;
  const xOf = (t: number) => pad.l + (t / Math.max(xMax, 0.001)) * plotW;
  const yOf = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  ctx.strokeStyle = "#2a3036";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillStyle = "#8e98a3";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(yMax - ((yMax - yMin) * i) / 4)), 4, y + 3);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, plotW, plotH);
  ctx.clip();
  for (const line of series) {
    ctx.beginPath();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 1.6;
    let started = false;
    for (const p of line.samples) {
      const y = p.v * line.scale;
      if (!Number.isFinite(y)) continue;
      const x = xOf(p.t);
      const yy = yOf(y);
      if (!started) {
        ctx.moveTo(x, yy);
        started = true;
      } else ctx.lineTo(x, yy);
    }
    ctx.setLineDash(line.dash ? [5, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = "#f0c14d";
  for (const t of splitTimes) {
    const x = xOf(t);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const marker of markers) {
    const x = xOf(marker.t);
    if (x < pad.l || x > width - pad.r) continue;
    const y = pad.t + 7 + marker.lane * 8;
    ctx.fillStyle = marker.color;
    ctx.beginPath();
    if (marker.kind === "brake") {
      ctx.moveTo(x, y + 6);
      ctx.lineTo(x - 4, y - 2);
      ctx.lineTo(x + 4, y - 2);
    } else {
      ctx.moveTo(x, y - 4);
      ctx.lineTo(x + 4, y);
      ctx.lineTo(x, y + 4);
      ctx.lineTo(x - 4, y);
    }
    ctx.fill();
  }
  if (cursor != null) {
    const x = xOf(cursor);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
    if (cursorText) {
      const label = unit ? `${cursorText} ${unit}` : cursorText;
      ctx.font = "600 12px ui-monospace, monospace";
      const tw = ctx.measureText(label).width + 10;
      const lx = x + tw + 8 > width - pad.r ? x - tw - 4 : x + 4;
      const ly = pad.t + 4;
      ctx.fillStyle = "#101214";
      ctx.fillRect(lx, ly, tw, 16);
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(lx, ly, tw, 16);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, lx + 5, ly + 12);
    }
  }
  ctx.fillStyle = "#e7ebef";
  ctx.font = "600 12px sans-serif";
  ctx.fillText(unit ? `${title}  ·  ${unit}` : title, pad.l, 14);
}

function drawDelta(
  canvas: HTMLCanvasElement,
  wrap: HTMLElement,
  series: { name: string; color: string; dash?: boolean; points: { metres: number; delta: number }[] }[],
  metresMax: number,
  bands: { from: number; to: number }[],
  cursorMetres: number | null = null,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = wrap.clientWidth || 800;
  const height = 210;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = "100%";
  canvas.style.height = height + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pad = { l: 52, r: 12, t: 22, b: 26 };
  const plotW = Math.max(1, width - pad.l - pad.r);
  const plotH = Math.max(1, height - pad.t - pad.b);
  ctx.fillStyle = "#181b1f";
  ctx.fillRect(0, 0, width, height);
  let yMin = 0;
  let yMax = 0;
  for (const line of series) {
    for (const point of line.points) {
      if (point.delta < yMin) yMin = point.delta;
      if (point.delta > yMax) yMax = point.delta;
    }
  }
  if (yMax - yMin < 0.05) {
    yMin -= 0.05;
    yMax += 0.05;
  }
  const slack = (yMax - yMin) * 0.12;
  yMin -= slack;
  yMax += slack;
  const xOf = (metres: number) => pad.l + (metres / Math.max(metresMax, 1)) * plotW;
  const yOf = (value: number) => pad.t + (1 - (value - yMin) / (yMax - yMin)) * plotH;
  ctx.fillStyle = "rgba(232,93,4,0.10)";
  for (const band of bands) {
    const x0 = xOf(band.from);
    const x1 = xOf(band.to);
    ctx.fillRect(x0, pad.t, Math.max(1, x1 - x0), plotH);
  }
  ctx.strokeStyle = "#2a3036";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillStyle = "#8e98a3";
  for (let i = 0; i <= 4; i++) {
    const value = yMax - ((yMax - yMin) * i) / 4;
    const y = pad.t + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    ctx.fillText(value.toFixed(2), 4, y + 3);
  }
  const primary = series[0];
  if (primary) {
    for (let i = 1; i < primary.points.length; i++) {
      const left = primary.points[i - 1]!;
      const right = primary.points[i]!;
      const pieces: [{ metres: number; delta: number }, { metres: number; delta: number }][] = [];
      if (left.delta * right.delta < 0) {
        const u = left.delta / (left.delta - right.delta);
        const cross = { metres: left.metres + u * (right.metres - left.metres), delta: 0 };
        pieces.push([left, cross], [cross, right]);
      } else pieces.push([left, right]);
      for (const [a, b] of pieces) {
        ctx.fillStyle = a.delta + b.delta >= 0 ? "rgba(251,113,133,0.28)" : "rgba(61,220,151,0.28)";
        ctx.beginPath();
        ctx.moveTo(xOf(a.metres), yOf(a.delta));
        ctx.lineTo(xOf(b.metres), yOf(b.delta));
        ctx.lineTo(xOf(b.metres), yOf(0));
        ctx.lineTo(xOf(a.metres), yOf(0));
        ctx.fill();
      }
    }
  }
  ctx.strokeStyle = "#f0c14d";
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(pad.l, yOf(0));
  ctx.lineTo(width - pad.r, yOf(0));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#8e98a3";
  ctx.font = "11px sans-serif";
  ctx.fillText("behind", pad.l + 6, yOf(0) - 6);
  ctx.fillText("ahead", pad.l + 6, yOf(0) + 14);
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, plotW, plotH);
  ctx.clip();
  for (const line of series) {
    ctx.beginPath();
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 1.8;
    ctx.setLineDash(line.dash ? [5, 3] : []);
    let started = false;
    for (const point of line.points) {
      const x = xOf(point.metres);
      const y = yOf(point.delta);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.setLineDash([]);
  if (cursorMetres != null) {
    const x = xOf(cursorMetres);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
  }
  ctx.fillStyle = "#e7ebef";
  ctx.font = "600 12px sans-serif";
  ctx.fillText("Time delta  ·  s", pad.l, 14);
  ctx.fillStyle = "#8e98a3";
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillText("0 m", pad.l, height - 8);
  const end = `${Math.round(metresMax)} m`;
  ctx.fillText(end, width - pad.r - ctx.measureText(end).width, height - 8);
}

type DeltaView = {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  series: { name: string; color: string; dash?: boolean; points: { metres: number; delta: number }[] }[];
  metresMax: number;
  bands: { from: number; to: number }[];
};
let deltaView: DeltaView | null = null;

function redrawDelta(fraction: number | null) {
  if (!deltaView) return;
  drawDelta(
    deltaView.canvas,
    deltaView.host,
    deltaView.series,
    deltaView.metresMax,
    deltaView.bands,
    fraction == null ? null : fraction * deltaView.metresMax,
  );
}

function paintDelta(drawnLaps: LapProfile[]) {
  const host = document.getElementById("delta");
  if (!host) return;
  const pair = reviewPair();
  if (!pair || !drawnLaps.length) {
    deltaView = null;
    host.innerHTML = `<p class="hint">Check two laps, or one lap, to plot time gained and lost against the reference.</p>`;
    return;
  }
  const ref = pair.ref;
  const compares = pair.laps;
  const canvas = document.createElement("canvas");
  host.replaceChildren(canvas);
  const series = compares.map((lap) => ({
    name: lapName(lap),
    color: colorOf(lap),
    dash: lap.side === "B",
    points: deltaVsDistance(ref, lap, 280),
  }));
  const bands = state.spans
    .filter((span) => span.kind === "corner")
    .map((span) => ({ from: span.from * ref.total, to: span.to * ref.total }));
  deltaView = { canvas, host, series, metresMax: ref.total, bands };
  const fraction = cursorFraction();
  drawDelta(canvas, host, series, ref.total, bands, fraction == null ? null : fraction * ref.total);
  host.onpointermove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const plotW = rect.width - 64;
    if (plotW <= 0) return;
    const x = Math.min(plotW, Math.max(0, event.clientX - rect.left - 52));
    seekDistance(plotW > 0 ? x / plotW : 0);
  };
}

let onCursor: (time: number) => void = (time) => {
  state.cursor = time;
};

function cursorFraction(): number | null {
  if (state.cursor == null) return null;
  const anchor = anchorLap();
  if (!anchor) return null;
  return fractionAtTime(anchor, state.cursor);
}

function seekDistance(fraction: number) {
  const anchor = anchorLap();
  if (!anchor || !Number.isFinite(fraction)) return;
  onCursor(timeAtFraction(anchor, Math.min(1, Math.max(0, fraction))));
}

function mapLaps(): LapProfile[] {
  const selected = chosen();
  const pair = reviewPair();
  const list = [...selected];
  if (pair && !list.some((lap) => lap.id === pair.ref.id)) list.unshift(pair.ref);
  return list;
}

function trackCaption(fraction: number | null): string {
  const drawn = mapLaps().filter((lap) => lap.path.length > 1);
  if (!drawn.length) return "No GPS latitude/longitude for the laps on the graph, so the map stays empty.";
  const anchor = anchorLap();
  if (fraction == null || !anchor) return "Hover a graph, the delta plot, or the split bar. Drag the map to move the cursor.";
  const ruler = reviewPair()?.ref ?? anchor;
  const metres = fraction * ruler.total;
  const span = state.spans.find((item) => fraction >= item.from && fraction <= item.to);
  const where = span ? sectorLabel(span) : "";
  return `${Math.round(metres).toLocaleString("en-US")} m along ${lapName(ruler)}${where ? ` · ${where}` : ""}`;
}

function syncChrome(fraction: number | null) {
  const legend = document.getElementById("delta-legend");
  const caption = document.getElementById("track-caption");
  const pair = reviewPair();
  if (legend) {
    if (!pair) {
      legend.textContent = "Check two laps, or one lap, to plot time gained and lost against the reference.";
    } else if (fraction == null) {
      const intro = pair.implicit
        ? `Reference is ${lapName(pair.ref)}, the best other full lap. ${pair.laps.map(lapName).join(", ")} is the lap being reviewed.`
        : `Reference is ${lapName(pair.ref)}. Comparing ${pair.laps.map(lapName).join(", ")}.`;
      legend.textContent = `${intro} Positive is behind the reference (lost time). Negative is ahead of the reference (gained time). Shaded bands are the named corners.`;
    } else {
      const metres = fraction * pair.ref.total;
      const bits = pair.laps.map((lap) => {
        const gap = timeAtFraction(lap, fraction) - timeAtFraction(pair.ref, fraction);
        const word = gap > 0.0005 ? "behind" : gap < -0.0005 ? "ahead" : "level";
        return `${lapName(lap)} ${formatSigned(gap)} s ${word}`;
      });
      legend.textContent = `${Math.round(metres)} m along ${lapName(pair.ref)} · ${bits.join(" · ")}. Positive is behind. Negative is ahead.`;
    }
  }
  if (caption) caption.textContent = trackCaption(fraction);
}

type ScreenPt = { x: number; y: number; d: number };
type MapPath = { lap: LapProfile; pts: ScreenPt[] };
type MapFrame = { paths: MapPath[]; width: number; height: number };
let mapFrame: MapFrame | null = null;

function closestFraction(frame: MapFrame, x: number, y: number): number | null {
  let best = 36 * 36;
  let fraction: number | null = null;
  for (const path of frame.paths) {
    const total = path.lap.total;
    if (total <= 0) continue;
    const pts = path.pts;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let u = len2 > 1e-6 ? ((x - a.x) * dx + (y - a.y) * dy) / len2 : 0;
      if (u < 0) u = 0;
      else if (u > 1) u = 1;
      const px = a.x + u * dx;
      const py = a.y + u * dy;
      const dist2 = (px - x) ** 2 + (py - y) ** 2;
      if (dist2 < best) {
        best = dist2;
        fraction = (a.d + u * (b.d - a.d)) / total;
      }
    }
  }
  return fraction;
}

function drawDot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, radius: number) {
  ctx.beginPath();
  ctx.fillStyle = "#ffffff";
  ctx.arc(x, y, radius + 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawTrack(fraction: number | null) {
  const host = document.getElementById("track");
  if (!host) return;
  let canvas = host.querySelector("canvas");
  if (!canvas) {
    canvas = document.createElement("canvas");
    host.replaceChildren(canvas);
    const seek = (event: PointerEvent) => {
      if (!mapFrame || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const hit = closestFraction(mapFrame, event.clientX - rect.left, event.clientY - rect.top);
      if (hit == null) return;
      seekDistance(hit);
    };
    canvas.onpointerdown = (event) => {
      canvas!.setPointerCapture(event.pointerId);
      seek(event);
    };
    canvas.onpointermove = (event) => {
      if ((event.buttons & 1) === 0) return;
      seek(event);
    };
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = host.clientWidth || 320;
  const height = host.clientHeight || 280;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#181b1f";
  ctx.fillRect(0, 0, width, height);

  const laps = mapLaps().filter((lap) => lap.path.length > 1);
  if (!laps.length) {
    mapFrame = null;
    ctx.fillStyle = "#8e98a3";
    ctx.font = "13px sans-serif";
    ctx.fillText("No GPS path for the selected laps.", 16, 28);
    return;
  }

  let latSum = 0;
  let lonSum = 0;
  let count = 0;
  for (const lap of laps) {
    for (const fix of lap.path) {
      latSum += fix.lat;
      lonSum += fix.lon;
      count += 1;
    }
  }
  const lat0 = latSum / count;
  const lon0 = lonSum / count;
  const mLat = 111320;
  const mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const lap of laps) {
    for (const fix of lap.path) {
      const x = (fix.lon - lon0) * mLon;
      const y = (fix.lat - lat0) * mLat;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const pad = 34;
  const worldW = Math.max(maxX - minX, 1);
  const worldH = Math.max(maxY - minY, 1);
  const plotW = Math.max(1, width - pad * 2);
  const plotH = Math.max(1, height - pad * 2);
  const scale = Math.min(plotW / worldW, plotH / worldH);
  const ox = pad + (plotW - worldW * scale) / 2;
  const oy = pad + (plotH - worldH * scale) / 2;
  const screen = (fix: GpsFix): ScreenPt => ({
    x: ox + ((fix.lon - lon0) * mLon - minX) * scale,
    y: oy + (maxY - (fix.lat - lat0) * mLat) * scale,
    d: fix.d,
  });
  const paths: MapPath[] = laps.map((lap) => ({ lap, pts: lap.path.map(screen) }));
  mapFrame = { paths, width, height };

  const anchor = anchorLap();
  const pair = reviewPair();
  const ordered = [...paths].sort((a, b) => {
    const rank = (lap: LapProfile) => (anchor && lap.id === anchor.id ? 2 : pair && lap.id === pair.ref.id ? 0 : 1);
    return rank(a.lap) - rank(b.lap);
  });
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const path of ordered) {
    const active = anchor?.id === path.lap.id;
    const referenceOnly = pair?.ref.id === path.lap.id && !active;
    ctx.beginPath();
    ctx.strokeStyle = colorOf(path.lap);
    ctx.globalAlpha = active ? 1 : 0.82;
    ctx.lineWidth = active ? 2.8 : 1.8;
    ctx.setLineDash(path.lap.side === "B" || referenceOnly ? [6, 4] : []);
    path.pts.forEach((pt, index) => {
      if (index === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  const labelHost = paths.find((path) => path.lap.id === anchor?.id) ?? paths[0]!;
  let cx = 0;
  let cy = 0;
  for (const pt of labelHost.pts) {
    cx += pt.x;
    cy += pt.y;
  }
  cx /= labelHost.pts.length;
  cy /= labelHost.pts.length;
  const placeLabel = (x: number, y: number, text: string) => {
    const vx = x - cx;
    const vy = y - cy;
    const len = Math.hypot(vx, vy) || 1;
    const lx = Math.min(width - 16, Math.max(16, x + (vx / len) * 15));
    const ly = Math.min(height - 12, Math.max(12, y + (vy / len) * 15));
    ctx.font = "600 11px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#101214";
    ctx.strokeText(text, lx, ly);
    ctx.fillStyle = "#f0c14d";
    ctx.fillText(text, lx, ly);
  };
  const start = labelHost.pts[0];
  if (start) {
    ctx.fillStyle = "#e7ebef";
    ctx.fillRect(start.x - 3.5, start.y - 3.5, 7, 7);
    placeLabel(start.x, start.y, "S/F");
  }
  if (state.templateId === "zic") {
    for (const span of state.spans) {
      if (span.kind !== "corner") continue;
      const at = span.apex ?? (span.from + span.to) / 2;
      const fix = fixAtMetres(labelHost.lap.path, at * labelHost.lap.total);
      if (!fix) continue;
      const pt = screen(fix);
      ctx.fillStyle = "#f0c14d";
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      placeLabel(pt.x, pt.y, span.label);
    }
  }

  if (fraction == null) return;
  const markerAt = (lap: LapProfile) => {
    const fix = fixAtMetres(lap.path, fraction * lap.total);
    return fix ? screen(fix) : null;
  };
  for (const path of ordered) {
    if (anchor && path.lap.id === anchor.id) continue;
    const pt = markerAt(path.lap);
    if (!pt) continue;
    ctx.beginPath();
    ctx.strokeStyle = "#101214";
    ctx.lineWidth = 4;
    ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = colorOf(path.lap);
    ctx.lineWidth = 2;
    ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (anchor) {
    const pt = markerAt(anchor);
    if (pt) {
      const aheadFix = fixAtMetres(anchor.path, Math.min(anchor.total, fraction * anchor.total + Math.max(12, anchor.total * 0.012)));
      if (aheadFix && anchor.path.length) {
        const tip = screen(aheadFix);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
      }
      drawDot(ctx, pt.x, pt.y, colorOf(anchor), 4.5);
    }
  }
}

function exportLaps(): LapProfile[] {
  const pair = reviewPair();
  if (pair) return [pair.ref, ...pair.laps.filter((lap) => lap.id !== pair.ref.id)].slice(0, 4);
  const session = comparedLaps();
  if (!session.length) return chosen().slice(0, 4);
  const ref = fastest(session);
  return [ref, ...session.filter((lap) => lap.id !== ref.id)].slice(0, 4);
}

function channelChart(laps: LapProfile[], key: string | undefined): NoteChart | null {
  if (!key || !laps.length) return null;
  const xMax = Math.max(...laps.map((lap) => lap.duration), 1);
  let title = "";
  let unit = "";
  const series = laps.flatMap((lap) => {
    const channel = lapChannel(lap, key);
    if (!channel) return [];
    title = title || channel.label;
    unit = unit || channel.unit;
    const samples = downsample(sliceChannel(channel.channel, lap.startMs, lap.endMs), 420);
    return [
      {
        name: lapName(lap),
        color: colorOf(lap),
        dash: lap.side === "B",
        points: samples.map((sample) => ({ x: sample.t, y: sample.v * channel.scale })),
      },
    ];
  });
  if (!series.length) return null;
  const marks = markerMap(laps);
  return {
    title,
    unit,
    xLabel: `${xMax.toFixed(0)} s`,
    xMax,
    series,
    markers: laps.flatMap((lap, lane) =>
      (marks.get(lap.id) ?? []).map((hit) => ({ x: hit.t, color: colorOf(lap), kind: hit.kind, lane })),
    ),
  };
}

async function exportNote(kind: "png" | "pdf") {
  const log = state.log;
  if (!log) return;
  const laps = exportLaps();
  if (!laps.length) {
    alert("Open a session with at least one lap first.");
    return;
  }
  const ref = laps[0]!;
  const compare = laps[1];
  const allRows = sectorTableFromSpans(laps, state.spans);
  const tableRows = allRows.some((row) => row.kind === "corner") ? allRows.filter((row) => row.kind === "corner") : allRows;
  const word = (gap: number) => (gap > 0.0005 ? "behind" : gap < -0.0005 ? "ahead" : "level");
  const tone = (gap: number): "gain" | "loss" | "plain" => (gap > 0.0005 ? "loss" : gap < -0.0005 ? "gain" : "plain");
  const sessionRows = sectors();
  const ideal =
    sessionRows.length && sessionRows.every((row) => Number.isFinite(row.best)) ? formatLap(idealSeconds(sessionRows)) : "";
  const losses = compare ? topSectorLosses(allRows, 0, 1, 3) : [];
  const coach = coachingChannelKeys(log.channels);
  const charts: NoteChart[] = [];
  const missing = [coach.brake ? "" : "brake", coach.throttle ? "" : "throttle", coach.lean ? "" : "lean"].filter(Boolean);
  if (compare) {
    charts.push({
      title: `Time delta vs ${lapName(ref)}`,
      unit: "s",
      xLabel: `${Math.round(ref.total)} m`,
      xMax: ref.total,
      zeroLine: true,
      fillToZero: true,
      bands: state.spans
        .filter((span) => span.kind === "corner")
        .map((span) => ({ from: span.from * ref.total, to: span.to * ref.total, label: span.label })),
      series: laps.slice(1).map((lap) => ({
        name: lapName(lap),
        color: colorOf(lap),
        dash: lap.side === "B",
        points: deltaVsDistance(ref, lap, 300).map((point) => ({ x: point.metres, y: point.delta })),
      })),
    });
  }
  for (const key of [coach.brake, coach.throttle, coach.lean]) {
    const chart = channelChart(laps, key);
    if (chart) charts.push(chart);
  }
  if (charts.length < 3) {
    const speed = channelChart(laps, coach.speed);
    if (speed) charts.push(speed);
  }
  const note: CoachingNote = {
    track: log.track,
    rider: log.rider,
    vehicle: log.vehicle,
    fileName: state.compare ? `${log.fileName} vs ${state.compare.fileName}` : log.fileName,
    when: log.when,
    template: templateLabel(),
    ideal,
    laps: laps.map((lap, index) => {
      const gap = lap.duration - ref.duration;
      return {
        name: lapName(lap),
        time: formatLap(lap.duration),
        color: colorOf(lap),
        role: index === 0 ? "Reference" : `${formatSigned(gap)} s ${word(gap)} on the full lap`,
      };
    }),
    sectorHeaders: laps.map((lap, index) => (index === 0 ? `${lapName(lap)} ref` : lapName(lap))),
    sectors: tableRows.map((row) => ({
      label: sectorLabel(row),
      distance: distanceText(row),
      cells: row.times.map((time, index) => {
        if (index === 0) return { text: formatLap(time), delta: "", tone: "ref" as const };
        const gap = time - row.times[0]!;
        return { text: formatLap(time), delta: `${formatSigned(gap)} ${word(gap)}`, tone: tone(gap) };
      }),
    })),
    lossesTitle: compare ? `Top time lost by ${lapName(compare)} vs ${lapName(ref)}` : "Top time lost",
    losses: losses.map((item) => ({
      label: sectorLabel(item.row),
      text: `${formatSigned(item.delta)} s behind`,
    })),
    emptyLosses: compare ? `${lapName(compare)} is ahead in every sector versus ${lapName(ref)}.` : "Select a second lap to list sector losses.",
    convention: `Positive time is behind the reference (lost time). Negative time is ahead of the reference (gained time). Corner bands sit on the delta chart.${missing.length ? ` This session has no ${listWords(missing)} channel.` : ""}`,
    charts,
  };
  try {
    await downloadCoachingNote(note, kind, safeStem(`${log.track}-${log.fileName}-coaching-note`));
  } catch (err) {
    alert(err instanceof Error ? err.message : "Could not export the coaching note.");
  }
}

const BCOLORS = ["#7dd3fc", "#c4b5fd", "#fb7185", "#fde68a", "#86efac", "#e2e8f0", "#67e8f9", "#f9a8d4"];
function colorOf(lap: LapProfile) {
  const list = lap.side === "B" ? state.compare?.laps : state.log?.laps;
  const index = Math.max(0, list?.findIndex((item) => item.id === lap.id) ?? 0);
  return lap.side === "B" ? BCOLORS[index % BCOLORS.length]! : lapColor(index);
}

const picker = document.createElement("input");
picker.type = "file";
picker.accept = ".xrk,.xrz,.vbo";
picker.style.display = "none";
document.body.appendChild(picker);
let pickTarget: "A" | "B" = "A";
picker.onchange = async () => {
  const file = picker.files?.[0];
  const target = pickTarget;
  pickTarget = "A";
  picker.value = "";
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const parsed = file.name.toLowerCase().endsWith(".vbo")
      ? parseVbo(new TextDecoder().decode(buf), file.name)
      : parseXrk(new Uint8Array(buf));
    const prepared = prepare(parsed, file.name, target);
    if (!prepared.laps.length) {
      alert("No laps with a usable distance trace were found.");
      return;
    }
    const quick = fastest(prepared.laps).duration;
    const flying = prepared.laps.filter((l) => l.duration < quick * 1.12);
    const ids = (flying.length ? flying : prepared.laps).map((l) => l.id);
    if (target === "B") {
      state.compare = prepared;
      state.laps = [...state.laps.filter((id) => id.startsWith("A")), ...ids];
      render();
      return;
    }
    state.log = prepared;
    state.compare = null;
    const coachKeys = coachingChannelKeys(prepared.channels);
    const defaults = [coachKeys.brake, coachKeys.throttle, coachKeys.lean].filter((key): key is string => !!key);
    state.keys = defaults.length ? defaults : prepared.channels.slice(0, 3).map((channel) => channel.key);
    state.laps = ids;
    state.anchor = fastest(flying.length ? flying : prepared.laps).id;
    const saved = parseSplitDocument(localStorage.getItem("lap-splits:" + prepared.track));
    state.spans = [];
    state.templateId = "manual";
    state.lapLengthM = rulerLength();
    if (saved) {
      state.spans = saved.spans;
      state.templateId = saved.templateId;
      state.lapLengthM = saved.lapLengthM || state.lapLengthM;
    } else if (/zhuhai|\bzic\b/i.test(`${prepared.track} ${prepared.fileName}`)) {
      applyTemplateId("zic");
    }
    render();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Could not read that file.");
  }
};

function pick() {
  picker.click();
}

render();
