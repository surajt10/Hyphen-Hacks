// Situational-awareness analytics. Everything here works on events and places,
// never on people: no identities, faces, plates or individual tracks.
import { cellToParent, gridDisk, latLngToCell } from "h3-js";
import { scoreCells, type Ev, type LiveZone, type Mode } from "./scoring";
import { placeOf } from "./format";

const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.hypot((a.lng - b.lng) * 88, (a.lat - b.lat) * 111);
const timeOf = (e: Ev) => Date.parse(e.d) + e.h * 3600e3;

// ---------- incident constellations ----------
// Violent incidents within 500 ft and 12 h of each other are linked; linked groups of 3+
// are "constellations" (e.g. a run of fights moving down one street over a weekend).
export type Constellation = { id: number; events: Ev[]; links: [Ev, Ev][]; from: number; to: number; place: string; top: string; spanKm: number };

export function findConstellations(events: Ev[], maxKm = 0.15, maxHours = 12, minSize = 3): Constellation[] {
  // Violence only: break-ins and threats are too common to say anything about a chain.
  const crime = events.filter((e) => ["shooting", "carjacking", "robbery", "agg_assault", "assault"].includes(e.t));
  const byCell = new Map<string, number[]>();
  crime.forEach((e, i) => {
    const p = cellToParent(e.c, 8);
    if (!byCell.has(p)) byCell.set(p, []);
    byCell.get(p)!.push(i);
  });
  const parent = crime.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const t = crime.map(timeOf);
  for (let i = 0; i < crime.length; i++) {
    for (const nb of gridDisk(cellToParent(crime[i].c, 8), 1)) {
      for (const j of byCell.get(nb) ?? []) {
        if (j <= i || Math.abs(t[i] - t[j]) > maxHours * 3600e3 || kmBetween(crime[i], crime[j]) > maxKm) continue;
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, number[]>();
  crime.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  });
  const out: Constellation[] = [];
  for (const idx of groups.values()) {
    if (idx.length < minSize) continue;
    const evs = idx.map((i) => crime[i]).sort((a, b) => timeOf(a) - timeOf(b));
    // Minimum spanning tree: the "constellation lines" between incidents (big chains are
    // drawn in time order instead, to keep this fast).
    const inTree = new Set([0]);
    const links: [Ev, Ev][] = [];
    if (evs.length > 60) for (let k = 1; k < evs.length; k++) links.push([evs[k - 1], evs[k]]);
    while (evs.length <= 60 && inTree.size < evs.length) {
      let best: [number, number, number] = [-1, -1, Infinity];
      for (const a of inTree) for (let b = 0; b < evs.length; b++) if (!inTree.has(b)) {
        const d = kmBetween(evs[a], evs[b]);
        if (d < best[2]) best = [a, b, d];
      }
      inTree.add(best[1]);
      links.push([evs[best[0]], evs[best[1]]]);
    }
    const where = new Map<string, number>();
    const types = new Map<string, number>();
    for (const e of evs) {
      where.set(placeOf(e.x), (where.get(placeOf(e.x)) ?? 0) + 1);
      types.set(e.t, (types.get(e.t) ?? 0) + 1);
    }
    let span = 0;
    for (const [a, b] of links) span += kmBetween(a, b);
    out.push({
      id: 0,
      events: evs,
      links,
      from: timeOf(evs[0]),
      to: timeOf(evs[evs.length - 1]),
      place: [...where].sort((a, b) => b[1] - a[1])[0][0],
      top: [...types].sort((a, b) => b[1] - a[1])[0][0],
      spanKm: span,
    });
  }
  return out
    .sort((a, b) => b.events.length - a.events.length || b.to - a.to)
    .slice(0, 12)
    .map((c, i) => ({ ...c, id: i + 1 }));
}

// ---------- next-hour forecast ----------
// Same model as routing, evaluated one hour ahead: which blocks get riskier, and by how much.
export type Forecast = { now: number; next: number; rising: { cell: string; now: number; next: number }[] };

export function forecastNextHour(events: Ev[], mode: Mode, at = new Date()): Forecast {
  const a = scoreCells(events, mode, at);
  const b = scoreCells(events, mode, new Date(at.getTime() + 3600e3));
  let now = 0, next = 0;
  for (const v of a.values()) now += v.score;
  for (const v of b.values()) next += v.score;
  const rising = [...b]
    .map(([cell, v]) => ({ cell, now: a.get(cell)?.score ?? 0, next: v.score }))
    .filter((x) => x.next - x.now > 0.5)
    .sort((x, y) => y.next - y.now - (x.next - x.now))
    .slice(0, 40);
  return { now, next, rising };
}

// ---------- live anomaly watch ----------
// Violent dispatch calls in the last 3 hours per area (~0.3 sq mi) versus that area's normal
// rate from the historical data. 2+ calls at 3x normal or more is flagged.
export type Call = { ts: number; type: string; where: string; lat: number; lng: number };
export type Anomaly = { cell: string; n: number; expected: number; calls: Call[]; lat: number; lng: number };

export function detectAnomalies(calls: Call[], events: Ev[], now = Date.now()): Anomaly[] {
  const crime = events.filter((e) => !e.t.startsWith("crash"));
  if (!crime.length) return [];
  const dates = crime.map((e) => Date.parse(e.d));
  const days = Math.max(7, (Math.max(...dates) - Math.min(...dates)) / 864e5);
  const base = new Map<string, number>();
  for (const e of crime) {
    const p = cellToParent(e.c, 8);
    base.set(p, (base.get(p) ?? 0) + 1);
  }
  const recent = new Map<string, Call[]>();
  for (const c of calls) {
    if (now - c.ts > 3 * 3600e3 || now - c.ts < -600e3) continue;
    const p = latLngToCell(c.lat, c.lng, 8);
    if (!recent.has(p)) recent.set(p, []);
    recent.get(p)!.push(c);
  }
  const out: Anomaly[] = [];
  for (const [cell, list] of recent) {
    const expected = (base.get(cell) ?? 0) / (days * 8);
    if (list.length >= 2 && list.length >= 3 * Math.max(expected, 0.15)) {
      out.push({ cell, n: list.length, expected, calls: list, lat: list[0].lat, lng: list[0].lng });
    }
  }
  return out.sort((a, b) => b.n / Math.max(b.expected, 0.15) - a.n / Math.max(a.expected, 0.15));
}

// ---------- alert corroboration ----------
// A phone-detected bang is backed up when SFPD dispatch logs a gun-related call within
// 0.4 mi and 20 minutes of it.
export function corroborate(zones: LiveZone[], calls: Call[]): Map<string, Call> {
  const out = new Map<string, Call>();
  for (const z of zones) {
    if (z.kind !== "sound") continue;
    const match = calls.find((c) => /SHOT|SHOOT|GUN/.test(c.type) && Math.abs(c.ts - z.ts) <= 20 * 60e3 && kmBetween(c, z) <= 0.65);
    if (match) out.set(z.id, match);
  }
  return out;
}
