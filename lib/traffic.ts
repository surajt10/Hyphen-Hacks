export type TrafficIncident = {
  id: string;
  kind: "accident" | "jam" | "closure" | "roadworks" | "hazard" | "other";
  title: string;
  detail: string;
  delayMin: number;
  magnitude: number;
  lng: number;
  lat: number;
  full: boolean;
  line: [number, number][];
  since?: number;
};

const KIND: Record<number, TrafficIncident["kind"]> = { 0: "other", 1: "accident", 2: "hazard", 3: "hazard", 4: "hazard", 5: "hazard", 6: "jam", 7: "closure", 8: "closure", 9: "roadworks", 10: "hazard", 11: "hazard", 14: "hazard" };
const BOXES = ["-122.75,37.75,-121.55,38.35", "-122.75,37.15,-121.55,37.75"];
const FIELDS = "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,from,to,length,delay,roadNumbers}}}";
const TTL = 3 * 60_000;

type Raw = {
  geometry: { type: "Point" | "LineString"; coordinates: number[] | number[][] };
  properties: { id: string; iconCategory: number; magnitudeOfDelay: number; events?: { description: string }[]; startTime?: string; from?: string; to?: string; delay?: number | null; roadNumbers?: string[] };
};

const cache = ((globalThis as unknown as { __ns_traffic?: { at: number; data: TrafficIncident[]; ms: number; ok: boolean; pending?: Promise<void> } }).__ns_traffic ??= { at: 0, data: [], ms: 0, ok: false });

const clean = (s?: string) => (s ?? "").replace(/\s*\([^)]*\)/g, "").trim();
const inParens = (s?: string) => /\(([^)]+)\)/.exec(s ?? "")?.[1];

function simplify(coords: [number, number][], max = 30) {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => coords[Math.round(i * step)]);
}

function toIncident(r: Raw): TrafficIncident | null {
  const p = r.properties;
  const coords = (r.geometry.type === "Point" ? [r.geometry.coordinates] : r.geometry.coordinates) as [number, number][];
  if (!coords.length) return null;
  const kind = KIND[p.iconCategory] ?? "other";
  const at = kind === "accident" || kind === "jam" ? coords[coords.length - 1] : coords[Math.floor(coords.length / 2)];
  const raw = p.events?.[0]?.description ?? "Incident";
  const desc = raw === "Closed" ? "Road closed" : raw;
  const road = p.roadNumbers?.find((n) => /^(I|US|CA|SR)-/.test(n)) ?? p.roadNumbers?.[0] ?? inParens(p.from);
  const from = clean(p.from), to = clean(p.to);
  const delayMin = Math.round((p.delay ?? 0) / 60);
  const title = road ? `${desc} on ${road}` : from ? `${desc} near ${from}` : desc;
  const between = from && to && from !== to ? `${from} to ${to}` : from || to;
  return {
    id: p.id,
    kind,
    title,
    detail: [between, delayMin > 0 ? `${delayMin} min delay` : ""].filter(Boolean).join(" · "),
    delayMin,
    magnitude: p.magnitudeOfDelay ?? 0,
    lng: at[0],
    lat: at[1],
    full: p.iconCategory === 8,
    line: simplify(coords),
    since: p.startTime ? Date.parse(p.startTime) : undefined,
  };
}

async function refresh(key: string) {
  const t0 = Date.now();
  try {
    const lists = await Promise.all(
      BOXES.map(async (bbox) => {
        const u = new URL("https://api.tomtom.com/traffic/services/5/incidentDetails");
        u.search = new URLSearchParams({ key, bbox, fields: FIELDS, language: "en-US", timeValidityFilter: "present" }).toString();
        const r = await fetch(u, { cache: "no-store" });
        if (!r.ok) throw new Error(`TomTom ${r.status}`);
        return ((await r.json()).incidents ?? []) as Raw[];
      }),
    );
    const seen = new Set<string>();
    cache.data = lists
      .flat()
      .map(toIncident)
      .filter((i): i is TrafficIncident => !!i && !seen.has(i.id) && !!seen.add(i.id));
    cache.ok = true;
  } catch {
    cache.ok = false;
  }
  cache.ms = Date.now() - t0;
  cache.at = Date.now();
}

export async function trafficIncidents(): Promise<{ ok: boolean; at: number; ms: number; incidents: TrafficIncident[] }> {
  const key = process.env.TOMTOM_API_KEY;
  if (!key) return { ok: false, at: Date.now(), ms: 0, incidents: [] };
  if (Date.now() - cache.at > TTL) {
    cache.pending ??= refresh(key).finally(() => (cache.pending = undefined));
    await cache.pending;
  }
  return { ok: cache.ok, at: cache.at, ms: cache.ms, incidents: cache.data };
}
