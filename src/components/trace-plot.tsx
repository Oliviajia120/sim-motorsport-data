import { useEffect, useRef, type PointerEvent } from "react";
import type { Sample } from "@/lib/telemetry";

export type TraceSeries = {
  name: string;
  color: string;
  samples: Sample[];
  scale: number;
};

export type PlotMarker = { t: number; color: string; kind: "brake" | "apex"; lane?: number };

type Props = {
  title: string;
  unit: string;
  series: TraceSeries[];
  xMax: number;
  splitTimes: number[];
  markers?: PlotMarker[];
  cursor: number | null;
  placeMode: boolean;
  onCursor: (time: number | null) => void;
  onPlace: (time: number) => void;
};

export function TracePlot({
  title,
  unit,
  series,
  xMax,
  splitTimes,
  markers = [],
  cursor,
  placeMode,
  onCursor,
  onPlace,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pad = { l: 52, r: 12, t: 22, b: 22 };
    const plotW = Math.max(1, width - pad.l - pad.r);
    const plotH = Math.max(1, height - pad.t - pad.b);

    ctx.clearRect(0, 0, width, height);
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
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
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
    ctx.lineWidth = 1;
    ctx.font = "11px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.fillStyle = "#8e98a3";
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(width - pad.r, y);
      ctx.stroke();
      const value = yMax - ((yMax - yMin) * i) / 4;
      ctx.fillText(value.toFixed(0), 4, y + 3);
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
    ctx.lineWidth = 1;
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
      const y = pad.t + 7 + (marker.lane ?? 0) * 8;
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
      ctx.strokeStyle = "#e7ebef";
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = "#e7ebef";
    ctx.font = "600 12px Barlow, ui-sans-serif, sans-serif";
    ctx.fillText(unit ? `${title}  ·  ${unit}` : title, pad.l, 14);
    ctx.fillStyle = "#8e98a3";
    ctx.font = "11px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.fillText("0", pad.l, height - 6);
    const endLabel = `${xMax.toFixed(0)}s`;
    ctx.fillText(endLabel, width - pad.r - ctx.measureText(endLabel).width, height - 6);
  }, [series, xMax, splitTimes, markers, cursor, title, unit]);

  function timeFromEvent(event: PointerEvent<HTMLCanvasElement>): number | null {
    const canvas = ref.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const padL = 52;
    const padR = 12;
    const x = event.clientX - rect.left - padL;
    const plotW = rect.width - padL - padR;
    if (plotW <= 0) return null;
    const t = (x / plotW) * xMax;
    if (t < 0 || t > xMax) return null;
    return t;
  }

  return (
    <div ref={wrapRef} className="h-40 w-full overflow-hidden rounded-sm border border-border bg-surface">
      <canvas
        ref={ref}
        className="h-full w-full cursor-crosshair"
        onPointerMove={(event) => {
          const t = timeFromEvent(event);
          if (t != null) onCursor(t);
        }}
        onPointerLeave={() => onCursor(null)}
        onPointerDown={(event) => {
          if (!placeMode) return;
          const t = timeFromEvent(event);
          if (t != null) onPlace(t);
        }}
      />
    </div>
  );
}

export type DeltaSeries = {
  name: string;
  color: string;
  points: { metres: number; delta: number }[];
};

export function DeltaPlot({
  series,
  metresMax,
  bands,
}: {
  series: DeltaSeries[];
  metresMax: number;
  bands: { from: number; to: number }[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
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
    for (const band of bands) ctx.fillRect(xOf(band.from), pad.t, Math.max(1, xOf(band.to) - xOf(band.from)), plotH);
    ctx.strokeStyle = "#2a3036";
    ctx.font = "11px 'IBM Plex Mono', ui-monospace, monospace";
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
        const pieces: [typeof left, typeof right][] = [];
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
    ctx.font = "11px Barlow, ui-sans-serif, sans-serif";
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
    ctx.fillStyle = "#e7ebef";
    ctx.font = "600 12px Barlow, ui-sans-serif, sans-serif";
    ctx.fillText("Time delta  ·  s", pad.l, 14);
    ctx.fillStyle = "#8e98a3";
    ctx.font = "11px 'IBM Plex Mono', ui-monospace, monospace";
    const end = `${Math.round(metresMax)} m`;
    ctx.fillText("0 m", pad.l, height - 8);
    ctx.fillText(end, width - pad.r - ctx.measureText(end).width, height - 8);
  }, [series, metresMax, bands]);

  return (
    <div ref={wrapRef} className="h-52 w-full overflow-hidden rounded-sm border border-border bg-surface">
      <canvas ref={ref} className="h-full w-full" />
    </div>
  );
}
