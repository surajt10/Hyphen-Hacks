// Place categories: OpenStreetMap tags to search by type (not by name), plus the words people type.
export const CATEGORIES: Record<string, { label: string; tags: string[]; words: RegExp }> = {
  restaurant: { label: "Restaurants", tags: ["amenity:restaurant", "amenity:fast_food", "amenity:food_court"], words: /^(food|eat|eats|restaurants?|dinner|lunch|breakfast|brunch|takeout)$/ },
  cafe: { label: "Cafes", tags: ["amenity:cafe"], words: /^(coffee|cafes?|café|cafés|tea|boba)$/ },
  bar: { label: "Bars", tags: ["amenity:bar", "amenity:pub"], words: /^(bars?|pubs?|drinks?)$/ },
  grocery: { label: "Groceries", tags: ["shop:supermarket", "shop:convenience", "shop:greengrocer"], words: /^(grocer(y|ies)|supermarkets?|markets?|convenience stores?)$/ },
  pharmacy: { label: "Pharmacies", tags: ["amenity:pharmacy", "shop:chemist"], words: /^(pharmac(y|ies)|drugstores?|medicine)$/ },
  transit: { label: "Transit", tags: ["railway:station", "railway:halt", "public_transport:station"], words: /^(transit|stations?|bart|muni|train|subway)$/ },
  atm: { label: "ATMs", tags: ["amenity:atm", "amenity:bank"], words: /^(atms?|cash|banks?)$/ },
  hospital: { label: "Hospitals", tags: ["amenity:hospital", "amenity:clinic"], words: /^(hospitals?|er|emergency room|urgent care|clinics?|doctor)$/ },
  hotel: { label: "Hotels", tags: ["tourism:hotel", "tourism:hostel", "tourism:motel"], words: /^(hotels?|hostels?|motels?)$/ },
  gas: { label: "Gas", tags: ["amenity:fuel"], words: /^(gas|gas stations?|fuel)$/ },
  parking: { label: "Parking", tags: ["amenity:parking"], words: /^(parking|garages?)$/ },
  police: { label: "Police", tags: ["amenity:police"], words: /^(police|police stations?)$/ },
};

export const categoryFor = (q: string) => {
  const s = q.trim().toLowerCase().replace(/ (near me|nearby|around here)$/, "");
  return Object.keys(CATEGORIES).find((k) => CATEGORIES[k].words.test(s)) ?? null;
};

type Found = { name: string; lat: number; lng: number; addr: string; dist: number };
const cache = new Map<string, { at: number; items: Found[] }>();

function miles(a: [number, number], b: [number, number]) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Nearest places with the given OpenStreetMap tags, via Photon's reverse lookup.
export async function nearbyByTags(tags: string[], lat: number, lng: number, limit = 20, radiusKm = 2): Promise<Found[]> {
  const key = `${tags.join("|")}:${lat.toFixed(3)}:${lng.toFixed(3)}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.items;
  const qs = tags.map((t) => `&osm_tag=${encodeURIComponent(t)}`).join("");
  const j = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&limit=${limit}&radius=${radiusKm}${qs}`).then((r) => r.json());
  const items: Found[] = (j.features as { properties: Record<string, string>; geometry: { coordinates: [number, number] } }[])
    .filter((f) => f.properties.name)
    .map((f) => {
      const p = f.properties;
      const c = f.geometry.coordinates;
      return { name: p.name, lng: c[0], lat: c[1], addr: [p.housenumber, p.street].filter(Boolean).join(" "), dist: miles([lng, lat], c) };
    })
    .sort((a, b) => a.dist - b.dist);
  cache.set(key, { at: Date.now(), items });
  return items;
}

export const searchCategory = (cat: string, lat: number, lng: number) => (CATEGORIES[cat] ? nearbyByTags(CATEGORIES[cat].tags, lat, lng) : Promise.resolve([]));
