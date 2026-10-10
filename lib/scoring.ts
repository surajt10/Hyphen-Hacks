// Risk model: every event adds weight to its H3 cell, scaled by how serious it is,
// how it affects the chosen travel mode, how old it is and whether it happened near
// the hour of travel. See the design doc, "Safety risk model".
import { cellToLatLng, gridDisk, latLngToCell } from "h3-js";

export type Mode = "walk" | "wheelchair" | "bike" | "scooter" | "moped" | "car";
export const MODES: Mode[] = ["walk", "wheelchair", "bike", "scooter", "moped", "car"];

export type Ev = { c: string; t: string; d: string; h: number; x: string; f?: 1; lat: number; lng: number };

export const RES = 9;

export const TYPE_WEIGHT: Record<string, number> = {
  shooting: 10,
  carjacking: 8,
  robbery: 6,
  agg_assault: 6,
  assault: 4,
  threat: 2,
  car_breakin: 1,
  crash_ped: 3,
  crash_bike: 3,
  crash_moto: 3,
  crash_vehicle: 3,
  // An open 311 streetlight outage, counted only after sunset (see App: darkEvents).
  dark: 2.5,
};

const CRIME = { shooting: 1, carjacking: 0, robbery: 1, agg_assault: 1, assault: 1, threat: 1, car_breakin: 0 };
export const MODE_MULT: Record<Mode, Record<string, number>> = {
  walk: { ...CRIME, crash_ped: 1, crash_bike: 0, crash_moto: 0, crash_vehicle: 0.1, dark: 1 },
  wheelchair: { ...CRIME, crash_ped: 1, crash_bike: 0, crash_moto: 0, crash_vehicle: 0.1, dark: 1 },
  bike: { ...CRIME, robbery: 0.8, agg_assault: 0.8, assault: 0.8, threat: 0.6, crash_ped: 0.2, crash_bike: 1, crash_moto: 0.2, crash_vehicle: 0.3, dark: 0.7 },
  scooter: { ...CRIME, robbery: 0.8, agg_assault: 0.8, assault: 0.8, threat: 0.6, crash_ped: 0.2, crash_bike: 1, crash_moto: 0.2, crash_vehicle: 0.3, dark: 0.7 },
  moped: { shooting: 1, carjacking: 0.5, robbery: 0.4, agg_assault: 0.4, assault: 0.4, threat: 0.3, car_breakin: 0, crash_ped: 0.1, crash_bike: 0.3, crash_moto: 1, crash_vehicle: 0.6 },
  car: { shooting: 1, carjacking: 1, robbery: 0.1, agg_assault: 0.1, assault: 0.1, threat: 0.05, car_breakin: 0, crash_ped: 0.2, crash_bike: 0.2, crash_moto: 0.3, crash_vehicle: 0.5 },
};

// Crime fades over ~a month (SF's public feed is sparse); crash hotspots reflect
// street design, so they fade over a year.
export const TAU_DAYS = { crime: 30, crash: 365 };

export type CellRisk = { score: number; events: Ev[] };

// One event's share of a cell's risk, with every factor kept so it can be explained.
export type Contribution = { e: Ev; weight: number; fatal: number; mult: number; ageDays: number; decay: number; tod: number; value: number };

export function contribution(e: Ev, mode: Mode, when: Date): Contribution {
  const mult = MODE_MULT[mode][e.t] ?? 0;
  const crash = e.t.startsWith("crash");
  const ageDays = Math.max(0, (when.getTime() - Date.parse(e.d)) / 864e5);
  const decay = Math.exp(-ageDays / (crash ? TAU_DAYS.crash : TAU_DAYS.crime));
  const hour = when.getHours();
  const dh = Math.min(Math.abs(e.h - hour), 24 - Math.abs(e.h - hour));
  const tod = dh <= 3 ? 1 : 0.3;
  const weight = TYPE_WEIGHT[e.t] ?? 0;
  const fatal = e.f ? 3 : 1;
  return { e, weight, fatal, mult, ageDays, decay, tod, value: weight * fatal * mult * decay * tod };
}

export function scoreCells(events: Ev[], mode: Mode, when: Date): Map<string, CellRisk> {
  const cells = new Map<string, CellRisk>();
  for (const e of events) {
    const c = contribution(e, mode, when);
    if (!c.value) continue;
    const cell = cells.get(e.c) ?? { score: 0, events: [] };
    cell.score += c.value;
    cell.events.push(e);
    cells.set(e.c, cell);
  }
  return cells;
}

// Live zones from phones (sound alerts, confirmed reports) override the history.
export type LiveZone = {
  id: string;
  kind: "sound" | "report";
  level: "caution" | "confirmed";
  lat: number;
  lng: number;
  ts: number;
  count: number;
  category?: string;
  points?: [number, number][];
  // Acoustic triangulation (2+ phones with synced clocks): estimated origin and error radius.
  origin?: [number, number];
  radiusM?: number;
  spreadMs?: number;
  demo?: boolean;
};

export function liveCells(zones: LiveZone[]): Map<string, LiveZone> {
  const out = new Map<string, LiveZone>();
  for (const z of zones) {
    const center = latLngToCell(z.lat, z.lng, RES);
    const ring = z.kind === "sound" && z.level === "confirmed" ? gridDisk(center, 1) : [center];
    for (const c of ring) out.set(c, z);
  }
  return out;
}

export const LIVE_SCORE = { sound: { caution: 40, confirmed: 120 }, report: { caution: 0, confirmed: 15 } };

export function percentile(values: number[], p: number) {
  if (!values.length) return Infinity;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// Route exposure: score of each cell the route passes, times minutes spent in it.
export function routeRisk(
  coords: [number, number][],
  minutes: number,
  cells: Map<string, CellRisk>,
  live: Map<string, LiveZone>,
) {
  if (coords.length < 2) return { risk: 0, cellsOnRoute: new Map<string, number>() };
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], (coords[i][1] - coords[i - 1][1]) * 1.27);
    segs.push(d);
    total += d;
  }
  const minutesIn = new Map<string, number>();
  for (let i = 1; i < coords.length; i++) {
    const [lng, lat] = coords[i];
    const c = latLngToCell(lat, lng, RES);
    minutesIn.set(c, (minutesIn.get(c) ?? 0) + (segs[i - 1] / (total || 1)) * minutes);
  }
  let risk = 0;
  for (const [c, mins] of minutesIn) {
    const z = live.get(c);
    const s = (cells.get(c)?.score ?? 0) + (z ? LIVE_SCORE[z.kind][z.level] : 0);
    risk += s * Math.max(mins, 0.2);
  }
  return { risk, cellsOnRoute: minutesIn };
}

export const cellCenter = (c: string) => {
  const [lat, lng] = cellToLatLng(c);
  return [lng, lat] as [number, number];
};
