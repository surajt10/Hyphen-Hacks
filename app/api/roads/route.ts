type Camera = { name: string; lng: number; lat: number; img: string };
type Closure = { name: string; lng: number; lat: number; lng2: number; lat2: number; type: string; work: string; until: string };

const BASE = "https://cwwp2.dot.ca.gov/data/d4";
const HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh) NorthStar-hackathon", Accept: "application/json" };
const cache = ((globalThis as unknown as { __ns_roads?: { at: number; cams: Camera[]; closures: Closure[] } }).__ns_roads ??= {
  at: 0,
  cams: [],
  closures: [],
});

async function getJson(url: string) {
  const r = await fetch(url, { headers: HEADERS, cache: "no-store" });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`${url} ${r.status}: ${t.slice(0, 120)}`);
  }
}

type Raw = Record<string, Record<string, Record<string, string> | string>>;

async function refresh() {
  if (Date.now() - cache.at < 5 * 60_000) return;
  cache.at = Date.now();
  try {
    const cctv = await getJson(`${BASE}/cctv/cctvStatusD04.json`);
    cache.cams = cctv.data
      .map(({ cctv: c }: { cctv: Raw }) => {
        const loc = c.location as Record<string, string>;
        const img = (c.imageData as unknown as { static?: { currentImageURL?: string } }).static?.currentImageURL;
        return (c.inService as unknown as string) === "true" && img ? { name: loc.locationName, lng: +loc.longitude, lat: +loc.latitude, img } : null;
      })
      .filter(Boolean);
  } catch (err) {
    console.error("cctv", String(err).slice(0, 200));
  }
  try {
    const lcs = await getJson(`${BASE}/lcs/lcsStatusD04.json`);
    const now = Date.now() / 1000;
    cache.closures = lcs.data
      .map(({ lcs: l }: { lcs: Raw }) => {
        const loc = l.location as unknown as Record<string, Record<string, string>>;
        const b = loc.begin, e = loc.end;
        const c = l.closure as unknown as Record<string, string> & { closureTimestamp: Record<string, string> };
        const ts = c.closureTimestamp;
        const open = ts.isClosureEndIndefinite === "true";
        if (+ts.closureStartEpoch > now || (!open && +ts.closureEndEpoch < now)) return null;
        return {
          name: `${b.beginRoute} ${b.beginLocationName}`,
          lng: +b.beginLongitude,
          lat: +b.beginLatitude,
          lng2: +e.endLongitude || +b.beginLongitude,
          lat2: +e.endLatitude || +b.beginLatitude,
          type: c.typeOfClosure,
          work: c.typeOfWork,
          until: open ? "until further notice" : `${ts.closureEndDate} ${ts.closureEndTime}`,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error("lcs", String(err).slice(0, 200));
  }
}

const live = ((globalThis as unknown as { __ns_camok?: Map<string, { at: number; ok: boolean }> }).__ns_camok ??= new Map());
async function isLive(c: Camera) {
  const hit = live.get(c.img);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
  let ok = false;
  try {
    const r = await fetch(c.img, { headers: HEADERS, cache: "no-store" });
    const size = (await r.arrayBuffer()).byteLength;
    ok = r.ok && !(size > 13300 && size < 13600);
  } catch {}
  live.set(c.img, { at: Date.now(), ok });
  return ok;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const [w, s, e, n] = (url.searchParams.get("bbox") ?? "-122.52,37.70,-122.35,37.83").split(",").map(Number);
  await refresh();
  const inBox = (p: { lng: number; lat: number }) => p.lng > w && p.lng < e && p.lat > s && p.lat < n;
  const near = cache.cams.filter(inBox).slice(0, 24);
  const ok = await Promise.all(near.map(isLive));
  return Response.json({ cameras: near.filter((_, i) => ok[i]), closures: cache.closures.filter(inBox), asOf: cache.at });
}
