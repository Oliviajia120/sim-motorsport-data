import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { parseXrk } from "aim-xrk";
import { Flag, MousePointer2, Plus, RotateCcw, Upload } from "lucide-react";
import { DeltaPlot, TracePlot, type PlotMarker } from "@/components/trace-plot";
import { downloadCoachingNote, safeStem, type CoachingNote, type NoteChart } from "@/lib/coaching-note";
import {
  coachingChannelKeys,
  deltaVsDistance,
  downsample,
  equalSplits,
  formatLap,
  formatSigned,
  fractionAtTime,
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
  sliceChannel,
  spansFromSplits,
  spansFromTemplate,
  timeAtFraction,
  topSectorLosses,
  ZIC_TEMPLATE,
  prepareLog,
  type LapProfile,
  type NamedSector,
  type PreparedLog,
  type SavedTemplate,
} from "@/lib/telemetry";

const TEMPLATE_STORE = "lap-templates";

function storageKey(track: string) {
  return `lap-splits:${track}`;
}

export function Viewer() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<PreparedLog | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [selectedLaps, setSelectedLaps] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [spans, setSpans] = useState<NamedSector[]>([]);
  const [templateId, setTemplateId] = useState("manual");
  const [lapLengthM, setLapLengthM] = useState(0);
  const [templatePick, setTemplatePick] = useState("zic");
  const [templateName, setTemplateName] = useState("");
  const [saved, setSaved] = useState<SavedTemplate[]>([]);
  const [placeMode, setPlaceMode] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [equalCount, setEqualCount] = useState(4);
  const [dragging, setDragging] = useState<number | null>(null);

  useEffect(() => {
    setSaved(parseSavedTemplates(localStorage.getItem(TEMPLATE_STORE)));
  }, [log, templateId]);

  useEffect(() => {
    if (!log) return;
    try {
      localStorage.setItem(
        storageKey(log.track),
        serializeSplitDocument({ v: 2, templateId, lapLengthM, spans }),
      );
    } catch {
      /* private window */
    }
  }, [log, spans, templateId, lapLengthM]);

  const chosenLaps = useMemo(() => {
    if (!log) return [];
    return log.laps.filter((lap) => selectedLaps.includes(lap.num));
  }, [log, selectedLaps]);

  const anchorLap = useMemo(() => {
    if (!chosenLaps.length) return null;
    return chosenLaps.find((lap) => lap.num === anchor) ?? fastest(chosenLaps);
  }, [chosenLaps, anchor]);

  const pair = useMemo(() => reviewPair(chosenLaps, log?.laps ?? [], anchorLap), [chosenLaps, log, anchorLap]);
  const rows = useMemo(() => (spans.length ? sectorTableFromSpans(chosenLaps, spans) : []), [chosenLaps, spans]);
  const ideal = rows.length && rows.every((row) => Number.isFinite(row.best)) ? idealSeconds(rows) : NaN;
  const bestActual = chosenLaps.length ? Math.min(...chosenLaps.map((lap) => lap.duration)) : NaN;
  const xMax = chosenLaps.length ? Math.max(...chosenLaps.map((lap) => lap.duration)) : 60;
  const refIndex = anchorLap ? chosenLaps.findIndex((lap) => lap.num === anchorLap.num) : -1;

  const splitTimes = useMemo(() => {
    if (!anchorLap) return [];
    return spans.slice(0, -1).map((span) => timeAtFraction(anchorLap, span.to));
  }, [anchorLap, spans]);

  const markerByLap = useMemo(() => {
    const map = new Map<number, ReturnType<typeof markersForLap>>();
    if (!log || !spans.some((span) => span.kind === "corner")) return map;
    const keys = coachingChannelKeys(log.channels);
    for (const lap of chosenLaps) {
      const brake = channelOf(log, keys.brake);
      const speed = channelOf(log, keys.speed);
      const lean = channelOf(log, keys.lean);
      map.set(
        lap.num,
        markersForLap(lap, spans, {
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
  }, [log, chosenLaps, spans]);

  const plots = useMemo(() => {
    if (!log) return [];
    return selectedKeys
      .map((key) => log.channels.find((ch) => ch.key === key))
      .filter((ch) => ch != null)
      .slice(0, 6)
      .map((ch) => ({
        key: ch.key,
        title: ch.label,
        unit: ch.unit,
        scale: ch.scale,
        markers: isCoachingChannel(ch) || (/speed/i.test(`${ch.label} ${ch.key}`) && !/rate|accur|fix/i.test(`${ch.label} ${ch.key}`))
          ? chosenLaps.flatMap((lap, lane) =>
              (markerByLap.get(lap.num) ?? []).map(
                (hit): PlotMarker => ({
                  t: hit.t,
                  color: lapColor(log.laps.findIndex((item) => item.num === lap.num)),
                  kind: hit.kind,
                  lane,
                }),
              ),
            )
          : [],
        series: chosenLaps.map((lap) => ({
          name: `Lap ${lap.num}`,
          color: lapColor(log.laps.findIndex((item) => item.num === lap.num)),
          scale: ch.scale,
          samples: downsample(sliceChannel(ch.channel, lap.startMs, lap.endMs), 700),
        })),
      }));
  }, [log, selectedKeys, chosenLaps, markerByLap]);

  const deltaSeries = useMemo(() => {
    if (!pair) return [];
    return pair.laps.map((lap) => ({
      name: `L${lap.num}`,
      color: lapColor(log?.laps.findIndex((item) => item.num === lap.num) ?? 0),
      points: deltaVsDistance(pair.ref, lap, 240),
    }));
  }, [pair, log]);

  const cursorReadout = useMemo(() => {
    if (cursor == null || !log || !anchorLap) return [];
    return plots.map((plot) => {
      const channel = log.channels.find((ch) => ch.key === plot.key);
      if (!channel) return { label: plot.title, value: "—" };
      const samples = sliceChannel(channel.channel, anchorLap.startMs, anchorLap.endMs);
      let nearest = samples[0];
      let best = Infinity;
      for (const sample of samples) {
        const d = Math.abs(sample.t - cursor);
        if (d < best) {
          best = d;
          nearest = sample;
        }
      }
      const value = nearest ? nearest.v * channel.scale : NaN;
      return { label: plot.title, value: Number.isFinite(value) ? value.toFixed(1) : "—" };
    });
  }, [cursor, log, anchorLap, plots]);

  function remember(nextSpans: NamedSector[], nextTemplate: string, length = lapLengthM) {
    setSpans(nextSpans);
    setTemplateId(nextTemplate);
    setLapLengthM(length);
  }

  function applyTemplate(id: string) {
    if (!log) return;
    const length = median((chosenLaps.length ? chosenLaps : log.laps).map((lap) => lap.total));
    if (id === "manual") {
      remember(spansFromSplits(spans.slice(0, -1).map((span) => span.to)), "manual", length || lapLengthM);
      return;
    }
    if (id === "zic") {
      if (length < 200) return;
      const placed = spansFromTemplate(ZIC_TEMPLATE, length);
      remember(placed.spans, "zic", placed.lapLengthM);
      return;
    }
    if (id.startsWith("saved:")) {
      const found = saved.find((item) => item.name === id.slice(6));
      if (!found) return;
      remember(found.spans.map((span) => ({ ...span })), id, found.lapLengthM || length);
    }
  }

  async function openFile(file: File) {
    setError(null);
    setStatus("Reading file…");
    try {
      const buf = await file.arrayBuffer();
      setStatus("Parsing…");
      await new Promise((resolve) => setTimeout(resolve, 0));
      const parsed = parseXrk(new Uint8Array(buf));
      const prepared = prepareLog(parsed, file.name);
      if (!prepared.laps.length) {
        setError("No laps with a usable distance trace were found in this file.");
        setLog(null);
        setStatus(null);
        return;
      }
      const coach = coachingChannelKeys(prepared.channels);
      const defaults = [coach.brake, coach.throttle, coach.lean].filter((key): key is string => !!key);
      setSelectedKeys(defaults.length ? defaults : prepared.channels.slice(0, 3).map((ch) => ch.key));
      const quickest = fastest(prepared.laps).duration;
      const flying = prepared.laps.filter((lap) => lap.duration < quickest * 1.12);
      const active = flying.length ? flying : prepared.laps;
      setSelectedLaps(active.map((lap) => lap.num));
      setAnchor(fastest(active).num);
      const stored = parseSplitDocument(localStorage.getItem(storageKey(prepared.track)));
      const length = median(active.map((lap) => lap.total));
      if (stored) {
        setSpans(stored.spans);
        setTemplateId(stored.templateId);
        setTemplatePick(stored.templateId);
        setLapLengthM(stored.lapLengthM || length);
      } else if (/zhuhai|\bzic\b/i.test(`${prepared.track} ${prepared.fileName}`)) {
        const placed = spansFromTemplate(ZIC_TEMPLATE, length);
        setSpans(placed.spans);
        setTemplateId("zic");
        setTemplatePick("zic");
        setLapLengthM(placed.lapLengthM);
      } else {
        setSpans([]);
        setTemplateId("manual");
        setTemplatePick("manual");
        setLapLengthM(length);
      }
      setLog(prepared);
      setStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file.");
      setStatus(null);
    }
  }

  function addSplit(fraction: number) {
    if (templateId !== "manual") return;
    if (fraction <= 0.015 || fraction >= 0.985) return;
    const edges = spans.slice(0, -1).map((span) => span.to);
    if (edges.some((edge) => Math.abs(edge - fraction) < 0.012)) return;
    setSpans(spansFromSplits([...edges, fraction]));
  }

  function fractionFromBar(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(0.99, Math.max(0.01, (event.clientX - rect.left) / Math.max(rect.width, 1)));
  }

  function onBarDown(event: PointerEvent<HTMLDivElement>) {
    const fraction = fractionFromBar(event);
    let hit = -1;
    let best = 0.014;
    spans.forEach((span, index) => {
      if (index >= spans.length - 1) return;
      const distance = Math.abs(span.to - fraction);
      if (distance < best) {
        best = distance;
        hit = index;
      }
    });
    if (hit >= 0) {
      setDragging(hit);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    addSplit(fraction);
  }

  const coach = log ? coachingChannelKeys(log.channels) : {};
  const missingCoach = [coach.brake ? "" : "brake", coach.throttle ? "" : "throttle", coach.lean ? "" : "lean"].filter(Boolean);
  const ruler = lapLengthM || median((log?.laps ?? []).map((lap) => lap.total));

  async function exportNote(kind: "png" | "pdf") {
    if (!log) return;
    const laps = pair ? [pair.ref, ...pair.laps] : chosenLaps.slice(0, 4);
    if (!laps.length) return;
    const ref = laps[0]!;
    const compare = laps[1];
    const allRows = sectorTableFromSpans(laps, spans);
    const tableRows = allRows.some((row) => row.kind === "corner") ? allRows.filter((row) => row.kind === "corner") : allRows;
    const word = (gap: number) => (gap > 0.0005 ? "behind" : gap < -0.0005 ? "ahead" : "level");
    const tone = (gap: number): "gain" | "loss" | "plain" => (gap > 0.0005 ? "loss" : gap < -0.0005 ? "gain" : "plain");
    const charts: NoteChart[] = [];
    if (compare) {
      charts.push({
        title: `Time delta vs L${ref.num}`,
        unit: "s",
        xLabel: `${Math.round(ref.total)} m`,
        xMax: ref.total,
        zeroLine: true,
        fillToZero: true,
        bands: spans.filter((span) => span.kind === "corner").map((span) => ({ from: span.from * ref.total, to: span.to * ref.total, label: span.label })),
        series: laps.slice(1).map((lap) => ({
          name: `L${lap.num}`,
          color: lapColor(log.laps.findIndex((item) => item.num === lap.num)),
          points: deltaVsDistance(ref, lap, 300).map((point) => ({ x: point.metres, y: point.delta })),
        })),
      });
    }
    const traced = [coach.brake, coach.throttle, coach.lean];
    if (traced.filter(Boolean).length < 2 && coach.speed) traced.push(coach.speed);
    for (const key of traced) {
      if (!key) continue;
      const channel = log.channels.find((item) => item.key === key);
      if (!channel) continue;
      charts.push({
        title: channel.label,
        unit: channel.unit,
        xLabel: `${Math.max(...laps.map((lap) => lap.duration)).toFixed(0)} s`,
        xMax: Math.max(...laps.map((lap) => lap.duration), 1),
        series: laps.map((lap) => ({
          name: `L${lap.num}`,
          color: lapColor(log.laps.findIndex((item) => item.num === lap.num)),
          points: downsample(sliceChannel(channel.channel, lap.startMs, lap.endMs), 420).map((sample) => ({
            x: sample.t,
            y: sample.v * channel.scale,
          })),
        })),
        markers: laps.flatMap((lap, lane) =>
          (markerByLap.get(lap.num) ?? []).map((hit) => ({
            x: hit.t,
            color: lapColor(log.laps.findIndex((item) => item.num === lap.num)),
            kind: hit.kind,
            lane,
          })),
        ),
      });
    }
    const losses = compare ? topSectorLosses(allRows, 0, 1, 3) : [];
    const note: CoachingNote = {
      track: log.track,
      rider: log.rider,
      vehicle: log.vehicle,
      fileName: log.fileName,
      when: log.when,
      template: templateId === "zic" ? "ZIC C1–C11" : templateId.startsWith("saved:") ? templateId.slice(6) : "Manual splits",
      ideal: rows.length ? formatLap(ideal) : "",
      laps: laps.map((lap, index) => ({
        name: `L${lap.num}`,
        time: formatLap(lap.duration),
        color: lapColor(log.laps.findIndex((item) => item.num === lap.num)),
        role: index === 0 ? "Reference" : `${formatSigned(lap.duration - ref.duration)} s ${word(lap.duration - ref.duration)} on the full lap`,
      })),
      sectorHeaders: laps.map((lap, index) => (index === 0 ? `L${lap.num} ref` : `L${lap.num}`)),
      sectors: tableRows.map((row) => ({
        label: sectorLabel(row),
        distance: distanceText(row, templateId, ruler),
        cells: row.times.map((time, index) => {
          if (index === 0) return { text: formatLap(time), delta: "", tone: "ref" as const };
          const gap = time - row.times[0]!;
          return { text: formatLap(time), delta: `${formatSigned(gap)} ${word(gap)}`, tone: tone(gap) };
        }),
      })),
      lossesTitle: compare ? `Top time lost by L${compare.num} vs L${ref.num}` : "Top time lost",
      losses: losses.map((item) => ({ label: sectorLabel(item.row), text: `${formatSigned(item.delta)} s behind` })),
      emptyLosses: compare ? `L${compare.num} is ahead in every sector versus L${ref.num}.` : "Select a second lap to list sector losses.",
      convention: `Positive time is behind the reference (lost time). Negative time is ahead of the reference (gained time).${missingCoach.length ? ` This session has no ${missingCoach.join(", ")} channel.` : ""}`,
      charts,
    };
    await downloadCoachingNote(note, kind, safeStem(`${log.track}-${log.fileName}-coaching-note`));
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="mr-2 flex items-center gap-2">
          <Flag className="size-5 text-primary" aria-hidden="true" />
          <h1 className="text-lg font-semibold tracking-tight">Sim Motorsport Data</h1>
        </div>
        <button
          type="button"
          className="inline-flex h-11 items-center gap-2 rounded-sm bg-primary px-4 font-semibold text-primary-fg"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="size-4" aria-hidden="true" />
          Open .xrk
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".xrk,.xrz"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void openFile(file);
          }}
        />
        <p className="min-w-0 flex-1 truncate font-mono text-sm text-muted">
          {status ??
            (log
              ? `${log.fileName}  ·  ${log.rider !== "—" ? `${log.rider}  ·  ` : ""}${log.vehicle}  ·  ${log.track}`
              : "AIM Solo session")}
        </p>
      </header>

      {error ? <p className="border-b border-border bg-raised px-4 py-3 text-sm text-primary">{error}</p> : null}

      {!log ? (
        <main className="mx-auto flex max-w-xl flex-1 flex-col justify-center gap-4 px-6 py-16">
          <h2 className="text-3xl font-semibold tracking-tight">A coach desk for the lap</h2>
          <p className="text-base leading-relaxed text-muted">
            Open a session, apply the ZIC C1–C11 corners or drop your own splits, and compare where a lap
            gains and loses time.
          </p>
          <button
            type="button"
            className="inline-flex h-11 w-fit items-center gap-2 rounded-sm bg-primary px-4 font-semibold text-primary-fg"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="size-4" aria-hidden="true" />
            Choose a file
          </button>
        </main>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          <aside className="flex max-h-[48vh] min-h-0 flex-col gap-3 overflow-hidden border-b border-border bg-surface p-3 md:h-full md:max-h-none md:w-72 md:shrink-0 md:border-r md:border-b-0">
            <section className="flex shrink-0 flex-col">
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Channels</h2>
              <ul className="max-h-56 space-y-1 overflow-x-hidden overflow-y-auto overscroll-contain rounded-sm border border-border bg-bg">
                {log.channels.map((ch) => (
                  <li key={ch.key}>
                    <label className="flex min-h-9 items-center gap-2 rounded-sm px-1 text-sm hover:bg-raised">
                      <input
                        type="checkbox"
                        checked={selectedKeys.includes(ch.key)}
                        onChange={() =>
                          setSelectedKeys((current) =>
                            current.includes(ch.key) ? current.filter((key) => key !== ch.key) : [...current, ch.key],
                          )
                        }
                      />
                      <span className="truncate">{ch.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
            <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
                <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Laps</h2>
                <button
                  type="button"
                  className="text-xs font-semibold text-primary"
                  onClick={() => {
                    const quickest = fastest(log.laps).duration;
                    const flying = log.laps.filter((lap) => lap.duration < quickest * 1.12);
                    setSelectedLaps(flying.map((lap) => lap.num));
                    setAnchor(fastest(flying).num);
                  }}
                >
                  Flying only
                </button>
              </div>
              <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain">
                {log.laps.map((lap, index) => (
                  <li key={lap.num} className="flex items-center gap-2">
                    <label className="flex min-h-9 flex-1 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedLaps.includes(lap.num)}
                        onChange={() =>
                          setSelectedLaps((current) =>
                            current.includes(lap.num) ? current.filter((num) => num !== lap.num) : [...current, lap.num],
                          )
                        }
                      />
                      <span className="inline-block size-2.5 rounded-full" style={{ background: lapColor(index) }} />
                      <span className="font-mono">
                        L{lap.num} {formatLap(lap.duration)}
                      </span>
                    </label>
                    <button
                      type="button"
                      className={`h-8 rounded-sm px-2 text-xs font-semibold ${
                        anchorLap?.num === lap.num ? "bg-primary text-primary-fg" : "bg-raised text-muted"
                      }`}
                      onClick={() => setAnchor(lap.num)}
                    >
                      Ref
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </aside>

          <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-3">
            <section className="rounded-sm border border-border bg-surface p-3">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold tracking-wide text-muted uppercase">Ideal lap</p>
                  <p className="font-mono text-3xl font-semibold text-best">
                    {spans.length && chosenLaps.length ? formatLap(ideal) : "—"}
                  </p>
                  <p className="text-sm text-muted">
                    {spans.length && Number.isFinite(bestActual)
                      ? `Best full lap ${formatLap(bestActual)} · ${formatDelta(ideal - bestActual)}`
                      : "Apply ZIC or add a split"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex h-11 items-center gap-2 rounded-sm bg-raised px-3 text-sm">
                    Track
                    <select
                      value={templatePick}
                      onChange={(event) => setTemplatePick(event.target.value)}
                      className="bg-transparent text-fg outline-none"
                    >
                      <option value="manual">Manual splits</option>
                      <option value="zic">ZIC C1–C11</option>
                      {saved.map((item) => (
                        <option key={item.name} value={`saved:${item.name}`}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="inline-flex h-11 items-center rounded-sm bg-primary px-3 text-sm font-semibold text-primary-fg"
                    onClick={() => applyTemplate(templatePick)}
                  >
                    Apply
                  </button>
                  <input
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                    placeholder="Save template"
                    maxLength={40}
                    className="h-11 w-36 rounded-sm bg-raised px-3 text-sm outline-none"
                  />
                  <button
                    type="button"
                    className="inline-flex h-11 items-center rounded-sm bg-raised px-3 text-sm font-semibold"
                    onClick={() => {
                      const name = templateName.trim().slice(0, 40);
                      if (!name || !spans.length) return;
                      const next = [...saved.filter((item) => item.name !== name), { name, spans, lapLengthM: ruler }];
                      localStorage.setItem(TEMPLATE_STORE, serializeSavedTemplates(next));
                      setSaved(next);
                      setTemplateId(`saved:${name}`);
                      setTemplatePick(`saved:${name}`);
                    }}
                  >
                    Save
                  </button>
                  <button type="button" className="inline-flex h-11 items-center rounded-sm bg-raised px-3 text-sm font-semibold" onClick={() => void exportNote("png")}>
                    Export PNG
                  </button>
                  <button type="button" className="inline-flex h-11 items-center rounded-sm bg-raised px-3 text-sm font-semibold" onClick={() => void exportNote("pdf")}>
                    Export PDF
                  </button>
                  <button
                    type="button"
                    className={`inline-flex h-11 items-center gap-2 rounded-sm px-3 text-sm font-semibold ${
                      placeMode ? "bg-primary text-primary-fg" : "bg-raised text-fg"
                    }`}
                    onClick={() => setPlaceMode((on) => !on)}
                  >
                    <MousePointer2 className="size-4" aria-hidden="true" />
                    {placeMode ? "Click a graph to drop a split" : "Place on graph"}
                  </button>
                  <label className="flex h-11 items-center gap-2 rounded-sm bg-raised px-3 text-sm">
                    Equal
                    <input
                      type="number"
                      min={2}
                      max={12}
                      value={equalCount}
                      onChange={(event) => setEqualCount(Number(event.target.value))}
                      className="w-12 bg-transparent font-mono text-fg outline-none"
                    />
                  </label>
                  <button
                    type="button"
                    className="inline-flex h-11 items-center gap-2 rounded-sm bg-raised px-3 text-sm font-semibold"
                    onClick={() => {
                      setTemplateId("manual");
                      setSpans(spansFromSplits(equalSplits(equalCount)));
                    }}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    Divide lap
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-11 items-center gap-2 rounded-sm bg-raised px-3 text-sm font-semibold"
                    onClick={() => {
                      setTemplateId("manual");
                      setSpans([]);
                    }}
                  >
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Clear
                  </button>
                </div>
              </div>
              <p className="mb-2 text-sm text-muted">
                {log.distanceNote}{" "}
                {templateId === "manual"
                  ? "Manual splits are a percentage of the lap."
                  : `Named corners are placed on a ${Math.round(ruler).toLocaleString("en-US")} m lap.`}
              </p>
              <div
                className="relative h-12 cursor-crosshair rounded-sm bg-bg"
                onPointerDown={onBarDown}
                onPointerMove={(event) => {
                  if (dragging == null) return;
                  setSpans(moveSpanEdge(spans, dragging, fractionFromBar(event)));
                }}
                onPointerUp={() => setDragging(null)}
              >
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-border" />
                {spans
                  .filter((span) => span.kind === "corner")
                  .map((span) => (
                    <div
                      key={span.id}
                      className="pointer-events-none absolute top-1 bottom-1 rounded-sm bg-primary/15"
                      style={{ left: `${span.from * 100}%`, width: `${(span.to - span.from) * 100}%` }}
                    >
                      <span className="absolute bottom-0 left-1 font-mono text-[10px] text-primary">{span.label}</span>
                    </div>
                  ))}
                {spans.slice(0, -1).map((span, index) => (
                  <div
                    key={`${span.id}-edge`}
                    className="pointer-events-none absolute top-1 flex h-10 w-8 -translate-x-1/2 flex-col items-center"
                    style={{ left: `${span.to * 100}%` }}
                  >
                    <span className="h-5 w-0.5 bg-primary" />
                    <span className="font-mono text-xs text-primary">{templateId === "manual" ? index + 1 : ""}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {templateId === "manual"
                  ? spans.slice(0, -1).map((span, edge) => (
                      <button
                        key={`${span.id}-${edge}`}
                        type="button"
                        className="h-9 rounded-sm bg-raised px-2 font-mono text-xs"
                        onClick={() => setSpans(removeSpanEdge(spans, edge))}
                      >
                        {span.label} {(span.to * 100).toFixed(0)}% remove
                      </button>
                    ))
                  : spans
                      .filter((span) => span.kind === "corner")
                      .map((span) => (
                        <span key={span.id} className="inline-flex h-9 items-center rounded-sm bg-raised px-2 font-mono text-xs text-primary">
                          {sectorLabel(span)} {distanceText(span, templateId, ruler)}
                        </span>
                      ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                {templateId === "manual"
                  ? "Click the bar to add a split. Drag a marker to move it."
                  : "Drag a marker to edit this corner map. Apply Manual splits to go back to percentage sectors."}{" "}
                Lines on the graphs follow the reference lap
                {anchorLap ? ` L${anchorLap.num}` : ""}. ▲ brake on, ◆ apex.
              </p>
            </section>

            <section className="rounded-sm border border-border bg-surface p-3">
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">Time delta vs distance</p>
              <p className="mt-1 mb-2 text-sm text-muted">
                {pair
                  ? pair.implicit
                    ? `Reference is L${pair.ref.num}, the best other lap. Positive is behind the reference (lost time). Negative is ahead (gained time).`
                    : `Reference is L${pair.ref.num}. Positive is behind the reference (lost time). Negative is ahead (gained time).`
                  : "Check two laps, or one lap, to plot time gained and lost."}
              </p>
              {pair ? (
                <DeltaPlot
                  series={deltaSeries}
                  metresMax={pair.ref.total}
                  bands={spans.filter((span) => span.kind === "corner").map((span) => ({ from: span.from * pair.ref.total, to: span.to * pair.ref.total }))}
                />
              ) : null}
            </section>

            {missingCoach.length ? (
              <p className="text-sm text-muted">
                Coaching overlays look for brake, throttle, and lean. This file has no {missingCoach.join(" or ")} channel.
              </p>
            ) : (
              <p className="text-sm text-muted">Brake, throttle, and lean are the default overlays. ▲ brake on, ◆ apex.</p>
            )}

            {cursor != null && cursorReadout.length > 0 ? (
              <p className="font-mono text-xs text-muted">
                t {cursor.toFixed(2)}s
                {cursorReadout.map((item) => `   ${item.label} ${item.value}`).join("")}
              </p>
            ) : null}

            <div className="flex flex-col gap-2">
              {plots.map((plot) => (
                <TracePlot
                  key={plot.key}
                  title={plot.title}
                  unit={plot.unit}
                  series={plot.series}
                  xMax={xMax}
                  splitTimes={splitTimes}
                  markers={plot.markers}
                  cursor={cursor}
                  placeMode={placeMode && templateId === "manual"}
                  onCursor={setCursor}
                  onPlace={(time) => {
                    if (!anchorLap) return;
                    addSplit(fractionAtTime(anchorLap, time));
                  }}
                />
              ))}
            </div>

            {rows.length > 0 && chosenLaps.length > 0 ? (
              <div className="overflow-auto rounded-sm border border-border">
                <table className="w-full min-w-[36rem] border-collapse text-sm">
                  <thead className="bg-raised text-left text-xs tracking-wide text-muted uppercase">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Sector</th>
                      <th className="px-3 py-2 font-semibold">Distance</th>
                      {chosenLaps.map((lap) => (
                        <th key={lap.num} className="px-3 py-2 text-right font-semibold">
                          L{lap.num}
                          {lap.num === anchorLap?.num ? " ref" : ""}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-right font-semibold">Best</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} className="border-t border-border">
                        <td className="px-3 py-2 font-semibold">{sectorLabel(row)}</td>
                        <td className="px-3 py-2 font-mono text-muted">{distanceText(row, templateId, ruler)}</td>
                        {row.times.map((time, index) => {
                          const won = index === row.bestIndex;
                          const gap = refIndex >= 0 && index !== refIndex ? time - row.times[refIndex]! : null;
                          return (
                            <td key={chosenLaps[index]!.num} className={`px-3 py-2 text-right font-mono ${won ? "text-best" : ""}`}>
                              {formatLap(time)}
                              {gap != null ? (
                                <span className={`block text-xs ${gap > 0.0005 ? "text-rose-400" : gap < -0.0005 ? "text-best" : "text-muted"}`}>
                                  {formatSigned(gap)} {gap > 0.0005 ? "behind" : gap < -0.0005 ? "ahead" : "level"}
                                </span>
                              ) : null}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-right font-mono text-best">
                          L{row.bestLap} {formatLap(row.best)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-border bg-raised">
                      <td className="px-3 py-2 font-semibold" colSpan={2}>
                        Ideal
                      </td>
                      {chosenLaps.map((lap) => (
                        <td key={lap.num} className="px-3 py-2 text-right font-mono text-muted">
                          {formatLap(lap.duration)}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right font-mono text-best">{formatLap(ideal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : null}
          </main>
        </div>
      )}
    </div>
  );
}

function channelOf(log: PreparedLog, key: string | undefined) {
  if (!key) return undefined;
  return log.channels.find((channel) => channel.key === key);
}

function reviewPair(selected: LapProfile[], all: LapProfile[], anchorLap: LapProfile | null) {
  if (!anchorLap || !selected.length) return null;
  const others = selected.filter((lap) => lap.num !== anchorLap.num);
  if (others.length) return { ref: anchorLap, laps: others, implicit: false };
  const pool = all.filter((lap) => lap.num !== anchorLap.num);
  if (!pool.length) return null;
  return { ref: fastest(pool), laps: [anchorLap], implicit: true };
}

function distanceText(span: NamedSector, templateId: string, length: number) {
  if (length > 0 && templateId !== "manual") return `${Math.round(span.from * length)}–${Math.round(span.to * length)} m`;
  return `${(span.from * 100).toFixed(0)}–${(span.to * 100).toFixed(0)}%`;
}

function fastest<T extends { duration: number; num: number }>(laps: T[]): T {
  return laps.reduce((best, lap) => (lap.duration < best.duration ? lap : best));
}

function formatDelta(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  if (seconds < -0.0005) return `${formatLap(seconds)} vs best lap`;
  if (seconds > 0.0005) return `+${formatLap(seconds)} vs best lap`;
  return "matches the best lap";
}
