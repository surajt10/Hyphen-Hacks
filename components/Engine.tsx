"use client";

// "How it works" view: the scoring engine and every data feed behind it, live.
// Click any spot on the map to see exactly how its risk was calculated.
import { useEffect, useMemo, useState } from "react";
import { cellToBoundary, cellToLatLng } from "h3-js";
import { ArrowLeft, Crosshair, Radio, Activity, Satellite, Camera, Database, Siren } from "lucide-react";
import { MODES, MODE_MULT, TYPE_WEIGHT, contribution, type CellRisk, type Ev, type LiveZone, type Mode, LIVE_SCORE } from "@/lib/scoring";
import { EVENT_LABEL } from "@/lib/i18n";
import { fmtDate, fmtHour } from "@/lib/format";
import { MODE_ICON } from "./icons";
import Galaxy from "./Galaxy";

export type LogEntry = { t: number; text: string; kind?: "route" | "live" | "data" | "pick" };
export type Sources = {
  at: number;
  feeds: { id: string; name: string; provider: string; ok: boolean; ms: number; value?: string; detail: string; updated?: string }[];
  recentCalls: { t?: string; type: string; where: string }[];
  cameras: { name: string; img: string; lat: number; lng: number }[];
  weather: { isDay: boolean; sunset: string } | null;
};

type Props = {
  events: Ev[];
  cells: Map<string, CellRisk>;
  live: Map<string, LiveZone>;
  mode: Mode;
  setMode: (m: Mode) => void;
  offset: number;
  setOffset: (o: number) => void;
  when: Date;
  threshold: number;
  zones: LiveZone[];
  log: LogEntry[];
  selected: string | null;
  onSelect: (cell: string | null, fly?: boolean) => void;
  sources: Sources | null;
  center: [number, number];
  theme: "light" | "dark";
};

const LABEL = EVENT_LABEL.en;
const MODE_NAME: Record<Mode, string> = { walk: "Walk", wheelchair: "Wheelchair", bike: "Bike", scooter: "E-scooter", moped: "Moped", car: "Car" };
const TYPES = Object.keys(TYPE_WEIGHT);
const OFFSETS = [0, 60, 120, 240, 480];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const fmt = (n: number, d = 2) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(d));
const clock = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

import { satellite } from "@/lib/sat";

function useCountUp(target: number, key: string) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 700);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, key]);
  return v;
}

export default function Engine(p: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const minute = Math.floor(now / 60000);

  const scores = useMemo(() => [...p.cells.values()].map((c) => c.score).sort((a, b) => a - b), [p.cells]);

  const stats = useMemo(() => {
    const hour = new Array(24).fill(0);
    const day = new Array(7).fill(0);
    const byType = new Map<string, number>();
    const crash = { ped: 0, bike: 0, vehicle: 0, moto: 0, fatal: 0 };
    let calls7 = 0, callsPrev7 = 0, calls = 0;
    const t0 = p.when.getTime();
    for (const e of p.events) {
      const c = contribution(e, p.mode, p.when);
      const base = c.value / (c.tod || 1); // ignore the hour factor so the chart shows when risk happens
      if (base) {
        hour[e.h] += base;
        const [y, m, d] = e.d.split("-").map(Number);
        day[new Date(y, m - 1, d).getDay()] += base;
        byType.set(e.t, (byType.get(e.t) ?? 0) + c.value);
      }
      if (e.t.startsWith("crash")) {
        crash[e.t.slice(6) as "ped" | "bike" | "vehicle" | "moto"]++;
        if (e.f) crash.fatal++;
      } else {
        calls++;
        const age = (t0 - Date.parse(e.d)) / 864e5;
        if (age <= 7) calls7++;
        else if (age <= 14) callsPrev7++;
      }
    }
    const rows = [...byType].sort((a, b) => b[1] - a[1]);
    const maxT = Math.max(1, ...rows.map((r) => r[1]));
    return {
      hour,
      day,
      peakHour: hour.indexOf(Math.max(...hour)),
      peakDay: day.indexOf(Math.max(...day)),
      byType: rows.map(([t, v]) => ({ t, v, pct: v / maxT })),
      crash,
      calls,
      calls7,
      callsPrev7,
    };
  }, [p.events, p.mode, p.when]);

  const hottest = useMemo(
    () =>
      [...p.cells]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 6)
        .map(([c, v]) => {
          const top = new Map<string, number>();
          for (const e of v.events) top.set(e.t, (top.get(e.t) ?? 0) + 1);
          return { c, score: v.score, top: [...top].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "" };
        }),
    [p.cells],
  );

  const sat = satellite(p.center[0], p.center[1], 0.012);
  const trend = stats.callsPrev7 ? Math.round(((stats.calls7 - stats.callsPrev7) / stats.callsPrev7) * 100) : 0;

  return (
    <aside className="engine" aria-label="How NorthStar calculates risk">
      <div className="eng-scan" aria-hidden />
      <div className="eng-stars" aria-hidden>
        <Galaxy density={0.9} glowIntensity={0.35} saturation={0.15} hueShift={210} twinkleIntensity={0.5} rotationSpeed={0.04} starSpeed={0.3} mouseRepulsion={false} lightMode={p.theme === "light"} transparent={p.theme !== "light"} />
      </div>
      <header className="eng-head">
        <div>
          <p className="eyebrow">NorthStar engine</p>
          <h2>{p.selected ? "Cell analysis" : "Live risk model"}</h2>
        </div>
        <div className="eng-live">
          <span className="badge live">
            <Radio size={12} /> LIVE
          </span>
          <span className="mono muted">{clock(now)}</span>
        </div>
      </header>

      <div className="eng-controls">
        <div className="seg" role="radiogroup" aria-label="Travel mode">
          {MODES.map((m) => {
            const I = MODE_ICON[m];
            return (
              <button key={m} role="radio" aria-checked={p.mode === m} className={p.mode === m ? "on" : ""} onClick={() => p.setMode(m)} title={MODE_NAME[m]}>
                <I size={16} />
                <span>{MODE_NAME[m]}</span>
              </button>
            );
          })}
        </div>
        <div className="seg small" role="radiogroup" aria-label="Evaluate at">
          {OFFSETS.map((o) => (
            <button key={o} role="radio" aria-checked={p.offset === o} className={p.offset === o ? "on" : ""} onClick={() => p.setOffset(o)}>
              {o === 0 ? "Now" : `+${o / 60}h`}
            </button>
          ))}
        </div>
        <p className="muted small-text">
          Scoring for <strong>{MODE_NAME[p.mode]}</strong> at <span className="mono">{p.when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
          {p.sources?.weather && !p.sources.weather.isDay ? " · after dark" : ""}
        </p>
      </div>

      <div className="eng-body">
        {p.selected ? (
          <CellView key={`${p.selected}-${p.mode}-${p.offset}`} {...p} cell={p.selected} scores={scores} minute={minute} />
        ) : (
          <>
            <p className="eng-hint">
              <Crosshair size={14} /> Click anywhere on the map to see how its risk is calculated.
            </p>

            <div className="tiles">
              <Tile label="Violent calls, last 7 days" value={stats.calls7} note={stats.callsPrev7 ? `${trend >= 0 ? "▲" : "▼"} ${Math.abs(trend)}% vs prior week` : undefined} />
              <Tile label="Injury crashes, 2 years" value={stats.crash.ped + stats.crash.bike + stats.crash.vehicle + stats.crash.moto} note={`${stats.crash.fatal} fatal`} />
              <Tile label="Blocks with risk" value={p.cells.size} note="0.04 sq mi each" />
              <Tile label="Live alerts now" value={p.zones.length} />
              <Tile label="Riskiest hour" text={fmtHour(stats.peakHour)} note={`for ${MODE_NAME[p.mode].toLowerCase()}`} />
              <Tile label="Riskiest day" text={DAYS[stats.peakDay]} note="by weighted risk" />
            </div>

            <section>
              <h3 className="eyebrow">
                <Database size={12} /> Live data sources
              </h3>
              <ul className="feeds">
                {(p.sources?.feeds ?? []).map((f) => (
                  <li key={f.id}>
                    <span className={`dot ${f.ok ? "ok" : "err"}`} aria-label={f.ok ? "online" : "offline"} />
                    <div className="feed-main">
                      <div className="feed-top">
                        <strong>{f.name}</strong>
                        <span className="mono muted">{f.ms} ms</span>
                      </div>
                      <span className="feed-val">{f.value}</span>
                      <span className="feed-sub">
                        {f.provider}
                        {f.updated ? ` · updated ${f.updated}` : ""}
                        {f.detail ? ` · ${f.detail}` : ""}
                      </span>
                    </div>
                  </li>
                ))}
                {!p.sources && <li className="muted">Connecting to feeds…</li>}
              </ul>
            </section>

            {p.sources && p.sources.recentCalls.length > 0 && (
              <section>
                <h3 className="eyebrow">
                  <Siren size={12} /> Latest violent calls (SFPD dispatch)
                </h3>
                <ol className="calls">
                  {p.sources.recentCalls.map((c, i) => (
                    <li key={i}>
                      <span className="mono muted">{c.t}</span>
                      <span>
                        {c.type.toLowerCase()} · {c.where.toLowerCase().replace(/\b[a-z]/g, (x) => x.toUpperCase())}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <section>
              <h3 className="eyebrow">
                <Camera size={12} /> Live road cameras (Caltrans)
              </h3>
              <div className="cams live-cams">
                {(p.sources?.cameras ?? []).slice(0, 4).map((c) => (
                  <figure key={c.img}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`${c.img}?t=${minute}`} alt={`Live camera: ${c.name}`} loading="lazy" />
                    <figcaption>
                      <span className="rec" /> {c.name}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>

            <section>
              <h3 className="eyebrow">
                <Satellite size={12} /> Satellite view of the map center (USGS)
              </h3>
              <figure className="sat">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={sat.url} alt="USGS aerial imagery of the map center" />
                <span className="sat-cross" aria-hidden />
                <figcaption className="mono">
                  {p.center[1].toFixed(4)}°N, {Math.abs(p.center[0]).toFixed(4)}°W · USGS National Map
                </figcaption>
              </figure>
            </section>

            <section>
              <h3 className="eyebrow">When risk happens · {MODE_NAME[p.mode]}</h3>
              <div className="hours">
                {stats.hour.map((v, h) => (
                  <span key={h} className={`hbar ${h === p.when.getHours() ? "now" : ""} ${h === stats.peakHour ? "peak" : ""}`} style={{ height: `${Math.max(4, (v / Math.max(...stats.hour, 1)) * 100)}%` }} title={`${fmtHour(h)}: ${fmt(v, 0)}`} />
                ))}
              </div>
              <div className="hours-axis mono">
                <span>12 AM</span>
                <span>6 AM</span>
                <span>12 PM</span>
                <span>6 PM</span>
                <span>11 PM</span>
              </div>
            </section>

            <section>
              <h3 className="eyebrow">What drives risk for {MODE_NAME[p.mode]}</h3>
              <ul className="bars">
                {stats.byType.map((r) => (
                  <li key={r.t}>
                    <span className="lbl">{LABEL[r.t]}</span>
                    <span className="bar">
                      <span style={{ width: `${r.pct * 100}%` }} />
                    </span>
                    <span className="mono val">{fmt(r.v, 0)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="eyebrow">Crashes by who was hurt</h3>
              <div className="split">
                {[
                  ["Pedestrian", stats.crash.ped],
                  ["Bike / scooter", stats.crash.bike],
                  ["Vehicle", stats.crash.vehicle],
                ].map(([k, v]) => (
                  <div key={k as string}>
                    <span className="mono num">{(v as number).toLocaleString()}</span>
                    <span className="lbl">{k}</span>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="eyebrow">Highest-risk blocks</h3>
              <ol className="hot">
                {hottest.map((h, i) => (
                  <li key={h.c}>
                    <button onClick={() => p.onSelect(h.c, true)}>
                      <span className="mono rank">{String(i + 1).padStart(2, "0")}</span>
                      <span className="mono id">{h.c.slice(0, 9)}…</span>
                      <span className="top">{LABEL[h.top]}</span>
                      <span className="mono val">{fmt(h.score, 1)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <h3 className="eyebrow">How much each signal counts, by travel mode</h3>
              <div className="matrix-wrap">
                <table className="matrix mono">
                  <thead>
                    <tr>
                      <th />
                      <th className="num">wt</th>
                      {MODES.map((m) => {
                        const I = MODE_ICON[m];
                        return (
                          <th key={m} className={m === p.mode ? "on" : ""} title={MODE_NAME[m]}>
                            <I size={13} />
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {TYPES.map((t) => (
                      <tr key={t}>
                        <td className="name">{LABEL[t]}</td>
                        <td className="num">{TYPE_WEIGHT[t]}</td>
                        {MODES.map((m) => {
                          const v = MODE_MULT[m][t] ?? 0;
                          return (
                            <td key={m} className={m === p.mode ? "on" : ""} style={{ opacity: v ? 0.4 + v * 0.6 : 0.25 }}>
                              {v ? v.toFixed(1) : "–"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h3 className="eyebrow">
                <Activity size={12} /> Engine log
              </h3>
              <ol className="log mono">
                {p.log.slice(0, 30).map((l, i) => (
                  <li key={`${l.t}-${i}`} className={l.kind}>
                    <span className="time">{clock(l.t)}</span> {l.text}
                  </li>
                ))}
                {!p.log.length && <li className="muted">Waiting for activity…</li>}
              </ol>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

function Tile({ label, value, text, note }: { label: string; value?: number; text?: string; note?: string }) {
  const v = useCountUp(value ?? 0, label);
  return (
    <div className="tile">
      <span className="mono num">{text ?? Math.round(v).toLocaleString()}</span>
      <span className="lbl">{label}</span>
      {note && <span className="note">{note}</span>}
    </div>
  );
}

function CellView(p: Props & { cell: string; scores: number[]; minute: number }) {
  const cell = p.cells.get(p.cell);
  const zone = p.live.get(p.cell);
  const rows = useMemo(
    () =>
      (cell?.events ?? [])
        .map((e) => contribution(e, p.mode, p.when))
        .filter((c) => c.value > 0)
        .sort((a, b) => b.value - a.value),
    [cell, p.mode, p.when],
  );
  const liveValue = zone ? LIVE_SCORE[zone.kind][zone.level] : 0;
  const total = (cell?.score ?? 0) + liveValue;
  const shown = useCountUp(total, p.cell);
  const below = p.scores.filter((s) => s <= (cell?.score ?? 0)).length;
  const topPct = cell ? Math.max(0.1, 100 - (below / Math.max(1, p.scores.length)) * 100) : 100;
  const decision = total >= p.threshold ? "avoid" : total >= p.threshold * 0.6 ? "penalize" : "clear";
  const max = Math.max(...rows.map((r) => r.value), liveValue, 0.0001);
  const [lat, lng] = cellToLatLng(p.cell);
  const ignored = (cell?.events.length ?? 0) - rows.length;
  const sat = satellite(lng, lat, 0.0042, 460, 240);
  const hexPts = cellToBoundary(p.cell, true).map((c) => sat.toPx(c).join(",")).join(" ");
  const evPts = rows.slice(0, 40).map((r) => ({ xy: sat.toPx([r.e.lng, r.e.lat]), crash: r.e.t.startsWith("crash") }));
  const nearestCam = (p.sources?.cameras ?? [])
    .map((c) => ({ ...c, d: Math.hypot((c.lng - lng) * 88, (c.lat - lat) * 111) * 0.621371 }))
    .sort((a, b) => a.d - b.d)[0];

  return (
    <div className="cellview">
      <button className="ghost" onClick={() => p.onSelect(null)}>
        <ArrowLeft size={14} /> Overview
      </button>

      <figure className="sat cell-sat">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={sat.url} alt="USGS aerial imagery of this block" />
        <svg viewBox={`0 0 ${sat.W} ${sat.H}`} aria-hidden>
          <polygon points={hexPts} className="sat-hex" />
          {evPts.map((e, i) => (
            <circle key={i} cx={e.xy[0]} cy={e.xy[1]} r={4} className={e.crash ? "sat-crash" : "sat-crime"} style={{ animationDelay: `${i * 40}ms` }} />
          ))}
        </svg>
        <figcaption className="mono">
          {lat.toFixed(5)}°N, {Math.abs(lng).toFixed(5)}°W · H3 {p.cell}
        </figcaption>
      </figure>

      <div className="score-row">
        <div className="score">
          <span className="mono big">{fmt(shown, 1)}</span>
          <span className="muted">risk points for {MODE_NAME[p.mode].toLowerCase()}</span>
        </div>
        <div className="verdict">
          <span className={`badge ${decision}`}>{decision.toUpperCase()}</span>
          <span className="muted small-text">{cell ? `Top ${topPct < 1 ? topPct.toFixed(1) : Math.round(topPct)}% of ${p.scores.length} blocks` : "No recorded risk"}</span>
        </div>
      </div>

      <div className="threshold">
        <span className="bar">
          <span className="fill" style={{ width: `${Math.min(100, (total / (p.threshold * 1.6)) * 100)}%` }} />
          <span className="mark" style={{ left: `${(1 / 1.6) * 100}%` }} title="Avoid threshold" />
          <span className="mark soft" style={{ left: `${(0.6 / 1.6) * 100}%` }} title="Penalize threshold" />
        </span>
        <span className="mono muted small-text">
          routes avoid ≥ {fmt(p.threshold, 1)} · pay a penalty ≥ {fmt(p.threshold * 0.6, 1)}
        </span>
      </div>

      {nearestCam && nearestCam.d < 0.6 && (
        <figure className="cams single">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${nearestCam.img}?t=${p.minute}`} alt={`Nearest live camera: ${nearestCam.name}`} />
          <figcaption>
            <span className="rec" /> Nearest live camera · {nearestCam.name} · {nearestCam.d.toFixed(1)} mi
          </figcaption>
        </figure>
      )}

      <h3 className="eyebrow">
        {rows.length + (zone ? 1 : 0)} contributing signal{rows.length + (zone ? 1 : 0) === 1 ? "" : "s"}
        {ignored > 0 && <span className="muted"> · {ignored} don&apos;t affect {MODE_NAME[p.mode].toLowerCase()}</span>}
      </h3>
      <ol className="contribs">
        {zone && (
          <li className="contrib live" style={{ animationDelay: "0ms" }}>
            <div className="c-head">
              <span className="c-type">{zone.kind === "sound" ? (zone.level === "confirmed" ? "Confirmed gunshot" : "Possible gunshot") : "Community report"}</span>
              <span className="mono c-val">+{liveValue}</span>
            </div>
            <div className="c-desc">
              Live alert from {zone.count} {zone.count === 1 ? "phone" : "phones"} at {clock(zone.ts)}
            </div>
            <span className="c-bar">
              <span style={{ width: `${(liveValue / max) * 100}%` }} />
            </span>
          </li>
        )}
        {rows.slice(0, 40).map((r, i) => (
          <li key={i} className={`contrib ${r.e.t.startsWith("crash") ? "crash" : "crime"}`} style={{ animationDelay: `${(i + (zone ? 1 : 0)) * 70}ms` }}>
            <div className="c-head">
              <span className="c-type">{LABEL[r.e.t]}</span>
              <span className="mono c-val">+{fmt(r.value)}</span>
            </div>
            <div className="c-desc">
              {r.e.x} · {fmtDate(r.e.d)}, {fmtHour(r.e.h)}
            </div>
            <div className="factors mono">
              <span title="Severity weight">severity {r.weight}</span>
              {r.fatal > 1 && <span title="Fatal crash">fatal ×3</span>}
              <span title={`Multiplier for ${MODE_NAME[p.mode]}`}>
                {MODE_NAME[p.mode].toLowerCase()} ×{r.mult.toFixed(1)}
              </span>
              <span title="Older events count less">
                {r.ageDays.toFixed(0)} days old ×{r.decay.toFixed(2)}
              </span>
              <span title="Within 3 hours of travel time?">{r.tod === 1 ? "same time of day ×1.0" : "different time ×0.3"}</span>
            </div>
            <span className="c-bar">
              <span style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
          </li>
        ))}
        {!rows.length && !zone && <li className="muted">Nothing recorded here counts for {MODE_NAME[p.mode].toLowerCase()} at this hour. Score 0, so routes pass freely.</li>}
      </ol>
      {rows.length > 40 && <p className="muted small-text">+{rows.length - 40} smaller signals</p>}

      <div className="sum mono">
        Total {fmt(total)} →{" "}
        <strong className={decision}>{decision === "avoid" ? "routes avoid this block" : decision === "penalize" ? "routes pay a penalty here" : "no effect on routes"}</strong>
      </div>
    </div>
  );
}
