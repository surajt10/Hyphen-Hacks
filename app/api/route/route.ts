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
};

function costing(mode: Mode, night: boolean) {
  const lit = night ? 1 : 0;
  switch (mode) {
    case "walk":
      return { costing: "pedestrian", options: { pedestrian: { use_lit: lit } } };
    case "wheelchair":
      return { costing: "pedestrian", options: { pedestrian: { type: "wheelchair", use_lit: lit, use_hills: 0, step_penalty: 600 } } };
    case "bike":
      return { costing: "bicycle", options: { bicycle: { bicycle_type: "Hybrid", use_roads: 0.3, use_hills: 0.3, use_lit: lit } } };
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
  legs: { shape: string; maneuvers: { instruction: string; length: number }[] }[];
};

const toRoute = (trip: Trip) => ({
  coords: trip.legs.flatMap((l) => decode(l.shape)),
  minutes: trip.summary.time / 60,
  mi: trip.summary.length,
  steps: trip.legs.flatMap((l) => l.maneuvers.map((m) => ({ text: m.instruction, mi: m.length }))),
});

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
  return trips.map(toRoute);
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
