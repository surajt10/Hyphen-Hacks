"use client";

// "How it works" view: the scoring engine, live. Click any spot on the map to see
// exactly how its risk was calculated, event by event and factor by factor.
import { useEffect, useMemo, useRef, useState } from "react";
import { cellToLatLng } from "h3-js";
import { ArrowLeft, Crosshair, Radio, Activity } from "lucide-react";
import { MODES, MODE_MULT, TAU_DAYS, TYPE_WEIGHT, contribution, type CellRisk, type Ev, type LiveZone, type Mode, LIVE_SCORE } from "@/lib/scoring";
import { EVENT_LABEL } from "@/lib/i18n";
import { MODE_ICON } from "./icons";

export type LogEntry = { t: number; text: string; kind?: "route" | "live" | "data" | "pick" };

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
};

const LABEL = EVENT_LABEL.en;
const MODE_NAME: Record<Mode, string> = { walk: "Walk", wheelchair: "Wheelchair", bike: "Bike", scooter: "E-scooter", moped: "Moped", car: "Car" };
const TYPES = Object.keys(TYPE_WEIGHT);
const OFFSETS = [0, 60, 120, 240, 480];

const fmt = (n: number, d = 2) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(d));
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

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

  const scores = useMemo(() => [...p.cells.values()].map((c) => c.score).sort((a, b) => a - b), [p.cells]);
  const counts = useMemo(() => {
    let calls = 0, crashes = 0;
    for (const e of p.events) e.t.startsWith("crash") ? crashes++ : calls++;
    return { calls, crashes };
  }, [p.events]);

  const byType = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of p.events) {
      const v = contribution(e, p.mode, p.when).value;
      if (v) m.set(e.t, (m.get(e.t) ?? 0) + v);
    }
    const rows = [...m].sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return rows.map(([t, v]) => ({ t, v, pct: v / max }));
  }, [p.events, p.mode, p.when]);

  const hottest = useMemo(
    () =>
      [...p.cells]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 8)
        .map(([c, v]) => {
          const top = new Map<string, number>();
          for (const e of v.events) top.set(e.t, (top.get(e.t) ?? 0) + 1);
          return { c, score: v.score, top: [...top].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "" };
        }),
    [p.cells],
  );

  return (
    <aside className="engine" aria-label="How NorthStar calculates risk">
      <div className="eng-scan" aria-hidden />
      <header className="eng-head">
        <div>
          <p className="eyebrow">NorthStar engine</p>
          <h2>{p.selected ? "Cell analysis" : "Risk model, live"}</h2>
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
          Scoring for <strong>{MODE_NAME[p.mode]}</strong> at{" "}
          <span className="mono">{p.when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </p>
      </div>

      <div className="eng-body">
        {p.selected ? (
          <CellView key={`${p.selected}-${p.mode}-${p.offset}`} {...p} cell={p.selected} scores={scores} />
        ) : (
          <>
            <p className="eng-hint">
              <Crosshair size={14} /> Click anywhere on the map to see how its risk is calculated.
            </p>
            <div className="tiles">
              <Tile label="Violent dispatch calls" value={counts.calls} />
              <Tile label="Injury crashes" value={counts.crashes} />
              <Tile label="Cells with risk" value={p.cells.size} />
              <Tile label="Avoid threshold" value={p.threshold} decimals={1} note="90th percentile" />
              <Tile label="Live alerts" value={p.zones.length} />
              <Tile label="Cell size" value={0.1} decimals={1} note="km², H3 res 9" />
            </div>

            <section>
              <h3 className="eyebrow">How a score is built</h3>
              <div className="formula mono">
                risk(cell) = Σ <em>weight</em> × <em>mode</em> × e<sup>−age/τ</sup> × <em>hour</em>
              </div>
              <p className="muted small-text">
                τ = {TAU_DAYS.crime} days for violence, {TAU_DAYS.crash} days for crashes. Hour factor is 1.0 within 3 h of your
                travel time, else 0.3. Route risk = Σ cell risk × minutes spent in the cell.
              </p>
            </section>

            <section>
              <h3 className="eyebrow">What drives risk for {MODE_NAME[p.mode]}</h3>
              <ul className="bars">
                {byType.map((r) => (
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
              <h3 className="eyebrow">Mode multipliers</h3>
              <div className="matrix-wrap">
                <table className="matrix mono">
                  <thead>
                    <tr>
                      <th />
                      <th className="num">w</th>
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
              <h3 className="eyebrow">Highest-risk cells</h3>
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
              <h3 className="eyebrow">
                <Activity size={12} /> Event log
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

function Tile({ label, value, decimals = 0, note }: { label: string; value: number; decimals?: number; note?: string }) {
  const v = useCountUp(value, label);
  return (
    <div className="tile">
      <span className="mono num">{v.toFixed(decimals)}</span>
      <span className="lbl">{label}</span>
      {note && <span className="note">{note}</span>}
    </div>
  );
}

function CellView(p: Props & { cell: string; scores: number[] }) {
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
  const ignored = (cell ? 0 : 0) + (p.events.filter((e) => e.c === p.cell).length - rows.length);
  const listRef = useRef<HTMLOListElement>(null);

  return (
    <div className="cellview">
      <button className="ghost" onClick={() => p.onSelect(null)}>
        <ArrowLeft size={14} /> Overview
      </button>

      <div className="cell-id">
        <span className="eyebrow">H3 cell · resolution 9</span>
        <span className="mono">{p.cell}</span>
        <span className="mono muted">
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </span>
      </div>

      <div className="score-row">
        <div className="score">
          <span className="mono big">{fmt(shown, 1)}</span>
          <span className="muted">risk points</span>
        </div>
        <div className="verdict">
          <span className={`badge ${decision}`}>{decision.toUpperCase()}</span>
          <span className="muted small-text">
            {cell ? `Top ${topPct < 1 ? topPct.toFixed(1) : Math.round(topPct)}% of ${p.scores.length} cells` : "No recorded risk"}
          </span>
        </div>
      </div>

      <div className="threshold">
        <span className="bar">
          <span className="fill" style={{ width: `${Math.min(100, (total / (p.threshold * 1.6)) * 100)}%` }} />
          <span className="mark" style={{ left: `${(1 / 1.6) * 100}%` }} title="Avoid threshold" />
          <span className="mark soft" style={{ left: `${(0.6 / 1.6) * 100}%` }} title="Penalize threshold" />
        </span>
        <span className="mono muted small-text">
          avoid ≥ {fmt(p.threshold, 1)} · penalize ≥ {fmt(p.threshold * 0.6, 1)}
        </span>
      </div>

      <div className="formula mono">
        Σ weight × mode × e<sup>−age/τ</sup> × hour {zone ? "+ live alert" : ""}
      </div>

      <h3 className="eyebrow">
        {rows.length + (zone ? 1 : 0)} contributing signal{rows.length + (zone ? 1 : 0) === 1 ? "" : "s"}
        {ignored > 0 && <span className="muted"> · {ignored} ignored for {MODE_NAME[p.mode]}</span>}
      </h3>
      <ol className="contribs" ref={listRef}>
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
              {r.e.x} · {r.e.d} {String(r.e.h).padStart(2, "0")}:00
            </div>
            <div className="factors mono">
              <span title="Severity weight">w {r.weight}</span>
              {r.fatal > 1 && <span title="Fatal crash">×fatal 3</span>}
              <span title={`Multiplier for ${MODE_NAME[p.mode]}`}>×mode {r.mult.toFixed(1)}</span>
              <span title={`${r.ageDays.toFixed(0)} days old`}>
                ×age {r.decay.toFixed(2)} <em>({r.ageDays.toFixed(0)}d)</em>
              </span>
              <span title="Within 3 hours of travel time?">×hour {r.tod.toFixed(1)}</span>
            </div>
            <span className="c-bar">
              <span style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
          </li>
        ))}
        {!rows.length && !zone && <li className="muted">Nothing recorded here counts for {MODE_NAME[p.mode]} at this hour. Score 0, so routes pass freely.</li>}
      </ol>
      {rows.length > 40 && <p className="muted small-text">+{rows.length - 40} smaller signals</p>}

      <div className="sum mono">
        Σ = {fmt(total)} →{" "}
        <strong className={decision}>
          {decision === "avoid" ? "routes avoid this cell" : decision === "penalize" ? "routes pay a penalty here" : "no effect on routes"}
        </strong>
      </div>
    </div>
  );
}
