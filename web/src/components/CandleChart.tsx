import { useEffect, useRef } from 'react';
import type { Candle, Position, Tick } from '@sentinal/shared';

interface Props {
  candles: Candle[];
  quote: Tick | null;
  positions?: Position[];
  height?: number;
  bars?: number;
}

const AXIS_WIDTH = 62;
const TIME_HEIGHT = 22;

const COLORS = {
  grid: 'rgba(28, 41, 66, 0.55)',
  axis: '#6f83a3',
  up: '#22d3a5',
  down: '#ff5c7a',
  wickUp: 'rgba(34, 211, 165, 0.85)',
  wickDown: 'rgba(255, 92, 122, 0.85)',
  price: '#3b82f6',
  buy: '#22d3a5',
  sell: '#ff5c7a',
};

/**
 * MT5-style candlestick canvas.
 *
 * Rendered on a plain 2D context rather than a charting dependency so the
 * terminal stays a single lightweight bundle and repaints cleanly at tick rate.
 */
export function CandleChart({ candles, quote, positions = [], height = 340, bars = 90 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      const h = height;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, h);

      const visible = candles.slice(-bars);
      if (visible.length === 0) return;

      const plotW = width - AXIS_WIDTH;
      const plotH = h - TIME_HEIGHT;

      let high = -Infinity;
      let low = Infinity;
      for (const c of visible) {
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
      }
      const live = quote ? (quote.bid + quote.ask) / 2 : null;
      if (live !== null) {
        high = Math.max(high, live);
        low = Math.min(low, live);
      }
      for (const p of positions) {
        high = Math.max(high, p.openPrice);
        low = Math.min(low, p.openPrice);
      }

      const pad = Math.max(0.25, (high - low) * 0.08);
      high += pad;
      low -= pad;
      const span = Math.max(0.01, high - low);
      const y = (price: number) => ((high - price) / span) * plotH;

      // --- grid + price axis ---
      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      const rows = 6;
      for (let i = 0; i <= rows; i += 1) {
        const py = Math.round((plotH / rows) * i) + 0.5;
        ctx.strokeStyle = COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(plotW, py);
        ctx.stroke();

        const price = high - (span / rows) * i;
        ctx.fillStyle = COLORS.axis;
        ctx.textAlign = 'left';
        // Keep the first and last labels fully inside the canvas.
        ctx.fillText(price.toFixed(2), plotW + 8, Math.min(plotH - 7, Math.max(7, py)));
      }

      // --- candles ---
      const slot = plotW / visible.length;
      const bodyW = Math.max(1.5, Math.min(11, slot * 0.62));
      visible.forEach((candle, index) => {
        const cx = index * slot + slot / 2;
        const rising = candle.close >= candle.open;
        ctx.strokeStyle = rising ? COLORS.wickUp : COLORS.wickDown;
        ctx.beginPath();
        ctx.moveTo(Math.round(cx) + 0.5, y(candle.high));
        ctx.lineTo(Math.round(cx) + 0.5, y(candle.low));
        ctx.stroke();

        const top = y(Math.max(candle.open, candle.close));
        const bottom = y(Math.min(candle.open, candle.close));
        ctx.fillStyle = rising ? COLORS.up : COLORS.down;
        ctx.fillRect(cx - bodyW / 2, top, bodyW, Math.max(1, bottom - top));
      });

      // --- time axis ---
      ctx.fillStyle = COLORS.axis;
      ctx.textAlign = 'center';
      const labelEvery = Math.max(1, Math.floor(visible.length / 6));
      visible.forEach((candle, index) => {
        if (index % labelEvery !== 0) return;
        const cx = index * slot + slot / 2;
        const time = new Date(candle.time);
        const label = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
        ctx.fillText(label, cx, plotH + TIME_HEIGHT / 2);
      });

      // --- open position entry lines ---
      for (const position of positions) {
        const py = Math.round(y(position.openPrice)) + 0.5;
        if (py < 0 || py > plotH) continue;
        ctx.strokeStyle = position.side === 'buy' ? COLORS.buy : COLORS.sell;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(plotW, py);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // --- live price line + tag ---
      if (live !== null) {
        const py = Math.round(y(live)) + 0.5;
        ctx.strokeStyle = COLORS.price;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(plotW, py);
        ctx.stroke();
        ctx.setLineDash([]);

        const tagH = 17;
        ctx.fillStyle = COLORS.price;
        ctx.fillRect(plotW + 2, py - tagH / 2, AXIS_WIDTH - 4, tagH);
        ctx.fillStyle = '#f4f8ff';
        ctx.textAlign = 'center';
        ctx.fillText(live.toFixed(2), plotW + AXIS_WIDTH / 2, py);
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [candles, quote, positions, height, bars]);

  return (
    <div ref={wrapRef} className="w-full">
      <canvas ref={canvasRef} className="block w-full" />
    </div>
  );
}

/** Compact equity/balance line used on the dashboard tiles. */
export function Sparkline({
  points,
  height = 64,
  color = '#3b82f6',
}: {
  points: number[];
  height?: number;
  color?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx || points.length < 2) return;
      const dpr = window.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const min = Math.min(...points);
      const max = Math.max(...points);
      const span = Math.max(0.0001, max - min);
      const step = width / (points.length - 1);
      const y = (v: number) => height - 4 - ((v - min) / span) * (height - 8);

      ctx.beginPath();
      points.forEach((value, index) => {
        const px = index * step;
        if (index === 0) ctx.moveTo(px, y(value));
        else ctx.lineTo(px, y(value));
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.stroke();

      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, `${color}38`);
      gradient.addColorStop(1, `${color}00`);
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [points, height, color]);

  return (
    <div ref={wrapRef} className="w-full">
      <canvas ref={canvasRef} className="block w-full" />
    </div>
  );
}
