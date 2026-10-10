"use client";

// Incident replay ("time machine"): plays the last 7 days of incidents back on the live map,
// hour by hour, so hotspots light up and fade. Self-contained: it owns one GeoJSON source and two
// circle layers drawn above everything else, and puts them back whenever the basemap style is
// swapped (the theme switch calls map.setStyle, which drops custom sources and layers).
import "./replay.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { CircleLayerSpecification, ExpressionSpecification, GeoJSONSource, Map as MLMap } from "maplibre-gl";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import type { Ev } from "@/lib/scoring";
import { EVENT_LABEL } from "@/lib/i18n";
import { fmtDate, fmtHour, placeOf } from "@/lib/format";

export type ReplayProps = {
  map: MLMap | null; // the live MapLibre map instance (may be null briefly)
  events: Ev[]; // all events (SF + Bay Area violent incidents and injury crashes)
  theme: "light" | "dark";
  onClose: () => void;
};

type Theme = ReplayProps["theme"];
type Kind = "crime" | "crash" | "shooting";
type Filter = "all" | "crime" | "crash";
type FeatureProps = { age: number; kind: Kind; pulse: number };
type FC = GeoJSON.FeatureCollection<GeoJSON.Point, FeatureProps>;

const SRC = "replay";
const GLOW = "replay-glow";
const DOT = "replay-dot";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const SPAN = 7 * DAY; // length of the replay
const WINDOW = 6 * HOUR; // how long an incident stays on the map
const BIN = 3 * HOUR; // sparkline bucket
const NBINS = SPAN / BIN; // 56 bars
const HOURS = SPAN / HOUR; // 168 slider steps
// Playback starts 3 days before the latest incident (the busiest stretch of the data);
// the slider still reaches back the full 7 days.
const LEAD = 72 * HOUR;
const FRAME_MS = 100; // ~10 fps
const SPEEDS = [1, 3, 6] as const; // replay hours per second
type Speed = (typeof SPEEDS)[number];
const PULSE_AGE = 0.35; // only the freshest incidents pulse (as a share of the 6 h window)
const SPARK_H = 24; // sparkline viewBox height
const MIN_BAR = 1.5; // keep single incidents visible on the sparkline

const RED = "#ff4d4d"; // violence
const AMBER = "#f5a524"; // injury crashes
const HOT = "#ff6b6b"; // shootings: larger, brighter core
const VIOLENCE = new Set(["shooting", "carjacking", "robbery", "agg_assault", "assault", "threat", "car_breakin"]);
const K_CRIME = 0;
const K_CRASH = 1;
const K_SHOOT = 2;
const KIND_NAME: Kind[] = ["crime", "crash", "shooting"];
const kindOf = (type: string) => (type === "shooting" ? K_SHOOT : type.startsWith("crash") ? K_CRASH : VIOLENCE.has(type) ? K_CRIME : -1);
const passes = (k: number, f: Filter) => f === "all" || (f === "crash") === (k === K_CRASH);

const FILTERS: { id: Filter; label: string; aria: string }[] = [
  { id: "all", label: "All", aria: "All incidents" },
  { id: "crime", label: "Violence", aria: "Violence only" },
  { id: "crash", label: "Crashes", aria: "Crashes only" },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// Event times are wall-clock times stored as UTC (Date.parse("YYYY-MM-DD") is UTC midnight), so
// they are read back with the UTC getters: the labels show the hour the incident was logged,
// with no time-zone or daylight-saving shifts.
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const timeLabel = (ms: number) => {
  const d = new Date(ms);
  return `${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()} · ${fmtHour(d.getUTCHours())}`;
};
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---------- data ----------

// Every event in the replay range, sorted by time, so each tick binary-searches its window.
type Index = {
  start: number;
  end: number;
  ts: Float64Array; // ascending
  ev: Ev[];
  kind: Uint8Array; // K_CRIME | K_CRASH | K_SHOOT
  place: (string | undefined)[]; // placeOf(e.x), filled lazily
  crimeBins: number[]; // violent incidents (shootings included) per 3 h
  crashBins: number[];
};

function buildIndex(events: Ev[]): Index | null {
  const n = events.length;
  const all = new Float64Array(n);
  const days = new Map<string, number>(); // ~700 distinct dates for ~44k events
  let end = -Infinity;
  for (let i = 0; i < n; i++) {
    const e = events[i];
    let day = days.get(e.d);
    if (day === undefined) days.set(e.d, (day = Date.parse(e.d)));
    all[i] = day + e.h * HOUR;
    if (all[i] > end) end = all[i];
  }
  if (!Number.isFinite(end)) return null;
  const start = end - SPAN;
  // Keep what the replay can show: (start - 6 h, end]. NaN timestamps fail the comparison.
  const keep: number[] = [];
  for (let i = 0; i < n; i++) if (all[i] > start - WINDOW && kindOf(events[i].t) >= 0) keep.push(i);
  keep.sort((a, b) => all[a] - all[b] || a - b);
  const ts = new Float64Array(keep.length);
  const kind = new Uint8Array(keep.length);
  const ev: Ev[] = new Array(keep.length);
  const crimeBins = new Array<number>(NBINS).fill(0);
  const crashBins = new Array<number>(NBINS).fill(0);
  keep.forEach((src, j) => {
    ts[j] = all[src];
    ev[j] = events[src];
    kind[j] = kindOf(events[src].t);
    if (ts[j] >= start) (kind[j] === K_CRASH ? crashBins : crimeBins)[Math.min(NBINS - 1, Math.floor((ts[j] - start) / BIN))]++;
  });
  return { start, end, ts, ev, kind, place: new Array(keep.length), crimeBins, crashBins };
}

// First index whose timestamp is > x.
function upper(ts: Float64Array, x: number) {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ts[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Win = { fc: FC; violent: number; crashes: number; shootings: number; busiest: { place: string; what: string } | null };
const EMPTY_FC: FC = { type: "FeatureCollection", features: [] };
const EMPTY_WIN: Win = { fc: EMPTY_FC, violent: 0, crashes: 0, shootings: 0, busiest: null };

// Incidents in (t - 6 h, t]. `clock` (ms) drives the glow pulse; null keeps it still.
function windowAt(ix: Index, t: number, filter: Filter, clock: number | null): Win {
  const lo = upper(ix.ts, t - WINDOW);
  const hi = upper(ix.ts, t);
  const features: FC["features"] = [];
  const perPlace = new Map<string, number>();
  let violent = 0;
  let crashes = 0;
  let shootings = 0;
  let best = "";
  let bestN = 0;
  // Newest first, so ties for the busiest place go to the most recent one.
  for (let i = hi - 1; i >= lo; i--) {
    const k = ix.kind[i];
    if (!passes(k, filter)) continue;
    const e = ix.ev[i];
    const age = (t - ix.ts[i]) / WINDOW; // 0 = just happened, 1 = about to drop off
    if (k === K_CRASH) crashes++;
    else violent++;
    if (k === K_SHOOT) shootings++;
    const pulse = clock !== null && age < PULSE_AGE ? (1 - age / PULSE_AGE) * (0.5 + 0.5 * Math.sin(clock / 160 + i)) : 0;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [e.lng, e.lat] }, properties: { age, kind: KIND_NAME[k], pulse } });
    const place = (ix.place[i] ??= placeOf(e.x));
    if (!place) continue;
    const n = (perPlace.get(place) ?? 0) + 1;
    perPlace.set(place, n);
    if (n > bestN) [best, bestN] = [place, n];
  }
  let busiest: Win["busiest"] = null;
  if (bestN) {
    const types = new Set<string>();
    for (let i = lo; i < hi; i++) if (ix.place[i] === best && passes(ix.kind[i], filter)) types.add(ix.ev[i].t);
    const only = types.size === 1 ? [...types][0] : "";
    const label = only ? (EVENT_LABEL.en[only] ?? only) : "";
    busiest = { place: best, what: label ? (bestN > 1 ? `${bestN}× ${label}` : label) : `${bestN} incidents` };
  }
  return { fc: { type: "FeatureCollection", features }, violent, crashes, shootings, busiest };
}

// ---------- map layers ----------

const AGE: ExpressionSpecification = ["get", "age"];
const KIND: ExpressionSpecification = ["get", "kind"];
// Pixel sizes shrink over the whole Bay Area and grow at street level.
const byZoom = (px: ExpressionSpecification): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], 8, ["*", 0.55, px], 12, px, 16, ["*", 1.7, px]];
// Newest on top, shootings above everything.
const SORT: ExpressionSpecification = ["+", ["match", KIND, "shooting", 2, 0], ["-", 1, AGE]];
const DOT_OPACITY: ExpressionSpecification = ["interpolate", ["linear"], AGE, 0, 1, 0.35, 0.8, 1, ["match", KIND, "shooting", 0.5, 0.2]];
const glowOpacity = (th: Theme): ExpressionSpecification => [
  "*",
  th === "dark" ? 0.7 : 0.55,
  ["interpolate", ["linear"], AGE, 0, 1, 0.4, 0.45, 1, 0],
  ["match", KIND, "shooting", 1, 0.75],
];
const dotStroke = (th: Theme): ExpressionSpecification => ["match", KIND, "shooting", "#ffffff", th === "dark" ? "rgba(14, 16, 18, 0.85)" : "#ffffff"];
const dotStrokeWidth = (th: Theme): ExpressionSpecification => ["match", KIND, "shooting", 1.8, th === "dark" ? 0.6 : 1];

const glowLayer = (th: Theme): CircleLayerSpecification => ({
  id: GLOW,
  type: "circle",
  source: SRC,
  layout: { "circle-sort-key": SORT },
  paint: {
    "circle-color": ["match", KIND, "crash", AMBER, RED],
    "circle-radius": byZoom([
      "*",
      ["match", KIND, "shooting", 26, 14],
      ["interpolate", ["linear"], AGE, 0, 1.15, 0.2, 1, 1, 0.5],
      ["+", 1, ["*", 0.45, ["get", "pulse"]]],
    ]),
    "circle-opacity": glowOpacity(th),
    "circle-blur": 1,
    "circle-pitch-alignment": "map",
  },
});

const dotLayer = (th: Theme): CircleLayerSpecification => ({
  id: DOT,
  type: "circle",
  source: SRC,
  layout: { "circle-sort-key": SORT },
  paint: {
    "circle-color": ["match", KIND, "crash", AMBER, "shooting", HOT, RED],
    "circle-radius": byZoom(["*", ["match", KIND, "shooting", 6.5, 4], ["interpolate", ["linear"], AGE, 0, 1.35, 0.12, 1, 1, 0.65]]),
    "circle-opacity": DOT_OPACITY,
    "circle-stroke-color": dotStroke(th),
    "circle-stroke-width": dotStrokeWidth(th),
    "circle-stroke-opacity": DOT_OPACITY,
  },
});

// ---------- component ----------

export default function Replay(p: ReplayProps) {
  const { map, events, theme, onClose } = p;
  const ix = useMemo(() => buildIndex(events), [events]);

  const [t, setT] = useState(-Infinity); // replay clock in ms, clamped into [start, end] below
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(3);
  const [filter, setFilter] = useState<Filter>("all");
  const [reduced, setReduced] = useState(false);
  const tRef = useRef(t);
  const speedRef = useRef<Speed>(speed);
  const themeRef = useRef(theme);
  const dataRef = useRef<FC>(EMPTY_FC);
  const titleId = useId();

  const cur = ix ? clamp(t, ix.start, ix.end) : 0;
  const atEnd = !!ix && cur >= ix.end;
  const label = ix ? timeLabel(cur) : events.length ? "No incident data" : "Loading incidents…";

  // Reduced motion: start paused and keep the glow still. Otherwise play right away.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    setPlaying(!mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Playback: ~10 fps, advancing speed/10 replay hours per frame; stops at the end.
  useEffect(() => {
    if (!playing || !ix) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = now - last;
      if (dt >= FRAME_MS - 5) {
        last = now;
        const next = Math.min(ix.end, clamp(tRef.current, ix.start, ix.end) + (speedRef.current * HOUR * Math.min(dt, 250)) / 1000);
        tRef.current = next;
        setT(next);
        if (next >= ix.end) setPlaying(false);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, ix]);

  const win = useMemo(
    () => (ix ? windowAt(ix, cur, filter, playing && !reduced ? performance.now() : null) : EMPTY_WIN),
    [ix, cur, filter, playing, reduced],
  );

  // Map: one source + two layers on top. Re-added after every style swap, removed on unmount.
  useEffect(() => {
    if (!map) return;
    const install = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: dataRef.current });
        if (!map.getLayer(GLOW)) map.addLayer(glowLayer(themeRef.current));
        if (!map.getLayer(DOT)) map.addLayer(dotLayer(themeRef.current));
      } catch {
        // The style is still loading; "style.load" calls this again once it's ready.
      }
    };
    install();
    map.on("style.load", install);
    return () => {
      map.off("style.load", install);
      try {
        if (map.getLayer(DOT)) map.removeLayer(DOT);
        if (map.getLayer(GLOW)) map.removeLayer(GLOW);
        if (map.getSource(SRC)) map.removeSource(SRC);
      } catch {
        // The map or its style is already gone.
      }
    };
  }, [map]);

  useEffect(() => {
    themeRef.current = theme;
    if (!map) return;
    try {
      if (map.getLayer(GLOW)) map.setPaintProperty(GLOW, "circle-opacity", glowOpacity(theme));
      if (map.getLayer(DOT)) {
        map.setPaintProperty(DOT, "circle-stroke-color", dotStroke(theme));
        map.setPaintProperty(DOT, "circle-stroke-width", dotStrokeWidth(theme));
      }
    } catch {
      // A style swap is in flight; "style.load" re-adds the layers with this theme.
    }
  }, [map, theme]);

  useEffect(() => {
    dataRef.current = win.fc;
    void map?.getSource<GeoJSONSource>(SRC)?.setData(win.fc);
  }, [map, win.fc]);

  // ---------- controls ----------

  const seek = useCallback(
    (ms: number) => {
      if (!ix) return;
      tRef.current = clamp(ms, ix.start, ix.end);
      setT(tRef.current);
    },
    [ix],
  );
  useEffect(() => {
    if (ix && tRef.current === -Infinity) seek(ix.end - LEAD);
  }, [ix, seek]);

  const toggle = () => {
    if (!ix) return;
    if (atEnd) {
      seek(ix.end - LEAD);
      setPlaying(true);
    } else setPlaying((v) => !v);
  };

  const pickSpeed = (s: Speed) => {
    speedRef.current = s;
    setSpeed(s);
  };

  // Clicking or dragging on the sparkline scrubs too (the slider is the keyboard control).
  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!ix || !r.width) return;
    seek(ix.start + Math.round(clamp((e.clientX - r.left) / r.width, 0, 1) * HOURS) * HOUR);
  };

  // Sparkline: incidents per 3 h for the current filter, square-root scaled so quiet stretches still show.
  const bars = useMemo(() => {
    if (!ix) return [];
    const pick = (i: number): [number, number] => [filter === "crash" ? 0 : ix.crimeBins[i], filter === "crime" ? 0 : ix.crashBins[i]];
    let max = 1;
    for (let i = 0; i < NBINS; i++) max = Math.max(max, pick(i)[0] + pick(i)[1]);
    return Array.from({ length: NBINS }, (_, i) => {
      const [a, b] = pick(i);
      const n = a + b;
      const h = n ? Math.max(MIN_BAR, SPARK_H * Math.sqrt(n / max)) : 0;
      return { crime: n ? (h * a) / n : 0, crash: n ? (h * b) / n : 0 };
    });
  }, [ix, filter]);

  // Day spans (wall-clock midnights) for the separators and the labels under the slider.
  // Partial days at either end are labelled only when they have room (and never on phones).
  const days = useMemo(() => {
    const out: { at: number; mid: number; label: string; wide: boolean; edge: boolean }[] = [];
    if (!ix) return out;
    for (let a = ix.start; a < ix.end; ) {
      const b = Math.min(ix.end, (Math.floor(a / DAY) + 1) * DAY);
      const d = new Date(a);
      out.push({ at: (a - ix.start) / SPAN, mid: ((a + b) / 2 - ix.start) / SPAN, label: `${WD[d.getUTCDay()]} ${d.getUTCDate()}`, wide: b - a >= 9 * HOUR, edge: b - a < DAY });
      a = b;
    }
    return out;
  }, [ix]);

  const hour = ix ? Math.floor((cur - ix.start) / HOUR + 1e-6) : 0; // slider position
  const head = ix ? (cur - ix.start) / BIN : 0; // playhead, in bars
  const lensFrom = Math.max(0, head - WINDOW / BIN);
  const nowFirst = Math.floor(lensFrom);
  const nowLast = Math.min(NBINS - 1, Math.floor(head));

  return (
    <section
      className="rp-card"
      data-rp-theme={theme}
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="rp-head">
        <span className={playing ? "rp-live rp-on" : "rp-live"} aria-hidden="true" />
        <h2 className="rp-title" id={titleId}>
          Incident replay
        </h2>
        <span className="rp-sub">{ix ? `${fmtDate(ymd(ix.start))} – ${fmtDate(ymd(ix.end))} · 6-hour window` : "Last 7 days"}</span>
        <button type="button" className="rp-x" onClick={onClose} aria-label="Close replay" title="Close">
          <X size={18} />
        </button>
      </header>

      <div className="rp-main">
        <button
          type="button"
          className="rp-play"
          onClick={toggle}
          disabled={!ix}
          aria-label={atEnd ? "Replay from the start" : playing ? "Pause replay" : "Play replay"}
          title={atEnd ? "Replay" : playing ? "Pause" : "Play"}
        >
          {atEnd ? <RotateCcw size={20} /> : playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
        <div className="rp-now">
          <div className="rp-time">{label}</div>
          {ix && (
            <p className="rp-counts">
              {filter !== "crash" && (
                <span className="rp-count">
                  <i className="rp-dot rp-dot-crime" aria-hidden="true" />
                  <b className="rp-num">{win.violent}</b> {plural(win.violent, "violent incident", "violent incidents")}
                </span>
              )}
              {filter !== "crime" && (
                <span className="rp-count">
                  <i className="rp-dot rp-dot-crash" aria-hidden="true" />
                  <b className="rp-num">{win.crashes}</b> {plural(win.crashes, "injury crash", "injury crashes")}
                </span>
              )}
              {filter !== "crash" && (
                <span className="rp-count">
                  <i className="rp-dot rp-dot-shot" aria-hidden="true" />
                  <b className="rp-num">{win.shootings}</b> {plural(win.shootings, "shooting", "shootings")}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="rp-seg rp-speed" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={s === speed ? "rp-on" : undefined}
              aria-pressed={s === speed}
              aria-label={`${s} ${plural(s, "hour", "hours")} per second`}
              onClick={() => pickSpeed(s)}
            >
              <span className="rp-num">{s}</span> h/s
            </button>
          ))}
        </div>
      </div>

      <div className="rp-track">
        <div
          className="rp-spark"
          aria-hidden="true"
          onPointerDown={(e) => {
            scrub(e);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e);
          }}
        >
          <svg viewBox={`0 0 ${NBINS} ${SPARK_H}`} preserveAspectRatio="none">
            {days.slice(1).map((d) => (
              <line key={d.at} className="rp-daytick" x1={d.at * NBINS} x2={d.at * NBINS} y1={0} y2={SPARK_H} vectorEffect="non-scaling-stroke" />
            ))}
            {ix && <rect className="rp-lens" x={lensFrom} y={0} width={head - lensFrom} height={SPARK_H} />}
            {bars.map((b, i) => (
              <g key={i} className={i < nowFirst ? "rp-past" : i <= nowLast ? "rp-now-bar" : "rp-next"}>
                {b.crime > 0 && <rect className="rp-bar-crime" x={i + 0.12} y={SPARK_H - b.crime} width={0.76} height={b.crime} />}
                {b.crash > 0 && <rect className="rp-bar-crash" x={i + 0.12} y={SPARK_H - b.crime - b.crash} width={0.76} height={b.crash} />}
              </g>
            ))}
            {ix && <line className="rp-head-line" x1={head} x2={head} y1={0} y2={SPARK_H} vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>
        <input
          className="rp-slider"
          type="range"
          min={0}
          max={HOURS}
          step={1}
          value={hour}
          disabled={!ix}
          aria-label="Replay time"
          aria-valuetext={label.replace(" · ", ", ")}
          onChange={(e) => ix && seek(ix.start + Number(e.currentTarget.value) * HOUR)}
          style={{ "--rp-f": hour / HOURS } as CSSProperties}
        />
        <div className="rp-days" aria-hidden="true">
          {days
            .filter((d) => d.wide)
            .map((d) => (
              <span key={d.at} className={d.edge ? "rp-edge" : undefined} style={{ left: `${d.mid * 100}%` }}>
                {d.label}
              </span>
            ))}
        </div>
      </div>

      <footer className="rp-foot">
        <div className="rp-seg" role="group" aria-label="Incident types">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={f.id === filter ? "rp-on" : undefined}
              aria-pressed={f.id === filter}
              aria-label={f.aria}
              onClick={() => setFilter(f.id)}
            >
              {f.id !== "all" && <i className={f.id === "crime" ? "rp-dot rp-dot-crime" : "rp-dot rp-dot-crash"} aria-hidden="true" />}
              {f.label}
            </button>
          ))}
        </div>
        <p className="rp-busy" title={win.busiest ? `Busiest now: ${win.busiest.place} · ${win.busiest.what}` : undefined}>
          {win.busiest ? (
            <>
              Busiest now: <b>{win.busiest.place}</b>
              <span className="rp-what"> · {win.busiest.what}</span>
            </>
          ) : ix ? (
            "No incidents in this 6-hour window"
          ) : null}
        </p>
      </footer>

      <p className="rp-sr" aria-live="polite">
        {atEnd && !playing ? "Replay finished." : ""}
      </p>
    </section>
  );
}
