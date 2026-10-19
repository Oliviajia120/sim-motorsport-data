import { useEffect, useRef, type PointerEvent } from "react";
import type { Sample } from "@/lib/telemetry";

export type TraceSeries = {
  name: string;
  color: string;
  samples: Sample[];
  scale: number;
};

type Props = {
  title: string;
  unit: string;
  series: TraceSeries[];
  xMax: number;
  splitTimes: number[];
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
  }, [series, xMax, splitTimes, cursor, title, unit]);

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
