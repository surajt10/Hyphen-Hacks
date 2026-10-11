"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Map as MLMap, GeoJSONSource, MapMouseEvent, LngLatLike, Marker } from "maplibre-gl";
import { cellToBoundary, cellToChildren, cellToLatLng, cellToParent, cellsToMultiPolygon, gridDisk, latLngToCell } from "h3-js";
import {
  ArrowUpDown,
  Bookmark,
  Building2,
  CarFront,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Flag,
  Heart,
  History,
  Layers,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Menu,
  Mic,
  Moon,
  MoonStar,
  Navigation,
  Radio,
  Satellite,
  Search,
  ShieldCheck,
  Siren,
  Sun,
  Trash2,
  X,
  Camera,
  Ear,
  CircleDot,
  CornerUpRight,
  ChartColumnBig,
  TrafficCone,
} from "lucide-react";
import { MODES, type Mode, type Ev, type LiveZone, scoreCells, liveCells, routeRisk, percentile, cellCenter, contribution, LIVE_SCORE } from "@/lib/scoring";
import { DICTS, EVENT_LABEL, LANGS, type Lang, type Key } from "@/lib/i18n";
import { SoundWatcher, type Detection } from "@/lib/sound";
import { categoryFor, nearbyByTags, searchCategory } from "@/lib/places";
import { fmtAgo, fmtDate, fmtDist, fmtHour, peakWindow, placeOf } from "@/lib/format";
import Engine, { type LogEntry, type Sources } from "./Engine";
import { CAT, CAT_UI, CHIP_ORDER, MODE_ICON } from "./icons";
import { addPoiIcons, MAP_POI, POI_OF_TAG } from "./mapIcons";
import { corroborate, detectAnomalies, findConstellations, forecastNextHour, type Call } from "@/lib/intel";
import Galaxy from "./Galaxy";
import Logo from "./Logo";
import Replay from "./Replay";
import Command from "./Command";
import { satellite } from "@/lib/sat";
import type { TrafficIncident } from "@/lib/traffic";

type Theme = "light" | "dark";
type View = "nav" | "engine";
type Place = { label: string; lng: number; lat: number; cat?: string; addr?: string; hours?: string; dist?: number };
type Route = { coords: [number, number][]; minutes: number; mi: number; steps: { text: string; mi: number; at: number }[]; traffic?: number; trafficSource?: "live" | "model" | "none" };
type Nav = { route: Scored; idx: number; pos: [number, number]; cum: number[]; sim: boolean; started: number; avoided: number; arrived?: boolean; rerouting?: boolean; reroutes: number };
type Scored = Route & { risk: number };
type Avoided = { cell: string; score: number; events: Ev[]; live?: LiveZone };
type Camera = { name: string; lng: number; lat: number; img: string };
type Roads = { cameras: Camera[]; closures: { name: string; lng: number; lat: number; lng2: number; lat2: number; type: string }[] };
type TripAlert = { zone: LiveZone; where: "dest" | "start" | "route"; mi: number; avoided: boolean; fastestHits: boolean; saferEnters: boolean; fastestEnters: boolean };
type Result = { safer: Scored; fastest: Scored; avoided: Avoided[]; passes: Avoided[]; timeline: { offset: number; risk: number }[]; cams: Camera[]; alert?: TripAlert };
type ListId = "fav" | "want" | "saved";
type ZoneInfo = { cell8: string; place: string; calls: number; crashes: number; topType: string; peak: string; last: string; rankPct: number; level: string; bestCell: string };
type LayerState = { satellite: boolean; buildings: boolean; night: boolean; zones: boolean; traffic: boolean; skyline: boolean };

const CITY = { center: [-122.4294, 37.7649] as [number, number], bbox: [-122.75, 37.15, -121.55, 38.35], data: ["/data/sf-events.json", "/data/bay-events.json"] };
const STYLE: Record<Theme, string> = {
  light: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};
const PALETTE = {
  light: { route: "#1a73e8", casing: "#1557b0", alt: "#aecbfa", altCasing: "#7ba3e8", zoneLo: "#b9bdf7", zoneHi: "#4f46e5", strokeLo: "#6870e8", strokeHi: "#2e2bb8", hex: "#1a56db", sel: "#202124", end: "#ea4335", me: "#1a73e8", bldg: "#d9dce3", label: "#2e2bb8", halo: "#ffffff" },
  dark: { route: "#3d8bff", casing: "#0b3d91", alt: "#4d5b73", altCasing: "#2a3343", zoneLo: "#3b4aa8", zoneHi: "#7c8dff", strokeLo: "#5b6fd6", strokeHi: "#a5b4ff", hex: "#007afc", sel: "#ffffff", end: "#ff5a4e", me: "#3d8bff", bldg: "#2a2f38", label: "#ffffff", halo: "#0e1012" },
};
const SOURCES = ["hex", "zones", "places", "routeAlt", "route", "avoid", "havens", "live", "liveLines", "sel", "selLinks", "selPts", "ends", "pin", "me", "constLines", "constPts", "forecast", "anomaly", "sensors", "trafficInc", "lights", "tri", "liveArea"];
const OFFSETS = [0, 30, 60, 120, 180];
const H = ["coalesce", ["get", "render_height"], 12];
const BLDG_3D = {
  light: ["interpolate", ["linear"], H, 0, "#f1f2f5", 30, "#e9ebf0", 90, "#dfe5ee", 180, "#cfdbec"],
  dark: ["interpolate", ["linear"], H, 0, "#2b3039", 40, "#323946", 150, "#3c4a63"],
  sat: ["interpolate", ["linear"], H, 0, "#f4f1ea", 120, "#e6ebf2"],
};
const SKY = {
  light: { "sky-color": "#a9cdf2", "horizon-color": "#eaf2fb", "fog-color": "#f4f6f9", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.35, "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 12, 0] },
  dark: { "sky-color": "#0a1222", "horizon-color": "#1a2538", "fog-color": "#0e1012", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.35, "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 12, 0] },
  sat: { "sky-color": "#8fbfe9", "horizon-color": "#dbe8f4", "fog-color": "#d5dee8", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.4, "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 12, 0] },
};
const nightAt = (d: Date, sunsetIso?: string) => {
  const sunset = sunsetIso ? new Date(sunsetIso) : null;
  if (sunset && d.toDateString() === sunset.toDateString()) return d > sunset || d.getHours() < 6;
  return d.getHours() >= 19 || d.getHours() < 6;
};
const DARK_MODES: Mode[] = ["walk", "wheelchair", "bike", "scooter"];
const notable = (i: TrafficIncident) => i.kind === "accident" || i.kind === "hazard" || (i.kind === "jam" && i.magnitude >= 3) || (i.full && !!i.since && Date.now() - i.since < 2 * 3600e3);
const REPORT_CATS = ["incident", "hazard", "blocked", "ramp", "light"] as const;
const LISTS: { id: ListId; label: string; icon: typeof Heart; color: string }[] = [
  { id: "fav", label: "Favorites", icon: Heart, color: "#d93025" },
  { id: "want", label: "Want to go", icon: Flag, color: "#188038" },
  { id: "saved", label: "Saved places", icon: Bookmark, color: "#1a73e8" },
];
const MAX_EXCLUDE_M = 9000;
const M_PER_PX_Z0 = 123800;
const FONT = ["Montserrat Medium", "Open Sans Bold", "Noto Sans Regular"];

const km = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * 88, (a[1] - b[1]) * 111);
const miles = (a: [number, number], b: [number, number]) => km(a, b) * 0.621371;
const inCity = (p: [number, number] | null) => !!p && p[0] > CITY.bbox[0] && p[0] < CITY.bbox[2] && p[1] > CITY.bbox[1] && p[1] < CITY.bbox[3];
const fc = (features: unknown[]) => ({ type: "FeatureCollection", features }) as GeoJSON.FeatureCollection;
const pt = (c: [number, number], props: Record<string, unknown> = {}) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });
const line = (coords: [number, number][], props: Record<string, unknown> = {}) => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
function hexFeature(cell: string, props: Record<string, unknown> = {}) {
  const ring = cellToBoundary(cell, true);
  ring.push(ring[0]);
  return { type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } };
}
function ringPerimeterM(ring: number[][]) {
  let m = 0;
  for (let i = 1; i < ring.length; i++) m += km(ring[i - 1] as [number, number], ring[i] as [number, number]) * 1000;
  return m;
}
const metersToPx = (prop: string) => ["interpolate", ["exponential", 2], ["zoom"], 0, ["/", ["get", prop], M_PER_PX_Z0], 22, ["/", ["*", ["get", prop], 4194304], M_PER_PX_Z0]];
const load = <T,>(k: string, d: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "null") ?? d;
  } catch {
    return d;
  }
};
const store = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};
const samePlace = (a: Place, b: Place) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;

const SIM_SPEEDUP = 8;
const SPEED_MPS: Record<Mode, number> = { walk: 1.34, wheelchair: 1.0, bike: 4.4, scooter: 5, moped: 9, car: 9 };
const cumDist = (coords: [number, number][]) => {
  const c = [0];
  for (let i = 1; i < coords.length; i++) c.push(c[i - 1] + km(coords[i - 1], coords[i]) * 1000);
  return c;
};
function distToLineKm(p: [number, number], line: [number, number][]) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = [(line[i - 1][0] - p[0]) * 88, (line[i - 1][1] - p[1]) * 111];
    const [bx, by] = [(line[i][0] - p[0]) * 88, (line[i][1] - p[1]) * 111];
    const [dx, dy] = [bx - ax, by - ay];
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return line.length === 1 ? km(p, line[0]) : best;
}
const bearing = (a: [number, number], b: [number, number]) => (Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI;
function makeNav(route: Scored, sim: boolean, prev?: Nav, avoided = 0): Nav {
  return {
    route,
    idx: 0,
    pos: route.coords[0],
    cum: cumDist(route.coords),
    sim,
    started: prev?.started ?? Date.now(),
    avoided: (prev?.avoided ?? 0) + avoided,
    reroutes: (prev?.reroutes ?? 0) + (prev ? 1 : 0),
  };
}

export default function App() {
  const [theme, setTheme] = useState<Theme | null>(null);
  const [lang, setLang] = useState<Lang>("en");
  const t = useCallback((k: Key) => DICTS[lang][k], [lang]);
  const [largeText, setLargeText] = useState(false);
  const [contrast, setContrast] = useState(false);
  const [havensOn, setHavensOn] = useState(false);
  const [listenOn, setListenOn] = useState(false);
  const [layers, setLayers] = useState<LayerState>({ satellite: false, buildings: false, night: false, zones: true, traffic: false, skyline: false });
  const [layersOpen, setLayersOpen] = useState(false);

  const [view, setView] = useState<View>("nav");
  const [mode, setMode] = useState<Mode>("walk");
  const [offset, setOffset] = useState(0);
  const [fromIsMe, setFromIsMe] = useState(true);
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [dirOpen, setDirOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchFocus, setSearchFocus] = useState(false);
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [suggest, setSuggest] = useState<{ field: "search" | "from" | "to"; items: Place[] } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [pick, setPick] = useState<"safer" | "fastest">("safer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSteps, setShowSteps] = useState(false);

  const [panel, setPanel] = useState<"none" | "saved" | "recents" | "results">("none");
  const [category, setCategory] = useState<string | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [placesBusy, setPlacesBusy] = useState(false);
  const [poi, setPoi] = useState<Place | null>(null);
  const [recents, setRecents] = useState<{ p: Place; t: number }[]>([]);
  const [saved, setSaved] = useState<Record<ListId, Place[]>>({ fav: [], want: [], saved: [] });
  const [openList, setOpenList] = useState<ListId | null>(null);

  const [events, setEvents] = useState<Ev[]>([]);
  const [zones, setZones] = useState<LiveZone[]>([]);
  const [myPos, setMyPos] = useState<[number, number] | null>(null);
  const [havens, setHavens] = useState<Place[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [center, setCenter] = useState<[number, number]>(CITY.center);
  const [sensors, setSensors] = useState<{ phones: number; cells: { cell: string; n: number }[] }>({ phones: 0, cells: [] });
  const [focusConst, setFocusConst] = useState<number | null>(null);
  const [traffic, setTraffic] = useState<TrafficIncident[]>([]);
  const [replayOn, setReplayOn] = useState(false);
  const [commandOn, setCommandOn] = useState(false);

  const [drawer, setDrawer] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [joinPrompt, setJoinPrompt] = useState(false);
  const [riskAsk, setRiskAsk] = useState<"pick" | "start" | null>(null);
  const [riskOk, setRiskOk] = useState("");
  useEffect(() => {
    if (new URLSearchParams(location.search).get("listen") === "1") setJoinPrompt(true);
  }, []);
  const joinGrid = (yes: boolean) => {
    setJoinPrompt(false);
    history.replaceState(null, "", location.pathname);
    if (yes) setListenOn(true);
  };
  const [alert, setAlert] = useState<{ id: string; d: Detection } | null>(null);
  const [pin, setPin] = useState<Place | null>(null);
  const [zoneCard, setZoneCard] = useState<ZoneInfo | null>(null);
  const [reportCard, setReportCard] = useState<{ ids: string[]; category: string; count: number } | null>(null);
  const [toast, setToast] = useState("");
  const [announce, setAnnounce] = useState("");
  const [online, setOnline] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [nav, setNav] = useState<Nav | null>(null);
  const navRef = useRef<Nav | null>(null);
  const [splash, setSplash] = useState<"on" | "fading" | "off">("on");
  const bootAt = useRef(0);

  const mapRef = useRef<MLMap | null>(null);
  const mlRef = useRef<typeof import("maplibre-gl") | null>(null);
  const mapDiv = useRef<HTMLDivElement>(null);
  const dataRef = useRef<Record<string, GeoJSON.FeatureCollection>>({});
  const watcher = useRef<SoundWatcher | null>(null);
  const device = useRef("");
  const viewRef = useRef<View>("nav");
  const layersRef = useRef(layers);
  const clickRef = useRef<(e: MapMouseEvent) => void>(() => {});
  const markers = useRef<{ m: Marker; root: Root }[]>([]);

  const addLog = useCallback((text: string, kind?: LogEntry["kind"]) => setLog((l) => [{ t: Date.now(), text, kind }, ...l].slice(0, 120)), []);
  const placesLoad = useRef<() => void>(() => {});
  const placeClick = useRef<(p: Place) => void>(() => {});
  const placesCache = useRef(new Map<string, GeoJSON.Feature>());

  useEffect(() => {
    device.current = load("ns-device", "") || Math.random().toString(36).slice(2, 10);
    store("ns-device", device.current);
    setRecents(load("ns-recents", []));
    setSaved(load("ns-saved", { fav: [], want: [], saved: [] }));
    let savedTheme: Theme | null = null;
    try {
      const raw = (localStorage.getItem("ns-theme") ?? "").replace(/[^a-z]/g, "");
      savedTheme = raw === "light" || raw === "dark" ? raw : null;
    } catch {}
    setTheme(savedTheme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    const t0 = performance.now();
    Promise.allSettled(CITY.data.map((u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(r.status))))).then((res) => {
      const all: Ev[] = [];
      for (const r of res) if (r.status === "fulfilled") all.push(...r.value.events);
      setEvents(all);
      const crashes = all.filter((e) => e.t.startsWith("crash")).length;
      addLog(`Loaded ${all.length.toLocaleString()} events from ${res.filter((r) => r.status === "fulfilled").length} data files (${(all.length - crashes).toLocaleString()} violent incidents, ${crashes.toLocaleString()} injury crashes) in ${Math.round(performance.now() - t0)} ms`, "data");
    });
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") navigator.serviceWorker.register("/sw.js").catch(() => {});
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [addLog]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const j = await fetch("/api/sources").then((r) => r.json());
        if (!stop) setSources(j);
      } catch {}
      if (!stop) setTimeout(tick, 60_000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const j = await fetch("/api/traffic").then((r) => r.json());
        if (!stop && j.ok) setTraffic(j.incidents);
      } catch {}
      if (!stop) setTimeout(tick, 180_000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("ns-theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  const setData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    dataRef.current[id] = data;
    (mapRef.current?.getSource(id) as GeoJSONSource | undefined)?.setData(data);
  }, []);

  const applyVisibility = useCallback((map: MLMap, v: View, L: LayerState) => {
    const set = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    set("hex", v === "engine" && !L.skyline);
    set("hex-line", v === "engine" && !L.skyline);
    set("hex-3d", v === "engine" && L.skyline);
    set("avoid", v === "engine");
    for (const id of ["zones-halo", "zones", "zones-count"]) set(id, v === "nav" && L.zones);
    set("places", v === "nav");
    for (const id of ["forecast", "forecast-line", "sensors", "sensors-fill", "anomaly", "const-glow", "const-lines", "const-pts"]) set(id, v === "engine");
    set("sat", L.satellite);
    set("night", L.night);
    set("bldg-3d", L.buildings);
    set("hillshade", L.buildings);
    set("traffic", L.traffic);
    set("traffic-inc", L.traffic);
    set("tri-ring", v === "nav" || v === "engine");
    const th: Theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    try {
      map.setTerrain(L.buildings && map.getSource("dem") ? { source: "dem", exaggeration: 1.35 } : null);
      if (L.buildings) map.setSky((L.satellite ? SKY.sat : SKY[th]) as never);
      map.setLight({ anchor: "viewport", position: [1.25, 200, 32], color: "#ffffff", intensity: L.buildings ? 0.38 : 0.25 });
      if (map.getLayer("bldg-3d")) {
        map.setPaintProperty("bldg-3d", "fill-extrusion-color", (L.satellite ? BLDG_3D.sat : BLDG_3D[th]) as never);
        map.setPaintProperty("bldg-3d", "fill-extrusion-opacity", L.satellite ? 0.72 : 0.94);
      }
    } catch {}
  }, []);

  const installLayers = useCallback(
    (map: MLMap, th: Theme) => {
      const P = PALETTE[th];
      const baseLayers = map.getStyle().layers;
      const lastShape = baseLayers.reduce((i, l, k) => (["fill", "line", "fill-extrusion", "background"].includes(l.type) && !SOURCES.includes(l.id) ? k : i), 0);
      const firstSymbol = baseLayers.slice(lastShape + 1).find((l) => l.type === "symbol")?.id;
      if (!map.getSource("sat"))
        map.addSource("sat", { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" });
      if (!map.getSource("night"))
        map.addSource("night", { type: "raster", tiles: ["https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png"], tileSize: 256, maxzoom: 8, attribution: "Night lights: NASA Black Marble" });
      if (!map.getLayer("sat")) map.addLayer({ id: "sat", type: "raster", source: "sat", layout: { visibility: "none" } }, firstSymbol);
      if (!map.getLayer("night")) map.addLayer({ id: "night", type: "raster", source: "night", layout: { visibility: "none" }, paint: { "raster-opacity": 0.75 } }, firstSymbol);
      const dem = { type: "raster-dem" as const, tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium" as const, tileSize: 256, maxzoom: 14, attribution: "Elevation: Mapzen / AWS Terrain Tiles" };
      if (!map.getSource("dem")) map.addSource("dem", dem);
      if (!map.getSource("dem-hs")) map.addSource("dem-hs", dem);
      if (!map.getLayer("hillshade"))
        map.addLayer(
          {
            id: "hillshade",
            type: "hillshade",
            source: "dem-hs",
            layout: { visibility: "none" },
            paint: { "hillshade-exaggeration": th === "dark" ? 0.45 : 0.3, "hillshade-shadow-color": th === "dark" ? "#000000" : "#5b6b80", "hillshade-highlight-color": th === "dark" ? "#2a3446" : "#ffffff", "hillshade-accent-color": th === "dark" ? "#0b0d10" : "#7d8ba0" },
          },
          firstSymbol,
        );
      if (!map.getSource("traffic"))
        map.addSource("traffic", { type: "raster", tiles: [`${location.origin}/api/traffic/tile?z={z}&x={x}&y={y}&style=${th === "dark" ? "relative0-dark" : "relative0"}`], tileSize: 256, minzoom: 6, maxzoom: 18, attribution: "Traffic © TomTom" });
      if (!map.getLayer("traffic")) map.addLayer({ id: "traffic", type: "raster", source: "traffic", minzoom: 6, layout: { visibility: "none" }, paint: { "raster-opacity": 0.95 } }, firstSymbol);
      if (!map.getLayer("bldg-3d") && map.getSource("carto"))
        map.addLayer(
          {
            id: "bldg-3d",
            type: "fill-extrusion",
            source: "carto",
            "source-layer": "building",
            minzoom: 13,
            layout: { visibility: "none" },
            paint: {
              "fill-extrusion-color": BLDG_3D[th] as never,
              "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.2, ["coalesce", ["get", "render_height"], 12]],
              "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
              "fill-extrusion-opacity": 0.94,
              "fill-extrusion-vertical-gradient": true,
            },
          },
          firstSymbol,
        );

      for (const id of SOURCES) if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: dataRef.current[id] ?? fc([]), generateId: id === "zones" });
      const add = (layer: Parameters<MLMap["addLayer"]>[0]) => !map.getLayer(layer.id) && map.addLayer(layer);
      add({ id: "hex", type: "fill", source: "hex", paint: { "fill-color": P.hex, "fill-opacity": ["*", 0.6, ["get", "s"]] } });
      add({ id: "hex-line", type: "line", source: "hex", paint: { "line-color": P.hex, "line-width": 0.5, "line-opacity": ["*", 0.8, ["get", "s"]] } });
      add({
        id: "hex-3d",
        type: "fill-extrusion",
        source: "hex",
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": ["interpolate", ["linear"], ["get", "s"], 0, "#2fa84f", 0.4, "#9ccc3a", 0.6, "#f2c230", 0.78, "#f08a24", 0.92, "#e5484d", 1, "#c81e1e"],
          "fill-extrusion-height": ["*", ["^", ["get", "s"], 2.2], 1500],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.9,
          "fill-extrusion-vertical-gradient": true,
        },
      });
      const hover = ["boolean", ["feature-state", "hover"], false];
      add({ id: "zones-halo", type: "circle", source: "zones", paint: { "circle-radius": metersToPx("mh") as never, "circle-color": ["interpolate", ["linear"], ["get", "s"], 0, P.zoneLo, 1, P.zoneHi], "circle-opacity": ["case", hover as never, 0.22, 0.1], "circle-blur": 0.6, "circle-pitch-alignment": "map" } });
      add({
        id: "zones",
        type: "circle",
        source: "zones",
        paint: {
          "circle-radius": metersToPx("m") as never,
          "circle-color": ["interpolate", ["linear"], ["get", "s"], 0, P.zoneLo, 1, P.zoneHi],
          "circle-opacity": ["case", hover as never, 0.55, ["interpolate", ["linear"], ["get", "s"], 0, 0.22, 1, 0.42]] as never,
          "circle-stroke-color": ["interpolate", ["linear"], ["get", "s"], 0, P.strokeLo, 1, P.strokeHi],
          "circle-stroke-width": ["case", hover as never, 3.5, ["interpolate", ["linear"], ["get", "s"], 0, 1.2, 1, 2.6]] as never,
          "circle-pitch-alignment": "map",
        },
      });
      add({
        id: "zones-count",
        type: "symbol",
        source: "zones",
        minzoom: 13.2,
        layout: { "text-field": ["to-string", ["get", "n"]], "text-font": FONT, "text-size": 12, "text-allow-overlap": false },
        paint: { "text-color": P.label, "text-halo-color": P.halo, "text-halo-width": 1.5 },
      });
      addPoiIcons(map);
      add({
        id: "places",
        type: "symbol",
        source: "places",
        minzoom: 14.5,
        layout: {
          "icon-image": ["concat", "poi-", ["get", "cat"]],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 14.5, 0.62, 17, 0.8],
          "icon-allow-overlap": false,
          "text-field": ["step", ["zoom"], "", 15.2, ["get", "name"]],
          "text-font": FONT,
          "text-size": 11.5,
          "text-anchor": "left",
          "text-offset": [1.05, 0],
          "text-max-width": 9,
          "text-optional": true,
          "symbol-sort-key": ["get", "rank"],
        },
        paint: { "text-color": ["get", "color"], "text-halo-color": P.halo, "text-halo-width": 1.6 },
      });
      add({ id: "forecast", type: "fill", source: "forecast", paint: { "fill-color": "#f29900", "fill-opacity": ["*", 0.55, ["get", "s"]] } });
      add({ id: "forecast-line", type: "line", source: "forecast", paint: { "line-color": "#f29900", "line-width": 1.2, "line-opacity": 0.8 } });
      add({ id: "sensors", type: "line", source: "sensors", paint: { "line-color": "#2fbf71", "line-width": 2, "line-dasharray": [1, 1] } });
      add({ id: "sensors-fill", type: "fill", source: "sensors", paint: { "fill-color": "#2fbf71", "fill-opacity": 0.12 } });
      add({ id: "anomaly", type: "circle", source: "anomaly", paint: { "circle-radius": 26, "circle-color": "#d93025", "circle-opacity": 0.15, "circle-stroke-color": "#d93025", "circle-stroke-width": 2.5 } });
      add({ id: "const-glow", type: "line", source: "constLines", layout: { "line-cap": "round" }, paint: { "line-color": "#ffd27a", "line-width": 7, "line-blur": 5, "line-opacity": ["case", ["get", "on"], 0.7, 0.25] } });
      add({ id: "const-lines", type: "line", source: "constLines", layout: { "line-cap": "round" }, paint: { "line-color": th === "light" ? "#b06d00" : "#ffd27a", "line-width": ["case", ["get", "on"], 2.4, 1.2], "line-opacity": ["case", ["get", "on"], 1, 0.6] } });
      add({ id: "const-pts", type: "circle", source: "constPts", paint: { "circle-radius": ["case", ["get", "on"], 5.5, 3.5], "circle-color": th === "light" ? "#b06d00" : "#fff6dc", "circle-stroke-color": th === "light" ? "#fff" : "#ffd27a", "circle-stroke-width": 1.5, "circle-blur": th === "light" ? 0 : 0.15 } });
      add({ id: "avoid", type: "line", source: "avoid", paint: { "line-color": P.sel, "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.8 } });
      add({ id: "live-area", type: "fill", source: "liveArea", paint: { "fill-color": "#d93025", "fill-opacity": 0.1 } });
      add({ id: "live-area-line", type: "line", source: "liveArea", paint: { "line-color": "#d93025", "line-width": 1.5, "line-opacity": 0.7, "line-dasharray": [3, 2] } });
      add({ id: "route-alt-casing", type: "line", source: "routeAlt", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": P.altCasing, "line-width": 9 } });
      add({ id: "route-alt", type: "line", source: "routeAlt", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": P.alt, "line-width": 6 } });
      add({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": P.casing, "line-width": 10 } });
      add({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": P.route, "line-width": 7 } });
      add({ id: "havens", type: "circle", source: "havens", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 5], "circle-color": "#188038", "circle-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.35, 15, 0.9], "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
      add({ id: "live-lines", type: "line", source: "liveLines", paint: { "line-color": "#d93025", "line-width": 2, "line-opacity": 0.75, "line-dasharray": [2, 1.5] } });
      add({
        id: "live",
        type: "circle",
        source: "live",
        paint: {
          "circle-radius": ["match", ["get", "level"], "confirmed", 18, 12],
          "circle-color": ["match", ["get", "kind"], "sound", ["match", ["get", "level"], "confirmed", "#d93025", "#f29900"], "#5f6368"],
          "circle-opacity": 0.35,
          "circle-stroke-color": ["match", ["get", "kind"], "sound", ["match", ["get", "level"], "confirmed", "#d93025", "#f29900"], "#5f6368"],
          "circle-stroke-width": 2,
        },
      });
      add({ id: "sel-fill", type: "fill", source: "sel", paint: { "fill-color": P.sel, "fill-opacity": 0.12 } });
      add({ id: "sel-line", type: "line", source: "sel", paint: { "line-color": P.sel, "line-width": 2.5 } });
      add({ id: "sel-links", type: "line", source: "selLinks", paint: { "line-color": P.sel, "line-width": 1, "line-opacity": 0.6, "line-dasharray": [1, 1.5] } });
      add({ id: "sel-pts", type: "circle", source: "selPts", paint: { "circle-radius": 4.5, "circle-color": ["match", ["get", "k"], "crash", "#f29900", "#d93025"], "circle-stroke-color": th === "light" ? "#fff" : "#0e1012", "circle-stroke-width": 1.5 } });
      add({ id: "lights", type: "symbol", source: "lights", minzoom: 13.5, layout: { "icon-image": "alert-light", "icon-size": ["interpolate", ["linear"], ["zoom"], 13.5, 0.42, 17, 0.6], "icon-allow-overlap": true } });
      add({ id: "traffic-inc", type: "symbol", source: "trafficInc", minzoom: 9, layout: { visibility: "none", "icon-image": ["concat", "ti-", ["get", "kind"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.38, 13, 0.52, 16, 0.62], "icon-allow-overlap": false, "symbol-sort-key": ["-", 0, ["get", "rank"]] } });
      add({ id: "tri-ring", type: "circle", source: "tri", paint: { "circle-radius": metersToPx("r") as never, "circle-color": "#d93025", "circle-opacity": 0.14, "circle-stroke-color": "#d93025", "circle-stroke-width": 2, "circle-pitch-alignment": "map" } });
      add({ id: "tri-pt", type: "circle", source: "tri", paint: { "circle-radius": 5, "circle-color": "#d93025", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
      add({ id: "me-halo", type: "circle", source: "me", paint: { "circle-radius": 18, "circle-color": P.me, "circle-opacity": 0.16 } });
      add({ id: "me", type: "circle", source: "me", paint: { "circle-radius": 7, "circle-color": P.me, "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
      add({
        id: "ends",
        type: "circle",
        source: "ends",
        paint: {
          "circle-radius": ["match", ["get", "k"], "to", 8, 6],
          "circle-color": ["match", ["get", "k"], "to", P.end, th === "light" ? "#fff" : "#0e1012"],
          "circle-stroke-color": ["match", ["get", "k"], "to", "#fff", th === "light" ? "#202124" : "#fff"],
          "circle-stroke-width": 2.5,
        },
      });
      add({ id: "pin", type: "circle", source: "pin", paint: { "circle-radius": 8, "circle-color": P.end, "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
      applyVisibility(map, viewRef.current, layersRef.current);
    },
    [applyVisibility],
  );

  useEffect(() => {
    if (!theme || mapRef.current) return;
    let cancelled = false;
    (async () => {
      const maplibre = await import("maplibre-gl");
      maplibre.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
      mlRef.current = maplibre;
      if (cancelled || !mapDiv.current) return;
      const map = new maplibre.Map({ container: mapDiv.current, style: STYLE[theme], center: CITY.center as LngLatLike, zoom: 12.4, attributionControl: { compact: true }, maxPitch: 70 });
      map.addControl(new maplibre.NavigationControl({ showCompass: true, visualizePitch: true }), "bottom-right");
      mapRef.current = map;
      if (process.env.NODE_ENV !== "production") (window as unknown as { __map?: MLMap }).__map = map;
      map.on("style.load", () => {
        installLayers(map, (document.documentElement.dataset.theme as Theme) ?? "light");
        setMapReady(true);
      });
      map.on("click", (e) => clickRef.current(e));
      map.on("moveend", () => {
        const c = map.getCenter();
        setCenter([c.lng, c.lat]);
        placesLoad.current();
      });
      map.on("click", "places", (e) => {
        const f = e.features?.[0];
        if (!f || viewRef.current !== "nav") return;
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
        placeClick.current({ label: String(f.properties.name), lng, lat, cat: String(f.properties.cat), addr: String(f.properties.addr ?? "") });
      });
      map.on("click", "traffic-inc", (e) => {
        const f = e.features?.[0];
        if (f) setToast(`${f.properties.title}${f.properties.detail ? ` · ${f.properties.detail}` : ""}`);
      });
      map.on("click", "lights", (e) => {
        const f = e.features?.[0];
        if (f) setToast(`Streetlight ${String(f.properties.kind).toLowerCase()} · ${f.properties.addr} · reported ${fmtAgo(Number(f.properties.since))} (SF 311)`);
      });
      for (const id of ["route-alt", "live", "zones", "places", "traffic-inc", "lights"]) {
        map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
      }
      let hovered: number | string | undefined;
      map.on("mousemove", "zones", (e) => {
        const f = e.features?.[0];
        if (f?.id === undefined || f.id === hovered) return;
        if (hovered !== undefined) map.setFeatureState({ source: "zones", id: hovered }, { hover: false });
        hovered = f.id;
        map.setFeatureState({ source: "zones", id: hovered }, { hover: true });
      });
      map.on("mouseleave", "zones", () => {
        if (hovered !== undefined) map.setFeatureState({ source: "zones", id: hovered }, { hover: false });
        hovered = undefined;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [theme, installLayers]);

  const styleTheme = useRef<Theme | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !theme || !mapReady) return;
    if (styleTheme.current === null) {
      styleTheme.current = theme;
      return;
    }
    if (styleTheme.current === theme) return;
    styleTheme.current = theme;
    map.setStyle(STYLE[theme], { diff: false });
  }, [theme, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    applyVisibility(map, view, layers);
    if (view === "nav") {
      setSelectedCell(null);
      for (const id of ["sel", "selLinks", "selPts"]) setData(id, fc([]));
    }
  }, [view, layers, mapReady, applyVisibility, setData]);

  const was3d = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || was3d.current === layers.buildings) return;
    was3d.current = layers.buildings;
    map.easeTo(layers.buildings ? { pitch: 63, bearing: -24, zoom: Math.max(map.getZoom(), 15.4), duration: 1400 } : { pitch: 0, bearing: 0, duration: 800 });
    if (layers.buildings && !navRef.current)
      map.once("moveend", () => {
        if (layersRef.current.buildings && !navRef.current) map.rotateTo(map.getBearing() + 40, { duration: 14000, easing: (x) => x });
      });
  }, [layers.buildings, mapReady]);

  const wasSky = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    const on = layers.skyline && view === "engine";
    if (!map || !mapReady || wasSky.current === on) return;
    wasSky.current = on;
    const offset: [number, number] = window.innerWidth > 760 ? [-Math.min(500, window.innerWidth * 0.44) / 2, 0] : [0, -window.innerHeight * 0.26];
    if (on) map.easeTo({ center: [-122.418, 37.768], offset, pitch: 58, bearing: -24, zoom: 12.1, duration: 1600 });
    else if (!layers.buildings) map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
  }, [layers.skyline, layers.buildings, view, mapReady]);

  useEffect(() => {
    if (mode === "car" || mode === "moped") setLayers((l) => (l.traffic ? l : { ...l, traffic: true }));
  }, [mode]);

  useEffect(() => {
    if (!mapReady) return;
    const rank = { closure: 5, accident: 4, hazard: 3, roadworks: 2, jam: 1, other: 0 };
    const shown = traffic.filter((i) => (commandOn ? notable(i) : i.kind !== "jam" || i.magnitude >= 3));
    setData("trafficInc", fc(shown.map((i) => pt([i.lng, i.lat], { kind: i.kind === "closure" && !i.full ? "roadworks" : i.kind, title: i.title, detail: i.detail, rank: rank[i.kind] }))));
  }, [traffic, commandOn, mapReady, setData]);
  useEffect(() => {
    if (!mapReady) return;
    setData("lights", fc((sources?.lights ?? []).map((l) => pt([l.lng, l.lat], { addr: l.addr, kind: l.kind, since: l.since }))));
  }, [sources, mapReady, setData]);

  const when = useMemo(() => new Date(Date.now() + offset * 60_000), [offset]);
  const darkEvents = useMemo<Ev[]>(() => {
    if (!DARK_MODES.includes(mode) || !nightAt(when, sources?.weather?.sunset)) return [];
    const d = new Date().toISOString().slice(0, 10);
    return (sources?.lights ?? []).map((l) => ({ c: latLngToCell(l.lat, l.lng, 9), t: "dark", d, h: when.getHours(), x: `Streetlight ${l.kind.toLowerCase()}, ${l.addr}`, lat: l.lat, lng: l.lng }));
  }, [sources, mode, when]);
  const scoringEvents = useMemo(() => (darkEvents.length ? [...events, ...darkEvents] : events), [events, darkEvents]);
  const cells = useMemo(() => scoreCells(scoringEvents, mode, when), [scoringEvents, mode, when]);
  const live = useMemo(() => liveCells(zones), [zones]);
  const threshold = useMemo(() => percentile([...cells.values()].map((c) => c.score), 0.9), [cells]);
  const parentScores = useMemo(() => {
    const parents = new Map<string, number>();
    for (const [c, v] of cells) {
      const p = cellToParent(c, 8);
      parents.set(p, (parents.get(p) ?? 0) + v.score);
    }
    return parents;
  }, [cells]);

  useEffect(() => {
    if (!mapReady) return;
    const cut = percentile([...parentScores.values()], 0.72);
    const max = Math.max(1, ...parentScores.values());
    const zonesFc: unknown[] = [];
    for (const [p, s] of parentScores) {
      if (s < cut) continue;
      const [lat, lng] = cellToLatLng(p);
      let n = 0;
      for (const c of cellToChildren(p, 9)) n += cells.get(c)?.events.length ?? 0;
      const m = 70 + 330 * Math.sqrt(s / max);
      zonesFc.push(pt([lng, lat], { m, mh: m * 1.22, s: Math.sqrt(s / max), n, cell8: p }));
    }
    setData("zones", fc(zonesFc));
    const hex: unknown[] = [];
    const hmax = Math.max(1, ...[...cells.values()].map((c) => c.score));
    for (const [c, v] of cells) hex.push(hexFeature(c, { s: Math.max(0.06, Math.min(1, Math.log1p(v.score) / Math.log1p(hmax))) }));
    setData("hex", fc(hex));
  }, [cells, parentScores, mapReady, setData]);

  const zoneInfo = useCallback(
    (cell8: string): ZoneInfo => {
      const evs: Ev[] = [];
      let bestCell = "", best = -1;
      for (const c of cellToChildren(cell8, 9)) {
        const v = cells.get(c);
        if (!v) continue;
        evs.push(...v.events);
        if (v.score > best) [best, bestCell] = [v.score, c];
      }
      const where = new Map<string, number>();
      const types = new Map<string, number>();
      for (const e of evs) {
        const p = placeOf(e.x);
        where.set(p, (where.get(p) ?? 0) + 1);
        types.set(e.t, (types.get(e.t) ?? 0) + 1);
      }
      const all = [...parentScores.values()].sort((a, b) => a - b);
      const s = parentScores.get(cell8) ?? 0;
      const rankPct = Math.max(1, Math.round(100 - (all.filter((x) => x <= s).length / all.length) * 100));
      return {
        cell8,
        place: [...where].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
        calls: evs.filter((e) => !e.t.startsWith("crash")).length,
        crashes: evs.filter((e) => e.t.startsWith("crash")).length,
        topType: [...types].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
        peak: peakWindow(evs.map((e) => e.h)),
        last: evs.length ? fmtDate(evs.map((e) => e.d).sort().at(-1)!) : "",
        rankPct,
        level: rankPct <= 5 ? "High" : rankPct <= 15 ? "Elevated" : "Moderate",
        bestCell,
      };
    },
    [cells, parentScores],
  );

  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setMyPos([p.coords.longitude, p.coords.latitude]),
      () => setMyPos(null),
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  const meInCity = inCity(myPos);
  useEffect(() => {
    if (mapReady) setData("me", fc(meInCity ? [pt(myPos!)] : []));
  }, [myPos, meInCity, mapReady, setData]);

  const start: Place | null = fromIsMe ? (meInCity ? { label: t("yourLocation"), lng: myPos![0], lat: myPos![1] } : null) : from;
  const startKey = start ? `${start.lng.toFixed(4)},${start.lat.toFixed(4)}` : "";

  useEffect(() => {
    if (!mapReady) return;
    const f: unknown[] = [];
    if (start && !fromIsMe) f.push(pt([start.lng, start.lat], { k: "from" }));
    if (to) f.push(pt([to.lng, to.lat], { k: "to" }));
    setData("ends", fc(f));
  }, [startKey, fromIsMe, to, mapReady, setData]);

  useEffect(() => {
    if (mapReady) setData("pin", fc(pin ? [pt([pin.lng, pin.lat])] : []));
  }, [pin, mapReady, setData]);

  const seen = useRef(new Set<string>());
  const clock = useRef<{ offset: number; rtt: number; samples: { offset: number; rtt: number }[] }>({ offset: 0, rtt: Infinity, samples: [] });
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const t0 = Date.now();
        const j = await fetch("/api/live").then((r) => r.json());
        const t1 = Date.now();
        const c = clock.current;
        c.samples = [...c.samples, { offset: j.now - (t0 + t1) / 2, rtt: t1 - t0 }].slice(-30);
        const bestSample = c.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        c.offset = bestSample.offset;
        c.rtt = bestSample.rtt;
        if (!stop) {
          setZones(j.zones);
          if (j.sensors) setSensors(j.sensors);
        }
      } catch {}
      if (!stop) setTimeout(tick, 1500);
    };
    tick();
    return () => {
      stop = true;
    };
  }, []);
  useEffect(() => {
    for (const z of zones) {
      const key = `${z.id}:${z.level}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      addLog(
        z.kind === "sound"
          ? `Live alert · ${z.level === "confirmed" ? "CONFIRMED gunshot" : "possible gunshot"} at ${z.lat.toFixed(4)}, ${z.lng.toFixed(4)} (${z.count} ${z.count === 1 ? "phone" : "phones"})${z.origin ? ` · triangulated from arrival times ${z.spreadMs} ms apart, ±${Math.round((z.radiusM ?? 0) * 3.28)} ft${z.demo ? " (demo)" : ""}` : ""}`
          : `Community report · ${z.category} · ${z.count}/3 people${z.level === "confirmed" ? " → counted" : ""}`,
        "live",
      );
    }
    if (!mapReady) return;
    setData("live", fc(zones.map((z) => pt([z.lng, z.lat], { kind: z.kind, level: z.level, id: z.id, category: z.category ?? "", count: z.count, ids: ((z as { reportIds?: string[] }).reportIds ?? []).join(",") }))));
    setData(
      "liveLines",
      fc(zones.filter((z) => (z.points?.length ?? 0) > 1).flatMap((z) => (z.origin ? z.points!.map((p) => line([p, z.origin!])) : [line(z.points!)]))),
    );
    setData("tri", fc(zones.filter((z) => z.origin).map((z) => pt(z.origin!, { r: z.radiusM ?? 30 }))));
    const soundCells = [...liveCells(zones)].filter(([, z]) => z.kind === "sound").map(([c]) => c);
    setData("liveArea", fc(soundCells.length ? cellsToMultiPolygon(soundCells, true).map((poly) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: poly } })) : []));
  }, [zones, mapReady, setData, addLog]);

  useEffect(() => {
    if (mapReady) setData("havens", fc(havensOn ? havens.map((h) => pt([h.lng, h.lat], { name: h.label })) : []));
  }, [havens, havensOn, mapReady, setData]);

  const remember = useCallback((p: Place) => {
    setRecents((r) => {
      const next = [{ p, t: Date.now() }, ...r.filter((x) => !samePlace(x.p, p))].slice(0, 20);
      store("ns-recents", next);
      return next;
    });
  }, []);
  const toggleSave = (list: ListId, p: Place) =>
    setSaved((s) => {
      const has = s[list].some((x) => samePlace(x, p));
      const next = { ...s, [list]: has ? s[list].filter((x) => !samePlace(x, p)) : [p, ...s[list]] };
      store("ns-saved", next);
      setToast(has ? `Removed from ${LISTS.find((l) => l.id === list)!.label}` : `Saved to ${LISTS.find((l) => l.id === list)!.label}`);
      return next;
    });
  const isSaved = (list: ListId, p: Place) => saved[list].some((x) => samePlace(x, p));

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = (field: "search" | "from" | "to", q: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (q.trim().length < 2) return setSuggest(null);
    searchTimer.current = setTimeout(async () => {
      const [w, s, e, n] = CITY.bbox;
      const bias = meInCity ? `&lat=${myPos![1]}&lon=${myPos![0]}` : `&lat=${center[1]}&lon=${center[0]}`;
      try {
        const j = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&bbox=${w},${s},${e},${n}&limit=6&lang=en${bias}`).then((r) => r.json());
        const items: Place[] = j.features.map((f: { properties: Record<string, string>; geometry: { coordinates: [number, number] } }) => {
          const pr = f.properties;
          const street = pr.street ? `${pr.housenumber ?? ""} ${pr.street}`.trim() : "";
          return {
            label: pr.name ?? street,
            addr: [pr.name ? street : "", pr.district ?? pr.locality ?? ""].filter(Boolean).join(", "),
            lng: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
          };
        });
        setSuggest({ field, items });
      } catch {}
    }, 250);
  };

  const fit = useCallback((coords: [number, number][], maxZoom = 17) => {
    const map = mapRef.current;
    if (!map || !coords.length) return;
    const xs = coords.map((c) => c[0]), ys = coords.map((c) => c[1]);
    const wide = window.innerWidth > 760;
    const leftPanel = viewRef.current === "nav" ? (document.querySelector(".dir, .side") ? 72 + 408 : 72) : 0;
    map.fitBounds(
      [
        [Math.min(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.max(...ys)],
      ],
      {
        padding: wide ? { top: 90, bottom: 60, left: (leftPanel || 60) + 30, right: viewRef.current === "engine" ? 530 : 80 } : { top: 140, bottom: window.innerHeight * 0.5 + 20, left: 30, right: 30 },
        duration: 700,
        maxZoom,
      },
    );
  }, []);

  const openCategory = useCallback(
    async (cat: string) => {
      setPanel("results");
      setDirOpen(false);
      setCategory(cat);
      setPlaces([]);
      setPlacesBusy(true);
      setSuggest(null);
      setSearchFocus(false);
      setQuery(CAT[cat]?.label ?? cat);
      setPoi(null);
      setZoneCard(null);
      const [lng, lat] = meInCity ? myPos! : center;
      try {
        const found = await searchCategory(cat, lat, lng);
        const items: Place[] = found.map((p) => ({ label: p.name, lat: p.lat, lng: p.lng, addr: p.addr, dist: p.dist, cat }));
        setPlaces(items);
        addLog(`Place search · ${CAT[cat]?.label} · ${items.length} results from OpenStreetMap`, "data");
        if (items.length) setTimeout(() => fit(items.map((p) => [p.lng, p.lat]), 16), 50);
      } catch {
        setToast("Couldn't load places right now.");
      } finally {
        setPlacesBusy(false);
      }
    },
    [meInCity, myPos, center, fit, addLog],
  );

  useEffect(() => {
    const map = mapRef.current, ml = mlRef.current;
    for (const { m, root } of markers.current) {
      m.remove();
      setTimeout(() => root.unmount());
    }
    markers.current = [];
    if (!map || !ml || view !== "nav") return;
    for (const p of places) {
      const c = CAT[p.cat ?? ""];
      const el = document.createElement("button");
      el.className = `poi-marker ${poi && samePlace(poi, p) ? "on" : ""}`;
      el.style.setProperty("--c", c?.color ?? "#1a73e8");
      el.setAttribute("aria-label", p.label);
      const root = createRoot(el);
      const Icon = c?.icon ?? MapPin;
      root.render(
        <>
          <span className="pm-dot">
            <Icon size={14} strokeWidth={2.4} />
          </span>
          <span className="pm-label">{p.label}</span>
        </>,
      );
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setPoi(p);
        setPin(null);
        setZoneCard(null);
      });
      markers.current.push({ m: new ml.Marker({ element: el, anchor: "left", offset: [-13, 0] }).setLngLat([p.lng, p.lat]).addTo(map), root });
    }
  }, [places, poi, view, mapReady]);

  const focusCell = (cell: string) => {
    setData("sel", fc([hexFeature(cell)]));
    mapRef.current?.flyTo({ center: cellCenter(cell), zoom: 16, padding: window.innerWidth > 760 ? { left: 480, right: 0, top: 0, bottom: 0 } : { bottom: window.innerHeight * 0.5, top: 0, left: 0, right: 0 } });
  };
  const [navWhy, setNavWhy] = useState(false);

  const placesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placesKey = useRef("");
  placesLoad.current = () => {
    const map = mapRef.current;
    if (!map || viewRef.current !== "nav" || map.getZoom() < 14.5) return;
    if (placesTimer.current) clearTimeout(placesTimer.current);
    placesTimer.current = setTimeout(async () => {
      const c = map.getCenter();
      const key = `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
      if (key === placesKey.current) return;
      placesKey.current = key;
      try {
        const found = await nearbyByTags(Object.values(MAP_POI).flatMap((v) => v.tags), c.lat, c.lng, 50, map.getZoom() >= 16 ? 0.7 : 1.2);
        for (const p of found) {
          const cat = POI_OF_TAG[p.tag];
          if (!cat) continue;
          placesCache.current.set(`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`, {
            type: "Feature",
            properties: { name: p.name, cat, color: MAP_POI[cat].color, addr: p.addr, rank: Math.round(p.dist * 100) },
            geometry: { type: "Point", coordinates: [p.lng, p.lat] },
          });
        }
        const keys = [...placesCache.current.keys()];
        for (const k of keys.slice(0, Math.max(0, keys.length - 600))) placesCache.current.delete(k);
        setData("places", fc([...placesCache.current.values()]));
      } catch {}
    }, 350);
  };
  placeClick.current = (p: Place) => {
    setPoi({ ...p, cat: p.cat === "attraction" ? "todo" : p.cat });
    setPin(null);
    setZoneCard(null);
    setReportCard(null);
  };

  const goTo = (p: Place) => {
    setTo(p);
    setToText(p.label);
    setQuery(p.label);
    setDirOpen(true);
    setSuggest(null);
    setSearchFocus(false);
    setPin(null);
    setPoi(null);
    setZoneCard(null);
    remember(p);
  };
  const showPlace = (p: Place) => {
    setPoi(p);
    setPin(null);
    setZoneCard(null);
    setSuggest(null);
    setSearchFocus(false);
    setQuery(p.label);
    remember(p);
    mapRef.current?.flyTo({ center: [p.lng, p.lat], zoom: Math.max(mapRef.current.getZoom(), 15.5) });
  };
  const setStart = (p: Place) => {
    setFromIsMe(false);
    setFrom(p);
    setFromText(p.label);
    setSuggest(null);
    setPin(null);
    setPoi(null);
  };
  const closeDirections = () => {
    setDirOpen(false);
    setTo(null);
    setToText("");
    setQuery("");
    setResult(null);
    setError("");
    for (const id of ["route", "routeAlt", "avoid", "ends", "sel"]) setData(id, fc([]));
  };
  const swap = () => {
    if (!to) return;
    const oldStart = start;
    setStart(to);
    if (oldStart) {
      setTo(oldStart);
      setToText(oldStart.label);
    }
  };
  const submitSearch = () => {
    const cat = categoryFor(query);
    if (cat) return openCategory(cat);
    if (suggest?.items[0]) showPlace(suggest.items[0]);
  };

  const voice = () => {
    type SR = { lang: string; start: () => void; onresult: (e: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => void };
    const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return setToast("Voice search isn't supported in this browser.");
    const r = new Ctor();
    r.lang = { en: "en-US", es: "es-ES", pt: "pt-BR", zh: "zh-CN" }[lang];
    r.onresult = (e) => {
      const text = e.results[0][0].transcript;
      setQuery(text);
      const cat = categoryFor(text);
      if (cat) openCategory(cat);
      else search("search", text);
    };
    r.start();
  };

  const isNight = useCallback(
    (d: Date) => nightAt(d, sources?.weather?.sunset),
    [sources],
  );

  const fetchRoutes = async (m: Mode, a: Place, b: Place, night: boolean, exclude?: [number, number][][], alternates = 2) => {
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: m, from: [a.lng, a.lat], to: [b.lng, b.lat], exclude, night, alternates, depart: when.toISOString() }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    return j.routes as Route[];
  };

  const computeId = useRef(0);
  const compute = useCallback(
    async (opts?: { quiet?: boolean; reason?: string; from?: Place }) => {
      const a = opts?.from ?? start, b = to;
      if (!a || !b || !events.length) return;
      const id = ++computeId.current;
      setBusy(true);
      setError("");
      const T0 = performance.now();
      try {
        const night = isNight(when);
        addLog(`${opts?.reason ?? "Route request"} · ${mode} · ${a.label} → ${b.label}${night ? " · after sunset: prefer lit streets" : ""}`, "route");
        let fastRoutes = await fetchRoutes(mode, a, b, night);
        addLog(`Router returned ${fastRoutes.length} candidate${fastRoutes.length > 1 ? "s" : ""} in ${Math.round(performance.now() - T0)} ms`, "route");

        const closureBoxes: [number, number][][] = [];
        let roads: Roads | null = null;
        if (mode === "car" || mode === "moped") {
          const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
          const touches = (r: Route, i: TrafficIncident) => i.line.some((p) => distToLineKm(p, r.coords) < 0.025);
          const closed = traffic.filter((i) => i.full);
          const hits = closed.filter((i) => fastRoutes.some((r) => touches(r, i))).slice(0, 8);
          for (const i of hits) {
            const [x, y] = i.line[Math.floor(i.line.length / 2)];
            closureBoxes.push(box(x - 0.00028, y - 0.00028, x + 0.00028, y + 0.00028));
          }
          roads = await fetch("/api/roads").then((r) => r.json()).catch(() => null);
          const full = roads?.closures.filter((c) => c.type === "Full") ?? [];
          for (const c of full) {
            const d = 0.0006;
            closureBoxes.push(box(Math.min(c.lng, c.lng2) - d, Math.min(c.lat, c.lat2) - d, Math.max(c.lng, c.lng2) + d, Math.max(c.lat, c.lat2) + d));
          }
          addLog(`Live traffic: ${closed.length} road closures in the Bay Area, ${hits.length} on this trip's candidate routes avoided · Caltrans: ${roads?.cameras.length ?? 0} cameras, ${full.length} full closures`, "data");
          if (hits.length) {
            const legal = fastRoutes.filter((r) => !hits.some((i) => touches(r, i)));
            const detour = legal.length ? [] : await fetchRoutes(mode, a, b, night, closureBoxes, 1).catch(() => []);
            if (legal.length || detour.length) fastRoutes = [...legal, ...detour];
          }
        }
        const closurePerim = closureBoxes.reduce((sum, r) => sum + ringPerimeterM(r), 0);
        const fastest = fastRoutes[0];

        const pad = 0.012;
        const [minX, maxX] = [Math.min(a.lng, b.lng) - pad, Math.max(a.lng, b.lng) + pad];
        const [minY, maxY] = [Math.min(a.lat, b.lat) - pad, Math.max(a.lat, b.lat) + pad];
        const protect = new Set([...gridDisk(latLngToCell(a.lat, a.lng, 9), 1), ...gridDisk(latLngToCell(b.lat, b.lng, 9), 1)]);
        const onFast = routeRisk(fastest.coords, fastest.minutes, cells, live).cellsOnRoute;
        const candidates = new Map<string, number>();
        for (const [c, v] of cells) {
          if (v.score < threshold || protect.has(c)) continue;
          const [x, y] = cellCenter(c);
          if (x < minX || x > maxX || y < minY || y > maxY) continue;
          candidates.set(c, v.score * (onFast.has(c) ? 3 : 1));
        }
        for (const [c, z] of live) if (!protect.has(c) && LIVE_SCORE[z.kind][z.level] > 0) candidates.set(c, 1e6);
        const chosen: string[] = [];
        let polys: number[][][][] = [];
        let perimeter = 0;
        for (const [c] of [...candidates].sort((p, q) => q[1] - p[1]).slice(0, 80)) {
          const next = cellsToMultiPolygon([...chosen, c], true);
          const perim = next.reduce((s, poly) => s + ringPerimeterM(poly[0]), 0);
          if (perim > MAX_EXCLUDE_M - closurePerim) continue;
          chosen.push(c);
          polys = next;
          perimeter = perim;
        }
        const exclude = [...polys.map((p) => p[0] as [number, number][]), ...closureBoxes];
        addLog(`${candidates.size} high-risk cells near the trip → ${chosen.length} avoided as ${exclude.length} polygon${exclude.length === 1 ? "" : "s"} (${((perimeter / 1000) * 0.621371).toFixed(1)} mi perimeter)`, "route");

        const safeRoutes = exclude.length ? await fetchRoutes(mode, a, b, night, exclude, 1).catch(() => []) : [];
        if (id !== computeId.current) return;

        const scored: Scored[] = [...fastRoutes, ...safeRoutes].map((r) => ({ ...r, risk: routeRisk(r.coords, r.minutes, cells, live).risk }));
        const fastScored = scored[0];
        const limit = fastScored.minutes * 1.4 + 3;
        const soundCells = new Set([...live].filter(([, z]) => z.kind === "sound").map(([c]) => c));
        const liveOn = (r: Route) => [...routeRisk(r.coords, r.minutes, new Map(), new Map()).cellsOnRoute.keys()].filter((c) => soundCells.has(c) && !protect.has(c)).length;
        const fastestHits = soundCells.size > 0 && liveOn(fastScored) > 0;
        const clean = fastestHits ? scored.filter((r) => liveOn(r) === 0) : [];
        const pool = clean.length ? clean : scored.filter((r) => r.minutes <= limit);
        const safer = pool.reduce((best, r) => (r.risk + 4 * r.minutes < best.risk + 4 * best.minutes ? r : best), pool[0] ?? fastScored);
        addLog(`Scored ${scored.length} routes (minutes / risk): ${scored.map((r) => `${Math.round(r.minutes)}/${Math.round(r.risk)}`).join(", ")}`, "route");
        if (fastestHits) addLog(clean.length ? `Live gunshot area on the fastest way · routed around it (+${Math.max(0, Math.round(safer.minutes - fastScored.minutes))} min)` : "Live gunshot area on every candidate route · no way around found", "live");
        const miTo = (z: LiveZone, p: Place) => miles([z.lng, z.lat], [p.lng, p.lat]);
        const sounds = zones.filter((z) => z.kind === "sound");
        const nearDest = sounds.filter((z) => miTo(z, b) < 0.3).sort((x, y) => miTo(x, b) - miTo(y, b))[0];
        const nearStart = sounds.filter((z) => miTo(z, a) < 0.3).sort((x, y) => miTo(x, a) - miTo(y, a))[0];
        const onWay = fastestHits ? sounds.find((z) => [...live].some(([c, lz]) => lz.id === z.id && routeRisk(fastScored.coords, 1, new Map(), new Map()).cellsOnRoute.has(c))) : undefined;
        const enters = (r: Route) => [...routeRisk(r.coords, r.minutes, new Map(), new Map()).cellsOnRoute.keys()].some((c) => soundCells.has(c));
        const base = { avoided: liveOn(safer) === 0, fastestHits, saferEnters: enters(safer), fastestEnters: enters(fastScored) };
        const alert: TripAlert | undefined = nearDest
          ? { zone: nearDest, where: "dest", mi: miTo(nearDest, b), ...base }
          : nearStart
            ? { zone: nearStart, where: "start", mi: miTo(nearStart, a), ...base }
            : onWay
              ? { zone: onWay, where: "route", mi: 0, ...base }
              : undefined;

        const onSafe = routeRisk(safer.coords, safer.minutes, cells, live).cellsOnRoute;
        const avoided: Avoided[] = [...onFast.keys()]
          .filter((c) => !onSafe.has(c) && ((cells.get(c)?.score ?? 0) >= threshold * 0.6 || live.has(c)))
          .map((c) => ({ cell: c, score: (cells.get(c)?.score ?? 0) + (live.has(c) ? 999 : 0), events: cells.get(c)?.events ?? [], live: live.get(c) }))
          .sort((p, q) => q.score - p.score)
          .filter((x, i, all) => !x.live || all.findIndex((y) => y.live?.id === x.live!.id) === i)
          .slice(0, 5);
        const timeline = OFFSETS.map((o) => {
          const tc = scoreCells(events, mode, new Date(Date.now() + o * 60_000));
          return { offset: o, risk: routeRisk(safer.coords, safer.minutes, tc, live).risk };
        });
        const sample = safer.coords.filter((_, i) => i % 4 === 0);
        const cams = (roads?.cameras ?? [])
          .map((c) => ({ ...c, dist: Math.min(...sample.map((p) => km(p, [c.lng, c.lat]))) }))
          .filter((c) => c.dist < 0.5)
          .sort((p, q) => p.dist - q.dist)
          .slice(0, 4);

        const passes: Avoided[] = [...onSafe.keys()]
          .filter((c) => (cells.get(c)?.score ?? 0) > 0)
          .map((c) => ({ cell: c, score: cells.get(c)!.score, events: cells.get(c)!.events, live: live.get(c) }))
          .sort((p, q) => q.score - p.score)
          .slice(0, 3);
        setResult({ safer, fastest: fastScored, avoided, passes, timeline, cams, alert });
        setPick("safer");
        if (navRef.current && !navRef.current.arrived) {
          const prev = navRef.current;
          setNav(makeNav(safer, prev.sim, prev, avoided.length));
          addLog(`Navigation updated live · new route ${Math.round(safer.minutes)} min from current position`, "route");
        }
        setData("avoid", fc(polys.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: p[0] } }))));
        const same = safer === fastScored;
        const pct = fastScored.risk > 0 ? Math.round((1 - safer.risk / fastScored.risk) * 100) : 0;
        addLog(
          same ? `Fastest route is already lowest-risk · ${Math.round(safer.minutes)} min` : `Chose safer route: ${pct}% less risk for +${Math.max(0, Math.round(safer.minutes - fastScored.minutes))} min · total ${Math.round(performance.now() - T0)} ms`,
          "route",
        );
        setAnnounce(`${t("saferRoute")}: ${Math.round(safer.minutes)} ${t("min")}, ${pct}% ${t("lessRisk")}.`);
        if (!opts?.quiet) fit([...fastScored.coords, ...safer.coords]);
      } catch (e) {
        if (id === computeId.current) setError(t("noRoute"));
        addLog(`Routing failed: ${String(e).slice(0, 80)}`, "route");
      } finally {
        if (id === computeId.current) setBusy(false);
      }
    },
    [startKey, to, events, mode, when, cells, live, zones, threshold, t, setData, addLog, fit, fromIsMe, isNight, traffic],
  );

  const lastQuiet = useRef(false);
  useEffect(() => {
    if (!start || !to || !events.length) return;
    const quiet = lastQuiet.current;
    lastQuiet.current = true;
    const id = setTimeout(() => compute({ quiet }), 120);
    return () => clearTimeout(id);
  }, [startKey, to, mode, offset, events.length]);
  useEffect(() => {
    lastQuiet.current = false;
  }, [to, startKey]);

  useEffect(() => {
    navRef.current = nav;
  }, [nav]);

  useEffect(() => {
    if (!mapReady) return;
    if (nav) {
      setData("route", fc([line(nav.route.coords.slice(Math.max(0, nav.idx - 1)))]));
      setData("routeAlt", fc([]));
      return;
    }
    if (!result) {
      setData("route", fc([]));
      setData("routeAlt", fc([]));
      return;
    }
    const same = result.safer === result.fastest;
    const main = pick === "safer" || same ? result.safer : result.fastest;
    const alt = same ? null : pick === "safer" ? result.fastest : result.safer;
    setData("route", fc([line(main.coords)]));
    setData("routeAlt", fc(alt ? [line(alt.coords, { alt: pick === "safer" ? "fastest" : "safer" })] : []));
  }, [result, pick, nav, mapReady, setData]);

  const startNav = () => {
    if (!result) return;
    const same = result.safer === result.fastest;
    const route = pick === "fastest" && !same ? result.fastest : result.safer;
    const n = makeNav(route, !meInCity, undefined, pick === "fastest" ? 0 : result.avoided.length);
    setNav(n);
    setPin(null);
    setPoi(null);
    setZoneCard(null);
    addLog(`Navigation started · ${mode} · ${Math.round(route.minutes)} min${n.sim ? " · simulated trip (no GPS)" : " · following GPS"}`, "route");
  };
  const routeKey = (r: Route) => `${r.coords.length}:${r.minutes.toFixed(2)}`;
  const enters = (which: "safer" | "fastest") => !!result?.alert && (which === "fastest" ? result.alert.fastestEnters : result.alert.saferEnters);
  const choose = (which: "safer" | "fastest") => {
    if (which === "fastest" && result && enters("fastest") && !enters("safer") && riskOk !== routeKey(result.fastest)) return setRiskAsk("pick");
    setPick(which);
  };
  const tryStart = () => {
    if (!result) return;
    const which = pick === "fastest" && result.safer !== result.fastest ? "fastest" : "safer";
    if (enters(which) && riskOk !== routeKey(result[which])) return setRiskAsk("start");
    startNav();
  };
  const acceptRisk = () => {
    if (!result) return;
    const action = riskAsk;
    setRiskAsk(null);
    if (action === "pick") {
      setRiskOk(routeKey(result.fastest));
      setPick("fastest");
    } else {
      const which = pick === "fastest" && result.safer !== result.fastest ? "fastest" : "safer";
      setRiskOk(routeKey(result[which]));
      startNav();
    }
  };
  const clearAlerts = async () => {
    const j = await fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset" }) }).then((r) => r.json()).catch(() => null);
    if (!j) return setToast("Couldn't clear alerts. Check your connection.");
    setZones([]);
    setAlert(null);
    setRiskOk("");
    addLog("Live alerts cleared (demo reset)", "live");
    setToast("Gunshot simulations cleared");
    if (start && to) compute({ quiet: true, reason: "Alerts cleared" });
  };
  const exitNav = () => {
    setNav(null);
    mapRef.current?.easeTo({ pitch: layers.buildings ? 58 : 0, bearing: 0, duration: 700 });
    if (result) fit(result.safer.coords);
  };
  const reroutingAt = useRef(0);
  const rerouteFrom = useCallback(
    (pos: [number, number], reason: string) => {
      if (Date.now() - reroutingAt.current < 8000) return;
      reroutingAt.current = Date.now();
      setNav((n) => (n ? { ...n, rerouting: true } : n));
      compute({ quiet: true, reason, from: { label: "Current position", lng: pos[0], lat: pos[1] } });
    },
    [compute],
  );

  useEffect(() => {
    if (!nav?.sim || nav.arrived) return;
    const id = setInterval(() => {
      setNav((n) => {
        if (!n || n.arrived) return n;
        const target = n.cum[n.idx] + SPEED_MPS[mode] * SIM_SPEEDUP;
        let i = n.idx;
        while (i < n.cum.length - 1 && n.cum[i] < target) i++;
        const arrived = i >= n.cum.length - 1;
        return { ...n, idx: i, pos: n.route.coords[i], arrived, rerouting: false };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [nav?.sim, nav?.arrived, nav?.route, mode]);

  useEffect(() => {
    const n = navRef.current;
    if (!n || n.sim || n.arrived || !myPos) return;
    let best = n.idx, bestD = Infinity;
    for (let i = Math.max(0, n.idx - 5); i < Math.min(n.route.coords.length, n.idx + 120); i++) {
      const d = km(myPos, n.route.coords[i]) * 1000;
      if (d < bestD) [best, bestD] = [i, d];
    }
    if (bestD > 60) {
      rerouteFrom(myPos, `OFF ROUTE: ${Math.round(bestD * 3.28)} ft from the route, rerouting`);
      return;
    }
    const arrived = n.cum[n.cum.length - 1] - n.cum[best] < 25;
    setNav({ ...n, idx: best, pos: myPos, arrived, rerouting: false });
  }, [myPos, rerouteFrom]);

  useEffect(() => {
    if (!nav || nav.arrived) return;
    const ahead = nav.route.coords[Math.min(nav.idx + 4, nav.route.coords.length - 1)];
    mapRef.current?.easeTo({
      center: nav.pos,
      zoom: 16.6,
      pitch: 52,
      bearing: bearing(nav.pos, ahead),
      duration: 950,
      padding: window.innerWidth > 760 ? { top: 140, bottom: 140, left: 0, right: 0 } : { top: 150, bottom: 170, left: 0, right: 0 },
    });
    if (mapReady) setData("me", fc([pt(nav.pos)]));
  }, [nav?.pos, nav?.arrived]);
  useEffect(() => {
    if (nav?.arrived) addLog(`Arrived · ${nav.reroutes} live reroute${nav.reroutes === 1 ? "" : "s"} · ${nav.avoided} higher-risk spots avoided`, "route");
  }, [nav?.arrived]);

  const zoneSig = zones.filter((z) => LIVE_SCORE[z.kind][z.level] > 0).map((z) => `${z.id}:${z.level}`).join("|");
  const lastSig = useRef("");
  useEffect(() => {
    if (zoneSig === lastSig.current) return;
    const prev = lastSig.current;
    lastSig.current = zoneSig;
    if (!zoneSig || zoneSig.length < prev.length) return;
    const n = navRef.current;
    const coords = n && !n.arrived ? n.route.coords.slice(n.idx) : result?.safer.coords;
    if (!coords?.length) return;
    const onRoute = routeRisk(coords, 10, new Map(), new Map()).cellsOnRoute;
    const near = [...live.keys()].some((c) => gridDisk(c, 2).some((x) => onRoute.has(x)));
    if (!near) return;
    setToast(t("rerouted"));
    if (n && !n.arrived) rerouteFrom(n.pos, "REROUTE: live alert ahead on the route");
    else compute({ quiet: true, reason: "REROUTE: live alert within 2 cells of the route" });
  }, [zoneSig]);

  const selectCell = useCallback(
    (c: string | null, fly = false) => {
      setSelectedCell(c);
      if (!c) {
        for (const id of ["sel", "selLinks", "selPts"]) setData(id, fc([]));
        return;
      }
      const ctr = cellCenter(c);
      const contributing = (cells.get(c)?.events ?? []).filter((e) => contribution(e, mode, when).value > 0);
      setData("sel", fc([hexFeature(c)]));
      setData("selLinks", fc(contributing.map((e) => line([ctr, [e.lng, e.lat]]))));
      setData("selPts", fc(contributing.map((e) => pt([e.lng, e.lat], { k: e.t.startsWith("crash") ? "crash" : "crime" }))));
      addLog(`Inspect cell ${c} · ${contributing.length} contributing signals · score ${(cells.get(c)?.score ?? 0).toFixed(1)}`, "pick");
      if (fly) mapRef.current?.flyTo({ center: ctr, zoom: 16, duration: 900, padding: window.innerWidth > 760 ? { right: 520, left: 0, top: 0, bottom: 0 } : { bottom: window.innerHeight * 0.5, top: 0, left: 0, right: 0 } });
      const map = mapRef.current;
      const t0 = performance.now();
      const pulse = (now: number) => {
        const p = Math.min(1, (now - t0) / 900);
        map?.getLayer("sel-line") && map.setPaintProperty("sel-line", "line-width", 10 - 7.5 * p);
        if (p < 1) requestAnimationFrame(pulse);
      };
      requestAnimationFrame(pulse);
    },
    [cells, mode, when, setData, addLog],
  );
  useEffect(() => {
    if (selectedCell) selectCell(selectedCell);
  }, [mode, offset]);

  clickRef.current = (e: MapMouseEvent) => {
    const map = mapRef.current;
    if (!map) return;
    setLayersOpen(false);
    if (viewRef.current === "engine") {
      selectCell(latLngToCell(e.lngLat.lat, e.lngLat.lng, 9), map.getZoom() < 14.5);
      return;
    }
    const hits = map.queryRenderedFeatures(e.point, { layers: ["places", "live", "route-alt", "zones"].filter((l) => map.getLayer(l)) });
    const hit = hits.find((h) => h.layer.id !== "zones") ?? hits[0];
    if (hit?.layer.id === "places") return;
    if (hit?.layer.id === "route-alt") return choose(hit.properties.alt);
    if (hit?.layer.id === "live" && hit.properties.kind === "report") return setReportCard({ ids: String(hit.properties.ids).split(","), category: hit.properties.category, count: hit.properties.count });
    setReportCard(null);
    setPoi(null);
    if (hit?.layer.id === "zones") {
      setPin(null);
      return setZoneCard(zoneInfo(hit.properties.cell8));
    }
    setZoneCard(null);
    setPin({ label: t("droppedPin"), lng: e.lngLat.lng, lat: e.lngLat.lat });
  };

  const explainZone = (z: ZoneInfo) => {
    setZoneCard(null);
    setView("engine");
    setTimeout(() => selectCell(z.bestCell, true), 60);
  };

  const here = useCallback((): [number, number] => {
    if (meInCity) return myPos!;
    if (start) return [start.lng, start.lat];
    const c = mapRef.current?.getCenter();
    return c ? [c.lng, c.lat] : CITY.center;
  }, [meInCity, myPos, start]);

  const onDetect = useCallback(
    async (d: Detection, at?: [number, number], demo = false) => {
      const [lng, lat] = at ?? here();
      navigator.vibrate?.([300, 100, 300]);
      addLog(`Microphone: ${d.label} detected on this phone (confidence ${(d.confidence * 100).toFixed(0)}%) · audio stays on device`, "live");
      const onset = d.onset !== undefined ? d.onset + clock.current.offset : undefined;
      if (onset !== undefined) addLog(`Sound onset timed to the millisecond · clock synced to server (round trip ${Math.round(clock.current.rtt)} ms)`, "live");
      const j = await fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sound", lat, lng, device: device.current, confidence: d.confidence, at: onset, demoOrigin: demo ? [lng, lat] : undefined }) }).then((r) => r.json());
      setZones(j.zones);
      setAlert({ id: j.id, d });
    },
    [here, addLog],
  );

  useEffect(() => {
    if (!listenOn) {
      watcher.current?.stop();
      watcher.current = null;
      return;
    }
    const w = new SoundWatcher();
    watcher.current = w;
    w.start(onDetect).catch(() => {
      setToast("Microphone unavailable. It needs HTTPS and permission.");
      setListenOn(false);
    });
    let lock: { release: () => void } | null = null;
    (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => void }> } }).wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    const beat = (off = false) => {
      const [lng, lat] = here();
      fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "listen", lat, lng, device: device.current, off }) }).catch(() => {});
    };
    beat();
    const iv = setInterval(beat, 20_000);
    return () => {
      w.stop();
      lock?.release();
      clearInterval(iv);
      beat(true);
    };
  }, [listenOn, onDetect, here]);

  const calls24: Call[] = useMemo(() => sources?.calls24 ?? [], [sources]);
  const constellations = useMemo(() => findConstellations(events), [events]);
  const forecast = useMemo(() => forecastNextHour(events, mode), [events, mode]);
  const anomalies = useMemo(() => detectAnomalies(calls24, events), [calls24, events]);
  const corroborated = useMemo(() => corroborate(zones, calls24), [zones, calls24]);
  const intelSeen = useRef(new Set<string>());
  useEffect(() => {
    for (const a of anomalies) {
      const k = `a:${a.cell}:${a.n}`;
      if (intelSeen.current.has(k)) continue;
      intelSeen.current.add(k);
      addLog(`ANOMALY · ${a.n} violent calls in 3 h near ${a.calls[0].where.toLowerCase()} (normal ≈ ${a.expected.toFixed(1)})`, "live");
    }
    for (const [id, c] of corroborated) {
      const k = `c:${id}`;
      if (intelSeen.current.has(k)) continue;
      intelSeen.current.add(k);
      addLog(`CORROBORATED · phone alert matches SFPD "${c.type.toLowerCase()}" call at ${c.where.toLowerCase()}`, "live");
    }
  }, [anomalies, corroborated, addLog]);

  useEffect(() => {
    if (!mapReady) return;
    const lines: unknown[] = [];
    const pts: unknown[] = [];
    for (const c of constellations) {
      const on = c.id === focusConst;
      for (const [a, b] of c.links) lines.push(line([[a.lng, a.lat], [b.lng, b.lat]], { on, id: c.id }));
      for (const e of c.events) pts.push(pt([e.lng, e.lat], { on, id: c.id }));
    }
    setData("constLines", fc(lines));
    setData("constPts", fc(pts));
    const maxRise = Math.max(1, ...forecast.rising.map((x) => x.next - x.now));
    setData("forecast", fc(forecast.rising.slice(0, 25).map((x) => hexFeature(x.cell, { s: Math.max(0.2, (x.next - x.now) / maxRise) }))));
    setData("anomaly", fc(anomalies.map((a) => pt([a.lng, a.lat], { n: a.n }))));
    setData("sensors", fc(sensors.cells.map((s) => hexFeature(s.cell, { n: s.n }))));
  }, [constellations, focusConst, forecast, anomalies, sensors, mapReady, setData]);

  const focusConstellation = (id: number | null) => {
    setFocusConst(id);
    const c = constellations.find((x) => x.id === id);
    if (c) fit(c.events.map((e) => [e.lng, e.lat] as [number, number]), 16.5);
  };

  const answer = async (ans: "safe" | "danger") => {
    if (!alert) return;
    const j = await fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "answer", id: alert.id, answer: ans }) }).then((r) => r.json());
    setZones(j.zones);
    setAlert(null);
    addLog(`User answered "${ans}"${ans === "danger" ? " → alert confirmed" : ""}`, "live");
    if (ans === "danger" && havensOn && havens.length) {
      const [x, y] = here();
      const nearest = havens.reduce((b, h) => (km([h.lng, h.lat], [x, y]) < km([b.lng, b.lat], [x, y]) ? h : b));
      setToast(`${t("nearestHaven")}: ${nearest.label}`);
    }
  };

  const simulate = () => {
    setDrawer(false);
    const n = navRef.current;
    if (n && !n.arrived) {
      const c = n.route.coords;
      return onDetect({ confidence: 0.9, label: "gunshot", at: Date.now() }, c[Math.min(c.length - 1, n.idx + Math.max(8, Math.floor((c.length - n.idx) * 0.35)))], true);
    }
    const c = result ? (pick === "fastest" ? result.fastest : result.safer).coords : null;
    onDetect({ confidence: 0.9, label: "gunshot", at: Date.now() }, c ? c[Math.floor(c.length * 0.55)] : undefined, true);
  };

  const beforeCommand = useRef<{ theme: Theme; traffic: boolean; skyline: boolean } | null>(null);
  const notableTraffic = useMemo(() => traffic.filter(notable), [traffic]);
  const commandPadding = () =>
    window.innerWidth >= 1100 ? { top: 150, bottom: 140, left: 350, right: 370 } : { top: 70, bottom: Math.round(window.innerHeight * 0.55), left: 0, right: 0 };
  const openCommand = () => {
    beforeCommand.current = { theme: theme ?? "light", traffic: layers.traffic, skyline: layers.skyline };
    setReplayOn(false);
    setCommandOn(true);
    setView("engine");
    setLayers((l) => ({ ...l, traffic: true, skyline: false }));
    if (theme !== "dark") setTheme("dark");
    setTimeout(() => mapRef.current?.flyTo({ center: [-122.432, 37.765], zoom: 12.3, pitch: 0, bearing: 0, padding: commandPadding(), duration: 1200 }), 80);
    addLog("Command center opened · live feeds, cameras, sensors and anomalies in one view", "data");
  };
  const exitCommand = () => {
    setCommandOn(false);
    mapRef.current?.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
    const b = beforeCommand.current;
    if (b) {
      setLayers((l) => ({ ...l, traffic: b.traffic, skyline: b.skyline }));
      if (b.theme !== "dark") setTheme(b.theme);
    }
  };

  useEffect(() => {
    if (!bootAt.current) bootAt.current = performance.now();
    if (!events.length || !mapReady) return;
    const wait = Math.max(0, 1400 - (performance.now() - bootAt.current));
    const a = setTimeout(() => setSplash((s) => (s === "on" ? "fading" : s)), wait);
    const b = setTimeout(() => setSplash("off"), wait + 600);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [events.length, mapReady]);

  const sendReport = async (cat: string) => {
    const [lng, lat] = here();
    const j = await fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "report", category: cat, lat, lng, device: device.current }) }).then((r) => r.json());
    setZones(j.zones);
    setReportOpen(false);
    setToast(t("reported"));
  };
  const vote = async (v: "confirm" | "gone") => {
    if (!reportCard) return;
    const j = await fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "vote", ids: reportCard.ids, device: device.current, vote: v }) }).then((r) => r.json());
    setZones(j.zones);
    setReportCard(null);
  };

  useEffect(() => {
    if (!havensOn || havens.length) return;
    nearbyByTags(["amenity:hospital", "amenity:police", "amenity:fire_station", "amenity:pharmacy"], CITY.center[1], CITY.center[0], 50, 9)
      .then((items) => setHavens(items.map((p) => ({ label: p.name, lat: p.lat, lng: p.lng }))))
      .catch(() => setToast("Couldn't load safe places right now."));
  }, [havensOn, havens.length]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const requestPosition = (then: (pos: [number, number]) => void) => {
    if (!navigator.geolocation) return setToast("Location isn't available on this device.");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const pos: [number, number] = [p.coords.longitude, p.coords.latitude];
        setMyPos(pos);
        if (!inCity(pos)) return setToast("You're outside the Bay Area, so NorthStar can't route from there yet.");
        then(pos);
      },
      () => setToast("Allow location access to use where you are."),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 10_000 },
    );
  };
  const startFromMe = () => {
    setSuggest(null);
    requestPosition(() => {
      setFromIsMe(true);
      setFrom(null);
      setFromText("");
    });
  };
  const locate = () => {
    if (meInCity) mapRef.current?.flyTo({ center: myPos!, zoom: 15.5 });
    else requestPosition((pos) => mapRef.current?.flyTo({ center: pos, zoom: 15.5 }));
  };

  const r = result;
  const same = !!r && r.safer === r.fastest;
  const pctLess = r && r.fastest.risk > 0 ? Math.max(0, Math.round((1 - r.safer.risk / r.fastest.risk) * 100)) : 0;
  const chosen = r ? (pick === "fastest" && !same ? r.fastest : r.safer) : null;
  const tlMax = r ? Math.max(...r.timeline.map((x) => x.risk)) : 1;
  const tlMin = r ? Math.min(...r.timeline.map((x) => x.risk)) : 0;
  const tlFlat = tlMax - tlMin < Math.max(1, tlMax * 0.05);
  const barHeight = (risk: number) => (tlFlat ? 50 : 18 + 82 * ((risk - tlMin) / (tlMax - tlMin)));
  const bestOffset = r ? r.timeline.reduce((b, x) => (x.risk < b.risk ? x : b)).offset : 0;
  const offsetLabel = (o: number) => (o === 0 ? t("leaveNow") : `+${o >= 60 ? `${o / 60} h` : `${o} min`}`);
  const showDir = view === "nav" && dirOpen && !nav;
  const showSide = view === "nav" && !dirOpen && panel !== "none" && !nav;
  const recQuery = query.trim().toLowerCase();
  const catHint = recQuery.length >= 2 ? CAT_UI.filter((c) => c.label.toLowerCase().startsWith(recQuery) || categoryFor(recQuery) === c.id) : [];
  const card = view === "nav" && !nav ? (poi ? "poi" : zoneCard ? "zone" : reportCard ? "report" : pin ? "pin" : null) : null;
  const navInfo = nav
    ? (() => {
        const steps = nav.route.steps;
        let k = 0;
        for (let i = 0; i < steps.length; i++) if (steps[i].at <= nav.idx) k = i;
        const next = steps[k + 1];
        const total = nav.cum[nav.cum.length - 1] || 1;
        const remain = Math.max(0, total - nav.cum[nav.idx]);
        const toNext = next ? Math.max(0, nav.cum[Math.min(next.at, nav.cum.length - 1)] - nav.cum[nav.idx]) : remain;
        const mins = nav.route.minutes * (remain / total);
        return { next: next?.text ?? `Arrive at ${to?.label ?? "your destination"}`, toNext, remainMi: remain / 1609.34, mins, eta: new Date(Date.now() + mins * 60000) };
      })()
    : null;

  return (
    <div className={`app ${largeText ? "large" : ""} ${contrast ? "contrast" : ""} view-${view} ${showDir || showSide ? "panel-open" : ""} ${nav ? "navigating" : ""} ${commandOn ? "commanding" : ""}`} lang={lang}>
      <div ref={mapDiv} className="map" role="application" aria-label={view === "engine" ? "Map. Click a spot to inspect its risk." : "Map. Click to drop a pin."} />

      {view === "nav" && (
        <nav className="rail" aria-label="Main">
          <button className="rail-btn" onClick={() => setDrawer(true)} aria-label={t("menu")}>
            <Menu size={22} />
          </button>
          <button className={`rail-btn ${showSide && panel === "saved" ? "on" : ""}`} onClick={() => { setDirOpen(false); setPanel(panel === "saved" ? "none" : "saved"); }}>
            <span className="rail-ico">
              <Bookmark size={20} />
            </span>
            <span>Saved</span>
          </button>
          <button className={`rail-btn ${showSide && panel === "recents" ? "on" : ""}`} onClick={() => { setDirOpen(false); setPanel(panel === "recents" ? "none" : "recents"); }}>
            <span className="rail-ico">
              <History size={20} />
            </span>
            <span>Recents</span>
          </button>
          <span className="rail-sep" />
          {recents.slice(0, 3).map((x) => (
            <button key={`${x.p.lat},${x.p.lng}`} className="rail-recent" onClick={() => showPlace(x.p)} title={x.p.label}>
              <span className="rail-thumb">{x.p.cat && CAT[x.p.cat] ? (() => { const I = CAT[x.p.cat!].icon; return <I size={16} />; })() : <MapPin size={16} />}</span>
              <span>{x.p.label}</span>
            </button>
          ))}
        </nav>
      )}

      <div className="topbar">
        {view === "nav" && !showDir && (
          <div className="searchwrap">
            <div className="searchbox card">
              <button className="icon-btn menu-mobile" onClick={() => setDrawer(true)} aria-label={t("menu")}>
                <Menu size={20} />
              </button>
              <input
                value={query}
                placeholder={t("search")}
                aria-label={t("search")}
                onFocus={() => setSearchFocus(true)}
                onBlur={() => setTimeout(() => setSearchFocus(false), 180)}
                onChange={(e) => {
                  setQuery(e.target.value);
                  search("search", e.target.value);
                }}
                onKeyDown={(e) => e.key === "Enter" && submitSearch()}
              />
              {query ? (
                <button className="icon-btn" onClick={() => { setQuery(""); setSuggest(null); setPanel(panel === "results" ? "none" : panel); setPlaces([]); setCategory(null); }} aria-label={t("close")}>
                  <X size={18} />
                </button>
              ) : (
                <button className="icon-btn" onClick={voice} aria-label={t("voice")}>
                  <Mic size={18} />
                </button>
              )}
              <button className="icon-btn" onClick={submitSearch} aria-label="Search">
                <Search size={18} />
              </button>
              <span className="divider" />
              <button className="icon-btn accent" onClick={() => setDirOpen(true)} aria-label={t("directions")} title={t("directions")}>
                <Navigation size={18} />
              </button>
            </div>
            {searchFocus && (
              <div className="suggest card" role="listbox">
                {!query && (
                  <>
                    <div className="sg-chips">
                      {CHIP_ORDER.slice(0, 8).map((id) => CAT[id]).filter(Boolean).map((c) => (
                        <button key={c.id} className="sg-chip" onMouseDown={() => openCategory(c.id)}>
                          <c.icon size={15} style={{ color: c.color }} /> {c.label}
                        </button>
                      ))}
                    </div>
                    {recents.length > 0 && <p className="sg-head">Recent</p>}
                    {recents.slice(0, 5).map((x) => (
                      <button key={`${x.p.lat},${x.p.lng}`} className="sg-row" role="option" aria-selected={false} onMouseDown={() => showPlace(x.p)}>
                        <span className="sg-ico">
                          <History size={16} />
                        </span>
                        <span className="sg-text">
                          <strong>{x.p.label}</strong>
                          {x.p.addr && <span>{x.p.addr}</span>}
                        </span>
                      </button>
                    ))}
                  </>
                )}
                {catHint.map((c) => (
                  <button key={c.id} className="sg-row" role="option" aria-selected={false} onMouseDown={() => openCategory(c.id)}>
                    <span className="sg-ico cat" style={{ background: c.color }}>
                      <c.icon size={15} />
                    </span>
                    <span className="sg-text">
                      <strong>{c.label} nearby</strong>
                      <span>Search by type near {meInCity ? "you" : "this area"}</span>
                    </span>
                  </button>
                ))}
                {query &&
                  suggest?.field === "search" &&
                  suggest.items.map((p, i) => (
                    <button key={i} className="sg-row" role="option" aria-selected={false} onMouseDown={() => showPlace(p)}>
                      <span className="sg-ico">
                        <MapPin size={16} />
                      </span>
                      <span className="sg-text">
                        <strong>{p.label}</strong>
                        {p.addr && <span>{p.addr}</span>}
                      </span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
        {view === "nav" && !showDir && (
          <div className="chips" role="toolbar" aria-label="Nearby">
            {CHIP_ORDER.map((id) => CAT[id]).filter(Boolean).map((c) => (
              <button key={c.id} className={`chip ${category === c.id && panel === "results" ? "on" : ""}`} onClick={() => openCategory(c.id)}>
                <c.icon size={16} style={{ color: category === c.id && panel === "results" ? undefined : c.color }} /> {c.label}
              </button>
            ))}
          </div>
        )}
        {view === "engine" && (
          <div className="engine-title card">
            <button className="icon-btn" onClick={() => setDrawer(true)} aria-label={t("menu")}>
              <Menu size={20} />
            </button>
            <span className="brand">
              <Logo size={22} /> NorthStar
            </span>
          </div>
        )}
        <div className="topright">
          <div className="viewswitch card" role="tablist" aria-label="View">
            <button role="tab" aria-selected={view === "nav"} className={view === "nav" ? "on" : ""} onClick={() => setView("nav")}>
              <Navigation size={15} /> <span>{t("navigate")}</span>
            </button>
            <button role="tab" aria-selected={view === "engine"} className={view === "engine" ? "on" : ""} onClick={() => setView("engine")}>
              <Cpu size={15} /> <span>{t("howItWorks")}</span>
            </button>
          </div>
          <button
            className={`icon-btn card round ${layers.satellite ? "pressed" : ""}`}
            onClick={() => setLayers((l) => ({ ...l, satellite: !l.satellite }))}
            aria-pressed={layers.satellite}
            aria-label="Satellite view"
            title={layers.satellite ? "Map view" : "Satellite view"}
          >
            <Satellite size={18} />
          </button>
          <button
            className={`icon-btn card round td-btn ${layers.buildings ? "pressed" : ""}`}
            onClick={() => setLayers((l) => ({ ...l, buildings: !l.buildings }))}
            aria-pressed={layers.buildings}
            aria-label="3D view"
            title={layers.buildings ? "Back to 2D" : "3D view: terrain and buildings"}
          >
            3D
          </button>
          {view === "engine" && (
            <button
              className={`icon-btn card round ${layers.skyline ? "pressed" : ""}`}
              onClick={() => setLayers((l) => ({ ...l, skyline: !l.skyline }))}
              aria-pressed={layers.skyline}
              aria-label="3D risk skyline"
              title="3D risk skyline"
            >
              <ChartColumnBig size={18} />
            </button>
          )}
          <button className="icon-btn card round" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? t("light") : t("dark")} title={theme === "dark" ? t("light") : t("dark")}>
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </div>

      {showSide && (
        <section className="side" aria-label={panel}>
          {panel === "results" && (
            <>
              <div className="side-head">
                <h2>{CAT[category ?? ""]?.label ?? "Results"}</h2>
                <p className="fine">Near {meInCity ? "you" : "the map center"} · OpenStreetMap</p>
              </div>
              {placesBusy && <div className="progress" role="progressbar" />}
              {!placesBusy && !places.length && <p className="notice">No places found here. Move the map and try again.</p>}
              <ul className="results">
                {places.map((p, i) => {
                  const c = CAT[p.cat ?? ""];
                  return (
                    <li key={i}>
                      <button className={`res ${poi && samePlace(poi, p) ? "on" : ""}`} onClick={() => showPlace(p)}>
                        <span className="res-ico" style={{ background: c?.color }}>
                          {c && <c.icon size={16} />}
                        </span>
                        <span className="res-text">
                          <strong>{p.label}</strong>
                          <span>{[p.addr, p.dist !== undefined ? fmtDist(p.dist) : ""].filter(Boolean).join(" · ")}</span>
                          {p.hours && <span className="fine">{p.hours.length > 40 ? `${p.hours.slice(0, 40)}…` : p.hours}</span>}
                        </span>
                      </button>
                      <button className="icon-btn res-go" onClick={() => goTo(p)} aria-label={`${t("directions")}: ${p.label}`}>
                        <Navigation size={17} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {panel === "recents" && (
            <>
              <div className="side-head">
                <h2>Recents</h2>
                <div className="pill-row">
                  <span className="pill-chip on">All {recents.length}</span>
                  {recents.length > 0 && (
                    <button className="pill-chip" onClick={() => { setRecents([]); store("ns-recents", []); }}>
                      <Trash2 size={14} /> Clear
                    </button>
                  )}
                </div>
              </div>
              {!recents.length && <p className="notice">Places you search for and visit will show up here.</p>}
              <ul className="results">
                {recents.map((x) => {
                  const c = CAT[x.p.cat ?? ""];
                  return (
                    <li key={`${x.p.lat},${x.p.lng}`}>
                      <button className="res" onClick={() => showPlace(x.p)}>
                        <span className="res-ico muted-ico" style={c ? { background: c.color, color: "#fff" } : undefined}>
                          {c ? <c.icon size={16} /> : <History size={16} />}
                        </span>
                        <span className="res-text">
                          <strong>{x.p.label}</strong>
                          <span>{[x.p.addr, fmtAgo(x.t)].filter(Boolean).join(" · ")}</span>
                        </span>
                      </button>
                      <button className="icon-btn res-go" onClick={() => goTo(x.p)} aria-label={`${t("directions")}: ${x.p.label}`}>
                        <Navigation size={17} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {panel === "saved" && (
            <>
              <div className="side-head">
                <h2>Saved</h2>
                <p className="fine">Lists stay on this device.</p>
              </div>
              <ul className="lists">
                {LISTS.map((l) => (
                  <li key={l.id}>
                    <button className="list-row" onClick={() => setOpenList(openList === l.id ? null : l.id)} aria-expanded={openList === l.id}>
                      <l.icon size={22} style={{ color: l.color }} />
                      <span className="res-text">
                        <strong>{l.label}</strong>
                        <span>
                          Private · {saved[l.id].length} {saved[l.id].length === 1 ? "place" : "places"}
                        </span>
                      </span>
                      <ChevronDown size={18} className={openList === l.id ? "flip" : ""} />
                    </button>
                    {openList === l.id && (
                      <ul className="results nested">
                        {!saved[l.id].length && <li className="fine pad">Tap the {l.label.toLowerCase()} button on any place to add it.</li>}
                        {saved[l.id].map((p) => (
                          <li key={`${p.lat},${p.lng}`}>
                            <button className="res" onClick={() => showPlace(p)}>
                              <span className="res-text">
                                <strong>{p.label}</strong>
                                {p.addr && <span>{p.addr}</span>}
                              </span>
                            </button>
                            <button className="icon-btn res-go" onClick={() => toggleSave(l.id, p)} aria-label={`Remove ${p.label}`}>
                              <X size={16} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {showDir && (
        <section className="dir" aria-label={t("directions")}>
          <div className="dir-top">
            <div className="dir-modes" role="radiogroup" aria-label="Travel mode">
              {MODES.map((m) => {
                const I = MODE_ICON[m];
                return (
                  <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)} title={t(m)} aria-label={t(m)}>
                    <I size={19} />
                  </button>
                );
              })}
            </div>
            <button className="icon-btn" onClick={closeDirections} aria-label={t("close")}>
              <X size={20} />
            </button>
          </div>

          <div className="dir-fields">
            <div className="dots" aria-hidden>
              <span className="dot start" />
              <span className="dotline" />
              <MapPin size={16} className="dot-end" />
            </div>
            <div className="fields">
              <div className="field">
                <input
                  aria-label={t("from")}
                  placeholder={t("chooseStart")}
                  value={fromIsMe ? (meInCity ? t("yourLocation") : "") : fromText}
                  className={fromIsMe && meInCity ? "me" : ""}
                  onFocus={(e) => {
                    if (fromIsMe) e.currentTarget.select();
                    if (!fromText) setSuggest({ field: "from", items: [] });
                  }}
                  onBlur={() => setTimeout(() => setSuggest((x) => (x?.field === "from" && !x.items.length ? null : x)), 200)}
                  onChange={(e) => {
                    setFromIsMe(false);
                    setFrom(null);
                    setFromText(e.target.value);
                    search("from", e.target.value);
                  }}
                />
                {suggest?.field === "from" && (
                  <Suggestions
                    items={suggest.items}
                    onPick={setStart}
                    extra={
                      <button role="option" aria-selected={false} className="sg-me" onMouseDown={(e) => e.preventDefault()} onClick={startFromMe}>
                        <LocateFixed size={16} /> {t("yourLocation")}
                      </button>
                    }
                  />
                )}
              </div>
              <div className="field">
                <input
                  aria-label={t("to")}
                  placeholder={t("to")}
                  value={toText}
                  onChange={(e) => {
                    setToText(e.target.value);
                    search("to", e.target.value);
                  }}
                />
                {suggest?.field === "to" && <Suggestions items={suggest.items} onPick={goTo} />}
              </div>
            </div>
            <button className="icon-btn" onClick={swap} aria-label={t("swap")} title={t("swap")}>
              <ArrowUpDown size={18} />
            </button>
          </div>

          <div className="dir-leave">
            <Clock size={16} />
            <select value={offset} onChange={(e) => setOffset(+e.target.value)} aria-label={t("leaveIn")}>
              {OFFSETS.slice(0, 4).map((o) => (
                <option key={o} value={o}>
                  {offsetLabel(o)}
                </option>
              ))}
            </select>
            {isNight(when) && (
              <span className="night-tag">
                <MoonStar size={13} /> After sunset · lit streets preferred
              </span>
            )}
          </div>
          {busy && <div className="progress" role="progressbar" aria-label={t("finding")} />}

          <div className="dir-body">
            {!start && <p className="notice">{t("locationOff")}</p>}
            {error && <p className="notice error" role="alert">{error}</p>}

            {r && (
              <>
                {r.alert && (
                  <div className={`trip-alert ${r.alert.where === "dest" || !r.alert.avoided ? "bad" : ""}`} role="alert">
                    <Siren size={16} aria-hidden />
                    <div>
                      <strong>
                        {r.alert.zone.level === "confirmed" ? "Confirmed gunshot" : "Possible gunshot"}{" "}
                        {r.alert.where === "route" ? "on the fastest way" : `${fmtDist(r.alert.mi)} from your ${r.alert.where === "dest" ? "destination" : "start"}`} · {fmtAgo(r.alert.zone.ts)}
                      </strong>
                      <span>
                        {r.alert.where === "dest"
                          ? "Your destination is inside the alert area, so no route can fully avoid it. Consider another place nearby, or wait: alerts clear after 2 hours."
                          : r.alert.where === "start"
                            ? "This route takes the quickest way out of the alert area and stays clear of it after that."
                            : r.alert.avoided
                              ? `This route goes around the alert area (+${Math.max(0, Math.round(r.safer.minutes - r.fastest.minutes))} min). The fastest way goes through it.`
                              : "No way around it was found. Take care, or wait until the alert clears."}
                      </span>
                    </div>
                  </div>
                )}
                <div className="options" role="radiogroup" aria-label="Routes">
                  <RouteOption
                    on={pick === "safer" || same}
                    onClick={() => setPick("safer")}
                    minutes={r.safer.minutes}
                    mi={r.safer.mi}
                    title={same ? `${t("saferRoute")} · ${t("fastestRoute")}` : t("saferRoute")}
                    tag={same ? undefined : `${pctLess}% ${t("lessRisk")}`}
                    sub={same ? t("sameRoute") : `${t("recommended")} · +${Math.max(0, Math.round(r.safer.minutes - r.fastest.minutes))} ${t("extraMin")}`}
                  />
                  {!same && (
                    <RouteOption
                      on={pick === "fastest"}
                      onClick={() => choose("fastest")}
                      minutes={r.fastest.minutes}
                      mi={r.fastest.mi}
                      title={t("fastestRoute")}
                      danger={r.alert?.fastestHits}
                      sub={r.alert?.fastestHits ? "Goes through a live gunshot alert" : `Passes ${r.avoided.length} higher-risk ${r.avoided.length === 1 ? "spot" : "spots"}`}
                    />
                  )}
                </div>

                <div className="start-row">
                  <button className="btn primary start" onClick={tryStart}>
                    <Navigation size={17} /> Start
                  </button>
                  <span className="fine">
                    {!meInCity ? "No GPS here, so Start runs a simulated trip for the demo." : "Follows your location and reroutes live."}
                    {chosen?.trafficSource === "live" ? " Times include live traffic." : chosen?.traffic && chosen.traffic > 1 ? ` Times include typical SF traffic for ${when.toLocaleString("en-US", { weekday: "short", hour: "numeric" })}.` : ""}
                  </span>
                </div>

                <WhySection r={r} pctLess={pctLess} lang={lang} t={t} onFocus={focusCell} />

                <section className="block">
                  <h3>{t("bestTime")}</h3>
                  {tlFlat && <p className="fine flat">About the same risk for the next 3 hours.</p>}
                  <div className="timeline">
                    {r.timeline.map((x) => (
                      <button key={x.offset} className={`bar ${x.offset === bestOffset ? "best" : ""} ${x.offset === offset ? "cur" : ""}`} onClick={() => setOffset(x.offset)} aria-label={`${offsetLabel(x.offset)}: ${t("risk")} ${Math.round(x.risk)}`}>
                        <span className="fill" style={{ height: `${barHeight(x.risk)}%` }} />
                        <span className="lbl">{x.offset === 0 ? "Now" : `+${x.offset >= 60 ? `${x.offset / 60}h` : `${x.offset}m`}`}</span>
                      </button>
                    ))}
                  </div>
                </section>

                {r.cams.length > 0 && (
                  <section className="block">
                    <h3>
                      <Camera size={15} /> {t("roadCams")}
                    </h3>
                    <div className="cams">
                      {r.cams.map((c) => (
                        <figure key={c.img}>
                          <img src={`${c.img}?t=${Math.floor(Date.now() / 60000)}`} alt={`Caltrans camera: ${c.name}`} loading="lazy" />
                          <figcaption>{c.name.replace(/^TV\d+ -- /, "")}</figcaption>
                        </figure>
                      ))}
                    </div>
                    <p className="fine">{t("camsNote")}</p>
                  </section>
                )}

                {chosen && (
                  <section className="block">
                    <button className="expander" onClick={() => setShowSteps((s) => !s)} aria-expanded={showSteps}>
                      {t("steps")} · {chosen.steps.length} <ChevronDown size={16} className={showSteps ? "flip" : ""} />
                    </button>
                    {showSteps && (
                      <ol className="steps">
                        {chosen.steps.map((s, i) => (
                          <li key={i}>
                            <span>{s.text}</span>
                            {s.mi > 0 && <span className="fine">{fmtDist(s.mi)}</span>}
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                )}
              </>
            )}
            <p className="fine data-note">{t("dataNote")}</p>
          </div>
        </section>
      )}

      {view === "engine" && (
        <Engine
          events={events}
          cells={cells}
          live={live}
          mode={mode}
          setMode={setMode}
          offset={offset}
          setOffset={setOffset}
          when={when}
          threshold={threshold}
          zones={zones}
          log={log}
          selected={selectedCell}
          onSelect={selectCell}
          sources={sources}
          center={center}
          theme={theme ?? "light"}
          constellations={constellations}
          focusConst={focusConst}
          onFocusConst={focusConstellation}
          forecast={forecast}
          anomalies={anomalies}
          sensors={sensors}
          corroborated={corroborated}
          onCommand={openCommand}
          onReplay={() => setReplayOn(true)}
          skyline={layers.skyline}
          onSkyline={() => setLayers((l) => ({ ...l, skyline: !l.skyline }))}
        />
      )}
      {replayOn && <Replay map={mapReady ? mapRef.current : null} events={events} theme={theme ?? "light"} onClose={() => setReplayOn(false)} />}
      {commandOn && (
        <Command
          theme={theme ?? "dark"}
          events={events}
          cells={cells}
          zones={zones}
          sources={sources}
          anomalies={anomalies}
          constellations={constellations}
          forecast={forecast}
          sensors={sensors}
          corroborated={corroborated}
          traffic={notableTraffic}
          log={log}
          onExit={exitCommand}
          onFocus={(lng, lat, zoom = 15) => mapRef.current?.flyTo({ center: [lng, lat], zoom, padding: commandPadding(), duration: 1400, essential: true })}
        />
      )}

      <div className="fab-col">
        {zones.some((z) => z.kind === "sound") && (
          <button className="fab card clear-sim" onClick={clearAlerts} aria-label="Clear gunshot simulations" title="Clear gunshot simulations">
            <Trash2 size={16} />
          </button>
        )}
        {view === "nav" && (
          <button className="fab card" onClick={() => setReportOpen(true)} aria-label={t("report")} title={t("report")}>
            <Flag size={18} />
          </button>
        )}
        <button className="fab card" onClick={locate} aria-label={t("yourLocation")} title={t("yourLocation")}>
          <LocateFixed size={18} />
        </button>
      </div>

      <div className="layers">
        <button className={`layers-btn card ${layers.satellite ? "sat" : ""}`} onClick={() => setLayersOpen((o) => !o)} aria-expanded={layersOpen} aria-label="Layers">
          <Layers size={18} />
          <span>Layers</span>
        </button>
        {layersOpen && (
          <div className="layers-pop card" role="dialog" aria-label="Map layers">
            <p className="eyebrow">Map type</p>
            <div className="lp-row">
              <button className={`lp-tile ${!layers.satellite ? "on" : ""}`} onClick={() => setLayers((l) => ({ ...l, satellite: false }))}>
                <span className="lp-thumb default">
                  <MapIcon size={18} />
                </span>
                Default
              </button>
              <button className={`lp-tile ${layers.satellite ? "on" : ""}`} onClick={() => setLayers((l) => ({ ...l, satellite: true }))}>
                <span className="lp-thumb satellite">
                  <Satellite size={18} />
                </span>
                Satellite
              </button>
            </div>
            <p className="eyebrow">Details</p>
            <div className="lp-row">
              <button className={`lp-tile ${layers.buildings ? "on" : ""}`} onClick={() => setLayers((l) => ({ ...l, buildings: !l.buildings }))}>
                <span className="lp-thumb">
                  <Building2 size={18} />
                </span>
                3D
              </button>
              <button className={`lp-tile ${layers.night ? "on" : ""}`} onClick={() => setLayers((l) => ({ ...l, night: !l.night }))}>
                <span className="lp-thumb">
                  <MoonStar size={18} />
                </span>
                Night lights
              </button>
              <button className={`lp-tile ${layers.zones ? "on" : ""}`} onClick={() => setLayers((l) => ({ ...l, zones: !l.zones }))}>
                <span className="lp-thumb">
                  <CircleDot size={18} />
                </span>
                Risk zones
              </button>
              <button className={`lp-tile ${layers.traffic ? "on" : ""}`} onClick={() => setLayers((l) => ({ ...l, traffic: !l.traffic }))}>
                <span className="lp-thumb">
                  <TrafficCone size={18} />
                </span>
                Traffic
              </button>
            </div>
            <p className="fine">Satellite: Esri · Night lights: NASA · Traffic: TomTom · Terrain: AWS</p>
          </div>
        )}
      </div>

      {listenOn && (
        <div className="pill listening card" role="status">
          <Ear size={14} /> {t("listening")}
        </div>
      )}
      {riskAsk && result?.alert && (
        <div className="risk-ask" role="alertdialog" aria-modal="true" aria-labelledby="risk-title" onClick={(e) => e.target === e.currentTarget && setRiskAsk(null)}>
          <div className="risk-card card">
            <h2 id="risk-title">{riskAsk === "pick" ? "This route goes through a gunshot alert" : "Your route enters a gunshot alert area"}</h2>
            <p>
              {result.alert.zone.level === "confirmed" ? "A confirmed gunshot" : "A possible gunshot"} was reported{" "}
              {result.alert.where === "route" ? "on this way" : `${fmtDist(result.alert.mi)} from your ${result.alert.where === "dest" ? "destination" : "start"}`} {fmtAgo(result.alert.zone.ts)}. NorthStar keeps you out of this area unless you choose to go.
            </p>
            <div className="risk-actions">
              {riskAsk === "pick" ? (
                <button className="btn primary" onClick={() => { setRiskAsk(null); setPick("safer"); }} autoFocus>
                  Keep the safer route
                </button>
              ) : (
                <button className="btn primary" onClick={() => setRiskAsk(null)} autoFocus>
                  Cancel
                </button>
              )}
              <button className="btn risk-go" onClick={acceptRisk}>
                {riskAsk === "pick" ? "Use this route anyway" : "Start anyway"}
              </button>
            </div>
          </div>
        </div>
      )}
      {joinPrompt && !listenOn && (
        <div className="join card" role="dialog" aria-labelledby="join-title">
          <h2 id="join-title">Join the sensor grid</h2>
          <p>This phone will listen for gunshot-like bangs and warn people nearby. Sound is analyzed on the phone and never recorded or uploaded. Keep this page open with the screen on.</p>
          <div className="join-actions">
            <button className="btn primary" onClick={() => joinGrid(true)}>
              <Ear size={16} /> Start listening
            </button>
            <button className="btn" onClick={() => joinGrid(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {!online && (
        <div className="pill offline card" role="status">
          Offline · showing saved map and routes
        </div>
      )}

      {card === "poi" && poi && (
        <div className="placecard card" role="dialog" aria-label={poi.label}>
          <div className="pc-head">
            <div className="pc-title">
              {poi.cat && CAT[poi.cat] && (
                <span className="res-ico" style={{ background: CAT[poi.cat].color }}>
                  {(() => {
                    const I = CAT[poi.cat!].icon;
                    return <I size={16} />;
                  })()}
                </span>
              )}
              <div>
                <strong>{poi.label}</strong>
                <span className="fine">{[poi.cat ? CAT[poi.cat]?.label.replace(/s$/, "") : "", poi.addr, meInCity ? fmtDist(miles(myPos!, [poi.lng, poi.lat])) : poi.dist !== undefined ? fmtDist(poi.dist) : ""].filter(Boolean).join(" · ")}</span>
                {poi.hours && <span className="fine">Hours: {poi.hours}</span>}
                {(() => {
                  const z = zones
                    .filter((x) => x.kind === "sound")
                    .map((x) => ({ x, mi: miles([x.lng, x.lat], [poi.lng, poi.lat]) }))
                    .filter((x) => x.mi < 0.3)
                    .sort((p, q) => p.mi - q.mi)[0];
                  return z ? (
                    <span className="pc-alert" role="status">
                      <Siren size={13} aria-hidden /> {z.x.level === "confirmed" ? "Confirmed gunshot" : "Possible gunshot"} {fmtDist(z.mi)} away · {fmtAgo(z.x.ts)}. Routes here avoid the area where possible.
                    </span>
                  ) : null;
                })()}
              </div>
            </div>
            <button className="icon-btn" onClick={() => setPoi(null)} aria-label={t("close")}>
              <X size={18} />
            </button>
          </div>
          <div className="pc-actions">
            <button className="btn primary" onClick={() => goTo(poi)}>
              <Navigation size={16} /> {t("directionsHere")}
            </button>
            <button className="btn" onClick={() => setStart(poi)}>
              {t("startHere")}
            </button>
            {LISTS.map((l) => (
              <button key={l.id} className={`icon-btn save-btn ${isSaved(l.id, poi) ? "on" : ""}`} onClick={() => toggleSave(l.id, poi)} aria-pressed={isSaved(l.id, poi)} aria-label={`${l.label}`} title={l.label}>
                <l.icon size={18} style={{ color: l.color }} fill={isSaved(l.id, poi) ? l.color : "none"} />
              </button>
            ))}
          </div>
        </div>
      )}

      {card === "zone" && zoneCard && (
        <div className="placecard zonecard card" role="dialog" aria-label="Risk area">
          <div className="pc-head">
            <div>
              <span className={`level ${zoneCard.level.toLowerCase()}`}>{zoneCard.level} risk · top {zoneCard.rankPct}% in SF</span>
              <strong>{zoneCard.place ? `Near ${zoneCard.place}` : "Higher-risk area"}</strong>
              <span className="fine">For {t(mode).toLowerCase()} trips{offset ? ` in ${offsetLabel(offset).replace("+", "")}` : " right now"}</span>
            </div>
            <button className="icon-btn" onClick={() => setZoneCard(null)} aria-label={t("close")}>
              <X size={18} />
            </button>
          </div>
          <div className="zone-stats">
            <div>
              <Siren size={16} />
              <strong>{zoneCard.calls}</strong>
              <span>violent calls</span>
            </div>
            <div>
              <CarFront size={16} />
              <strong>{zoneCard.crashes}</strong>
              <span>injury crashes</span>
            </div>
            <div>
              <Clock size={16} />
              <strong>{zoneCard.peak || "—"}</strong>
              <span>busiest hours</span>
            </div>
          </div>
          <p className="fine">
            Most common: {EVENT_LABEL[lang][zoneCard.topType] ?? "—"} · last report {zoneCard.last}
          </p>
          <div className="pc-actions">
            <button className="btn primary" onClick={() => explainZone(zoneCard)}>
              <Cpu size={16} /> How it&apos;s calculated
            </button>
          </div>
        </div>
      )}

      {card === "report" && reportCard && (
        <div className="placecard card" role="dialog" aria-label={t("reportPrompt")}>
          <div className="pc-head">
            <div>
              <strong>{t(`cat_${reportCard.category}` as Key)}</strong>
              <span className="fine">
                {t("reportPrompt")} · {reportCard.count}/3
              </span>
            </div>
            <button className="icon-btn" onClick={() => setReportCard(null)} aria-label={t("close")}>
              <X size={18} />
            </button>
          </div>
          <div className="pc-actions">
            <button className="btn primary" onClick={() => vote("confirm")}>
              {t("confirm")}
            </button>
            <button className="btn" onClick={() => vote("gone")}>
              {t("gone")}
            </button>
          </div>
        </div>
      )}

      {card === "pin" && pin && (
        <div className="placecard card" role="dialog" aria-label={t("droppedPin")}>
          <div className="pc-head">
            <div>
              <strong>{t("droppedPin")}</strong>
              <span className="fine">
                {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
              </span>
            </div>
            <button className="icon-btn" onClick={() => setPin(null)} aria-label={t("close")}>
              <X size={18} />
            </button>
          </div>
          <div className="pc-actions">
            <button className="btn primary" onClick={() => goTo(pin)}>
              <Navigation size={16} /> {t("directionsHere")}
            </button>
            <button className="btn" onClick={() => setStart(pin)}>
              {t("startHere")}
            </button>
            <button className={`icon-btn save-btn`} onClick={() => toggleSave("saved", pin)} aria-label="Save" title="Save">
              <Bookmark size={18} />
            </button>
          </div>
        </div>
      )}

      {drawer && (
        <div className="scrim" onClick={() => setDrawer(false)}>
          <nav className="drawer" onClick={(e) => e.stopPropagation()} aria-label={t("menu")}>
            <div className="drawer-head">
              <span className="brand">
                <Logo size={24} /> NorthStar
              </span>
              <button className="icon-btn" onClick={() => setDrawer(false)} aria-label={t("close")}>
                <X size={20} />
              </button>
            </div>
            <p className="fine">{t("tagline")}</p>

            <div className="drawer-links">
              <button onClick={() => { setDrawer(false); setDirOpen(false); setPanel("saved"); }}>
                <Bookmark size={18} /> Saved
              </button>
              <button onClick={() => { setDrawer(false); setDirOpen(false); setPanel("recents"); }}>
                <History size={18} /> Recents
              </button>
            </div>

            <h4>{t("appearance")}</h4>
            <div className="seg">
              <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")}>
                <Sun size={15} /> {t("light")}
              </button>
              <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")}>
                <Moon size={15} /> {t("dark")}
              </button>
            </div>

            <h4>{t("language")}</h4>
            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("language")}>
              {LANGS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>

            <h4>{t("safety")}</h4>
            <Toggle checked={listenOn} onChange={setListenOn} label={t("listen")} />
            <Toggle checked={havensOn} onChange={setHavensOn} label={t("havens")} />
            <button className="btn text" onClick={simulate}>
              {t("simulate")}
            </button>

            <h4>{t("accessibility")}</h4>
            <Toggle checked={largeText} onChange={setLargeText} label={t("largeText")} />
            <Toggle checked={contrast} onChange={setContrast} label={t("contrast")} />

            <h4>{t("aboutData")}</h4>
            <p className="fine">{t("dataNote")}</p>
          </nav>
        </div>
      )}

      {reportOpen && (
        <div className="scrim center" onClick={() => setReportOpen(false)}>
          <div className="sheet card" role="dialog" aria-modal="true" aria-label={t("reportWhat")} onClick={(e) => e.stopPropagation()}>
            <h2>{t("reportWhat")}</h2>
            {REPORT_CATS.map((c) => (
              <button key={c} className="choice" onClick={() => sendReport(c)}>
                {t(`cat_${c}` as Key)}
                <ChevronRight size={16} />
              </button>
            ))}
            <button className="btn text" onClick={() => setReportOpen(false)}>
              {t("close")}
            </button>
          </div>
        </div>
      )}

      {alert && (
        <div className="alert" role="alertdialog" aria-modal="true" aria-labelledby="alert-title">
          <h2 id="alert-title">{t("alertTitle")}</h2>
          <p>{t("alertBody")}</p>
          {(() => {
            const z = zones.find((x) => x.id === alert.id || (x.kind === "sound" && x.origin && Math.abs(x.ts - Date.now()) < 60_000));
            return z?.origin ? (
              <p className="a-tri">
                Heard by {z.count} phones · origin located within {fmtDist((z.radiusM ?? 0) / 1609.34)} by arrival times
              </p>
            ) : null;
          })()}
          <button className="a-safe" onClick={() => answer("safe")}>
            {t("safe")}
          </button>
          <button className="a-danger" onClick={() => answer("danger")}>
            {t("danger")}
          </button>
          <a className="a-call" href="tel:911">
            {t("call911")}
          </a>
        </div>
      )}

      {nav && navInfo && !nav.arrived && (
        <>
          <div className="nav-banner" role="status" aria-live="polite">
            <span className="nb-ico">
              <CornerUpRight size={30} />
            </span>
            <div>
              <strong>{fmtDist(navInfo.toNext / 1609.34)}</strong>
              <span>{navInfo.next}</span>
            </div>
          </div>
          {navWhy && result && (
            <div className="nav-why card">
              <WhySection r={result} pctLess={pctLess} lang={lang} t={t} onFocus={() => {}} compact />
            </div>
          )}
          <div className="nav-sheet card">
            <div className="ns-main">
              <span className="ns-min">{Math.max(1, Math.round(navInfo.mins))} min</span>
              <span className="ns-sub">
                {fmtDist(navInfo.remainMi)} · arrive {navInfo.eta.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
              </span>
              <span className={`ns-live ${nav.rerouting ? "busy" : ""}`}>
                <Radio size={13} /> {nav.rerouting ? "Rerouting around a live alert…" : `Live: watching ${zones.length} alert${zones.length === 1 ? "" : "s"}${nav.reroutes ? ` · rerouted ${nav.reroutes}×` : ""}`}
              </span>
              {nav.sim && <span className="ns-demo">Demo trip · {SIM_SPEEDUP}× speed</span>}
            </div>
            <div className="ns-actions">
              {result && (
                <button className={`btn ${navWhy ? "on" : ""}`} onClick={() => setNavWhy((w) => !w)} aria-expanded={navWhy}>
                  <ShieldCheck size={16} /> {t("why")}
                </button>
              )}
              <button className="btn" onClick={simulate} title="Demo: a gunshot is detected on the road ahead">
                <Siren size={16} /> Simulate alert
              </button>
            </div>
            <button className="btn danger-btn" onClick={exitNav}>
              <X size={16} /> Exit
            </button>
          </div>
        </>
      )}

      {nav?.arrived && (
        <div className="arrival" role="dialog" aria-modal="true" aria-labelledby="arrival-title">
          <div className="arrival-stars" aria-hidden>
            <Galaxy density={1.2} glowIntensity={0.45} saturation={0.3} hueShift={210} twinkleIntensity={0.6} rotationSpeed={0.06} mouseRepulsion={false} transparent={false} />
          </div>
          <div className="arrival-card">
            <Logo size={52} className="logo-lg" />
            <h2 id="arrival-title">You&apos;ve arrived safely</h2>
            <p>{to?.label}</p>
            <div className="arrival-stats">
              <div>
                <strong>{Math.round(nav.route.minutes)}</strong>
                <span>min trip</span>
              </div>
              <div>
                <strong>{nav.avoided}</strong>
                <span>risky spots avoided</span>
              </div>
              <div>
                <strong>{nav.reroutes}</strong>
                <span>live reroutes</span>
              </div>
            </div>
            <button
              className="btn primary"
              onClick={() => {
                setNav(null);
                closeDirections();
                mapRef.current?.easeTo({ pitch: 0, bearing: 0, duration: 700 });
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {splash !== "off" && (
        <div className={`splash ${splash === "fading" ? "fading" : ""}`} aria-hidden={splash === "fading"}>
          <div className="splash-stars" aria-hidden>
            <Galaxy density={1.1} glowIntensity={0.4} saturation={0.25} hueShift={215} twinkleIntensity={0.5} rotationSpeed={0.05} mouseRepulsion={false} transparent={false} />
          </div>
          <div className="splash-brand">
            <Logo size={64} className="logo-lg" />
            <h1>NorthStar</h1>
            <p>{t("tagline")}</p>
            <span className="splash-load">Loading SF safety data…</span>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      <div className="sr" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden />
    </label>
  );
}

function Suggestions({ items, onPick, extra }: { items: Place[]; onPick: (p: Place) => void; extra?: React.ReactNode }) {
  if (!items.length && !extra) return null;
  return (
    <ul className="suggest card" role="listbox">
      {extra && <li>{extra}</li>}
      {items.map((p, i) => (
        <li key={i}>
          <button role="option" aria-selected={false} onClick={() => onPick(p)}>
            <MapPin size={16} />
            <span>
              {p.label}
              {p.addr && <span className="fine">{p.addr}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RouteOption(p: { on: boolean; onClick: () => void; minutes: number; mi: number; title: string; tag?: string; sub: string; danger?: boolean }) {
  return (
    <button role="radio" aria-checked={p.on} className={`option ${p.on ? "on" : ""}`} onClick={p.onClick}>
      <div className="o-main">
        <span className="o-title">{p.title}</span>
        <span className={`o-sub ${p.danger ? "o-danger" : ""}`}>{p.sub}</span>
      </div>
      <div className="o-side">
        <span className="o-min">{Math.round(p.minutes)} min</span>
        <span className="o-km">{fmtDist(p.mi)}</span>
        {p.tag && <span className="o-tag">{p.tag}</span>}
      </div>
    </button>
  );
}

function WhyItem({ a, lang, t, tag }: { a: Avoided; lang: Lang; t: (k: Key) => string; tag?: string }) {
  const [lng, lat] = cellCenter(a.cell);
  const sat = satellite(lng, lat, 0.0026, 132, 99);
  const hex = cellToBoundary(a.cell, true)
    .map((c) => sat.toPx(c).join(","))
    .join(" ");
  if (a.live) {
    const lp = sat.toPx([a.live.lng, a.live.lat]);
    return (
      <span className="why-item">
        <span className="why-sat">
          <img src={sat.url} alt="" loading="lazy" />
          <svg viewBox={`0 0 ${sat.W} ${sat.H}`} aria-hidden>
            <circle cx={lp[0]} cy={lp[1]} r={14} className="ws-live" />
            <circle cx={lp[0]} cy={lp[1]} r={5} className="ws-crime" />
          </svg>
        </span>
        <span className="why-text">
          <strong className="r-live">{a.live.kind === "sound" ? (a.live.level === "confirmed" ? t("confirmed") : t("caution")) : t(`cat_${a.live.category}` as Key)}</strong>
          <span className="why-types">Live alert · {a.live.count} {a.live.count === 1 ? "phone" : "phones"}</span>
        </span>
      </span>
    );
  }
  const types = new Map<string, number>();
  const where = new Map<string, number>();
  for (const e of a.events) {
    types.set(e.t, (types.get(e.t) ?? 0) + 1);
    where.set(placeOf(e.x), (where.get(placeOf(e.x)) ?? 0) + 1);
  }
  const place = [...where].sort((x, y) => y[1] - x[1])[0]?.[0];
  const latest = [...a.events].sort((x, y) => y.d.localeCompare(x.d))[0];
  const ranked = [...types].sort((x, y) => y[1] - x[1]);
  const marks = [...a.events].sort((x, y) => y.d.localeCompare(x.d)).slice(0, 24);
  return (
    <span className="why-item">
      <span className="why-sat">
        <img src={sat.url} alt={`Satellite view near ${place ?? "this block"}`} loading="lazy" />
        <svg viewBox={`0 0 ${sat.W} ${sat.H}`} aria-hidden>
          <polygon points={hex} className="ws-hex" />
          {marks.map((e, i) => {
            const [x, y] = sat.toPx([e.lng, e.lat]);
            return <circle key={i} cx={x} cy={y} r={e.t.startsWith("crash") ? 4 : 5} className={e.t.startsWith("crash") ? "ws-crash" : e.t === "dark" ? "ws-dark" : "ws-crime"} />;
          })}
        </svg>
        <span className="ws-count">{a.events.length}</span>
      </span>
      <span className="why-text">
        {tag && <span className={`why-tag ${tag === "Avoided" ? "avoided" : "onroute"}`}>{tag}</span>}
        <strong>{place ? `Near ${place}` : "Higher-risk block"}</strong>
        <span className="why-types">
          {ranked.slice(0, 3).map(([type, n]) => (
            <span key={type} className={type.startsWith("crash") ? "wt crash" : type === "dark" ? "wt dark" : "wt crime"}>
              {n}× {EVENT_LABEL[lang][type] ?? type}
            </span>
          ))}
          {ranked.length > 3 && <span className="wt more">+{ranked.slice(3).reduce((s, [, n]) => s + n, 0)} more</span>}
        </span>
        {latest && (
          <span className="fine">
            Last report {fmtDate(latest.d)}, {fmtHour(latest.h)} · busiest {peakWindow(a.events.map((e) => e.h))}
          </span>
        )}
      </span>
    </span>
  );
}

function WhySection({ r, pctLess, lang, t, onFocus, compact }: { r: Result; pctLess: number; lang: Lang; t: (k: Key) => string; onFocus: (cell: string) => void; compact?: boolean }) {
  const avoided = r.avoided.length > 0;
  const list = avoided ? r.avoided : r.passes;
  return (
    <section className={`block why ${compact ? "compact" : ""}`} aria-label={t("why")}>
      <div className="why-head">
        <span className={`why-badge ${avoided ? "" : "calm"}`}>
          <ShieldCheck size={18} />
        </span>
        <div>
          <h3>{t("why")}</h3>
          <p>
            {avoided
              ? `Avoids ${r.avoided.length} higher-risk ${r.avoided.length === 1 ? "spot" : "spots"} on the fastest route${pctLess > 0 ? ` · ${pctLess}% less risk` : ""}`
              : list.length
                ? "Nothing riskier to avoid: this is already the lowest-risk way. Heads-up on the busiest spots along it:"
                : "No recorded incidents along this route for this travel mode."}
          </p>
        </div>
      </div>
      {list.length > 0 && (
        <ul className="why-list">
          {list.map((a) => (
            <li key={a.cell}>
              <button onClick={() => onFocus(a.cell)}>
                <WhyItem a={a} lang={lang} t={t} tag={avoided ? "Avoided" : "On route"} />
                <ChevronRight size={16} className="chev" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
