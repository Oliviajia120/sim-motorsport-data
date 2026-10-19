export type NotePoint = { x: number; y: number };

export type NoteSeries = {
  name: string;
  color: string;
  points: NotePoint[];
  dash?: boolean;
};

export type NoteMarker = { x: number; color: string; kind: "brake" | "apex"; lane?: number };

export type NoteBand = { from: number; to: number; label: string };

export type NoteChart = {
  title: string;
  unit: string;
  xLabel: string;
  xMax: number;
  zeroLine?: boolean;
  fillToZero?: boolean;
  series: NoteSeries[];
  markers?: NoteMarker[];
  bands?: NoteBand[];
};

export type NoteLap = {
  name: string;
  time: string;
  color: string;
  role: string;
};

export type NoteCell = {
  text: string;
  delta: string;
  tone: "gain" | "loss" | "ref" | "plain";
};

export type NoteSector = {
  label: string;
  distance: string;
  cells: NoteCell[];
};

export type NoteLoss = { label: string; text: string };

export type CoachingNote = {
  track: string;
  rider: string;
  vehicle: string;
  fileName: string;
  when: string;
  template: string;
  ideal: string;
  laps: NoteLap[];
  sectorHeaders: string[];
  sectors: NoteSector[];
  lossesTitle: string;
  losses: NoteLoss[];
  emptyLosses: string;
  convention: string;
  charts: NoteChart[];
};

const PAPER = "#f4f1ec";
const INK = "#1c1917";
const MUTED = "#57534e";
const LINE = "#d6d3d1";
const LOSS = "#be123c";
const GAIN = "#047857";
const ACCENT = "#c2410c";

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > max) out = out.slice(0, -1);
  return `${out}…`;
}

function drawChart(ctx: CanvasRenderingContext2D, chart: NoteChart, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = "#fffdf9";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = LINE;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  const pad = { l: 58, r: 16, t: 28, b: 26 };
  const plotW = Math.max(1, w - pad.l - pad.r);
  const plotH = Math.max(1, h - pad.t - pad.b);
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const series of chart.series) {
    for (const point of series.points) {
      if (!Number.isFinite(point.y)) continue;
      if (point.y < yMin) yMin = point.y;
      if (point.y > yMax) yMax = point.y;
    }
  }
  if (!Number.isFinite(yMin)) {
    yMin = 0;
    yMax = 1;
  }
  if (chart.zeroLine) {
    yMin = Math.min(yMin, 0);
    yMax = Math.max(yMax, 0);
  }
  if (yMax - yMin < 1e-6) {
    yMin -= 1;
    yMax += 1;
  }
  const slack = (yMax - yMin) * 0.1;
  yMin -= slack;
  yMax += slack;
  const xOf = (value: number) => x + pad.l + (value / Math.max(chart.xMax, 0.001)) * plotW;
  const yOf = (value: number) => y + pad.t + (1 - (value - yMin) / (yMax - yMin)) * plotH;

  if (chart.bands?.length && chart.xMax > 0) {
    for (const band of chart.bands) {
      const x0 = xOf(Math.max(0, band.from));
      const x1 = xOf(Math.min(chart.xMax, band.to));
      ctx.fillStyle = "rgba(194,65,12,0.08)";
      ctx.fillRect(x0, y + pad.t, Math.max(1, x1 - x0), plotH);
    }
  }

  ctx.strokeStyle = "#e7e5e4";
  ctx.fillStyle = MUTED;
  ctx.font = "14px ui-monospace, monospace";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const value = yMax - ((yMax - yMin) * i) / 3;
    const py = y + pad.t + (plotH * i) / 3;
    ctx.beginPath();
    ctx.moveTo(x + pad.l, py);
    ctx.lineTo(x + w - pad.r, py);
    ctx.stroke();
    const label = chart.zeroLine ? value.toFixed(2) : Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
    ctx.fillText(label, x + 8, py + 4);
  }

  if (chart.fillToZero && chart.series[0]) {
    const points = chart.series[0].points;
    for (let i = 1; i < points.length; i++) {
      const left = points[i - 1]!;
      const right = points[i]!;
      const pieces: [NotePoint, NotePoint][] = [];
      if (left.y * right.y < 0) {
        const u = left.y / (left.y - right.y);
        const cross = { x: left.x + u * (right.x - left.x), y: 0 };
        pieces.push([left, cross], [cross, right]);
      } else pieces.push([left, right]);
      for (const [a, b] of pieces) {
        ctx.fillStyle = a.y + b.y >= 0 ? "rgba(190,18,60,0.16)" : "rgba(4,120,87,0.16)";
        ctx.beginPath();
        ctx.moveTo(xOf(a.x), yOf(a.y));
        ctx.lineTo(xOf(b.x), yOf(b.y));
        ctx.lineTo(xOf(b.x), yOf(0));
        ctx.lineTo(xOf(a.x), yOf(0));
        ctx.fill();
      }
    }
  }

  if (chart.zeroLine) {
    ctx.strokeStyle = "#a8a29e";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x + pad.l, yOf(0));
    ctx.lineTo(x + w - pad.r, yOf(0));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = MUTED;
    ctx.font = "13px sans-serif";
    ctx.fillText("ahead", x + pad.l + 6, yOf(0) + 16);
    ctx.fillText("behind", x + pad.l + 6, yOf(0) - 8);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(x + pad.l, y + pad.t, plotW, plotH);
  ctx.clip();
  for (const series of chart.series) {
    ctx.beginPath();
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(series.dash ? [6, 4] : []);
    let started = false;
    for (const point of series.points) {
      if (!Number.isFinite(point.y)) continue;
      const px = xOf(point.x);
      const py = yOf(point.y);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  for (const marker of chart.markers ?? []) {
    const px = xOf(marker.x);
    if (px < x + pad.l || px > x + w - pad.r) continue;
    const lane = marker.lane ?? 0;
    const py = y + pad.t + 8 + lane * 9;
    ctx.fillStyle = marker.color;
    ctx.beginPath();
    if (marker.kind === "brake") {
      ctx.moveTo(px, py + 6);
      ctx.lineTo(px - 4, py - 2);
      ctx.lineTo(px + 4, py - 2);
    } else {
      ctx.moveTo(px, py - 4);
      ctx.lineTo(px + 4, py);
      ctx.lineTo(px, py + 4);
      ctx.lineTo(px - 4, py);
    }
    ctx.fill();
  }

  ctx.fillStyle = INK;
  ctx.font = "600 16px sans-serif";
  const title = chart.unit ? `${chart.title}  ·  ${chart.unit}` : chart.title;
  ctx.fillText(fit(ctx, title, w - pad.l - 12), x + pad.l, y + 18);
  ctx.fillStyle = MUTED;
  ctx.font = "13px sans-serif";
  ctx.fillText("0", x + pad.l, y + h - 8);
  const end = chart.xLabel;
  ctx.fillText(end, x + w - pad.r - ctx.measureText(end).width, y + h - 8);
}

export function renderCoachingNote(canvas: HTMLCanvasElement, note: CoachingNote) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#e85d04";
  ctx.fillRect(0, 0, width, 12);

  const pad = 52;
  let y = 40;
  ctx.fillStyle = ACCENT;
  ctx.font = "600 16px sans-serif";
  ctx.fillText("SIM MOTORSPORT DATA", pad, y + 16);
  y += 28;
  ctx.fillStyle = INK;
  ctx.font = "700 40px sans-serif";
  ctx.fillText("Coaching note", pad, y + 40);
  y += 52;
  ctx.fillStyle = MUTED;
  ctx.font = "18px sans-serif";
  const who = [note.rider !== "—" ? note.rider : "", note.vehicle !== "—" ? note.vehicle : "", note.track]
    .filter(Boolean)
    .join("  ·  ");
  ctx.fillText(fit(ctx, who || note.track, width - pad * 2), pad, y + 18);
  y += 26;
  const fileLine = [note.fileName, note.when, note.template].filter(Boolean).join("  ·  ");
  ctx.fillText(fit(ctx, fileLine, width - pad * 2), pad, y + 18);
  y += 34;

  ctx.fillStyle = INK;
  ctx.font = "700 16px sans-serif";
  ctx.fillText("LAPS", pad, y + 16);
  if (note.ideal) {
    const ideal = `Theoretical best  ${note.ideal}`;
    ctx.font = "600 16px ui-monospace, monospace";
    ctx.fillStyle = GAIN;
    ctx.fillText(ideal, width - pad - ctx.measureText(ideal).width, y + 16);
  }
  y += 28;
  note.laps.forEach((lap) => {
    ctx.fillStyle = lap.color;
    ctx.beginPath();
    ctx.arc(pad + 7, y + 10, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = "600 18px sans-serif";
    ctx.fillText(lap.name, pad + 22, y + 16);
    ctx.font = "18px ui-monospace, monospace";
    ctx.fillText(lap.time, pad + 160, y + 16);
    ctx.font = "16px sans-serif";
    ctx.fillStyle = MUTED;
    ctx.fillText(lap.role, pad + 300, y + 16);
    y += 28;
  });
  y += 8;

  const columns = Math.max(1, note.sectorHeaders.length);
  const labelW = 150;
  const distW = 210;
  const tableW = width - pad * 2;
  const cellW = Math.max(80, (tableW - labelW - distW) / columns);
  const hasDelta = note.sectors.some((sector) => sector.cells.some((cell) => cell.delta));
  const rowH = note.sectors.length > 16 ? (hasDelta ? 32 : 24) : hasDelta ? 38 : 30;
  ctx.fillStyle = "#fffdf9";
  ctx.fillRect(pad, y, tableW, rowH * (note.sectors.length + 1));
  ctx.fillStyle = "#efeae3";
  ctx.fillRect(pad, y, tableW, rowH);
  const headers = ["Sector", "Distance", ...note.sectorHeaders];
  ctx.font = "600 14px sans-serif";
  ctx.fillStyle = MUTED;
  headers.forEach((header, index) => {
    const hx = pad + (index === 0 ? 10 : index === 1 ? labelW : labelW + distW + (index - 2) * cellW);
    ctx.fillText(fit(ctx, header, index < 2 ? (index === 0 ? labelW - 16 : distW - 12) : cellW - 10), hx, y + 20);
  });
  note.sectors.forEach((sector, rowIndex) => {
    const ry = y + rowH * (rowIndex + 1);
    if (rowIndex % 2 === 0) {
      ctx.fillStyle = "rgba(255,253,249,0.01)";
    } else {
      ctx.fillStyle = "rgba(28,25,23,0.03)";
      ctx.fillRect(pad, ry, tableW, rowH);
    }
    ctx.fillStyle = INK;
    ctx.font = "600 15px sans-serif";
    ctx.fillText(fit(ctx, sector.label, labelW - 16), pad + 10, ry + 20);
    ctx.font = "14px ui-monospace, monospace";
    ctx.fillStyle = MUTED;
    ctx.fillText(fit(ctx, sector.distance, distW - 12), pad + labelW, ry + 20);
    sector.cells.forEach((cell, index) => {
      const cx = pad + labelW + distW + index * cellW;
      ctx.fillStyle = INK;
      ctx.font = "15px ui-monospace, monospace";
      ctx.fillText(cell.text, cx, ry + (cell.delta ? 14 : 20));
      if (cell.delta) {
        ctx.font = "13px ui-monospace, monospace";
        ctx.fillStyle = cell.tone === "loss" ? LOSS : cell.tone === "gain" ? GAIN : MUTED;
        ctx.fillText(cell.delta, cx, ry + 26);
      }
    });
  });
  y += rowH * (note.sectors.length + 1) + 18;

  ctx.fillStyle = INK;
  ctx.font = "700 16px sans-serif";
  ctx.fillText(note.lossesTitle, pad, y + 16);
  y += 26;
  if (!note.losses.length) {
    ctx.fillStyle = MUTED;
    ctx.font = "16px sans-serif";
    ctx.fillText(note.emptyLosses, pad, y + 16);
    y += 28;
  } else {
    note.losses.forEach((loss, index) => {
      ctx.fillStyle = ACCENT;
      ctx.font = "700 16px sans-serif";
      ctx.fillText(String(index + 1), pad, y + 16);
      ctx.fillStyle = INK;
      ctx.font = "600 16px sans-serif";
      ctx.fillText(loss.label, pad + 28, y + 16);
      ctx.font = "16px ui-monospace, monospace";
      ctx.fillStyle = LOSS;
      ctx.fillText(loss.text, pad + 220, y + 16);
      y += 24;
    });
    y += 6;
  }
  ctx.fillStyle = MUTED;
  ctx.font = "14px sans-serif";
  ctx.fillText(fit(ctx, note.convention, width - pad * 2), pad, y + 16);
  y += 28;

  const charts = note.charts.filter((chart) => chart.series.some((series) => series.points.length > 1));
  const footer = 36;
  const gap = 12;
  const available = height - y - footer - gap;
  const chartH = charts.length ? Math.max(0, Math.min(340, Math.floor((available - gap * (charts.length - 1)) / charts.length))) : 0;
  charts.forEach((chart, index) => {
    drawChart(ctx, chart, pad, y + index * (chartH + gap), width - pad * 2, chartH);
  });

  ctx.fillStyle = MUTED;
  ctx.font = "13px sans-serif";
  const foot = "▲ brake on    ◆ apex    Positive time is behind the reference. Negative time is ahead.";
  ctx.fillText(foot, pad, height - 18);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pdfFromJpeg(jpeg: Uint8Array, pxW: number, pxH: number): Uint8Array {
  const enc = (text: string) => new TextEncoder().encode(text);
  const pageW = 595.28;
  const pageH = pageW * (pxH / pxW);
  const content = enc(`q\n${pageW.toFixed(2)} 0 0 ${pageH.toFixed(2)} 0 0 cm\n/Im1 Do\nQ\n`);
  const objects = [
    enc("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    enc("2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n"),
    enc(
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${pageH.toFixed(2)}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n`,
    ),
    concat([enc(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`), content, enc("endstream\nendobj\n")]),
    concat([
      enc(
        `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      enc("\nendstream\nendobj\n"),
    ]),
  ];
  const header = enc("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");
  const offsets = [0];
  let cursor = header.length;
  const chunks: Uint8Array[] = [header];
  for (const object of objects) {
    offsets.push(cursor);
    chunks.push(object);
    cursor += object.length;
  }
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  chunks.push(enc(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF`));
  return concat(chunks);
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeStem(value: string): string {
  const stem = value.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return stem.slice(0, 80) || "coaching-note";
}

export async function downloadCoachingNote(note: CoachingNote, kind: "png" | "pdf", stem: string): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = 1654;
  canvas.height = 2339;
  renderCoachingNote(canvas, note);
  const type = kind === "png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((result) => resolve(result), type, 0.92));
  if (!blob) throw new Error("Could not draw the coaching note.");
  const name = safeStem(stem);
  if (kind === "png") {
    saveBlob(blob, `${name}.png`);
    return;
  }
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const pdf = pdfFromJpeg(jpeg, canvas.width, canvas.height);
  const copy = new ArrayBuffer(pdf.byteLength);
  new Uint8Array(copy).set(pdf);
  saveBlob(new Blob([copy], { type: "application/pdf" }), `${name}.pdf`);
}
