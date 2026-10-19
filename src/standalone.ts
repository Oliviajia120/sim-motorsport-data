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
  return { num, startMs, endMs, duration, times, dist, total, source };
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

function channelLabel(ch: XrkChannel) {
  const func = ch.func?.trim() || "";
  const name = ch.name.replaceAll("_", " ").trim();
  if (!func || /^number$/i.test(func)) return name || "Channel";
  return func;
}

function prepare(log: XrkLog, fileName: string): Prepared {
  const channels = Object.values(log.channels)
    .filter((ch) => ch.timecodes.length > 1)
    .map((ch) => {
      const d = displayScale(ch);
      return { key: ch.name, label: channelLabel(ch), unit: d.unit, scale: d.scale, channel: ch };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
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
  keys: string[];
  laps: number[];
  anchor: number | null;
  splits: number[];
  place: boolean;
  cursor: number | null;
  equal: number;
  drag: number | null;
  grok: boolean;
};

const state: State = { log: null, keys: [], laps: [], anchor: null, splits: [], place: false, cursor: null, equal: 4, drag: null, grok: false };

type GrokMsg = { role: "user" | "assistant"; content: string };
const grokChat: GrokMsg[] = [];
let grokBusy = false;

const app = document.getElementById("app")!;

function fastest(laps: LapProfile[]) {
  return laps.reduce((b, l) => (l.duration < b.duration ? l : b));
}

function chosen() {
  return state.log ? state.log.laps.filter((l) => state.laps.includes(l.num)) : [];
}

function anchorLap() {
  const laps = chosen();
  if (!laps.length) return null;
  return laps.find((l) => l.num === state.anchor) ?? fastest(laps);
}

function comparedLaps() {
  const all = state.log?.laps ?? [];
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
    let bestLap = laps[0]!.num;
    times.forEach((t, i) => {
      if (t > 0.05 && t < best) {
        best = t;
        bestLap = laps[i]!.num;
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
    `File: ${log.fileName}`,
    `Vehicle: ${log.vehicle}`,
    `Track: ${log.track}`,
    `Laps: ${laps.map((l) => `L${l.num} ${formatLap(l.duration)}`).join(", ")}`,
  ];
  if (!rows.length) lines.push("No splits are set, so there is no theoretical best yet.");
  else {
    const ideal = rows.every((r) => Number.isFinite(r.best)) ? rows.reduce((s, r) => s + r.best, 0) : NaN;
    lines.push(`Theoretical best: ${formatLap(ideal)}`);
    for (const row of rows) {
      const each = laps.map((l, i) => `L${l.num} ${formatLap(row.times[i]!)}`).join(", ");
      lines.push(`S${row.index} ${(row.from * 100).toFixed(0)}-${(row.to * 100).toFixed(0)}% best ${formatLap(row.best)} from L${row.bestLap}. ${each}`);
    }
  }
  lines.push(`Channels selected: ${state.keys.join(", ") || "none"}`);
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
          { role: "system", content: "You are a motorcycle racing engineer reading AIM telemetry for a coach. Use only the session below. Name the lap and the sector. If a channel is not in the brief, say you cannot see it.\n\n" + sessionBrief() },
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
    app.innerHTML = `<header class="bar"><h1>Sim Motorsport Data</h1><button id="open">Open .xrk</button></header>
      <main class="empty"><h2>Sectors, then the ideal lap</h2>
      <p>Open a session, drop splits along the lap, and the ideal time is the sum of the fastest pass through each sector.</p>
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
  const makeup = rows.map((r) => `S${r.index} ${formatLap(r.best)} from L${r.bestLap}`).join("  +  ");
  const skipped = (state.log?.laps.length ?? 0) - session.length;
  const deltaText = !rows.length ? "Add at least one split" : !Number.isFinite(delta) ? "" : delta < -0.0005 ? `${formatLap(delta)} vs best lap` : delta > 0.0005 ? `+${formatLap(delta)} vs best lap` : "matches the best lap";

  app.innerHTML = `
    <header class="bar">
      <h1>Sim Motorsport Data</h1>
      <button id="open">Open .xrk</button>
      <button id="grok">Grok</button>
      <span class="meta">${log.fileName} · ${log.vehicle} · ${log.track}</span>
    </header>
    <div class="layout">
      <aside>
        <h2>Channels</h2>
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
          <p class="hint">Click the bar to add a split. Drag a marker to move it. The theoretical best uses every full lap in this session, not only the laps drawn on the graph.</p>
          <div id="table"></div>
        </section>
        <p id="readout" class="readout">Move the mouse across a graph. A white line tracks every graph, and this bar shows the reference-lap value.</p>
        <div id="plots"></div>
      </main>
    </div>
    ${state.grok ? grokPanel() : ""}`;

  document.getElementById("open")!.onclick = pick;
  document.getElementById("grok")!.onclick = () => {
    state.grok = !state.grok;
    render();
  };
  document.getElementById("flying")!.onclick = () => {
    const q = fastest(log.laps).duration;
    const flying = log.laps.filter((l) => l.duration < q * 1.12);
    state.laps = flying.map((l) => l.num);
    state.anchor = fastest(flying).num;
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
  for (const ch of log.channels) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" ${state.keys.includes(ch.key) ? "checked" : ""}> ${ch.label}`;
    label.querySelector("input")!.onchange = () => {
      state.keys = state.keys.includes(ch.key) ? state.keys.filter((k) => k !== ch.key) : [...state.keys, ch.key];
      render();
    };
    chBox.appendChild(label);
  }
  const lapBox = document.getElementById("laps")!;
  log.laps.forEach((lap, index) => {
    const row = document.createElement("div");
    row.className = "laprow";
    row.innerHTML = `<label><input type="checkbox" ${state.laps.includes(lap.num) ? "checked" : ""}><i style="background:${lapColor(index)}"></i><span>L${lap.num} ${formatLap(lap.duration)}</span></label><button class="${anchor?.num === lap.num ? "on" : ""}">Ref</button>`;
    row.querySelector("input")!.onchange = () => {
      state.laps = state.laps.includes(lap.num) ? state.laps.filter((n) => n !== lap.num) : [...state.laps, lap.num];
      render();
    };
    row.querySelector("button")!.onclick = () => {
      state.anchor = lap.num;
      render();
    };
    lapBox.appendChild(row);
  });

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

  const xMax = laps.length ? Math.max(...laps.map((l) => l.duration)) : 60;
  const splitTimes = anchor ? [...state.splits].sort((a, b) => a - b).map((f) => timeAtFraction(anchor, f)) : [];
  const plots = document.getElementById("plots")!;
  const shown = state.keys.map((k) => log.channels.find((c) => c.key === k)).filter((c): c is PrepChannel => !!c).slice(0, 8);
  const anchorIndex = anchor ? laps.findIndex((l) => l.num === anchor.num) : -1;
  type Drawn = {
    canvas: HTMLCanvasElement;
    wrap: HTMLElement;
    title: string;
    unit: string;
    series: { color: string; samples: Sample[]; scale: number }[];
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
    const bits = drawn.map((p) => {
      const raw = p.anchorSamples ? nearest(p.anchorSamples, t) : NaN;
      const v = raw * p.scale;
      return `${p.title} ${Number.isFinite(v) ? v.toFixed(1) : "—"}`;
    });
    if (readout) readout.textContent = `Cursor ${t.toFixed(2)} s` + (bits.length ? "    " + bits.join("    ") : "");
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
    const series = laps.map((lap) => ({
      color: lapColor(log.laps.findIndex((x) => x.num === lap.num)),
      samples: downsample(sliceChannel(ch.channel, lap.startMs, lap.endMs), 700),
      scale: ch.scale,
    }));
    const item: Drawn = {
      canvas,
      wrap,
      title: ch.label,
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
    draw(canvas, wrap, ch.label, ch.unit, series, xMax, splitTimes, state.cursor, startValue);
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

  if (rows.length && session.length) {
    const head = `<tr><th>Sector</th><th>Track</th>${session.map((l) => `<th>L${l.num}</th>`).join("")}<th>Best</th></tr>`;
    const body = rows
      .map((row) => {
        const cells = row.times
          .map((t, i) => `<td class="${session[i]!.num === row.bestLap ? "best" : ""}">${formatLap(t)}</td>`)
          .join("");
        return `<tr><td>S${row.index}</td><td>${(row.from * 100).toFixed(0)}–${(row.to * 100).toFixed(0)}%</td>${cells}<td class="best">L${row.bestLap} ${formatLap(row.best)}</td></tr>`;
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
      void askGrok("Read this session. Give the theoretical best, which lap owns each sector, and what is worth checking next.");
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
  series: { color: string; samples: Sample[]; scale: number }[],
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
    ctx.stroke();
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

const picker = document.createElement("input");
picker.type = "file";
picker.accept = ".xrk,.xrz";
picker.style.display = "none";
document.body.appendChild(picker);
picker.onchange = async () => {
  const file = picker.files?.[0];
  picker.value = "";
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const parsed = parseXrk(new Uint8Array(buf));
    const prepared = prepare(parsed, file.name);
    if (!prepared.laps.length) {
      alert("No laps with a usable distance trace were found.");
      return;
    }
    state.log = prepared;
    const match = [/gps speed/i, /rpm/i, /front fork/i, /rear shock/i, /twist/i, /gear/i];
    const defaults = prepared.channels.filter((c) => match.some((r) => r.test(c.label) || r.test(c.key))).slice(0, 5);
    state.keys = (defaults.length ? defaults : prepared.channels.slice(0, 3)).map((c) => c.key);
    const quick = fastest(prepared.laps).duration;
    const flying = prepared.laps.filter((l) => l.duration < quick * 1.12);
    state.laps = (flying.length ? flying : prepared.laps).map((l) => l.num);
    state.anchor = fastest(flying.length ? flying : prepared.laps).num;
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
