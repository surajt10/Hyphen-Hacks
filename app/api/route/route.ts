// Proxies routing to the public Valhalla server (OpenStreetMap data, no key needed).
// Each travel mode maps to a Valhalla costing model; avoid zones go in as exclude_polygons.
import type { Mode } from "@/lib/scoring";

const VALHALLA = process.env.VALHALLA_URL ?? "https://valhalla1.openstreetmap.de";

type Body = {
  mode: Mode;
  from: [number, number];
  to: [number, number];
  exclude?: [number, number][][];
  night?: boolean;
  alternates?: number;
  depart?: string; // ISO time the trip starts
};

// The public router has free-flow speeds only. For cars and mopeds we apply typical
// San Francisco congestion by time of day so ETAs match real-world trips more closely.
function trafficFactor(mode: Mode, d: Date) {
  if (mode !== "car" && mode !== "moped") return 1;
  const h = d.getHours(), weekday = d.getDay() >= 1 && d.getDay() <= 5;
  const f = weekday && ((h >= 7 && h < 10) || (h >= 16 && h < 19)) ? 1.45 : h >= 10 && h < 16 ? 1.25 : h >= 19 && h < 22 ? 1.15 : 1.05;
  return mode === "moped" ? 1 + (f - 1) * 0.8 : f;
}

function costing(mode: Mode, night: boolean) {
  const lit = night ? 1 : 0;
  switch (mode) {
    case "walk":
      return { costing: "pedestrian", options: { pedestrian: { use_lit: lit, walking_speed: 4.8 } } };
    case "wheelchair":
      return { costing: "pedestrian", options: { pedestrian: { type: "wheelchair", walking_speed: 3.6, use_lit: lit, use_hills: 0, step_penalty: 600 } } };
    case "bike":
      return { costing: "bicycle", options: { bicycle: { bicycle_type: "Hybrid", cycling_speed: 16, use_roads: 0.3, use_hills: 0.3, use_lit: lit } } };
    case "scooter":
      // Kick e-scooters: no sidewalks, prefer bike lanes and quiet streets, avoid rough surfaces.
      return { costing: "bicycle", options: { bicycle: { bicycle_type: "City", cycling_speed: 18, use_roads: 0.1, use_hills: 0.5, avoid_bad_surfaces: 0.8, use_lit: lit } } };
    case "moped":
      return { costing: "motor_scooter", options: { motor_scooter: { top_speed: 45, use_primary: 0.3, use_hills: 0.3 } } };
    case "car":
    default:
      return { costing: "auto", options: {} };
  }
}

// Valhalla encodes shapes as polyline with 6-digit precision.
function decode(str: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b: number;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
}

type Trip = {
  summary: { time: number; length: number };
  legs: { shape: string; maneuvers: { instruction: string; length: number; begin_shape_index: number }[] }[];
};

// Each step keeps "at": the index into coords where the maneuver begins (for turn-by-turn).
const toRoute = (trip: Trip) => {
  const coords: [number, number][] = [];
  const steps: { text: string; mi: number; at: number }[] = [];
  for (const leg of trip.legs) {
    const offset = coords.length;
    coords.push(...decode(leg.shape));
    for (const m of leg.maneuvers) steps.push({ text: m.instruction, mi: m.length, at: offset + m.begin_shape_index });
  }
  return { coords, minutes: trip.summary.time / 60, mi: trip.summary.length, steps };
};

// Live traffic (optional): with TOMTOM_API_KEY set, car and moped times are scaled by TomTom's
// real-time travel time for the same trip. Without a key we use the time-of-day model above.
const liveCache = ((globalThis as unknown as { __ns_tt?: Map<string, { at: number; minutes: number }> }).__ns_tt ??= new Map());
async function trafficFor(body: Body, freeFlowMinutes: number): Promise<{ f: number; source: "live" | "model" | "none" }> {
  if (body.mode !== "car" && body.mode !== "moped") return { f: 1, source: "none" };
  const depart = body.depart ? new Date(body.depart) : new Date();
  const key = process.env.TOMTOM_API_KEY;
  if (key) {
    const id = `${body.from.map((n) => n.toFixed(3))}:${body.to.map((n) => n.toFixed(3))}:${Math.round(depart.getTime() / 300000)}`;
    try {
      let hit = liveCache.get(id);
      if (!hit || Date.now() - hit.at > 120_000) {
        const when = depart.getTime() - Date.now() > 5 * 60_000 ? encodeURIComponent(depart.toISOString().slice(0, 19) + "Z") : "now";
        const url = `https://api.tomtom.com/routing/1/calculateRoute/${body.from[1]},${body.from[0]}:${body.to[1]},${body.to[0]}/json?key=${key}&traffic=true&travelMode=car&departAt=${when}`;
        const j = await fetch(url, { cache: "no-store" }).then((r) => r.json());
        hit = { at: Date.now(), minutes: j.routes[0].summary.travelTimeInSeconds / 60 };
        liveCache.set(id, hit);
      }
      const f = Math.min(3, Math.max(0.8, hit.minutes / freeFlowMinutes));
      return { f: body.mode === "moped" ? 1 + (f - 1) * 0.8 : f, source: "live" };
    } catch {}
  }
  return { f: trafficFactor(body.mode, depart), source: "model" };
}

const localIso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

async function valhalla(body: Body, exclude?: [number, number][][]) {
  const { costing: c, options } = costing(body.mode, !!body.night);
  const req = {
    locations: [
      { lon: body.from[0], lat: body.from[1] },
      { lon: body.to[0], lat: body.to[1] },
    ],
    costing: c,
    costing_options: options,
    units: "miles",
    alternates: body.alternates ?? 0,
    ...(body.depart ? { date_time: { type: 1, value: localIso(new Date(body.depart)) } } : {}),
    ...(exclude?.length ? { exclude_polygons: exclude } : {}),
  };
  const res = await fetch(`${VALHALLA}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "NorthStar-hackathon/0.1" },
    body: JSON.stringify(req),
  });
  const json = await res.json();
  if (!res.ok || !json.trip) throw new Error(json.error ?? `Valhalla ${res.status}`);
  const trips: Trip[] = [json.trip, ...(json.alternates ?? []).map((a: { trip: Trip }) => a.trip)];
  const { f, source } = await trafficFor(body, trips[0].summary.time / 60);
  return trips.map(toRoute).map((r) => ({ ...r, minutes: r.minutes * f, traffic: f, trafficSource: source }));
}

export async function POST(request: Request) {
  const body = (await request.json()) as Body;
  try {
    return Response.json({ routes: await valhalla(body, body.exclude), excluded: !!body.exclude?.length });
  } catch (err) {
    // Avoid zones can cut off the start or end; fall back to an unrestricted route.
    if (body.exclude?.length) {
      try {
        return Response.json({ routes: await valhalla(body), excluded: false, note: String(err) });
      } catch {}
    }
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
