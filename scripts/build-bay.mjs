import { latLngToCell } from "h3-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const RES = 9;
const OUT_DIR = new URL("../public/data/", import.meta.url);
const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * 864e5).toISOString().slice(0, 19);

const BBOX = { minLng: -122.75, maxLng: -121.55, minLat: 37.15, maxLat: 38.35 };
const OAK_MAX = 15000;
const CRASH_MAX = 30000;

function curl(url, timeout = 300) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return execFileSync("curl", ["-sSL", "-m", String(timeout), url], {
        maxBuffer: 1 << 30,
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`curl failed for ${url}: ${lastErr?.message}`);
}

function getJSON(url) {
  const text = curl(url);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Bad JSON from ${url.slice(0, 120)}: ${text.slice(0, 300)}`);
  }
}

const titleCase = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Sr|Us|Ca|I)-(\d+)/g, (_, a, n) => `${a.toUpperCase()}-${n}`)
    .replace(/\s+/g, " ")
    .trim();

function inBox(lat, lng) {
  return lat >= BBOX.minLat && lat <= BBOX.maxLat && lng >= BBOX.minLng && lng <= BBOX.maxLng;
}

function coords(lat, lng) {
  lat = +lat;
  lng = +lng;
  if (!lat || !lng || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lng > 0) lng = -lng;
  if (!inBox(lat, lng)) return null;
  return [+lat.toFixed(5), +lng.toFixed(5)];
}

function makeEvent(t, iso, x, ll, fatal) {
  const [lat, lng] = ll;
  return {
    c: latLngToCell(lat, lng, RES),
    t,
    d: iso.slice(0, 10),
    h: +iso.slice(11, 13),
    x,
    lat,
    lng,
    f: fatal ? 1 : undefined,
  };
}

const SEVERITY = ["shooting", "carjacking", "robbery", "agg_assault", "assault", "threat", "car_breakin"];

const OAK_SKIP_TYPE =
  /DOMESTIC|SEX|RAPE|PROSTITUTION|NARCOTIC|DUI|DRUNK|RUNAWAY|WARRANT|KIDNAP|TRAFFIC|EMBEZZLE|FORGERY|FRAUD|GAMBLING|LIQUOR|MISSING|CURFEW/;
const OAK_DOMESTIC = /DOMESTIC|SPOUSE|COHAB|DATE\/ETC|CHILD|ELDER|DEP(ENDENT)? AD|CUSTODY/;
const OAK_SKIP_CHARGE =
  /UNEXPLAINED DEATH|PEACE OFFICER|PUBLIC OFFICER|EXECUTIVE OFFICER|EMERGENCY (PERSONNEL|MED)|TELEPHONE|PHONE CALL|ELECTR|SEX|RAPE|SODOM|LEWD|INDECENT|NARCOTIC|CONTROLLED SUBSTANCE|MARIJUANA|OPIUM|COCAINE|PROSTITUT|PANDER|LODGE|TRESPASS|DUI|DRIV|UNLICENSED|FALSE REPORT|COURT ORDER|CONTEMPT|PROB(ATION)? VIOL|PAROLE|STALK|ANIMAL|DOG/;

function classifyOakCharge(ct, d) {
  if (OAK_SKIP_CHARGE.test(d)) return null;
  if (ct === "HOMICIDE") return "shooting";
  if (/SHOOT|DISCHARGE|MURDER/.test(d)) return "shooting";
  if (/CARJACK/.test(d)) return "carjacking";
  if (ct === "ROBBERY" || /ROBBERY/.test(d)) return "robbery";
  if (/ADW|ASSAULT WITH|ASLT W|DEADLY WEAPON|FIREARM ON PERSON|GBI|SERIOUS BODILY|EXHIBIT F|BRANDISH|STUN GUN|CAUSTIC/.test(d))
    return "agg_assault";
  if (ct === "FELONY ASSAULT") return "agg_assault";
  if (ct === "THREATS" || /THREAT|TERRORIZE/.test(d)) return "threat";
  if (ct === "MISDEMEANOR ASSAULT" || /BATTERY|\bASSAULT\b|FIGHT\/CHALLENGE|FIGHT PUBLIC/.test(d)) return "assault";
  if (ct === "BURG - AUTO" || /BURGLARY.{0,3}AUTO/.test(d)) return "car_breakin";
  return null;
}

const weapon = (d) =>
  /FIREARM|F\/ARM|HANDGUN|SHOOT/.test(d) ? " (gun)" : /KNIFE|CUTTING/.test(d) ? " (knife)" : /STRONG.?ARM|HANDS, FISTS/.test(d) ? " (strong-arm)" : "";

function oakLabel(t, ct, d) {
  switch (t) {
    case "shooting":
      if (ct === "HOMICIDE") return /ATTEMPT/.test(d) ? "Attempted homicide" : "Homicide";
      return /DISCHARGE/.test(d) ? "Shots fired" : /MURDER/.test(d) ? "Attempted murder" : "Shooting";
    case "carjacking":
      return "Carjacking";
    case "robbery":
      return "Robbery" + weapon(d);
    case "agg_assault":
      return (/EXHIBIT|BRANDISH/.test(d) ? "Brandishing" : "Aggravated assault") + weapon(d);
    case "assault":
      return /FIGHT/.test(d) ? "Fight in public" : "Assault / battery";
    case "threat":
      return "Criminal threats";
    case "car_breakin":
      return "Auto burglary";
  }
}

const noCommas = (s) => (s || "").replace(/\s*,\s*/g, " ").trim();

function oakPlace(addr) {
  const a = noCommas(addr).replace(/\bAV\b/g, "AVE").replace(/\bWY\b/g, "WAY").replace(/\s*&\s*/g, " & ");
  const m = a.match(/^(\d+)\s+(.+)$/);
  if (m && !a.includes("&")) return `${+m[1]} Block ${titleCase(m[2])}`;
  return titleCase(a);
}

function buildOakland() {
  const BASE = "https://data.oaklandca.gov/resource/ppgh-7dqv.json";
  const rows = [];
  for (let offset = 0; ; offset += 50000) {
    const qs = new URLSearchParams({
      $select: "crimetype,description,casenumber,datetime,address,location",
      $where: `location IS NOT NULL AND datetime > '${daysAgo(365)}'`,
      $order: "datetime DESC, casenumber",
      $limit: "50000",
      $offset: String(offset),
    });
    const page = getJSON(`${BASE}?${qs}`);
    if (!Array.isArray(page)) throw new Error(`Oakland: ${JSON.stringify(page).slice(0, 300)}`);
    rows.push(...page);
    if (page.length < 50000) break;
  }

  const cases = new Map();
  rows.forEach((r, i) => {
    const key = r.casenumber || `row${i}`;
    if (!cases.has(key)) cases.set(key, []);
    cases.get(key).push(r);
  });

  const out = [];
  for (const charges of cases.values()) {
    const ct = (charges[0].crimetype || "").toUpperCase().trim();
    if (OAK_SKIP_TYPE.test(ct)) continue;
    if (charges.some((r) => OAK_DOMESTIC.test((r.description || "").toUpperCase()))) continue;
    let best = null;
    for (const r of charges) {
      const d = (r.description || "").toUpperCase();
      const t = classifyOakCharge((r.crimetype || "").toUpperCase().trim(), d);
      if (t && (!best || SEVERITY.indexOf(t) < SEVERITY.indexOf(best.t))) best = { t, r, d };
    }
    if (!best) continue;
    const [lng, lat] = best.r.location?.coordinates || [];
    const ll = coords(lat, lng);
    if (!ll || !best.r.datetime) continue;
    out.push(makeEvent(best.t, best.r.datetime, `${oakLabel(best.t, ct, best.d)}, ${oakPlace(best.r.address) || "Oakland"}`, ll));
  }
  out.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : b.h - a.h));
  console.log(`oakland: rows ${rows.length}, cases ${cases.size}, events ${out.length}`);
  return out.slice(0, OAK_MAX);
}

const CKAN = "https://data.ca.gov/api/3/action";
const COUNTIES = { 1: "Alameda", 7: "Contra Costa", 21: "Marin", 28: "Napa", 41: "San Mateo", 43: "Santa Clara", 48: "Solano", 49: "Sonoma" };
const MOTO_VEH = ["Motorcycle", "MotorDrivenCycleScooter15HpOrLess", "MotorizedBicycle"];
const BIKE_VEH = ["Bicycle", "ElectricBicycles", "GoPedZipElectricScooterAndMotorboard"];
const PARTY_TYPES = ["Pedestrian", "Bicyclist"];
const q = (xs) => xs.map((x) => `'${x}'`).join(",");

function sql(query) {
  const j = getJSON(`${CKAN}/datastore_search_sql?sql=${encodeURIComponent(query)}`);
  if (!j.success) throw new Error(`CKAN SQL error: ${JSON.stringify(j.error).slice(0, 400)}`);
  return j.result.records;
}

const crashFilter = (alias, since) => {
  const c = alias ? `${alias}.` : "";
  return `${c}"County Code" IN (${Object.keys(COUNTIES).join(",")})
    AND (${c}"NumberInjured" > 0 OR ${c}"NumberKilled" > 0)
    AND ${c}"Latitude" IS NOT NULL AND ${c}"Longitude" IS NOT NULL
    AND ${c}"Crash Date Time" >= '${since}'
    AND (${c}"IsDeleted" IS NULL OR ${c}"IsDeleted" <> 'True')`;
};

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') (cur += '"'), i++;
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function partiesFromCsv(url, ids, parties) {
  const child = spawn("curl", ["-sSL", "-m", "900", url], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise((res) => child.on("close", res));
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let idx = null;
  let kept = 0;
  for await (const line of rl) {
    if (!idx) {
      const h = parseCsvLine(line.replace(/^﻿/, "")).map((s) => s.trim());
      idx = { id: h.indexOf("CollisionId"), pt: h.indexOf("PartyType"), vt: h.indexOf("Vehicle1TypeDesc") };
      if (idx.id < 0 || idx.pt < 0 || idx.vt < 0) throw new Error(`Unexpected parties header: ${h.join(",").slice(0, 200)}`);
      continue;
    }
    const f = idx.id === 1 ? line.slice(line.indexOf(",") + 1, line.indexOf(",", line.indexOf(",") + 1)) : null;
    if (f !== null && !ids.has(+f)) continue;
    const cols = parseCsvLine(line);
    const id = +cols[idx.id];
    if (!ids.has(id)) continue;
    const pt = cols[idx.pt]?.trim();
    const vt = cols[idx.vt]?.trim();
    if (PARTY_TYPES.includes(pt) || MOTO_VEH.includes(vt) || BIKE_VEH.includes(vt)) {
      if (!parties.has(id)) parties.set(id, []);
      parties.get(id).push({ pt, vt });
      kept++;
    }
  }
  const code = await done;
  if (code !== 0) throw new Error(`curl exited with ${code}`);
  return kept;
}

function classifyCrash(r, ps) {
  const mviw = (r.mviw || "").toUpperCase();
  const ctype = (r.ctype || "").toUpperCase();
  if (ps.some((p) => p.pt === "Pedestrian") || mviw === "PEDESTRIAN" || (/PEDEST/.test(ctype) && mviw !== "BICYCLE"))
    return "crash_ped";
  if (mviw === "BICYCLE" || ps.some((p) => p.pt === "Bicyclist" || BIKE_VEH.includes(p.vt))) return "crash_bike";
  if (ps.some((p) => MOTO_VEH.includes(p.vt))) return "crash_moto";
  return "crash_vehicle";
}

const cleanRoad = (s) => (s && !/^null$/i.test(s.trim()) ? titleCase(noCommas(s)) : "");

async function buildCrashes() {
  const since = daysAgo(730);
  const pkg = getJSON(`${CKAN}/package_show?id=ccrs`).result;
  const res = (name) => pkg.resources.find((r) => r.name === name);

  const out = [];
  const stats = {};
  for (let year = +since.slice(0, 4); year <= now.getFullYear(); year++) {
    const crashesRes = res(`Crashes_${year}`);
    if (!crashesRes?.datastore_active) {
      console.warn(`ccrs ${year}: Crashes_${year} missing or not queryable, skipped`);
      continue;
    }
    const rid = crashesRes.id;

    const rows = [];
    for (let offset = 0; ; offset += 10000) {
      const page = sql(`SELECT "Collision Id" AS id, "Report Number" AS rn, "Report Version" AS rv,
          "Crash Date Time" AS dt, "NumberKilled" AS k, "Collision Type Description" AS ctype,
          "MotorVehicleInvolvedWithDesc" AS mviw, "PrimaryRoad" AS r1, "SecondaryRoad" AS r2,
          "City Name" AS city, "County Code" AS cc, "Latitude" AS lat, "Longitude" AS lng
        FROM "${rid}" WHERE ${crashFilter("", since)}
        ORDER BY "_id" LIMIT 10000 OFFSET ${offset}`);
      rows.push(...page);
      if (page.length < 10000) break;
    }

    const parties = new Map();
    const partiesRes = res(`Parties_${year}`);
    let partySource = "none";
    try {
      if (partiesRes?.datastore_active) {
        const ps = sql(`SELECT p."CollisionId" AS id, p."PartyType" AS pt, p."Vehicle1TypeDesc" AS vt
          FROM "${partiesRes.id}" p JOIN "${rid}" c ON c."Collision Id" = p."CollisionId"
          WHERE ${crashFilter("c", since)}
            AND (p."PartyType" IN (${q(PARTY_TYPES)}) OR p."Vehicle1TypeDesc" IN (${q([...MOTO_VEH, ...BIKE_VEH])}))`);
        for (const p of ps) {
          if (!parties.has(+p.id)) parties.set(+p.id, []);
          parties.get(+p.id).push({ pt: p.pt, vt: p.vt });
        }
        partySource = `sql (${ps.length} parties)`;
      } else if (partiesRes?.url) {
        const ids = new Set(rows.map((r) => +r.id));
        const kept = await partiesFromCsv(partiesRes.url, ids, parties);
        partySource = `csv (${kept} parties)`;
      }
    } catch (e) {
      console.warn(`ccrs ${year}: parties unavailable (${e.message}); using crash-level fields only`);
    }

    const byReport = new Map();
    for (const r of rows) {
      const key = `${r.rn}|${r.dt}`;
      const prev = byReport.get(key);
      if (!prev || +r.rv > +prev.rv) byReport.set(key, r);
    }

    let kept = 0;
    for (const r of byReport.values()) {
      const ll = coords(r.lat, r.lng);
      if (!ll || !r.dt) continue;
      const fatal = +r.k > 0;
      const roads = [...new Set([cleanRoad(r.r1), cleanRoad(r.r2)].filter(Boolean))];
      const city = r.city && r.city !== "Unincorporated" ? r.city : `${COUNTIES[r.cc] || ""} County`.trim();
      const place = roads.join(" & ") || noCommas(city);
      out.push(makeEvent(classifyCrash(r, parties.get(+r.id) || []), String(r.dt), `${fatal ? "Fatal" : "Injury"} crash, ${place}`, ll, fatal));
      kept++;
    }
    stats[year] = { rows: rows.length, kept, parties: partySource };
  }
  out.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : b.h - a.h));
  console.log("ccrs:", JSON.stringify(stats), `events ${out.length}`);
  return out.slice(0, CRASH_MAX);
}

const events = [];
const sources = [
  ["oakland", buildOakland],
  ["crashes", buildCrashes],
];
for (const [name, build] of sources) {
  try {
    events.push(...(await build()));
  } catch (e) {
    console.error(`${name} failed: ${e.message}`);
  }
}
if (!events.length) throw new Error("No events built; leaving the existing file untouched");

const counts = events.reduce((m, e) => ((m[e.t] = (m[e.t] || 0) + 1), m), {});
const json = JSON.stringify({ city: "bay", res: RES, generated: now.toISOString().slice(0, 10), events });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(new URL("bay-events.json", OUT_DIR), json);
console.log(`wrote bay-events.json: ${events.length} events, ${(json.length / 1048576).toFixed(2)} MB`);
console.log(counts, `fatal ${events.filter((e) => e.f).length}`);
