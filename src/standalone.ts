import { parseXrk, type XrkChannel, type XrkLog } from "aim-xrk";

type Sample = { t: number; v: number };
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
};
type PrepChannel = { key: string; label: string; unit: string; scale: number; channel: XrkChannel };
type Prepared = {
  fileName: string;
  vehicle: string;
  track: string;
  channels: PrepChannel[];
  laps: LapProfile[];
  distanceNote: string;
};

const COLORS = ["#e85d04", "#f0c14d", "#3ddc97", "#5eb1ff", "#c084fc", "#fb7185", "#94a3b8", "#f97316"];
const lapColor = (i: number) => COLORS[i % COLORS.length]!;

function formatLap(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "−" : "";
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = (abs - m * 60).toFixed(3).padStart(6, "0");
  return m > 0 ? `${sign}${m}:${s}` : `${sign}${s}`;
}

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
  return { num, startMs, endMs, duration, times, dist, total, source, side: "A", id: `A${num}` };
}

function profileFromGps(num: number, startMs: number, endMs: number, duration: number, lat: Sample[], lon: Sample[]) {
  const n = Math.min(lat.length, lon.length);
  const times: number[] = [];
  const dist: number[] = [];
  let acc = 0;
  let prevLat = 0;
  let prevLon = 0;
  let has = false;
  for (let i = 0; i < n; i++) {
    const la = lat[i]!.v;
    const lo = lon[i]!.v;
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
    if (Math.abs(la) < 0.01 && Math.abs(lo) < 0.01) continue;
    if (has) {
      const step = haversine(prevLat, prevLon, la, lo);
      if (step > 80) continue;
      acc += step;
    }
    times.push(lat[i]!.t);
    dist.push(acc);
    prevLat = la;
    prevLon = lo;
    has = true;
  }
  return profileFromPoints(num, startMs, endMs, duration, times, dist, "gps");
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
  return {
    fileName,
    vehicle: String(meta.Vehicle ?? "—"),
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

function timeAtFraction(p: LapProfile, fraction: number) {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return p.duration;
  const target = fraction * p.total;
  let lo = 0;
  let hi = p.dist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.dist[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return p.times[0] ?? 0;
  const span = p.dist[lo]! - p.dist[lo - 1]!;
  const u = span > 1e-6 ? (target - p.dist[lo - 1]!) / span : 0;
  return p.times[lo - 1]! + u * (p.times[lo]! - p.times[lo - 1]!);
}

function fractionAtTime(p: LapProfile, timeSec: number) {
  if (timeSec <= 0 || p.total <= 0) return 0;
  if (timeSec >= p.duration) return 1;
  let lo = 0;
  let hi = p.times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.times[mid]! < timeSec) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  const span = p.times[lo]! - p.times[lo - 1]!;
  const u = span > 1e-6 ? (timeSec - p.times[lo - 1]!) / span : 0;
  const d = p.dist[lo - 1]! + u * (p.dist[lo]! - p.dist[lo - 1]!);
  return Math.min(1, Math.max(0, d / p.total));
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

function downsample(samples: Sample[], maxPoints: number) {
  if (samples.length <= maxPoints) return samples;
  const step = samples.length / maxPoints;
  const out: Sample[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(samples[Math.floor(i * step)]!);
  const last = samples[samples.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

type State = {
  log: Prepared | null;
  compare: Prepared | null;
  keys: string[];
  laps: string[];
  anchor: string | null;
  splits: number[];
  place: boolean;
  cursor: number | null;
  equal: number;
  drag: number | null;
  grok: boolean;
  pairs: Record<string, string>;
};

const state: State = { log: null, compare: null, keys: [], laps: [], anchor: null, splits: [], place: false, cursor: null, equal: 4, drag: null, grok: false, pairs: {} };

type GrokMsg = { role: "user" | "assistant"; content: string };
const grokChat: GrokMsg[] = [];
let grokBusy = false;
let channelQuery = "";

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

function normName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function autoPairs(primary: Prepared, other: Prepared) {
  const pairs: Record<string, string> = {};
  for (const ch of primary.channels) {
    const hit = other.channels.find((item) => item.key === ch.key || normName(item.key) === normName(ch.key) || normName(item.label) === normName(ch.label));
    if (hit) pairs[ch.key] = hit.key;
  }
  return pairs;
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

function sectors() {
  const laps = comparedLaps();
  if (!state.splits.length || !laps.length) return [];
  const bounds = [0, ...[...state.splits].sort((a, b) => a - b), 1];
  const rows = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const from = bounds[s]!;
    const to = bounds[s + 1]!;
    const times = laps.map((lap) => timeAtFraction(lap, to) - timeAtFraction(lap, from));
    let best = Infinity;
    let bestLap = laps[0]!.id;
    times.forEach((t, i) => {
      if (t > 0.05 && t < best) {
        best = t;
        bestLap = laps[i]!.id;
      }
    });
    rows.push({ index: s + 1, from, to, times, best, bestLap });
  }
  return rows;
}

function addSplit(fraction: number) {
  if (fraction <= 0.015 || fraction >= 0.985) return;
  if (state.splits.some((s) => Math.abs(s - fraction) < 0.012)) return;
  state.splits = [...state.splits, fraction].sort((a, b) => a - b);
  saveSplits();
}

function saveSplits() {
  if (!state.log) return;
  localStorage.setItem("lap-splits:" + state.log.track, JSON.stringify(state.splits));
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
    lines.push(`Theoretical best: ${formatLap(ideal)}`);
    for (const row of rows) {
      const each = laps.map((l, i) => `${lapName(l)} ${formatLap(row.times[i]!)}`).join(", ");
      lines.push(`S${row.index} ${(row.from * 100).toFixed(0)}-${(row.to * 100).toFixed(0)}% best ${formatLap(row.best)} from ${nameOfId(row.bestLap)}. ${each}`);
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
      <main class="empty"><h2>Sectors, then the ideal lap</h2>
      <p>Open an AIM .xrk or a Dragy .vbo. Drop splits along the lap, and the ideal time is the sum of the fastest pass through each sector.</p>
      <button id="open2">Choose a file</button></main>`;
    document.getElementById("open")!.onclick = pick;
    document.getElementById("open2")!.onclick = pick;
    return;
  }
  const laps = chosen();
  const session = comparedLaps();
  const anchor = anchorLap();
  const rows = sectors();
  const ideal = rows.length && rows.every((r) => Number.isFinite(r.best)) ? rows.reduce((s, r) => s + r.best, 0) : NaN;
  const bestActual = session.length ? Math.min(...session.map((l) => l.duration)) : NaN;
  const delta = ideal - bestActual;
  const makeup = rows.map((r) => `S${r.index} ${formatLap(r.best)} from ${nameOfId(r.bestLap)}`).join("  +  ");
  const skipped = everyLap().length - session.length;
  const deltaText = !rows.length ? "Add at least one split" : !Number.isFinite(delta) ? "" : delta < -0.0005 ? `${formatLap(delta)} vs best lap` : delta > 0.0005 ? `+${formatLap(delta)} vs best lap` : "matches the best lap";

  app.innerHTML = `
    <header class="bar">
      <h1>Sim Motorsport Data</h1>
      <button id="open">Open file</button>
      <button id="compare">${state.compare ? "Remove compare" : "Compare file"}</button>
      <button id="grok">Grok</button>
      <span class="meta">${log.fileName}${state.compare ? " vs " + state.compare.fileName : ""} · ${log.vehicle} · ${log.track}</span>
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
              <button id="place" class="${state.place ? "on" : ""}">${state.place ? "Click a graph to drop a split" : "Place on graph"}</button>
              <label>Equal <input id="equal" type="number" min="2" max="12" value="${state.equal}"></label>
              <button id="divide">Divide lap</button>
              <button id="clear">Clear</button>
            </div>
          </div>
          <p class="sub">${log.distanceNote}</p>
          <div id="bar" class="splitbar"></div>
          <div id="chips" class="chips"></div>
          <p class="hint">${state.compare ? "On each channel, choose the matching sensor from the other bike. The graphs use distance, so the same corner lines up. File B is dashed." : "Click the bar to add a split. Drag a marker to move it. The theoretical best uses every full lap in this session, not only the laps drawn on the graph."}</p>
          <div id="table"></div>
        </section>
        <p id="readout" class="readout"><span class="hint">Move across a graph. Channel values line up here.</span></p>
        <div id="plots"></div>
      </main>
    </div>
    ${state.grok ? grokPanel() : ""}`;

  document.getElementById("open")!.onclick = pick;
  document.getElementById("compare")!.onclick = () => {
    if (state.compare) {
      state.compare = null;
      state.pairs = {};
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
  document.getElementById("divide")!.onclick = () => {
    const n = Math.max(2, Math.min(12, state.equal));
    state.splits = [];
    for (let i = 1; i < n; i++) state.splits.push(i / n);
    saveSplits();
    render();
  };
  document.getElementById("clear")!.onclick = () => {
    state.splits = [];
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
    if (state.compare) {
      const sel = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "Other bike…";
      sel.appendChild(blank);
      for (const other of state.compare.channels) {
        const opt = document.createElement("option");
        opt.value = other.key;
        opt.textContent = other.label;
        if ((state.pairs[ch.key] ?? "") === other.key) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => {
        if (sel.value) state.pairs[ch.key] = sel.value;
        else delete state.pairs[ch.key];
        render();
      };
      label.appendChild(sel);
    }
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
  const sorted = [...state.splits].sort((a, b) => a - b);
  bar.innerHTML = `<div class="track"></div>` + sorted.map((f, i) => `<div class="mark" style="left:${f * 100}%"><b></b><span>${i + 1}</span></div>`).join("");
  const fracOf = (e: PointerEvent) => {
    const r = bar.getBoundingClientRect();
    return Math.min(0.99, Math.max(0.01, (e.clientX - r.left) / Math.max(r.width, 1)));
  };
  bar.onpointerdown = (e) => {
    const f = fracOf(e);
    const hit = state.splits.findIndex((s) => Math.abs(s - f) < 0.018);
    if (hit >= 0) {
      state.drag = hit;
      bar.setPointerCapture(e.pointerId);
      return;
    }
    addSplit(f);
    render();
  };
  bar.onpointermove = (e) => {
    if (state.drag == null) return;
    const f = fracOf(e);
    state.splits[state.drag] = f;
    const marks = bar.querySelectorAll<HTMLElement>(".mark");
    const order = [...state.splits.keys()].sort((a, b) => state.splits[a]! - state.splits[b]!);
    order.forEach((idx, visual) => {
      const el = marks[visual];
      if (!el) return;
      el.style.left = `${state.splits[idx]! * 100}%`;
    });
  };
  bar.onpointerup = () => {
    if (state.drag == null) return;
    state.drag = null;
    state.splits = [...state.splits].sort((a, b) => a - b);
    saveSplits();
    render();
  };

  const chips = document.getElementById("chips")!;
  sorted.forEach((f, order) => {
    const btn = document.createElement("button");
    btn.textContent = `S${order + 1} ${(f * 100).toFixed(0)}% remove`;
    btn.onclick = () => {
      state.splits = state.splits.filter((s) => s !== f);
      saveSplits();
      render();
    };
    chips.appendChild(btn);
  });

  const distanceMode = !!state.compare && laps.length > 0;
  const length = distanceMode ? Math.max(...laps.map((l) => l.total), 1) : 0;
  const xMax = distanceMode ? length : laps.length ? Math.max(...laps.map((l) => l.duration)) : 60;
  const splitTimes = distanceMode
    ? [...state.splits].sort((a, b) => a - b).map((f) => f * xMax)
    : anchor ? [...state.splits].sort((a, b) => a - b).map((f) => timeAtFraction(anchor, f)) : [];
  const plots = document.getElementById("plots")!;
  const shown = state.keys.map((k) => log.channels.find((c) => c.key === k)).filter((c): c is PrepChannel => !!c).slice(0, 8);
  const anchorIndex = anchor ? laps.findIndex((l) => l.id === anchor.id) : -1;
  type Drawn = {
    canvas: HTMLCanvasElement;
    wrap: HTMLElement;
    title: string;
    unit: string;
    series: { color: string; samples: Sample[]; scale: number; dash?: boolean }[];
    anchorSamples: Sample[] | null;
    scale: number;
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
      time.textContent = distanceMode ? `${t.toFixed(0)} m` : `${t.toFixed(2)} s`;
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
      draw(p.canvas, p.wrap, p.title, p.unit, p.series, xMax, splitTimes, t, text);
    }
  };
  for (const ch of shown) {
    const wrap = document.createElement("div");
    wrap.className = "plot";
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    plots.appendChild(wrap);
    const other = state.compare?.channels.find((item) => item.key === state.pairs[ch.key]);
    const title = other && other.key !== ch.key ? `${ch.label} / ${other.label}` : ch.label;
    const series = laps.map((lap) => {
      const wanted = lap.side === "B" ? state.pairs[ch.key] ?? "" : ch.key;
      const src = (lap.side === "B" ? state.compare : log)?.channels.find((item) => item.key === wanted);
      let samples = src ? downsample(sliceChannel(src.channel, lap.startMs, lap.endMs), 700) : [];
      if (distanceMode && samples.length) samples = samples.map((sample) => ({ t: fractionAtTime(lap, sample.t) * length, v: sample.v }));
      return {
        color: colorOf(lap),
        dash: lap.side === "B",
        samples,
        scale: src?.scale ?? ch.scale,
      };
    });
    const item: Drawn = {
      canvas,
      wrap,
      title: title,
      unit: ch.unit,
      series,
      anchorSamples: anchorIndex >= 0 ? series[anchorIndex]!.samples : null,
      scale: ch.scale,
    };
    drawn.push(item);
    const startValue = state.cursor == null || !item.anchorSamples ? "" : (() => {
      const raw = nearest(item.anchorSamples, state.cursor) * item.scale;
      return Number.isFinite(raw) ? raw.toFixed(1) : "";
    })();
    draw(canvas, wrap, title, ch.unit, series, xMax, splitTimes, state.cursor, startValue);
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
      addSplit(distanceMode ? Math.min(0.99, Math.max(0.01, t / xMax)) : fractionAtTime(anchor, t));
      render();
    };
  }

  if (rows.length && session.length) {
    const head = `<tr><th>Sector</th><th>Track</th>${session.map((l) => `<th>${lapName(l)}</th>`).join("")}<th>Best</th></tr>`;
    const body = rows
      .map((row) => {
        const cells = row.times
          .map((t, i) => `<td class="${session[i]!.id === row.bestLap ? "best" : ""}">${formatLap(t)}</td>`)
          .join("");
        return `<tr><td>S${row.index}</td><td>${(row.from * 100).toFixed(0)}–${(row.to * 100).toFixed(0)}%</td>${cells}<td class="best">${nameOfId(row.bestLap)} ${formatLap(row.best)}</td></tr>`;
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
      state.pairs = state.log ? autoPairs(state.log, prepared) : {};
      state.laps = [...state.laps.filter((id) => id.startsWith("A")), ...ids];
      render();
      return;
    }
    state.log = prepared;
    state.compare = null;
    state.pairs = {};
    const match = [/gps speed/i, /rpm/i, /front fork/i, /rear shock/i, /twist/i, /throttle/i, /tps/i, /gear/i];
    const defaults = prepared.channels.filter((c) => match.some((r) => r.test(c.label) || r.test(c.key))).slice(0, 5);
    state.keys = (defaults.length ? defaults : prepared.channels.slice(0, 3)).map((c) => c.key);
    state.laps = ids;
    state.anchor = fastest(flying.length ? flying : prepared.laps).id;
    const saved = localStorage.getItem("lap-splits:" + prepared.track);
    state.splits = [];
    if (saved) {
      try {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) state.splits = arr.filter((n) => typeof n === "number" && n > 0.01 && n < 0.99);
      } catch { /* ignore */ }
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
