import { latLngToCell } from "h3-js";
import { writeFileSync, mkdirSync } from "node:fs";

const RES = 9;
const BASE = "https://data.sf.gov/resource";
const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * 864e5).toISOString().slice(0, 19);

async function soql(dataset, params) {
  const qs = new URLSearchParams({ ...params, $limit: "50000" });
  const res = await fetch(`${BASE}/${dataset}.json?${qs}`);
  if (!res.ok) throw new Error(`${dataset}: ${res.status} ${await res.text()}`);
  return res.json();
}

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();

function classifyCall(desc) {
  const d = desc.toUpperCase();
  if (/ DV\b|DOMESTIC|HOMELESS|SIT\/LIE/.test(d)) return null;
  if (/HOMICIDE|SHOOTING|SHOTS FIRED/.test(d)) return "shooting";
  if (/CARJACK/.test(d)) return "carjacking";
  if (/ROBBERY/.test(d)) return "robbery";
  if (/NO WEAPON/.test(d)) return "assault";
  if (/W\/GUN|W\/KNIFE|STABBING|AGG ASSAULT|ADW|WEAPON/.test(d)) return "agg_assault";
  if (/ASSAULT|BATTERY|FIGHT/.test(d)) return "assault";
  if (/THREAT/.test(d)) return "threat";
  if (/AUTO BOOST|BREAK.?IN|BURGLARY.*VEH/.test(d)) return "car_breakin";
  return null;
}

function classifyCrash(r) {
  const parties = [r.party1_type, r.party2_type, r.mviw, r.dph_col_grp_description].join(" ").toLowerCase();
  if (/pedestrian/.test(parties) && !/no pedestrian/.test(r.ped_action?.toLowerCase() || "x")) return "crash_ped";
  if (/pedestrian/.test(r.dph_col_grp_description?.toLowerCase() || "")) return "crash_ped";
  if (/bicycl|bike|scooter/.test(parties)) return "crash_bike";
  if (/motorcycl|moped/.test(parties)) return "crash_moto";
  return "crash_vehicle";
}

const events = [];

const incidents = await soql("gnap-fj3t", {
  $select: "received_datetime,call_type_final_desc,intersection_name,intersection_point",
  $where: `intersection_point IS NOT NULL AND received_datetime > '${daysAgo(365)}'`,
});
for (const r of incidents) {
  const type = classifyCall(r.call_type_final_desc || "");
  if (!type) continue;
  const [lng, lat] = r.intersection_point.coordinates;
  events.push({
    c: latLngToCell(lat, lng, RES),
    t: type,
    d: r.received_datetime.slice(0, 10),
    h: +r.received_datetime.slice(11, 13),
    x: `${titleCase(r.call_type_final_desc)} call, ${titleCase((r.intersection_name || "").replace(/\\+/g, "&"))}`,
    lat: +lat.toFixed(5),
    lng: +lng.toFixed(5),
  });
}

const crashes = await soql("ubvf-ztfx", {
  $select: "collision_datetime,collision_severity,number_killed,party1_type,party2_type,mviw,dph_col_grp_description,ped_action,lighting,primary_rd,secondary_rd,tb_latitude,tb_longitude",
  $where: `collision_datetime > '${daysAgo(730)}' AND tb_latitude IS NOT NULL`,
});
for (const r of crashes) {
  const lat = +r.tb_latitude, lng = +r.tb_longitude;
  if (!lat || !lng) continue;
  const fatal = +r.number_killed > 0;
  events.push({
    c: latLngToCell(lat, lng, RES),
    t: classifyCrash(r),
    d: r.collision_datetime.slice(0, 10),
    h: +r.collision_datetime.slice(11, 13),
    x: `${fatal ? "Fatal" : r.collision_severity || "Injury"} crash, ${[r.primary_rd, r.secondary_rd].filter(Boolean).join(" & ")}`,
    f: fatal ? 1 : undefined,
    lat: +lat.toFixed(5),
    lng: +lng.toFixed(5),
  });
}

const counts = events.reduce((m, e) => ((m[e.t] = (m[e.t] || 0) + 1), m), {});
mkdirSync("public/data", { recursive: true });
writeFileSync(
  "public/data/sf-events.json",
  JSON.stringify({ city: "sf", res: RES, generated: now.toISOString().slice(0, 10), events }),
);
console.log(`incidents fetched ${incidents.length}, crashes fetched ${crashes.length}, kept ${events.length}`);
console.log(counts);
