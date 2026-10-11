import type { LiveZone } from "@/lib/scoring";
import { cellToLatLng, latLngToCell } from "h3-js";

type Raw = {
  id: string;
  kind: "sound" | "report";
  category?: string;
  lat: number;
  lng: number;
  ts: number;
  device: string;
  confidence?: number;
  at?: number;
  demo?: boolean;
  answer?: "danger" | "safe";
  votes: { device: string; vote: "confirm" | "gone" }[];
};

const store = ((globalThis as unknown as { __ns_live?: Raw[] }).__ns_live ??= []);

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
const SOUND_RADIUS_M = 800;
const SOUND_WINDOW_MS = 3000;
const REPORT_RADIUS_M = 150;

function meters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371e3, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const snap = (p: { lat: number; lng: number }): [number, number] => {
  const [lat, lng] = cellToLatLng(latLngToCell(p.lat, p.lng, 10));
  return [lng, lat];
};

const C = 343;
const SIGMA_S = 0.03;
function triangulate(obs: { lat: number; lng: number; at: number }[]) {
  const lat0 = obs.reduce((a, o) => a + o.lat, 0) / obs.length;
  const lng0 = obs.reduce((a, o) => a + o.lng, 0) / obs.length;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180), my = 110540;
  const P = obs.map((o) => ({ x: (o.lng - lng0) * mx, y: (o.lat - lat0) * my, t: (o.at - obs[0].at) / 1000 }));
  const cost = (x: number, y: number) => {
    const r = P.map((p) => p.t - Math.hypot(p.x - x, p.y - y) / C);
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    return r.reduce((a, v) => a + ((v - m) / SIGMA_S) ** 2, 0) + (Math.hypot(x, y) / 400) ** 2;
  };
  const grid: { x: number; y: number; c: number }[] = [];
  let best = { x: 0, y: 0, c: Infinity };
  for (let x = -900; x <= 900; x += 12)
    for (let y = -900; y <= 900; y += 12) {
      const c = cost(x, y);
      grid.push({ x, y, c });
      if (c < best.c) best = { x, y, c };
    }
  for (let step = 6; step >= 0.75; step /= 2)
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
      const c = cost(best.x + dx, best.y + dy);
      if (c < best.c) best = { x: best.x + dx, y: best.y + dy, c };
    }
  const inside = grid.filter((g) => g.c <= best.c + 4).map((g) => Math.hypot(g.x - best.x, g.y - best.y)).sort((a, b) => a - b);
  const radiusM = Math.min(600, Math.max(25, inside.length ? inside[Math.floor(inside.length * 0.9)] : 25));
  const ts = obs.map((o) => o.at);
  return { origin: [lng0 + best.x / mx, lat0 + best.y / my] as [number, number], radiusM: Math.round(radiusM), spreadMs: Math.round(Math.max(...ts) - Math.min(...ts)) };
}

function zones(now: number) {
  const out: (LiveZone & { reportIds?: string[]; confirms?: number })[] = [];

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
    if (devices.size === 1 && allSafe) continue;
    const confirmed = devices.size >= 2 || danger;
    if (now - s.ts > (confirmed ? TTL.soundConfirmed : TTL.soundCaution)) continue;
    const timed = [...new Map(group.filter((g) => typeof g.at === "number").map((g) => [g.device, g as Raw & { at: number }])).values()];
    const tri = timed.length >= 2 ? triangulate(timed) : null;
    out.push({
      id: s.id,
      kind: "sound",
      level: confirmed ? "confirmed" : "caution",
      lat: tri ? tri.origin[1] : group.reduce((a, g) => a + g.lat, 0) / group.length,
      lng: tri ? tri.origin[0] : group.reduce((a, g) => a + g.lng, 0) / group.length,
      ts: s.ts,
      count: devices.size,
      points: group.map(snap),
      ...(tri ?? {}),
      demo: group.some((g) => g.demo) || undefined,
    });
  }

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

const BOOT = Date.now();

export async function GET() {
  const now = Date.now();
  return Response.json({ zones: zones(now), sensors: sensors(now), now, boot: BOOT });
}

export async function POST(request: Request) {
  const b = await request.json();
  const now = Date.now();
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
      at: Number.isFinite(b.at) && Math.abs(b.at - now) < 10_000 ? +b.at : undefined,
      votes: [],
    };
    if (b.action === "sound" && Array.isArray(b.demoOrigin)) {
      const [olng, olat] = b.demoOrigin.map(Number);
      const t0 = now - 900;
      const mx = 111320 * Math.cos((olat * Math.PI) / 180), my = 110540;
      const turn = Math.random() * 360;
      const phones = [0, 1, 2].map((k) => {
        const a = ((turn + k * 120 + (Math.random() - 0.5) * 50) * Math.PI) / 180, d = 130 + Math.random() * 170;
        const x = d * Math.cos(a), y = d * Math.sin(a);
        const noise = () => (Math.random() - 0.5) * 16;
        return { lng: olng + (x + noise()) / mx, lat: olat + (y + noise()) / my, at: t0 + (d / C) * 1000 + (Math.random() - 0.5) * 12 };
      });
      Object.assign(ev, { ...phones[0], demo: true });
      for (const [k, p] of phones.slice(1).entries())
        store.push({ id: Math.random().toString(36).slice(2, 10), kind: "sound", lat: p.lat, lng: p.lng, ts: now, device: `demo-${ev.device}-${k}`, confidence: 0.9, at: p.at, demo: true, votes: [] });
    }
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
