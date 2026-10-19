import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { parseXrk } from "aim-xrk";
import { Flag, MousePointer2, Plus, RotateCcw, Upload } from "lucide-react";
import { TracePlot } from "@/components/trace-plot";
import {
  downsample,
  equalSplits,
  formatLap,
  fractionAtTime,
  idealSeconds,
  lapColor,
  prepareLog,
  sectorTable,
  sliceChannel,
  timeAtFraction,
  type PreparedLog,
} from "@/lib/telemetry";

const DEFAULT_MATCH = [/gps speed/i, /rpm/i, /front fork/i, /rear shock/i, /twist/i, /gear/i];

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
  const [splits, setSplits] = useState<number[]>([]);
  const [placeMode, setPlaceMode] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [equalCount, setEqualCount] = useState(4);
  const [dragging, setDragging] = useState<number | null>(null);

  useEffect(() => {
    if (!log) return;
    const raw = localStorage.getItem(storageKey(log.track));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) {
        setSplits(parsed.filter((n) => n > 0.01 && n < 0.99));
      }
    } catch {
      /* ignore broken storage */
    }
  }, [log]);

  useEffect(() => {
    if (!log) return;
    localStorage.setItem(storageKey(log.track), JSON.stringify(splits));
  }, [log, splits]);

  const chosenLaps = useMemo(() => {
    if (!log) return [];
    return log.laps.filter((lap) => selectedLaps.includes(lap.num));
  }, [log, selectedLaps]);

  const anchorLap = useMemo(() => {
    if (!chosenLaps.length) return null;
    return chosenLaps.find((lap) => lap.num === anchor) ?? fastest(chosenLaps);
  }, [chosenLaps, anchor]);

  const rows = useMemo(() => (splits.length ? sectorTable(chosenLaps, splits) : []), [chosenLaps, splits]);
  const ideal = rows.length ? idealSeconds(rows) : NaN;
  const bestActual = chosenLaps.length ? Math.min(...chosenLaps.map((lap) => lap.duration)) : NaN;
  const xMax = chosenLaps.length ? Math.max(...chosenLaps.map((lap) => lap.duration)) : 60;

  const splitTimes = useMemo(() => {
    if (!anchorLap) return [];
    return [...splits].sort((a, b) => a - b).map((f) => timeAtFraction(anchorLap, f));
  }, [anchorLap, splits]);

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
        series: chosenLaps.map((lap) => ({
          name: `Lap ${lap.num}`,
          color: lapColor(log.laps.findIndex((item) => item.num === lap.num)),
          scale: ch.scale,
          samples: downsample(sliceChannel(ch.channel, lap.startMs, lap.endMs), 700),
        })),
      }));
  }, [log, selectedKeys, chosenLaps]);

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
      return {
        label: plot.title,
        value: Number.isFinite(value) ? value.toFixed(1) : "—",
      };
    });
  }, [cursor, log, anchorLap, plots]);

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
      setLog(prepared);
      const defaults = prepared.channels
        .filter((ch) => DEFAULT_MATCH.some((re) => re.test(ch.label) || re.test(ch.key)))
        .slice(0, 5)
        .map((ch) => ch.key);
      setSelectedKeys(defaults.length ? defaults : prepared.channels.slice(0, 3).map((ch) => ch.key));
      const quickest = fastest(prepared.laps).duration;
      const flying = prepared.laps.filter((lap) => lap.duration < quickest * 1.12).map((lap) => lap.num);
      setSelectedLaps(flying.length ? flying : prepared.laps.map((lap) => lap.num));
      setAnchor(fastest(prepared.laps.filter((lap) => (flying.length ? flying.includes(lap.num) : true))).num);
      setSplits([]);
      setStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file.");
      setStatus(null);
    }
  }

  function addSplit(fraction: number) {
    if (fraction <= 0.015 || fraction >= 0.985) return;
    setSplits((current) => {
      if (current.some((item) => Math.abs(item - fraction) < 0.012)) return current;
      return [...current, fraction].sort((a, b) => a - b);
    });
  }

  function placeFromTime(timeSec: number) {
    if (!anchorLap) return;
    addSplit(fractionAtTime(anchorLap, timeSec));
  }

  function fractionFromBar(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(0.99, Math.max(0.01, (event.clientX - rect.left) / Math.max(rect.width, 1)));
  }

  function onBarDown(event: PointerEvent<HTMLDivElement>) {
    const fraction = fractionFromBar(event);
    const hit = splits.findIndex((item) => Math.abs(item - fraction) < 0.018);
    if (hit >= 0) {
      setDragging(hit);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    addSplit(fraction);
  }

  function onBarMove(event: PointerEvent<HTMLDivElement>) {
    if (dragging == null) return;
    const fraction = fractionFromBar(event);
    setSplits((current) => {
      if (dragging >= current.length) return current;
      const next = current.slice();
      next[dragging] = fraction;
      return next;
    });
  }

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
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
          {status ?? (log ? `${log.fileName}  ·  ${log.vehicle}  ·  ${log.track}` : "AIM Solo session")}
        </p>
      </header>

      {error ? (
        <p className="border-b border-border bg-raised px-4 py-3 text-sm text-primary">{error}</p>
      ) : null}

      {!log ? (
        <main className="mx-auto flex max-w-xl flex-1 flex-col justify-center gap-4 px-6 py-16">
          <h2 className="text-3xl font-semibold tracking-tight">Sectors, then the ideal lap</h2>
          <p className="text-base leading-relaxed text-muted">
            Open a session, drop splits along the lap, and the ideal time is the sum of the fastest pass
            through each sector.
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
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex max-h-[40vh] flex-col gap-4 overflow-auto border-b border-border bg-surface p-3 md:max-h-none md:w-72 md:shrink-0 md:border-r md:border-b-0">
            <section>
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Channels</h2>
              <ul className="max-h-52 space-y-1 overflow-auto md:max-h-64">
                {log.channels.map((ch) => (
                  <li key={ch.key}>
                    <label className="flex min-h-9 items-center gap-2 rounded-sm px-1 text-sm hover:bg-raised">
                      <input
                        type="checkbox"
                        checked={selectedKeys.includes(ch.key)}
                        onChange={() =>
                          setSelectedKeys((current) =>
                            current.includes(ch.key)
                              ? current.filter((key) => key !== ch.key)
                              : [...current, ch.key],
                          )
                        }
                      />
                      <span className="truncate">{ch.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
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
              <ul className="space-y-1">
                {log.laps.map((lap, index) => (
                  <li key={lap.num} className="flex items-center gap-2">
                    <label className="flex min-h-9 flex-1 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedLaps.includes(lap.num)}
                        onChange={() =>
                          setSelectedLaps((current) =>
                            current.includes(lap.num)
                              ? current.filter((num) => num !== lap.num)
                              : [...current, lap.num],
                          )
                        }
                      />
                      <span
                        className="inline-block size-2.5 rounded-full"
                        style={{ background: lapColor(index) }}
                      />
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
                    {splits.length && chosenLaps.length ? formatLap(ideal) : "—"}
                  </p>
                  <p className="text-sm text-muted">
                    {splits.length && Number.isFinite(bestActual)
                      ? `Best full lap ${formatLap(bestActual)} · ${formatDelta(ideal - bestActual)}`
                      : "Add at least one split"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
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
                    onClick={() => setSplits(equalSplits(equalCount))}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    Divide lap
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-11 items-center gap-2 rounded-sm bg-raised px-3 text-sm font-semibold"
                    onClick={() => setSplits([])}
                  >
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Clear
                  </button>
                </div>
              </div>
              <p className="mb-2 text-sm text-muted">{log.distanceNote}</p>
              <div
                className="relative h-12 cursor-crosshair rounded-sm bg-bg"
                onPointerDown={onBarDown}
                onPointerMove={onBarMove}
                onPointerUp={() => {
                  setDragging(null);
                  setSplits((current) => [...current].sort((a, b) => a - b));
                }}
              >
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-border" />
                {splits.map((fraction, index) => (
                  <div
                    key={`${index}-${fraction.toFixed(4)}`}
                    className="pointer-events-none absolute top-1 flex h-10 w-8 -translate-x-1/2 flex-col items-center"
                    style={{ left: `${fraction * 100}%` }}
                  >
                    <span className="h-5 w-0.5 bg-primary" />
                    <span className="font-mono text-xs text-primary">{index + 1}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {[...splits]
                  .map((fraction, index) => ({ fraction, index }))
                  .sort((a, b) => a.fraction - b.fraction)
                  .map((item, order) => (
                    <button
                      key={`${item.index}-${item.fraction}`}
                      type="button"
                      className="h-9 rounded-sm bg-raised px-2 font-mono text-xs"
                      onClick={() => setSplits((current) => current.filter((_, i) => i !== item.index))}
                    >
                      S{order + 1} {(item.fraction * 100).toFixed(0)}% remove
                    </button>
                  ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                Click the bar to add a split. Drag a marker to move it. Lines on the graphs follow the
                reference lap
                {anchorLap ? ` L${anchorLap.num}` : ""}.
              </p>
            </section>

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
                  cursor={cursor}
                  placeMode={placeMode}
                  onCursor={setCursor}
                  onPlace={placeFromTime}
                />
              ))}
            </div>

            {rows.length > 0 && chosenLaps.length > 0 ? (
              <div className="overflow-auto rounded-sm border border-border">
                <table className="w-full min-w-[36rem] border-collapse text-sm">
                  <thead className="bg-raised text-left text-xs tracking-wide text-muted uppercase">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Sector</th>
                      <th className="px-3 py-2 font-semibold">Track</th>
                      {chosenLaps.map((lap) => (
                        <th key={lap.num} className="px-3 py-2 text-right font-semibold">
                          L{lap.num}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-right font-semibold">Best</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.index} className="border-t border-border">
                        <td className="px-3 py-2 font-semibold">S{row.index}</td>
                        <td className="px-3 py-2 font-mono text-muted">
                          {(row.from * 100).toFixed(0)}–{(row.to * 100).toFixed(0)}%
                        </td>
                        {row.times.map((time, index) => {
                          const won = chosenLaps[index]?.num === row.bestLap;
                          return (
                            <td
                              key={chosenLaps[index]!.num}
                              className={`px-3 py-2 text-right font-mono ${won ? "text-best" : ""}`}
                            >
                              {formatLap(time)}
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

function fastest<T extends { duration: number; num: number }>(laps: T[]): T {
  return laps.reduce((best, lap) => (lap.duration < best.duration ? lap : best));
}

function formatDelta(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  if (seconds < -0.0005) return `${formatLap(seconds)} vs best lap`;
  if (seconds > 0.0005) return `+${formatLap(seconds)} vs best lap`;
  return "matches the best lap";
}
