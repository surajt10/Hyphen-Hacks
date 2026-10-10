// Live layer shared by every phone: sound detections and community reports.
// Kept in server memory (fine for a single demo server). Phones poll GET every ~1.5 s.
import type { LiveZone } from "@/lib/scoring";
import { latLngToCell } from "h3-js";

type Raw = {
  id: string;
  kind: "sound" | "report";
  category?: string;
  lat: number;
  lng: number;
  ts: number;
  device: string;
  confidence?: number;
  answer?: "danger" | "safe";
  votes: { device: string; vote: "confirm" | "gone" }[];
};

const store = ((globalThis as unknown as { __ns_live?: Raw[] }).__ns_live ??= []);

// Phones with "listen for gunshots" on check in every ~20 s. Only area-level counts are ever
// returned (H3 cells about 0.3 sq mi), never a device's position.
const listeners = ((globalThis as unknown as { __ns_listen?: Map<string, { lat: number; lng: number; ts: number }> }).__ns_listen ??= new Map());
function sensors(now: number) {
  const cells = new Map<string, number>();
  for (const [id, l] of listeners) {
    if (now - l.ts > 60_000) {
      listeners.delete(id);
      continue;
    }
    const c = latLngToCell(l.lat, l.lng, 8);
    cells.set(c, (cells.get(c) ?? 0) + 1);
  }
  return { phones: [...cells.values()].reduce((a, b) => a + b, 0), cells: [...cells].map(([cell, n]) => ({ cell, n })) };
}

const MIN = 60_000;
const TTL = {
  soundCaution: 30 * MIN,
  soundConfirmed: 120 * MIN,
  reportIncident: 6 * 60 * MIN,
  reportHazard: 7 * 24 * 60 * MIN,
};
const SOUND_RADIUS_M = 500;
const SOUND_WINDOW_MS = 3000;
const REPORT_RADIUS_M = 150;

function meters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function zones(now: number) {
  const out: (LiveZone & { reportIds?: string[]; confirms?: number })[] = [];

  // Sound: phones that heard a bang within 3 s and 500 m of each other form one event.
  const sounds = store.filter((e) => e.kind === "sound" && now - e.ts < TTL.soundConfirmed);
  const used = new Set<string>();
  for (const s of sounds.sort((a, b) => a.ts - b.ts)) {
    if (used.has(s.id)) continue;
    const group = sounds.filter(
      (o) => !used.has(o.id) && Math.abs(o.ts - s.ts) <= SOUND_WINDOW_MS && meters(o, s) <= SOUND_RADIUS_M,
    );
    group.forEach((g) => used.add(g.id));
    const devices = new Set(group.map((g) => g.device));
    const danger = group.some((g) => g.answer === "danger");
    const allSafe = group.every((g) => g.answer === "safe");
    if (devices.size === 1 && allSafe) continue; // cancelled
    const confirmed = devices.size >= 2 || danger;
    if (now - s.ts > (confirmed ? TTL.soundConfirmed : TTL.soundCaution)) continue;
    out.push({
      id: s.id,
      kind: "sound",
      level: confirmed ? "confirmed" : "caution",
      lat: group.reduce((a, g) => a + g.lat, 0) / group.length,
      lng: group.reduce((a, g) => a + g.lng, 0) / group.length,
      ts: s.ts,
      count: devices.size,
      points: group.map((g) => [g.lng, g.lat] as [number, number]),
    });
  }

  // Reports: counted once 3 different people report or confirm within 150 m.
  const hazard = (c?: string) => c !== "incident";
  const reports = store.filter(
    (e) => e.kind === "report" && now - e.ts < (hazard(e.category) ? TTL.reportHazard : TTL.reportIncident),
  );
  const usedR = new Set<string>();
  for (const r of reports) {
    if (usedR.has(r.id)) continue;
    const group = reports.filter((o) => o.category === r.category && !usedR.has(o.id) && meters(o, r) <= REPORT_RADIUS_M);
    group.forEach((g) => usedR.add(g.id));
    const people = new Set<string>();
    let gone = 0;
    for (const g of group) {
      people.add(g.device);
      for (const v of g.votes) v.vote === "confirm" ? people.add(v.device) : gone++;
    }
    if (gone >= 2) continue;
    out.push({
      id: r.id,
      kind: "report",
      category: r.category,
      level: people.size >= 3 ? "confirmed" : "caution",
      lat: r.lat,
      lng: r.lng,
      ts: Math.max(...group.map((g) => g.ts)),
      count: people.size,
      reportIds: group.map((g) => g.id),
    });
  }
  return out;
}

export async function GET() {
  const now = Date.now();
  return Response.json({ zones: zones(now), sensors: sensors(now), now });
}

export async function POST(request: Request) {
  const b = await request.json();
  const now = Date.now();
  // Abuse limit: one sound event per device per 10 s, one report per category per device per hour.
  if (b.action === "sound" || b.action === "report") {
    const recent = store.find(
      (e) =>
        e.device === b.device &&
        e.kind === b.action &&
        (b.action === "sound" ? now - e.ts < 10_000 : e.category === b.category && now - e.ts < 60 * MIN),
    );
    if (recent) return Response.json({ id: recent.id, limited: true, zones: zones(now) });
    const ev: Raw = {
      id: Math.random().toString(36).slice(2, 10),
      kind: b.action,
      category: b.category,
      lat: +b.lat,
      lng: +b.lng,
      ts: now,
      device: String(b.device),
      confidence: b.confidence,
      votes: [],
    };
    store.push(ev);
    return Response.json({ id: ev.id, zones: zones(now) });
  }
  if (b.action === "answer") {
    const ev = store.find((e) => e.id === b.id);
    if (ev) ev.answer = b.answer;
    return Response.json({ ok: !!ev, zones: zones(now) });
  }
  if (b.action === "vote") {
    for (const id of b.ids ?? []) {
      const ev = store.find((e) => e.id === id);
      if (ev && !ev.votes.some((v) => v.device === b.device)) ev.votes.push({ device: b.device, vote: b.vote });
    }
    return Response.json({ ok: true, zones: zones(now) });
  }
  if (b.action === "listen") {
    if (b.off) listeners.delete(String(b.device));
    else listeners.set(String(b.device), { lat: +b.lat, lng: +b.lng, ts: now });
    return Response.json({ ok: true, sensors: sensors(now) });
  }
  if (b.action === "reset") {
    store.length = 0;
    return Response.json({ ok: true, zones: [] });
  }
  return Response.json({ error: "unknown action" }, { status: 400 });
}
