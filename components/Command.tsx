"use client";

// NorthStar Command: a city operations view drawn around a transparent window onto the live
// map. Panels sit on the edges and the middle stays clear, so the map can still be dragged.
// Everything here is about events and places, never people: no identities, faces, plates or
// individual tracks.
import "./command.css";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cellToLatLng } from "h3-js";
import {
  Activity,
  AudioWaveform,
  BadgeCheck,
  BellRing,
  Camera,
  Car,
  Cctv,
  ChartColumn,
  CloudSun,
  Construction,
  Database,
  LocateFixed,
  Megaphone,
  Moon,
  OctagonAlert,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Smartphone,
  Sparkles,
  Sun,
  TrafficCone,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import type { CellRisk, Ev, LiveZone } from "@/lib/scoring";
import type { Anomaly, Call, Constellation, Forecast } from "@/lib/intel";
import { DICTS, EVENT_LABEL, type Key } from "@/lib/i18n";
import { fmtAgo, fmtHour, placeOf } from "@/lib/format";
import Galaxy from "./Galaxy";
import type { LogEntry, Sources } from "./Engine";

export type TrafficIncident = {
  id: string;
  kind: "accident" | "jam" | "closure" | "roadworks" | "hazard" | "other";
  title: string; // e.g. "Accident on US-101 N"
  detail: string; // e.g. "Stationary traffic · 6 min delay"
  delayMin: number; // minutes of delay (0 if unknown)
  magnitude: number; // 0..4 severity
  lng: number;
  lat: number;
};

export type CommandProps = {
  theme: "light" | "dark";
  events: Ev[];
  cells: Map<string, CellRisk>;
  zones: LiveZone[]; // live phone gunshot alerts (kind "sound") and community reports (kind "report")
  sources: Sources | null; // live feeds: cameras, calls24, feeds, weather
  anomalies: Anomaly[];
  constellations: Constellation[];
  forecast: Forecast;
  sensors: { phones: number; cells: { cell: string; n: number }[] };
  corroborated: Map<string, Call>; // sound-alert id -> matching SFPD gun call
  traffic: TrafficIncident[]; // live TomTom incidents (may be empty)
  log: LogEntry[]; // engine event log, newest first
  onExit: () => void;
  onFocus: (lng: number, lat: number, zoom?: number) => void; // fly the map there
};

type Pt = { lat: number; lng: number };
type Kind = "sound" | "report" | "anomaly" | "traffic" | "call";
type Tone = Kind | "sensor" | "cam";
type Item = {
  id: string;
  kind: Kind;
  t: number; // when it happened (traffic: when this console first saw it)
  seen: number; // first sighting here; negative = already there when the console opened
  title: string;
  place: string;
  lat: number;
  lng: number;
  icon?: LucideIcon;
  verified?: Call; // SFPD gun call that backs up a phone sound alert
  severe?: boolean;
};

const FEED_MAX = 40;
const TRAFFIC_MAX = 8;
const NO_CALLS: Call[] = [];
const NO_CAMS: Sources["cameras"] = [];
const NO_FEEDS: Sources["feeds"] = [];

const KIND: Record<Kind, { label: string; icon: LucideIcon }> = {
  sound: { label: "Gunshot", icon: AudioWaveform },
  report: { label: "Report", icon: Megaphone },
  anomaly: { label: "Anomaly", icon: ShieldAlert },
  traffic: { label: "Traffic", icon: TrafficCone },
  call: { label: "SFPD", icon: Siren },
};
const TRAFFIC_ICON: Record<TrafficIncident["kind"], LucideIcon> = {
  accident: Car,
  jam: TrafficCone,
  closure: OctagonAlert,
  roadworks: Construction,
  hazard: TriangleAlert,
  other: TrafficCone,
};

// ---------- small helpers ----------
const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
const sentence = (s: string) => {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const km = (a: Pt, b: Pt) => Math.hypot((a.lng - b.lng) * 88, (a.lat - b.lat) * 111);
const hasPoint = (x: Pt) => Number.isFinite(x.lat) && Number.isFinite(x.lng);
const iso = (t: number) => (Number.isFinite(t) ? new Date(t).toISOString() : undefined);
const timeOfDay = (t: number, seconds = false) =>
  new Date(t).toLocaleTimeString("en-US", seconds ? { hour: "numeric", minute: "2-digit", second: "2-digit" } : { hour: "numeric", minute: "2-digit" });
const shortDate = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const withMinute = (url: string, minute: number) => `${url}${url.includes("?") ? "&" : "?"}t=${minute}`;
const bySeverity = (a: TrafficIncident, b: TrafficIncident) => b.magnitude - a.magnitude || b.delayMin - a.delayMin;
const cellPoint = (cell: string): Pt | null => {
  try {
    const [lat, lng] = cellToLatLng(cell);
    return { lat, lng };
  } catch {
    return null;
  }
};

// ---------- hooks ----------
const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (cb: () => void) => {
  const m = window.matchMedia(REDUCED);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
function useReducedMotion() {
  return useSyncExternalStore(subscribeMotion, () => window.matchMedia(REDUCED).matches, () => false);
}

// Re-render on a beat aligned to the wall clock (each second, each minute, ...).
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let id: ReturnType<typeof setTimeout> | undefined;
    const wait = () => ms - (Date.now() % ms) + 5;
    const tick = () => {
      setNow(Date.now());
      id = setTimeout(tick, wait());
    };
    id = setTimeout(tick, wait());
    return () => clearTimeout(id);
  }, [ms]);
  return now;
}

// Numbers ease to their new value from wherever they were, instead of jumping.
function useCountUp(target: number, still: boolean) {
  const [shown, setShown] = useState(0);
  const at = useRef(0);
  useEffect(() => {
    if (still) return;
    let raf = 0;
    const from = at.current;
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 900);
      at.current = from + (target - from) * (1 - Math.pow(1 - k, 3));
      setShown(at.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, still]);
  return still ? target : shown;
}

// One merged, newest-first timeline of everything live.
function useFeed(p: CommandProps, calls: Call[], near: (lat: number, lng: number) => string) {
  const seen = useRef(new Map<string, number>());
  const trafficPrimed = useRef(false);
  const [opened] = useState(() => Date.now());
  const { zones, anomalies, traffic, corroborated } = p;
  return useMemo(() => {
    const all: Item[] = [];
    const add = (it: Omit<Item, "seen">) => {
      if (hasPoint(it) && Number.isFinite(it.t)) all.push({ ...it, seen: 0 });
    };

    for (const z of zones) {
      if (z.kind === "sound") {
        const v = corroborated.get(z.id);
        add({
          id: `z:${z.id}`,
          kind: "sound",
          t: z.ts,
          title: `${z.level === "confirmed" ? "Confirmed" : "Possible"} gunshot · ${plural(z.count, "phone")}`,
          place: v ? `near ${titleCase(v.where)}` : near(z.lat, z.lng),
          lat: z.lat,
          lng: z.lng,
          verified: v,
          severe: z.level === "confirmed" || !!v,
        });
      } else {
        const label = z.category ? DICTS.en[`cat_${z.category}` as Key] : undefined;
        add({ id: `z:${z.id}`, kind: "report", t: z.ts, title: label || "Community report", place: `${near(z.lat, z.lng)} · ${plural(z.count, "report")}`, lat: z.lat, lng: z.lng });
      }
    }

    for (const a of anomalies) {
      const last = a.calls.reduce((m, c) => (Number.isFinite(c.ts) ? Math.max(m, c.ts) : m), 0);
      const where = a.calls[0]?.where;
      add({
        id: `a:${a.cell}`,
        kind: "anomaly",
        t: last || Date.now(),
        title: `${a.n} violent calls in 3 h · ${Math.round(a.n / Math.max(a.expected, 0.15))}× normal`,
        place: where ? `near ${titleCase(where)}` : near(a.lat, a.lng),
        lat: a.lat,
        lng: a.lng,
      });
    }

    // Only the most serious traffic incidents: a ticker full of minor jams is noise.
    for (const x of [...traffic].sort(bySeverity).slice(0, TRAFFIC_MAX)) {
      add({ id: `t:${x.id}`, kind: "traffic", t: 0, title: x.title || "Traffic incident", place: x.detail || near(x.lat, x.lng), lat: x.lat, lng: x.lng, icon: TRAFFIC_ICON[x.kind] ?? TrafficCone });
    }

    const dup = new Set<string>();
    for (const c of calls) {
      const id = `c:${c.ts}:${c.type}:${c.where}`;
      if (dup.has(id)) continue;
      dup.add(id);
      add({ id, kind: "call", t: c.ts, title: sentence(c.type), place: `near ${titleCase(c.where)}`, lat: c.lat, lng: c.lng });
    }

    // First sightings mark genuinely new arrivals. Items already there when the console
    // opened, arriving as one big batch (a feed reload) or in the first traffic load don't
    // count as new. Traffic incidents carry no timestamp: new ones sort by when they first
    // appeared; ones already active sort behind the last half hour of timed events.
    const now = Date.now();
    const unseen = all.filter((it) => !seen.current.has(it.id));
    const bulk = now - opened < 6000 || unseen.length > 12;
    for (const it of unseen) {
      const firstTraffic = it.kind === "traffic" && !trafficPrimed.current;
      seen.current.set(it.id, bulk || firstTraffic ? -now : now);
    }
    if (unseen.some((it) => it.kind === "traffic")) trafficPrimed.current = true;
    for (const it of all) {
      it.seen = seen.current.get(it.id) ?? -now;
      if (it.kind === "traffic") it.t = it.seen < 0 ? -it.seen - 30 * 60e3 : it.seen;
    }
    all.sort((a, b) => b.t - a.t);
    return { items: all.slice(0, FEED_MAX), total: all.length };
  }, [zones, anomalies, traffic, corroborated, calls, near, opened]);
}

// ---------- the view ----------
export default function Command(p: CommandProps) {
  const still = useReducedMotion();
  const calls = p.sources?.calls24 ?? NO_CALLS;
  const cams = p.sources?.cameras ?? NO_CAMS;
  const feeds = p.sources?.feeds ?? NO_FEEDS;
  const loading = !p.sources;
  const dark = p.theme === "dark";

  // Esc leaves command mode, unless someone is typing or a control inside used the key.
  const exit = useRef(p.onExit);
  useEffect(() => {
    exit.current = p.onExit;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      exit.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Name a spot after the closest recorded incident or dispatch call (within ~0.3 mi).
  const near = useMemo(() => {
    const events = p.events;
    return (lat: number, lng: number) => {
      const here = { lat, lng };
      let best = 0.45;
      let name = "";
      for (const e of events) {
        if (Math.abs(e.lat - lat) > 0.005 || Math.abs(e.lng - lng) > 0.006) continue;
        const d = km(e, here);
        if (d < best) [best, name] = [d, placeOf(e.x)];
      }
      for (const c of calls) {
        if (!hasPoint(c)) continue;
        const d = km(c, here);
        if (d < best) [best, name] = [d, titleCase(c.where)];
      }
      return name ? `near ${name}` : `${lat.toFixed(4)}°N, ${Math.abs(lng).toFixed(4)}°W`;
    };
  }, [p.events, calls]);

  // Most common street name among a block's recorded events.
  const placeFor = useMemo(() => {
    const memo = new Map<string, string>();
    return (cell: string) => {
      let name = memo.get(cell);
      if (name === undefined) {
        const evs = p.cells.get(cell)?.events ?? p.events.filter((e) => e.c === cell);
        const n = new Map<string, number>();
        for (const e of evs) {
          const s = placeOf(e.x);
          if (s) n.set(s, (n.get(s) ?? 0) + 1);
        }
        name = [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Unnamed block";
        memo.set(cell, name);
      }
      return name;
    };
  }, [p.cells, p.events]);

  const feed = useFeed(p, calls, near);

  const callStats = useMemo(() => {
    const now = Date.now();
    let latest: Call | null = null;
    let lastHour = 0;
    for (const c of calls) {
      if (now - c.ts < 3600e3) lastHour++;
      if (hasPoint(c) && (!latest || c.ts > latest.ts)) latest = c;
    }
    return { latest, lastHour };
  }, [calls]);
  const worstTraffic = useMemo(() => p.traffic.filter(hasPoint).sort(bySeverity)[0] ?? null, [p.traffic]);

  const sounds = p.zones.filter((z) => z.kind === "sound").length;
  const reports = p.zones.length - sounds;
  const newestZone = p.zones.reduce<LiveZone | null>((m, z) => (hasPoint(z) && (!m || z.ts > m.ts) ? z : m), null);
  const topAnomaly = p.anomalies.find(hasPoint);
  const busiest = p.sensors.cells.reduce<{ cell: string; n: number } | null>((m, c) => (!m || c.n > m.n ? c : m), null);
  const busiestPt = busiest ? cellPoint(busiest.cell) : null;
  const maxDelay = p.traffic.reduce((m, x) => Math.max(m, x.delayMin || 0), 0);
  const okFeeds = feeds.filter((f) => f.ok).length;
  const weatherNow = feeds.find((f) => f.id === "weather" && f.ok && f.value && f.value !== "unavailable")?.value;
  const sunset = p.sources?.weather ? Date.parse(p.sources.weather.sunset) : NaN;
  const go = (pt: Pt | null | undefined, zoom: number) => (pt && hasPoint(pt) ? () => p.onFocus(pt.lng, pt.lat, zoom) : undefined);

  return (
    <div className={`cmd-root ${dark ? "cmd-dark" : "cmd-light"}`}>
      <header className="cmd-top">
        {dark && (
          <div className="cmd-stars" aria-hidden="true">
            <Galaxy density={0.55} glowIntensity={0.3} saturation={0.15} hueShift={210} twinkleIntensity={0.45} rotationSpeed={0.03} starSpeed={0.25} speed={0.8} mouseInteraction={false} mouseRepulsion={false} transparent />
          </div>
        )}
        <div className="cmd-brand">
          <span className="cmd-logo" aria-hidden="true">
            <ShieldCheck size={20} />
          </span>
          <div className="cmd-brand-text">
            <div className="cmd-title-row">
              <h1 className="cmd-title">NorthStar Command</h1>
              <span className="cmd-live">
                <span className="cmd-live-dot" aria-hidden="true" />
                LIVE
              </span>
            </div>
            <p className="cmd-sub">San Francisco Bay Area · live</p>
          </div>
        </div>

        <ul className="cmd-status" aria-label="System status">
          <li>
            <span className={`cmd-dot${loading ? " cmd-wait" : okFeeds < feeds.length ? " cmd-err" : ""}`} aria-hidden="true" />
            {loading ? "Connecting to feeds" : `${okFeeds}/${feeds.length} feeds online`}
          </li>
          {weatherNow && (
            <li>
              <CloudSun size={14} aria-hidden="true" />
              {weatherNow}
            </li>
          )}
          {p.sources?.weather && Number.isFinite(sunset) && (
            <li>
              {p.sources.weather.isDay ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
              {p.sources.weather.isDay ? `Sunset ${timeOfDay(sunset)}` : "After dark"}
            </li>
          )}
        </ul>

        <div className="cmd-top-end">
          <Clock />
          <button type="button" className="cmd-exit" onClick={p.onExit} aria-label="Exit command center" aria-keyshortcuts="Escape" title="Exit command center (Esc)">
            <X size={15} aria-hidden="true" />
            <span className="cmd-exit-text">Exit</span>
            <kbd aria-hidden="true">Esc</kbd>
          </button>
        </div>
      </header>

      <Viewfinder />

      <div className="cmd-sheet">
        <section className="cmd-kpis" aria-label="Key figures">
          <Kpi
            tone="call"
            icon={Siren}
            label="Violent calls (24 h)"
            value={calls.length}
            note={loading ? "Connecting to SFPD dispatch…" : `${callStats.lastHour.toLocaleString()} in the last hour`}
            action="Show the latest call"
            onClick={go(callStats.latest, 16)}
            still={still}
          />
          <Kpi
            tone="sound"
            icon={BellRing}
            label="Live alerts"
            value={p.zones.length}
            hot={p.zones.length > 0}
            note={p.zones.length ? `${plural(sounds, "gunshot")} · ${plural(reports, "report")}` : "No active alerts"}
            action="Show the newest alert"
            onClick={go(newestZone, 16)}
            still={still}
          />
          <Kpi
            tone="anomaly"
            icon={ShieldAlert}
            label="Anomalies"
            value={p.anomalies.length}
            hot={p.anomalies.length > 0}
            note={
              topAnomaly
                ? `${Math.round(topAnomaly.n / Math.max(topAnomaly.expected, 0.15))}× normal${topAnomaly.calls[0] ? ` near ${titleCase(topAnomaly.calls[0].where)}` : ""}`
                : loading
                  ? "Waiting for dispatch data"
                  : "All areas within normal"
            }
            action="Show the top anomaly"
            onClick={go(topAnomaly, 15)}
            still={still}
          />
          <Kpi
            tone="sensor"
            icon={Smartphone}
            label="Phones listening"
            value={p.sensors.phones}
            note={p.sensors.phones ? `${plural(p.sensors.cells.length, "area")} covered` : "No phones listening now"}
            action="Show the busiest sensor area"
            onClick={go(busiestPt, 14)}
            still={still}
          />
          <Kpi
            tone="traffic"
            icon={TrafficCone}
            label="Traffic incidents"
            value={p.traffic.length}
            hot={p.traffic.some((x) => x.magnitude >= 3)}
            note={p.traffic.length ? (maxDelay ? `Worst delay ${maxDelay.toLocaleString()} min` : "Live from TomTom") : "No incidents reported"}
            action="Show the most serious incident"
            onClick={go(worstTraffic, 15)}
            still={still}
          />
          <Kpi tone="cam" icon={Cctv} label="Cameras online" value={cams.length} note={loading ? "Connecting to Caltrans…" : "Caltrans District 4 · 60 s"} still={still} />
        </section>

        <div className="cmd-col cmd-left">
          <CameraWall cams={cams} loading={loading} onFocus={p.onFocus} />
          <SensorCard sensors={p.sensors} />
          <FeedsCard feeds={feeds} loading={loading} />
        </div>

        <div className="cmd-col cmd-right">
          <EventFeed items={feed.items} total={feed.total} loading={loading} onFocus={p.onFocus} />
          <Constellations list={p.constellations} onFocus={p.onFocus} />
          <NextHour forecast={p.forecast} placeFor={placeFor} onFocus={p.onFocus} />
        </div>

        <section className="cmd-panel cmd-bottom" aria-label="Dispatch activity and engine log">
          <HourChart calls={calls} loading={loading} />
          <LogTicker log={p.log} still={still} />
        </section>
      </div>
    </div>
  );
}

// ---------- pieces ----------
function Head({ id, icon: Icon, title, meta }: { id: string; icon: LucideIcon; title: string; meta?: ReactNode }) {
  return (
    <div className="cmd-ph">
      <h2 id={id} className="cmd-eyebrow">
        <Icon size={12} aria-hidden="true" />
        {title}
      </h2>
      {meta != null && <span className="cmd-meta">{meta}</span>}
    </div>
  );
}

function Empty({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="cmd-empty">
      <Icon size={15} aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

function Clock() {
  const now = useNow(1000);
  return (
    <div className="cmd-clock" aria-hidden="true">
      <span className="cmd-clock-date" suppressHydrationWarning>
        {new Date(now).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
      </span>
      <span className="cmd-clock-time" suppressHydrationWarning>
        {timeOfDay(now, true)}
      </span>
    </div>
  );
}

// Decorative corner brackets around the map window.
function Viewfinder() {
  return (
    <div className="cmd-frame" aria-hidden="true">
      <span className="cmd-corner cmd-tl" />
      <span className="cmd-corner cmd-tr" />
      <span className="cmd-corner cmd-bl" />
      <span className="cmd-corner cmd-br" />
      <span className="cmd-frame-tag">Live map</span>
    </div>
  );
}

type KpiProps = { tone: Tone; icon: LucideIcon; label: string; value: number; note: string; hot?: boolean; action?: string; onClick?: () => void; still: boolean };

function Kpi({ tone, icon: Icon, label, value, note, hot, action, onClick, still }: KpiProps) {
  const shown = useCountUp(value, still);
  const cls = `cmd-kpi cmd-t-${tone}${hot ? " cmd-hot" : ""}`;
  const body = (
    <>
      <span className="cmd-kpi-label">
        <span className="cmd-kpi-ico" aria-hidden="true">
          <Icon size={13} />
        </span>
        <span className="cmd-kpi-text">{label}</span>
      </span>
      <span className="cmd-sr">{value.toLocaleString()}</span>
      <span className="cmd-kpi-num" aria-hidden="true">
        {Math.round(shown).toLocaleString()}
      </span>
      <span className="cmd-kpi-note">{note}</span>
      {onClick && <LocateFixed className="cmd-kpi-go" size={14} aria-hidden="true" />}
    </>
  );
  if (!onClick) return <div className={cls}>{body}</div>;
  return (
    <button type="button" className={cls} onClick={onClick} title={`${action ?? "Show"} on the map`} aria-label={`${label}: ${value.toLocaleString()}. ${note}. ${action ?? "Show"} on the map.`}>
      {body}
    </button>
  );
}

function CameraWall({ cams, loading, onFocus }: { cams: Sources["cameras"]; loading: boolean; onFocus: CommandProps["onFocus"] }) {
  const id = useId();
  const minute = Math.floor(useNow(60000) / 60000); // new frame from every camera each minute
  const [lost, setLost] = useState<ReadonlySet<string>>(() => new Set());
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set());
  const shown = cams.filter(hasPoint).slice(0, 6);
  return (
    <section className="cmd-panel cmd-p-cams" aria-labelledby={id}>
      <Head id={id} icon={Cctv} title="Camera wall" meta={loading ? "connecting" : `${shown.length} of ${cams.length} live · 60 s`} />
      {shown.length ? (
        <div className="cmd-cams">
          {shown.map((c, i) => {
            const src = withMinute(c.img, minute);
            return (
              <button key={c.img} type="button" className="cmd-cam" onClick={() => onFocus(c.lng, c.lat, 15)} aria-label={`Live camera, ${c.name}. Show on map.`} title={c.name}>
                {lost.has(src) ? (
                  <span className="cmd-cam-lost">No signal</span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src}
                    alt=""
                    decoding="async"
                    className={ready.has(c.img) ? "cmd-on" : undefined}
                    onLoad={() => setReady((s) => (s.has(c.img) ? s : new Set(s).add(c.img)))}
                    onError={() => setLost((s) => new Set(s).add(src))}
                  />
                )}
                <span className="cmd-cam-top">
                  <span className="cmd-rec">REC</span>
                  <span>CAM {String(i + 1).padStart(2, "0")}</span>
                </span>
                <span className="cmd-cam-name">{c.name}</span>
              </button>
            );
          })}
        </div>
      ) : loading ? (
        <div className="cmd-cams" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="cmd-cam cmd-cam-skel" />
          ))}
        </div>
      ) : (
        <Empty icon={Camera} text="No road cameras are online right now." />
      )}
    </section>
  );
}

function SensorCard({ sensors }: { sensors: CommandProps["sensors"] }) {
  const id = useId();
  return (
    <section className="cmd-panel cmd-p-sensor" aria-labelledby={id}>
      <Head
        id={id}
        icon={AudioWaveform}
        title="Sensor grid"
        meta={
          sensors.phones ? (
            <>
              <span className="cmd-pulse" aria-hidden="true" />
              listening
            </>
          ) : (
            "idle"
          )
        }
      />
      <div className="cmd-sensor">
        <div>
          <span className="cmd-num">{sensors.phones.toLocaleString()}</span>
          <span className="cmd-lbl">phones listening</span>
        </div>
        <div>
          <span className="cmd-num">{sensors.cells.length.toLocaleString()}</span>
          <span className="cmd-lbl">areas covered</span>
        </div>
      </div>
      <p className="cmd-fine">Counts by area only. No audio or identities are stored.</p>
    </section>
  );
}

function FeedsCard({ feeds, loading }: { feeds: Sources["feeds"]; loading: boolean }) {
  const id = useId();
  const ok = feeds.filter((f) => f.ok).length;
  return (
    <section className="cmd-panel cmd-p-feeds" aria-labelledby={id}>
      <Head id={id} icon={Database} title="Data feeds" meta={feeds.length ? `${ok}/${feeds.length} online` : undefined} />
      {feeds.length ? (
        <ul className="cmd-feeds">
          {feeds.map((f) => (
            <li key={f.id} title={[f.provider, f.value, f.detail].filter(Boolean).join(" · ")}>
              <span className={`cmd-dot${f.ok ? "" : " cmd-err"}`} role="img" aria-label={f.ok ? "Online" : "Offline"} />
              <span className="cmd-feed-name">{f.name}</span>
              <span className="cmd-feed-ms">{f.ok ? `${f.ms.toLocaleString()} ms` : "offline"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon={Database} text={loading ? "Connecting to data feeds…" : "No feed status available."} />
      )}
    </section>
  );
}

function EventFeed({ items, total, loading, onFocus }: { items: Item[]; total: number; loading: boolean; onFocus: CommandProps["onFocus"] }) {
  const id = useId();
  useNow(15000); // keeps "4 min ago" current
  const [opened] = useState(() => Date.now());
  const t = Date.now();
  const intro = t - opened < 1500; // stagger the first paint only; later rows slide in on their own
  const news = items.find((it) => it.seen > 0 && t - it.seen < 10000 && (it.kind === "sound" || it.kind === "anomaly"));
  return (
    <section className="cmd-panel cmd-feed cmd-p-feed" aria-labelledby={id}>
      <Head
        id={id}
        icon={Radio}
        title="Live event feed"
        meta={
          <>
            <span className="cmd-pulse" aria-hidden="true" />
            {total > items.length ? `latest ${items.length} of ${total.toLocaleString()}` : plural(total, "event")}
          </>
        }
      />
      {items.length ? (
        <ol className="cmd-feed-list">
          {items.map((it, i) => {
            const K = KIND[it.kind];
            const Icon = it.icon ?? K.icon;
            const when = it.kind === "traffic" && it.seen < 0 ? "active" : fmtAgo(it.t);
            const fresh = it.seen > 0 && t - it.seen < 10000;
            return (
              <li
                key={it.id}
                className={`cmd-ev cmd-t-${it.kind}${it.severe ? " cmd-ev-severe" : ""}${fresh ? " cmd-fresh" : ""}`}
                style={intro ? { animationDelay: `${Math.min(i, 16) * 28}ms` } : undefined}
              >
                <button
                  type="button"
                  className="cmd-ev-btn"
                  onClick={() => onFocus(it.lng, it.lat, 16)}
                  aria-label={`${K.label}: ${it.title}, ${it.place}, ${when}${it.verified ? ", corroborated by SFPD dispatch" : ""}. Show on map.`}
                >
                  <span className="cmd-ev-bar" aria-hidden="true" />
                  <span className="cmd-ev-title">{it.title}</span>
                  <time className="cmd-ev-time" dateTime={iso(it.t)}>
                    {when}
                  </time>
                  <span className="cmd-ev-sub">
                    <span className="cmd-chip">
                      <Icon size={11} aria-hidden="true" />
                      {K.label}
                    </span>
                    <span className="cmd-ev-place">{it.place}</span>
                    {it.verified && (
                      <span className="cmd-chip cmd-chip-crit" title={`SFPD dispatch: ${sentence(it.verified.type)} near ${titleCase(it.verified.where)}`}>
                        <BadgeCheck size={11} aria-hidden="true" />
                        Corroborated
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <Empty icon={Radio} text={loading ? "Connecting to live feeds…" : "All quiet. Watching SFPD dispatch, phone sensors and traffic."} />
      )}
      <p className="cmd-sr" role="status">
        {news ? `New ${KIND[news.kind].label.toLowerCase()}: ${news.title}, ${news.place}.` : ""}
      </p>
    </section>
  );
}

function Constellations({ list, onFocus }: { list: Constellation[]; onFocus: CommandProps["onFocus"] }) {
  const id = useId();
  return (
    <section className="cmd-panel cmd-p-const" aria-labelledby={id}>
      <Head id={id} icon={Sparkles} title="Incident constellations" meta={list.length ? plural(list.length, "chain") : undefined} />
      {list.length ? (
        <ol className="cmd-list">
          {list.slice(0, 4).map((c) => {
            const first = c.events.find(hasPoint);
            const range = c.to - c.from > 864e5 ? `${shortDate(c.from)}–${shortDate(c.to)}` : shortDate(c.from);
            const kind = (EVENT_LABEL.en[c.top] ?? c.top).toLowerCase();
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className="cmd-row"
                  disabled={!first}
                  onClick={() => first && onFocus(first.lng, first.lat, 16)}
                  aria-label={`${c.events.length} linked incidents near ${c.place}, mostly ${kind}, ${range}. Show on map.`}
                >
                  <span className="cmd-const-n">{c.events.length}</span>
                  <span className="cmd-row-main">
                    <strong>near {c.place}</strong>
                    <span>
                      mostly {kind} · {range}
                    </span>
                  </span>
                  <LocateFixed className="cmd-go" size={13} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <Empty icon={Sparkles} text="No linked incident chains in the current data." />
      )}
    </section>
  );
}

function NextHour({ forecast, placeFor, onFocus }: { forecast: Forecast; placeFor: (cell: string) => string; onFocus: CommandProps["onFocus"] }) {
  const id = useId();
  const pct = forecast.now > 0 ? Math.round(((forecast.next - forecast.now) / forecast.now) * 100) : null;
  const by = new Date(Date.now() + 3600e3).toLocaleTimeString("en-US", { hour: "numeric" });
  const dir = !pct ? "flat" : pct > 0 ? "up" : "down";
  const Trend = dir === "down" ? TrendingDown : TrendingUp;
  const rising = forecast.rising.slice(0, 3);
  return (
    <section className="cmd-panel cmd-p-next" aria-labelledby={id}>
      <Head id={id} icon={TrendingUp} title="Next hour" meta={`by ${by}`} />
      <p className={`cmd-next cmd-next-${dir}`}>
        <span className="cmd-trend" aria-hidden="true">
          <Trend size={15} />
        </span>
        <span>
          {pct === null ? (
            "Not enough history loaded to forecast yet."
          ) : pct === 0 ? (
            `Citywide risk holds steady through ${by}`
          ) : (
            <>
              Citywide risk{" "}
              <strong>
                {pct > 0 ? "+" : "−"}
                {Math.abs(pct)}%
              </strong>{" "}
              by {by}
            </>
          )}
        </span>
      </p>
      {rising.length > 0 && (
        <ol className="cmd-list" aria-label="Blocks getting riskier fastest">
          {rising.map((x, i) => {
            const pt = cellPoint(x.cell);
            const name = placeFor(x.cell);
            const up = (x.next - x.now).toFixed(1);
            return (
              <li key={x.cell}>
                <button type="button" className="cmd-row" disabled={!pt} onClick={() => pt && onFocus(pt.lng, pt.lat, 16)} aria-label={`${name}: risk up ${up} points in the next hour. Show on map.`}>
                  <span className="cmd-rank">{String(i + 1).padStart(2, "0")}</span>
                  <span className="cmd-row-main">
                    <strong>{name}</strong>
                  </span>
                  <span className="cmd-delta">+{up}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// 24 hourly columns ending with the current (partial) hour, which is highlighted.
function HourChart({ calls, loading }: { calls: Call[]; loading: boolean }) {
  const id = useId();
  const now = useNow(60000);
  const top = new Date(now);
  top.setMinutes(0, 0, 0);
  const h0 = top.getTime();
  const bins = useMemo(() => {
    const n: number[] = new Array(24).fill(0);
    for (const c of calls) {
      if (!Number.isFinite(c.ts)) continue;
      const back = c.ts >= h0 ? 0 : Math.floor((h0 - c.ts) / 3600e3) + 1;
      if (back <= 23) n[23 - back]++;
    }
    return n;
  }, [calls, h0]);
  const [sel, setSel] = useState<number | null>(null);
  const max = Math.max(1, ...bins);
  const total = bins.reduce((a, b) => a + b, 0);
  const peak = bins.reduce((best, v, i) => (v >= bins[best] ? i : best), 0);
  const hourAt = (i: number) => new Date(h0 - (23 - i) * 3600e3).getHours();
  const span = (i: number) => (i === 23 ? `${fmtHour(hourAt(i))} to now` : `${fmtHour(hourAt(i))} to ${fmtHour((hourAt(i) + 1) % 24)}`);
  const summary = total ? `${plural(total, "violent call")} in the last 24 hours, ${bins[23]} so far this hour, busiest ${fmtHour(hourAt(peak))} with ${bins[peak]}` : "No violent calls in the last 24 hours";

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    if (k === "Escape" && sel !== null) {
      e.preventDefault(); // close the readout without leaving command mode
      setSel(null);
      return;
    }
    if (k !== "ArrowLeft" && k !== "ArrowRight" && k !== "Home" && k !== "End") return;
    e.preventDefault();
    setSel((s) => (k === "Home" ? 0 : k === "End" ? 23 : Math.max(0, Math.min(23, (s ?? 23) + (k === "ArrowLeft" ? -1 : 1)))));
  };

  return (
    <div className="cmd-chart-wrap">
      <div className="cmd-ph">
        <h2 id={id} className="cmd-eyebrow">
          <ChartColumn size={12} aria-hidden="true" />
          Violent calls by hour, last 24 h
        </h2>
        <p className="cmd-chart-stats" aria-hidden="true">
          <span>
            This hour<b>{bins[23]}</b>
          </span>
          <span>
            Peak<b>{total ? bins[peak] : "–"}</b>
            {total ? ` at ${fmtHour(hourAt(peak))}` : ""}
          </span>
          <span>
            Total<b>{total.toLocaleString()}</b>
          </span>
        </p>
      </div>
      <div
        className="cmd-chart"
        tabIndex={0}
        role="group"
        aria-labelledby={id}
        aria-describedby={`${id}-sum`}
        onKeyDown={onKey}
        onFocus={() => setSel((s) => s ?? 23)}
        onBlur={() => setSel(null)}
      >
        <span id={`${id}-sum`} className="cmd-sr">
          {summary}. Use the left and right arrow keys to read each hour.
        </span>
        <div className="cmd-bars" onPointerLeave={() => setSel(null)}>
          {bins.map((v, i) => (
            <span key={i} className={`cmd-bar${i === 23 ? " cmd-now" : ""}${i === sel ? " cmd-sel" : ""}`} onPointerEnter={() => setSel(i)}>
              <span className="cmd-bar-fill" style={{ height: `${(v / max) * 100}%`, animationDelay: `${i * 16}ms` }} />
            </span>
          ))}
        </div>
        <div className="cmd-axis" aria-hidden="true">
          {[0, 6, 12, 18].map((i) => (
            <span key={i} style={{ left: `${((i + 0.5) / 24) * 100}%` }}>
              {fmtHour(hourAt(i))}
            </span>
          ))}
          <span className="cmd-axis-now">Now</span>
        </div>
        {sel !== null && (
          <div className={`cmd-tip${sel < 3 ? " cmd-tip-l" : sel > 20 ? " cmd-tip-r" : ""}`} style={{ left: `${((sel + 0.5) / 24) * 100}%` }} aria-hidden="true">
            <strong>{plural(bins[sel], "call")}</strong>
            <span>{span(sel)}</span>
          </div>
        )}
        <span className="cmd-sr" aria-live="polite">
          {sel !== null ? `${span(sel)}: ${plural(bins[sel], "call")}` : ""}
        </span>
        {(loading || !total) && <p className="cmd-chart-empty">{loading ? "Waiting for the SFPD dispatch feed…" : "No violent calls logged in the last 24 h."}</p>}
      </div>
    </div>
  );
}

// The latest engine log lines, scrolling past in one line (static and scrollable when motion is reduced).
function LogTicker({ log, still }: { log: LogEntry[]; still: boolean }) {
  const items = log.slice(0, 8);
  const chars = items.reduce((n, l) => n + l.text.length + 14, 0);
  const style = { "--cmd-dur": `${Math.max(24, Math.round(chars * 0.16))}s` } as CSSProperties;
  return (
    <div className="cmd-ticker">
      <span className="cmd-ticker-lbl">
        <Activity size={12} aria-hidden="true" />
        Engine
      </span>
      {items.length ? (
        <div className="cmd-ticker-view" role="marquee" aria-label="Latest engine log lines" tabIndex={0}>
          {/* Restart from the newest line whenever one arrives. */}
          <div className="cmd-ticker-track" key={items[0].t} style={style}>
            {(still ? [0] : [0, 1]).map((copy) => (
              <span key={copy} className="cmd-ticker-run" aria-hidden={copy === 1 ? true : undefined}>
                {items.map((l, i) => (
                  <span key={`${l.t}-${i}`} className={`cmd-tick cmd-tick-${l.kind ?? "data"}`}>
                    <time dateTime={iso(l.t)}>{timeOfDay(l.t, true)}</time>
                    {l.text}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <span className="cmd-ticker-empty">Waiting for engine activity…</span>
      )}
    </div>
  );
}
