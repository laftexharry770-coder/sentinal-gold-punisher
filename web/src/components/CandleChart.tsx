import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Candle, Position, Tick } from '@sentinal/shared';

interface Props {
  candles: Candle[];
  quote: Tick | null;
  positions?: Position[];
  height?: number;
  bars?: number;
}

const AXIS_WIDTH = 64;
const TIME_HEIGHT = 24;
const MIN_BARS = 20;
const MAX_BARS = 400;

const COLORS = {
  gridMinor: 'rgba(39, 44, 52, 0.5)',
  gridMajor: 'rgba(52, 58, 68, 0.75)',
  axis: '#71777f',
  axisStrong: '#a9aeb7',
  up: '#22d3a5',
  down: '#ff5c7a',
  wickUp: 'rgba(34, 211, 165, 0.8)',
  wickDown: 'rgba(255, 92, 122, 0.8)',
  price: '#aab1bb',
  buy: '#22d3a5',
  sell: '#ff5c7a',
  crosshair: 'rgba(169, 174, 183, 0.55)',
  tagInk: '#0b0d10',
};

/** What the pointer is over, in chart terms rather than pixels. */
interface Cursor {
  x: number;
  y: number;
  candle: Candle | null;
  price: number;
}

/** How much of the series is on screen: a window width and a distance from live. */
interface View {
  bars: number;
  /** Candles hidden off the right edge. Zero means pinned to the latest bar. */
  offset: number;
}

function formatClock(time: number): string {
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDay(time: number): string {
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(time);
}

/**
 * MT5-style candlestick canvas.
 *
 * Drawn on a plain 2D context rather than a charting dependency, so the
 * terminal stays one lightweight bundle and repaints cleanly at tick rate.
 *
 * It is navigable: drag to walk back through history, wheel or pinch to change
 * how much is in view, hover or hold for a crosshair reading the bar under the
 * pointer. Panning away from the latest bar pins the window, so the chart stops
 * chasing the live price while it is being read, and a control appears to
 * return to it.
 */
export function CandleChart({ candles, quote, positions = [], height = 340, bars = 90 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [view, setView] = useState<View>({ bars, offset: 0 });
  const [cursor, setCursor] = useState<Cursor | null>(null);

  // Drag and pinch state live in refs: they change per pointer event and must
  // not each cost a render.
  const drag = useRef<{ x: number; offset: number; moved: boolean } | null>(null);
  const pinch = useRef<{ distance: number; bars: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const live = quote ? (quote.bid + quote.ask) / 2 : null;
  const maxOffset = Math.max(0, candles.length - MIN_BARS);
  const following = view.offset === 0;

  /** The slice on screen, and the geometry every drawing pass shares. */
  const inView = useMemo(() => {
    const count = Math.min(view.bars, Math.max(1, candles.length));
    const end = Math.max(count, candles.length - view.offset);
    return candles.slice(Math.max(0, end - count), end);
  }, [candles, view.bars, view.offset]);

  const resetView = useCallback(() => setView((v) => ({ ...v, offset: 0 })), []);

  /* ------------------------------------------------------------------ */
  /* Interaction                                                         */
  /* ------------------------------------------------------------------ */

  const zoomBy = useCallback(
    (factor: number) => {
      setView((v) => {
        const next = Math.round(Math.min(MAX_BARS, Math.max(MIN_BARS, v.bars * factor)));
        return next === v.bars ? v : { ...v, bars: next };
      });
    },
    [],
  );

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const onWheel = (event: WheelEvent) => {
      // Only claim the gesture when it is a zoom; a plain page scroll over the
      // chart should still scroll the page.
      if (!event.ctrlKey && Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      event.preventDefault();
      zoomBy(event.deltaY > 0 ? 1.15 : 1 / 1.15);
    };

    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const geometry = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const plotW = wrap.clientWidth - AXIS_WIDTH;
    const plotH = height - TIME_HEIGHT;
    return { plotW, plotH, slot: plotW / Math.max(1, inView.length) };
  }, [height, inView.length]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), bars: view.bars };
      drag.current = null;
      return;
    }
    drag.current = { x: event.clientX, offset: view.offset, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const geo = geometry();
    if (!canvas || !geo) return;

    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    // Two fingers: scale the window instead of moving it.
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) {
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance > 0) {
          const ratio = pinch.current.distance / distance;
          const next = Math.round(Math.min(MAX_BARS, Math.max(MIN_BARS, pinch.current.bars * ratio)));
          setView((v) => (v.bars === next ? v : { ...v, bars: next }));
        }
      }
      return;
    }

    if (drag.current) {
      const dx = event.clientX - drag.current.x;
      if (Math.abs(dx) > 3) drag.current.moved = true;
      const shifted = drag.current.offset + Math.round(dx / Math.max(1, geo.slot));
      const clamped = Math.min(maxOffset, Math.max(0, shifted));
      setView((v) => (v.offset === clamped ? v : { ...v, offset: clamped }));
      return;
    }

    // No drag: read out whatever sits under the pointer.
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x > geo.plotW || y > geo.plotH) {
      setCursor(null);
      return;
    }
    const index = Math.min(inView.length - 1, Math.max(0, Math.floor(x / Math.max(1, geo.slot))));
    setCursor({ x, y, candle: inView[index] ?? null, price: priceAt(y) });
  };

  const endPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
    if (event.pointerType !== 'mouse') setCursor(null);
  };

  /* ------------------------------------------------------------------ */
  /* Scale                                                               */
  /* ------------------------------------------------------------------ */

  // The vertical scale is shared by the drawing pass and the crosshair, so it
  // is derived once from the same inputs both use.
  const scale = useMemo(() => {
    let high = -Infinity;
    let low = Infinity;
    for (const candle of inView) {
      if (candle.high > high) high = candle.high;
      if (candle.low < low) low = candle.low;
    }
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    // The live price and any open entry only stretch the scale while they are
    // actually in view; panned into history they would flatten it to nothing.
    if (following && live !== null) {
      high = Math.max(high, live);
      low = Math.min(low, live);
      for (const position of positions) {
        high = Math.max(high, position.openPrice);
        low = Math.min(low, position.openPrice);
      }
    }
    const pad = Math.max(0.25, (high - low) * 0.08);
    return { high: high + pad, low: low - pad, span: Math.max(0.01, high - low + pad * 2) };
  }, [inView, live, positions, following]);

  const priceAt = (y: number): number => {
    const geo = geometry();
    if (!geo || !scale) return 0;
    return scale.high - (y / geo.plotH) * scale.span;
  };

  /* ------------------------------------------------------------------ */
  /* Paint                                                               */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx || !scale) return;

      const dpr = globalThis.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      const h = height;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, h);

      const visible = inView;
      if (visible.length === 0) return;

      const plotW = width - AXIS_WIDTH;
      const plotH = h - TIME_HEIGHT;
      const y = (price: number) => ((scale.high - price) / scale.span) * plotH;

      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;

      // --- grid + price axis ---
      const rows = 6;
      for (let i = 0; i <= rows; i += 1) {
        const py = Math.round((plotH / rows) * i) + 0.5;
        ctx.strokeStyle = i === 0 || i === rows ? COLORS.gridMajor : COLORS.gridMinor;
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(plotW, py);
        ctx.stroke();

        const price = scale.high - (scale.span / rows) * i;
        ctx.fillStyle = COLORS.axis;
        ctx.textAlign = 'left';
        ctx.fillText(price.toFixed(2), plotW + 8, Math.min(plotH - 7, Math.max(7, py)));
      }

      // --- candles ---
      const slot = plotW / visible.length;
      const bodyW = Math.max(1, Math.min(13, slot * 0.64));
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
      let lastDay = '';
      visible.forEach((candle, index) => {
        if (index % labelEvery !== 0) return;
        const cx = index * slot + slot / 2;
        // A date only where the day turns, so the axis stays readable when the
        // window is wide enough to span more than one.
        const day = formatDay(candle.time);
        const label = day === lastDay ? formatClock(candle.time) : day;
        lastDay = day;
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
        if (py >= 0 && py <= plotH) {
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
          ctx.fillStyle = COLORS.tagInk;
          ctx.textAlign = 'center';
          ctx.fillText(live.toFixed(2), plotW + AXIS_WIDTH / 2, py);
        }
      }

      // --- crosshair ---
      if (cursor) {
        ctx.strokeStyle = COLORS.crosshair;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(cursor.x) + 0.5, 0);
        ctx.lineTo(Math.round(cursor.x) + 0.5, plotH);
        ctx.moveTo(0, Math.round(cursor.y) + 0.5);
        ctx.lineTo(plotW, Math.round(cursor.y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);

        const tagH = 17;
        ctx.fillStyle = '#2e343d';
        ctx.fillRect(plotW + 2, cursor.y - tagH / 2, AXIS_WIDTH - 4, tagH);
        ctx.fillStyle = COLORS.tagInk;
        ctx.textAlign = 'center';
        ctx.fillText(cursor.price.toFixed(2), plotW + AXIS_WIDTH / 2, cursor.y);

        if (cursor.candle) {
          const label = formatClock(cursor.candle.time);
          const w = ctx.measureText(label).width + 14;
          const x = Math.min(plotW - w, Math.max(0, cursor.x - w / 2));
          ctx.fillStyle = '#2e343d';
          ctx.fillRect(x, plotH + 2, w, TIME_HEIGHT - 4);
          ctx.fillStyle = COLORS.tagInk;
          ctx.fillText(label, x + w / 2, plotH + TIME_HEIGHT / 2);
        }
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [inView, positions, height, live, scale, cursor]);

  const reading = cursor?.candle ?? inView[inView.length - 1] ?? null;

  return (
    <div>
      {/*
        The readout and the controls sit in their own strip rather than
        floating over the plot. Overlaid, they collided with each other and
        with the price axis on a narrow screen — the numbers a chart exists to
        show were the ones being covered.
      */}
      <div className="flex items-start justify-between gap-2 px-2 pb-1.5 pt-0.5">
        <div className="flex min-w-0 items-center gap-x-2 overflow-hidden text-[0.6875rem] whitespace-nowrap">
          {reading && (
            <>
              {/* The clock is on the axis and in the crosshair tag already, so
                  it yields first when the strip runs out of room. */}
              <span className="tabular hidden font-semibold text-[var(--color-ink-dim)] xs:inline sm:inline">
                {formatClock(reading.time)}
              </span>
              {(['open', 'high', 'low', 'close'] as const).map((key) => (
                <span key={key} className="tabular text-[var(--color-ink-muted)]">
                  {key[0]?.toUpperCase()}
                  <span className={`ml-0.5 ${reading.close >= reading.open ? 'text-profit' : 'text-loss'}`}>
                    {reading[key].toFixed(2)}
                  </span>
                </span>
              ))}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!following && (
            <button
              className="btn btn-ghost px-2 py-0.5 text-[0.625rem] uppercase tracking-wide"
              onClick={resetView}
            >
              Back to live
            </button>
          )}
          <span className="tabular hidden text-[0.625rem] text-[var(--color-ink-muted)] sm:inline">
            {inView.length} bars
          </span>
          <button
            className="btn btn-ghost px-2 py-0.5 text-xs leading-none"
            aria-label="Zoom out"
            onClick={() => zoomBy(1.3)}
          >
            −
          </button>
          <button
            className="btn btn-ghost px-2 py-0.5 text-xs leading-none"
            aria-label="Zoom in"
            onClick={() => zoomBy(1 / 1.3)}
          >
            +
          </button>
        </div>
      </div>

      <div ref={wrapRef} className="w-full">
        <canvas
          ref={canvasRef}
          // pan-y, not none: the chart takes horizontal drags, and the page
          // keeps its vertical scroll. Claiming both would make the chart a
          // dead zone the page cannot be scrolled through on a phone — the
          // zoom buttons cover what pinching would have done.
          className="block w-full cursor-crosshair touch-pan-y select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onPointerLeave={() => setCursor(null)}
          onDoubleClick={resetView}
        />
      </div>
    </div>
  );
}

/** Compact equity/balance line used on the dashboard tiles. */
export function Sparkline({
  points,
  height = 64,
  color = '#9aa2ad',
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
      const dpr = globalThis.devicePixelRatio || 1;
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
