// Live status of every data source NorthStar uses, for the "How it works" panel.
// Each feed is fetched server-side, timed, and cached for a minute.
type Feed = { id: string; name: string; provider: string; ok: boolean; ms: number; detail: string; updated?: string; value?: string };

const cache = ((globalThis as unknown as { __ns_sources?: { at: number; data: unknown } }).__ns_sources ??= { at: 0, data: null });
const UA = { "User-Agent": "Mozilla/5.0 NorthStar-hackathon", Accept: "application/json" };

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; v?: T; err?: string }> {
  const t0 = Date.now();
  try {
    const v = await fn();
    return { ok: true, ms: Date.now() - t0, v };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: String(e).slice(0, 120) };
  }
}
const json = async (url: string) => {
  const r = await fetch(url, { headers: UA, cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

const VIOLENT = "(call_type_final_desc like '%ASSAULT%' OR call_type_final_desc like '%FIGHT%' OR call_type_final_desc like '%ROBBERY%' OR call_type_final_desc like '%SHOT%' OR call_type_final_desc like '%SHOOT%' OR call_type_final_desc like '%W/GUN%' OR call_type_final_desc like '%W/KNIFE%' OR call_type_final_desc like '%STAB%')";
const WMO: Record<number, string> = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 61: "Rain", 63: "Rain", 65: "Heavy rain", 80: "Showers", 81: "Showers", 82: "Heavy showers", 95: "Thunderstorm" };

export async function GET() {
  if (cache.data && Date.now() - cache.at < 60_000) return Response.json(cache.data);
  const since = new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 19);
  const since7 = new Date(Date.now() - 7 * 24 * 3600e3).toISOString().slice(0, 19);

  const [calls, latest, crashes, weather, bart, fires, cams, router] = await Promise.all([
    timed(() => json(`https://data.sf.gov/resource/gnap-fj3t.json?$select=count(*)&$where=${encodeURIComponent(`received_datetime > '${since}' AND ${VIOLENT}`)}`)),
    timed(() => json(`https://data.sf.gov/resource/gnap-fj3t.json?$select=received_datetime,call_type_final_desc,intersection_name,data_as_of&$where=${encodeURIComponent(`intersection_point IS NOT NULL AND received_datetime > '${since7}' AND ${VIOLENT}`)}&$order=received_datetime DESC&$limit=6`)),
    timed(() => json(`https://data.sf.gov/resource/ubvf-ztfx.json?$select=max(collision_datetime) as last,max(data_as_of) as asof`)),
    timed(() => json("https://api.open-meteo.com/v1/forecast?latitude=37.77&longitude=-122.42&current=temperature_2m,precipitation,weather_code,is_day&daily=sunrise,sunset&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=America%2FLos_Angeles&forecast_days=1")),
    timed(() => json("https://api.bart.gov/api/bsa.aspx?cmd=elev&key=MW9S-E7SL-26DU-VV8V&json=y")),
    timed(async () => {
      const r = await fetch("https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv", { cache: "no-store" });
      const rows = (await r.text()).trim().split("\n").slice(1);
      const bay = rows.filter((l) => {
        const [la, lo] = l.split(",").map(Number);
        return la > 37.2 && la < 38.4 && lo > -123.1 && lo < -121.5;
      });
      return { total: rows.length, bay: bay.length };
    }),
    timed(() => json("https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json")),
    timed(async () => {
      const r = await fetch("https://valhalla1.openstreetmap.de/status", { cache: "no-store" });
      return r.json();
    }),
  ]);

  const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : undefined);
  const lv = latest.v as { received_datetime: string; call_type_final_desc: string; intersection_name: string; data_as_of: string }[] | undefined;
  const cv = crashes.v as { last: string; asof: string }[] | undefined;
  const wv = weather.v as { current: { temperature_2m: number; precipitation: number; weather_code: number; is_day: number }; daily: { sunrise: string[]; sunset: string[] } } | undefined;
  const bv = bart.v as { root: { bsa: { description: { "#cdata-section": string } }[] } } | undefined;
  const fv = fires.v as { total: number; bay: number } | undefined;
  type Cam = { cctv: { inService: string; location: { locationName: string; latitude: string; longitude: string }; imageData: { static: { currentImageURL: string } } } };
  const camList = ((cams.v as { data: Cam[] } | undefined)?.data ?? [])
    .map((d) => d.cctv)
    .filter((c) => c.inService === "true" && +c.location.latitude > 37.7 && +c.location.latitude < 37.83 && +c.location.longitude > -122.52 && +c.location.longitude < -122.35);

  const feeds: Feed[] = [
    {
      id: "dispatch",
      name: "Police dispatch calls",
      provider: "DataSF · SFPD",
      ok: calls.ok,
      ms: calls.ms + latest.ms,
      value: calls.ok ? `${(calls.v as { count: string }[])[0].count} violent calls, last 24 h` : "unavailable",
      detail: lv?.[0] ? `Latest: ${lv[0].call_type_final_desc.toLowerCase()} near ${lv[0].intersection_name.replace(/\\+/g, "&")}` : "",
      updated: fmtTime(lv?.[0]?.data_as_of),
    },
    {
      id: "crashes",
      name: "Injury crashes",
      provider: "DataSF · SFMTA / SFPD",
      ok: crashes.ok,
      ms: crashes.ms,
      value: cv?.[0] ? `Latest crash on file: ${fmtTime(cv[0].last)}` : "unavailable",
      detail: "5,795 crashes over 2 years power the road-danger layer",
      updated: fmtTime(cv?.[0]?.asof),
    },
    {
      id: "weather",
      name: "Weather and daylight",
      provider: "Open-Meteo",
      ok: weather.ok,
      ms: weather.ms,
      value: wv ? `${Math.round(wv.current.temperature_2m)}°F · ${WMO[wv.current.weather_code] ?? "—"}${wv.current.precipitation > 0 ? ` · ${wv.current.precipitation} in rain` : ""}` : "unavailable",
      detail: wv ? `Sunset ${new Date(wv.daily.sunset[0]).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}: after dark, routes prefer lit streets` : "",
    },
    {
      id: "bart",
      name: "BART elevator status",
      provider: "BART API",
      ok: bart.ok,
      ms: bart.ms,
      value: bv?.root.bsa[0]?.description["#cdata-section"] ?? "unavailable",
      detail: "Step-free access for wheelchair routes",
    },
    {
      id: "cameras",
      name: "Highway cameras",
      provider: "Caltrans District 4",
      ok: cams.ok,
      ms: cams.ms,
      value: `${camList.length} live cameras in SF`,
      detail: "Road conditions for car and moped routes",
    },
    {
      id: "fires",
      name: "Satellite fire detection",
      provider: "NASA FIRMS · VIIRS",
      ok: fires.ok,
      ms: fires.ms,
      value: fv ? `${fv.bay} active fires in the Bay Area (24 h)` : "unavailable",
      detail: fv ? `${fv.total.toLocaleString()} detections across the US today` : "",
    },
    {
      id: "router",
      name: "Routing engine",
      provider: "Valhalla · OpenStreetMap",
      ok: router.ok,
      ms: router.ms,
      value: router.ok ? `Online · ${router.ms} ms` : "unavailable",
      detail: "6 travel modes, avoid zones from the risk grid",
    },
  ];

  // Drop cameras showing Caltrans's "Temporarily Unavailable" placeholder (~13.4 KB image).
  const checked = await Promise.all(
    camList.slice(0, 14).map(async (c) => {
      try {
        const r = await fetch(c.imageData.static.currentImageURL, { headers: UA, cache: "no-store" });
        const size = (await r.arrayBuffer()).byteLength;
        return size > 13300 && size < 13600 ? null : c;
      } catch {
        return null;
      }
    }),
  );
  const liveCams = checked.filter((c): c is Cam["cctv"] => !!c);

  const data = {
    at: Date.now(),
    feeds,
    recentCalls: (lv ?? []).map((c) => ({ t: fmtTime(c.received_datetime), type: c.call_type_final_desc, where: c.intersection_name.replace(/\\+/g, "&") })),
    cameras: liveCams.slice(0, 8).map((c) => ({ name: c.location.locationName.replace(/^TV\d+ -- /, ""), img: c.imageData.static.currentImageURL, lat: +c.location.latitude, lng: +c.location.longitude })),
    weather: wv ? { isDay: !!wv.current.is_day, sunset: wv.daily.sunset[0] } : null,
  };
  cache.at = Date.now();
  cache.data = data;
  return Response.json(data);
}
