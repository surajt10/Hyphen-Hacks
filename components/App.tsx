"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MLMap, GeoJSONSource, MapMouseEvent, LngLatLike } from "maplibre-gl";
import { cellToBoundary, cellToLatLng, cellToParent, cellsToMultiPolygon, gridDisk, latLngToCell } from "h3-js";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Flag,
  LocateFixed,
  MapPin,
  Menu,
  Mic,
  Moon,
  Navigation,
  Search,
  ShieldCheck,
  Sun,
  X,
  Camera,
  Ear,
} from "lucide-react";
import { MODES, type Mode, type Ev, type LiveZone, scoreCells, liveCells, routeRisk, percentile, cellCenter, contribution, LIVE_SCORE } from "@/lib/scoring";
import { DICTS, EVENT_LABEL, LANGS, type Lang, type Key } from "@/lib/i18n";
import { SoundWatcher, type Detection } from "@/lib/sound";
import Engine, { type LogEntry } from "./Engine";
import { MODE_ICON } from "./icons";

type Theme = "light" | "dark";
type View = "nav" | "engine";
type Place = { label: string; lng: number; lat: number };
type Route = { coords: [number, number][]; minutes: number; km: number; steps: { text: string; km: number }[] };
type Scored = Route & { risk: number };
type Avoided = { cell: string; score: number; events: Ev[]; live?: LiveZone };
type Camera = { name: string; lng: number; lat: number; img: string };
type Roads = { cameras: Camera[]; closures: { name: string; lng: number; lat: number; lng2: number; lat2: number; type: string }[] };
type Result = {
  safer: Scored;
  fastest: Scored;
  avoided: Avoided[];
  timeline: { offset: number; risk: number }[];
  cams: Camera[];
};

const CITY = { center: [-122.4294, 37.7649] as [number, number], bbox: [-122.52, 37.7, -122.35, 37.83], data: "/data/sf-events.json" };
const STYLE: Record<Theme, string> = {
  light: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};
const PALETTE = {
  light: { route: "#1a73e8", casing: "#1557b0", alt: "#aecbfa", altCasing: "#7ba3e8", zoneStroke: "#2f3bd6", zoneFill: "#8b90ee", zoneOpacity: 0.32, hex: "#1a56db", sel: "#202124", end: "#ea4335", me: "#1a73e8" },
  dark: { route: "#3d8bff", casing: "#0b3d91", alt: "#4d5b73", altCasing: "#2a3343", zoneStroke: "#7c96ff", zoneFill: "#5b78ff", zoneOpacity: 0.2, hex: "#007afc", sel: "#ffffff", end: "#ff5a4e", me: "#3d8bff" },
};
const SOURCES = ["hex", "zones", "routeAlt", "route", "avoid", "havens", "live", "liveLines", "sel", "selLinks", "selPts", "ends", "pin", "me"];
const OFFSETS = [0, 30, 60, 120, 180];
const REPORT_CATS = ["incident", "hazard", "blocked", "ramp", "light"] as const;
const MAX_EXCLUDE_M = 9000; // the public Valhalla server caps the total perimeter of avoid zones
const M_PER_PX_Z0 = 123800; // metres per pixel at zoom 0 at SF's latitude

const km = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * 88, (a[1] - b[1]) * 111);
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

function deviceId() {
  try {
    let id = localStorage.getItem("ns-device");
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem("ns-device", id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

export default function App() {
  // ---------- preferences ----------
  const [theme, setTheme] = useState<Theme | null>(null);
  const [lang, setLang] = useState<Lang>("en");
  const t = useCallback((k: Key) => DICTS[lang][k], [lang]);
  const [largeText, setLargeText] = useState(false);
  const [contrast, setContrast] = useState(false);
  const [havensOn, setHavensOn] = useState(false);
  const [listenOn, setListenOn] = useState(false);

  // ---------- trip ----------
  const [view, setView] = useState<View>("nav");
  const [mode, setMode] = useState<Mode>("walk");
  const [offset, setOffset] = useState(0);
  const [fromIsMe, setFromIsMe] = useState(true);
  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [dirOpen, setDirOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [suggest, setSuggest] = useState<{ field: "search" | "from" | "to"; items: Place[] } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [pick, setPick] = useState<"safer" | "fastest">("safer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSteps, setShowSteps] = useState(false);

  // ---------- data + live ----------
  const [events, setEvents] = useState<Ev[]>([]);
  const [zones, setZones] = useState<LiveZone[]>([]);
  const [myPos, setMyPos] = useState<[number, number] | null>(null);
  const [havens, setHavens] = useState<Place[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [selectedCell, setSelectedCell] = useState<string | null>(null);

  // ---------- overlays ----------
  const [drawer, setDrawer] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [alert, setAlert] = useState<{ id: string; d: Detection } | null>(null);
  const [pin, setPin] = useState<Place | null>(null);
  const [reportCard, setReportCard] = useState<{ ids: string[]; category: string; count: number } | null>(null);
  const [toast, setToast] = useState("");
  const [announce, setAnnounce] = useState("");
  const [online, setOnline] = useState(true);
  const [mapReady, setMapReady] = useState(false);

  const mapRef = useRef<MLMap | null>(null);
  const mapDiv = useRef<HTMLDivElement>(null);
  const dataRef = useRef<Record<string, GeoJSON.FeatureCollection>>({});
  const watcher = useRef<SoundWatcher | null>(null);
  const device = useRef("");
  const viewRef = useRef<View>("nav");
  const clickRef = useRef<(e: MapMouseEvent) => void>(() => {});

  const addLog = useCallback((text: string, kind?: LogEntry["kind"]) => setLog((l) => [{ t: Date.now(), text, kind }, ...l].slice(0, 120)), []);

  // ---------- startup ----------
  useEffect(() => {
    device.current = deviceId();
    let saved: Theme | null = null;
    try {
      saved = localStorage.getItem("ns-theme") as Theme | null;
    } catch {}
    setTheme(saved ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    const t0 = performance.now();
    fetch(CITY.data)
      .then((r) => r.json())
      .then((j) => {
        setEvents(j.events);
        const crashes = j.events.filter((e: Ev) => e.t.startsWith("crash")).length;
        addLog(`Loaded ${j.events.length.toLocaleString()} events (${j.events.length - crashes} violent dispatch calls, ${crashes.toLocaleString()} injury crashes) in ${Math.round(performance.now() - t0)} ms`, "data");
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
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("ns-theme", theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // ---------- map ----------
  const setData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    dataRef.current[id] = data;
    (mapRef.current?.getSource(id) as GeoJSONSource | undefined)?.setData(data);
  }, []);

  const applyVisibility = useCallback((map: MLMap, v: View) => {
    const set = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    set("hex", v === "engine");
    set("hex-line", v === "engine");
    set("avoid", v === "engine");
    set("zones", v === "nav");
  }, []);

  const installLayers = useCallback(
    (map: MLMap, th: Theme) => {
      const P = PALETTE[th];
      for (const id of SOURCES) if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: dataRef.current[id] ?? fc([]) });
      const add = (layer: Parameters<MLMap["addLayer"]>[0]) => !map.getLayer(layer.id) && map.addLayer(layer);
      add({ id: "hex", type: "fill", source: "hex", paint: { "fill-color": P.hex, "fill-opacity": ["*", 0.6, ["get", "s"]] } });
      add({ id: "hex-line", type: "line", source: "hex", paint: { "line-color": P.hex, "line-width": 0.5, "line-opacity": ["*", 0.8, ["get", "s"]] } });
      add({
        id: "zones",
        type: "circle",
        source: "zones",
        paint: {
          "circle-radius": metersToPx("m") as never,
          "circle-color": P.zoneFill,
          "circle-opacity": P.zoneOpacity,
          "circle-stroke-color": P.zoneStroke,
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 1.2, 15, 2.5],
          "circle-pitch-alignment": "map",
        },
      });
      add({ id: "avoid", type: "line", source: "avoid", paint: { "line-color": P.sel, "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.8 } });
      add({ id: "route-alt-casing", type: "line", source: "routeAlt", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": P.altCasing, "line-width": 9 } });
      add({ id: "route-alt", type: "line", source: "routeAlt", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": P.alt, "line-width": 6 } });
      add({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": P.casing, "line-width": 10 } });
      add({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": P.route, "line-width": 7 } });
      add({ id: "havens", type: "circle", source: "havens", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 5], "circle-color": "#188038", "circle-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.35, 15, 0.9], "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
      add({ id: "live-lines", type: "line", source: "liveLines", paint: { "line-color": th === "light" ? "#202124" : "#fff", "line-width": 1.5, "line-opacity": 0.7 } });
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
      add({
        id: "sel-pts",
        type: "circle",
        source: "selPts",
        paint: {
          "circle-radius": 4.5,
          "circle-color": ["match", ["get", "k"], "crash", "#f29900", "#d93025"],
          "circle-stroke-color": th === "light" ? "#fff" : "#0e1012",
          "circle-stroke-width": 1.5,
        },
      });
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
      applyVisibility(map, viewRef.current);
    },
    [applyVisibility],
  );

  // Create the map once the theme is known.
  useEffect(() => {
    if (!theme || mapRef.current) return;
    let cancelled = false;
    (async () => {
      const maplibre = await import("maplibre-gl");
      maplibre.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
      if (cancelled || !mapDiv.current) return;
      const map = new maplibre.Map({
        container: mapDiv.current,
        style: STYLE[theme],
        center: CITY.center as LngLatLike,
        zoom: 12.4,
        attributionControl: { compact: true },
      });
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "bottom-right");
      mapRef.current = map;
      map.on("style.load", () => {
        installLayers(map, (document.documentElement.dataset.theme as Theme) ?? "light");
        setMapReady(true);
      });
      map.on("click", (e) => clickRef.current(e));
      for (const id of ["route-alt", "live"]) {
        map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [theme, installLayers]);

  // Theme switch: swap the basemap, then put our layers back on top.
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
    applyVisibility(map, view);
    if (view === "nav") {
      setSelectedCell(null);
      setData("sel", fc([]));
      setData("selLinks", fc([]));
      setData("selPts", fc([]));
    }
  }, [view, mapReady, applyVisibility, setData]);

  // ---------- risk ----------
  const when = useMemo(() => new Date(Date.now() + offset * 60_000), [offset]);
  const cells = useMemo(() => scoreCells(events, mode, when), [events, mode, when]);
  const live = useMemo(() => liveCells(zones), [zones]);
  const threshold = useMemo(() => percentile([...cells.values()].map((c) => c.score), 0.9), [cells]);

  // Danger zones for people: proportional circles over ~0.7 km² areas.
  useEffect(() => {
    if (!mapReady) return;
    const parents = new Map<string, number>();
    for (const [c, v] of cells) {
      const p = cellToParent(c, 8);
      parents.set(p, (parents.get(p) ?? 0) + v.score);
    }
    const cut = percentile([...parents.values()], 0.72);
    const max = Math.max(1, ...parents.values());
    const zonesFc: unknown[] = [];
    for (const [p, s] of parents) {
      if (s < cut) continue;
      const [lat, lng] = cellToLatLng(p);
      zonesFc.push(pt([lng, lat], { m: 70 + 330 * Math.sqrt(s / max), s }));
    }
    setData("zones", fc(zonesFc));
    // Engine view: every scored cell.
    const hex: unknown[] = [];
    const hmax = Math.max(1, ...[...cells.values()].map((c) => c.score));
    for (const [c, v] of cells) hex.push(hexFeature(c, { s: Math.max(0.06, Math.min(1, Math.log1p(v.score) / Math.log1p(hmax))) }));
    setData("hex", fc(hex));
  }, [cells, mapReady, setData]);

  // ---------- geolocation ----------
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey, fromIsMe, to, mapReady, setData]);

  useEffect(() => {
    if (mapReady) setData("pin", fc(pin ? [pt([pin.lng, pin.lat])] : []));
  }, [pin, mapReady, setData]);

  // ---------- live layer: poll every 1.5 s ----------
  const seen = useRef(new Set<string>());
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const j = await fetch("/api/live").then((r) => r.json());
        if (!stop) setZones(j.zones);
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
          ? `Live alert · ${z.level === "confirmed" ? "CONFIRMED gunshot" : "possible gunshot"} at ${z.lat.toFixed(4)}, ${z.lng.toFixed(4)} (${z.count} ${z.count === 1 ? "phone" : "phones"})`
          : `Community report · ${z.category} · ${z.count}/3 people${z.level === "confirmed" ? " → counted" : ""}`,
        "live",
      );
    }
    if (!mapReady) return;
    setData("live", fc(zones.map((z) => pt([z.lng, z.lat], { kind: z.kind, level: z.level, id: z.id, category: z.category ?? "", count: z.count, ids: ((z as { reportIds?: string[] }).reportIds ?? []).join(",") }))));
    setData("liveLines", fc(zones.filter((z) => (z.points?.length ?? 0) > 1).map((z) => line(z.points!))));
  }, [zones, mapReady, setData, addLog]);

  useEffect(() => {
    if (mapReady) setData("havens", fc(havensOn ? havens.map((h) => pt([h.lng, h.lat], { name: h.label })) : []));
  }, [havens, havensOn, mapReady, setData]);

  // ---------- search ----------
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = (field: "search" | "from" | "to", q: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (q.trim().length < 2) return setSuggest(null);
    searchTimer.current = setTimeout(async () => {
      const [w, s, e, n] = CITY.bbox;
      const bias = myPos && meInCity ? `&lat=${myPos[1]}&lon=${myPos[0]}` : `&lat=${CITY.center[1]}&lon=${CITY.center[0]}`;
      try {
        const j = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&bbox=${w},${s},${e},${n}&limit=6&lang=en${bias}`).then((r) => r.json());
        const items: Place[] = j.features.map((f: { properties: Record<string, string>; geometry: { coordinates: [number, number] } }) => {
          const pr = f.properties;
          const street = pr.street ? `${pr.housenumber ?? ""} ${pr.street}`.trim() : "";
          return {
            label: [pr.name ?? street, pr.name ? street : "", pr.district ?? pr.locality ?? ""].filter(Boolean).join(", "),
            lng: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
          };
        });
        setSuggest({ field, items });
      } catch {}
    }, 250);
  };

  const goTo = (p: Place) => {
    setTo(p);
    setToText(p.label);
    setQuery(p.label);
    setDirOpen(true);
    setSuggest(null);
    setPin(null);
    if (!fromIsMe && !from) setFromText("");
  };
  const setStart = (p: Place) => {
    setFromIsMe(false);
    setFrom(p);
    setFromText(p.label);
    setSuggest(null);
    setPin(null);
  };
  const closeDirections = () => {
    setDirOpen(false);
    setTo(null);
    setToText("");
    setQuery("");
    setResult(null);
    setError("");
    for (const id of ["route", "routeAlt", "avoid", "ends"]) setData(id, fc([]));
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
      search("search", text);
    };
    r.start();
  };

  // ---------- routing ----------
  const fetchRoutes = async (m: Mode, a: Place, b: Place, night: boolean, exclude?: [number, number][][], alternates = 2) => {
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: m, from: [a.lng, a.lat], to: [b.lng, b.lat], exclude, night, alternates }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    return j.routes as Route[];
  };

  const fit = useCallback((coords: [number, number][]) => {
    const map = mapRef.current;
    if (!map || !coords.length) return;
    const xs = coords.map((c) => c[0]), ys = coords.map((c) => c[1]);
    const wide = window.innerWidth > 760;
    map.fitBounds(
      [
        [Math.min(...xs), Math.min(...ys)],
        [Math.max(...xs), Math.max(...ys)],
      ],
      {
        padding: wide
          ? { top: 80, bottom: 60, left: viewRef.current === "nav" ? 440 : 60, right: viewRef.current === "engine" ? 520 : 80 }
          : { top: 120, bottom: window.innerHeight * 0.5 + 20, left: 30, right: 30 },
        duration: 700,
      },
    );
  }, []);

  const computeId = useRef(0);
  const compute = useCallback(
    async (opts?: { quiet?: boolean; reason?: string }) => {
      const a = start, b = to;
      if (!a || !b || !events.length) return;
      const id = ++computeId.current;
      setBusy(true);
      setError("");
      const T0 = performance.now();
      try {
        const night = when.getHours() >= 19 || when.getHours() < 6;
        addLog(`${opts?.reason ?? "Route request"} · ${mode} · ${a.label} → ${b.label}${night ? " · night: prefer lit streets" : ""}`, "route");
        const fastRoutes = await fetchRoutes(mode, a, b, night);
        const fastest = fastRoutes[0];
        addLog(`Router returned ${fastRoutes.length} candidate${fastRoutes.length > 1 ? "s" : ""} in ${Math.round(performance.now() - T0)} ms`, "route");

        // Avoid zones: high-risk cells near the trip and every live alert, merged into
        // polygons, highest risk first, until the router's size limit is reached.
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
          if (perim > MAX_EXCLUDE_M) continue;
          chosen.push(c);
          polys = next;
          perimeter = perim;
        }
        const exclude = polys.map((p) => p[0] as [number, number][]);
        addLog(`${candidates.size} high-risk cells near the trip → ${chosen.length} avoided as ${exclude.length} polygon${exclude.length === 1 ? "" : "s"} (${(perimeter / 1000).toFixed(1)} km perimeter)`, "route");

        let roads: Roads | null = null;
        if (mode === "car" || mode === "moped") {
          roads = await fetch("/api/roads").then((r) => r.json()).catch(() => null);
          const full = roads?.closures.filter((c) => c.type === "Full") ?? [];
          for (const c of full) {
            const d = 0.0006;
            const x0 = Math.min(c.lng, c.lng2) - d, x1 = Math.max(c.lng, c.lng2) + d;
            const y0 = Math.min(c.lat, c.lat2) - d, y1 = Math.max(c.lat, c.lat2) + d;
            exclude.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]);
          }
          addLog(`Caltrans: ${roads?.cameras.length ?? 0} cameras, ${roads?.closures.length ?? 0} active closures (${full.length} full closures avoided)`, "data");
        }
        const safeRoutes = exclude.length ? await fetchRoutes(mode, a, b, night, exclude, 1).catch(() => []) : [];
        if (id !== computeId.current) return;

        const scored: Scored[] = [...fastRoutes, ...safeRoutes].map((r) => ({ ...r, risk: routeRisk(r.coords, r.minutes, cells, live).risk }));
        const fastScored = scored[0];
        const limit = fastScored.minutes * 1.4 + 3;
        const safer = scored.filter((r) => r.minutes <= limit).reduce((best, r) => (r.risk + 4 * r.minutes < best.risk + 4 * best.minutes ? r : best), fastScored);
        addLog(`Scored ${scored.length} routes (risk × minutes): ${scored.map((r) => `${Math.round(r.minutes)}m/${Math.round(r.risk)}`).join(", ")}`, "route");

        const onSafe = routeRisk(safer.coords, safer.minutes, cells, live).cellsOnRoute;
        const avoided: Avoided[] = [...onFast.keys()]
          .filter((c) => !onSafe.has(c) && ((cells.get(c)?.score ?? 0) >= threshold * 0.6 || live.has(c)))
          .map((c) => ({ cell: c, score: (cells.get(c)?.score ?? 0) + (live.has(c) ? 999 : 0), events: cells.get(c)?.events ?? [], live: live.get(c) }))
          .sort((p, q) => q.score - p.score)
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

        const res: Result = { safer, fastest: fastScored, avoided, timeline, cams };
        setResult(res);
        setPick("safer");
        setData("avoid", fc(polys.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: p[0] } }))));
        const same = safer === fastScored;
        const pct = fastScored.risk > 0 ? Math.round((1 - safer.risk / fastScored.risk) * 100) : 0;
        addLog(
          same
            ? `Fastest route is already lowest-risk · ${Math.round(safer.minutes)} min`
            : `Chose safer route: ${pct}% less risk for +${Math.max(0, Math.round(safer.minutes - fastScored.minutes))} min · total ${Math.round(performance.now() - T0)} ms`,
          "route",
        );
        setAnnounce(`${t("saferRoute")}: ${Math.round(safer.minutes)} ${t("min")}, ${pct}% ${t("lessRisk")}.`);
        if (!opts?.quiet) fit([...fastScored.coords, ...safer.coords]);
        try {
          localStorage.setItem("ns-last", JSON.stringify({ from: a, to: b, mode, fromIsMe }));
        } catch {}
      } catch (e) {
        if (id === computeId.current) setError(t("noRoute"));
        addLog(`Routing failed: ${String(e).slice(0, 80)}`, "route");
      } finally {
        if (id === computeId.current) setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startKey, to, events, mode, when, cells, live, threshold, t, setData, addLog, fit, fromIsMe],
  );

  // Route automatically whenever start, destination, mode or departure time change.
  const lastQuiet = useRef(false);
  useEffect(() => {
    if (!start || !to || !events.length) return;
    const quiet = lastQuiet.current;
    lastQuiet.current = true;
    const id = setTimeout(() => compute({ quiet }), 120);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey, to, mode, offset, events.length]);
  useEffect(() => {
    lastQuiet.current = false;
  }, [to, startKey]);

  // Draw the chosen route blue and the other one grey (tap grey to switch).
  useEffect(() => {
    if (!mapReady) return;
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
  }, [result, pick, mapReady, setData]);

  // A new live alert near the route: reroute.
  const zoneSig = zones.filter((z) => LIVE_SCORE[z.kind][z.level] > 0).map((z) => `${z.id}:${z.level}`).join("|");
  const lastSig = useRef("");
  useEffect(() => {
    if (zoneSig === lastSig.current) return;
    const prev = lastSig.current;
    lastSig.current = zoneSig;
    if (!result || !zoneSig || zoneSig.length < prev.length) return;
    const onRoute = routeRisk(result.safer.coords, result.safer.minutes, new Map(), new Map()).cellsOnRoute;
    const near = [...live.keys()].some((c) => gridDisk(c, 2).some((n) => onRoute.has(n)));
    if (near) {
      compute({ quiet: true, reason: "REROUTE: live alert within 2 cells of the route" });
      setToast(t("rerouted"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneSig]);

  // ---------- engine selection ----------
  const selectCell = useCallback(
    (c: string | null, fly = false) => {
      setSelectedCell(c);
      if (!c) {
        setData("sel", fc([]));
        setData("selLinks", fc([]));
        setData("selPts", fc([]));
        return;
      }
      const center = cellCenter(c);
      const contributing = (cells.get(c)?.events ?? []).filter((e) => contribution(e, mode, when).value > 0);
      setData("sel", fc([hexFeature(c)]));
      setData("selLinks", fc(contributing.map((e) => line([center, [e.lng, e.lat]]))));
      setData("selPts", fc(contributing.map((e) => pt([e.lng, e.lat], { k: e.t.startsWith("crash") ? "crash" : "crime" }))));
      addLog(`Inspect cell ${c} · ${contributing.length} contributing signals · score ${(cells.get(c)?.score ?? 0).toFixed(1)}`, "pick");
      if (fly) mapRef.current?.flyTo({ center, zoom: 16, duration: 900, padding: window.innerWidth > 760 ? { right: 480, left: 0, top: 0, bottom: 0 } : { bottom: window.innerHeight * 0.5, top: 0, left: 0, right: 0 } });
      // Pulse the outline.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, offset]);

  // ---------- map clicks ----------
  clickRef.current = (e: MapMouseEvent) => {
    const map = mapRef.current;
    if (!map) return;
    if (viewRef.current === "engine") {
      selectCell(latLngToCell(e.lngLat.lat, e.lngLat.lng, 9), map.getZoom() < 14.5);
      return;
    }
    const hits = map.queryRenderedFeatures(e.point, { layers: ["live", "route-alt"].filter((l) => map.getLayer(l)) });
    const hit = hits[0];
    if (hit?.layer.id === "route-alt") return setPick(hit.properties.alt);
    if (hit?.layer.id === "live" && hit.properties.kind === "report") {
      return setReportCard({ ids: String(hit.properties.ids).split(","), category: hit.properties.category, count: hit.properties.count });
    }
    setReportCard(null);
    setPin({ label: t("droppedPin"), lng: e.lngLat.lng, lat: e.lngLat.lat });
  };

  // ---------- sound alerts ----------
  const here = useCallback((): [number, number] => {
    if (meInCity) return myPos!;
    if (start) return [start.lng, start.lat];
    const c = mapRef.current?.getCenter();
    return c ? [c.lng, c.lat] : CITY.center;
  }, [meInCity, myPos, start]);

  const onDetect = useCallback(
    async (d: Detection, at?: [number, number]) => {
      const [lng, lat] = at ?? here();
      navigator.vibrate?.([300, 100, 300]);
      addLog(`Microphone: ${d.label} detected on this phone (confidence ${(d.confidence * 100).toFixed(0)}%) · audio stays on device`, "live");
      const j = await fetch("/api/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sound", lat, lng, device: device.current, confidence: d.confidence }),
      }).then((r) => r.json());
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
    return () => {
      w.stop();
      lock?.release();
    };
  }, [listenOn, onDetect]);

  const answer = async (ans: "safe" | "danger") => {
    if (!alert) return;
    const j = await fetch("/api/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "answer", id: alert.id, answer: ans }),
    }).then((r) => r.json());
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
    const c = result ? (pick === "fastest" ? result.fastest : result.safer).coords : null;
    setDrawer(false);
    onDetect({ confidence: 0.9, label: "gunshot", at: Date.now() }, c ? c[Math.floor(c.length * 0.55)] : undefined);
  };

  // ---------- reports ----------
  const sendReport = async (category: string) => {
    const [lng, lat] = here();
    const j = await fetch("/api/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "report", category, lat, lng, device: device.current }),
    }).then((r) => r.json());
    setZones(j.zones);
    setReportOpen(false);
    setToast(t("reported"));
  };
  const vote = async (v: "confirm" | "gone") => {
    if (!reportCard) return;
    const j = await fetch("/api/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "vote", ids: reportCard.ids, device: device.current, vote: v }),
    }).then((r) => r.json());
    setZones(j.zones);
    setReportCard(null);
  };

  // ---------- safe places (optional) ----------
  useEffect(() => {
    if (!havensOn || havens.length) return;
    const [w, s, e, n] = CITY.bbox;
    const q = `[out:json][timeout:20];(nwr["amenity"~"^(hospital|police|fire_station)$"](${s},${w},${n},${e});nwr["opening_hours"="24/7"]["shop"](${s},${w},${n},${e});nwr["opening_hours"="24/7"]["amenity"~"^(pharmacy|fuel|cafe|fast_food)$"](${s},${w},${n},${e}););out center 400;`;
    fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q) })
      .then((r) => r.json())
      .then((j) =>
        setHavens(
          j.elements
            .map((el: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }) => ({
              label: el.tags?.name ?? el.tags?.amenity ?? "Open 24/7",
              lat: el.lat ?? el.center?.lat,
              lng: el.lon ?? el.center?.lon,
            }))
            .filter((p: Place) => p.lat && p.lng),
        ),
      )
      .catch(() => setToast("Couldn't load safe places right now."));
  }, [havensOn, havens.length]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(id);
  }, [toast]);

  const locate = () => {
    if (meInCity) mapRef.current?.flyTo({ center: myPos!, zoom: 15.5 });
    else setToast(t("locationOff"));
  };

  // ---------- render ----------
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
  const showDir = view === "nav" && dirOpen;

  return (
    <div className={`app ${largeText ? "large" : ""} ${contrast ? "contrast" : ""} view-${view} ${showDir ? "dir-open" : ""}`} lang={lang}>
      <div ref={mapDiv} className="map" role="application" aria-label={view === "engine" ? "Map. Click a spot to inspect its risk." : "Map. Click to drop a pin."} />

      {/* ----- top bar ----- */}
      <div className="topbar">
        {view === "nav" && !showDir && (
          <div className="searchwrap">
            <div className="searchbox card">
              <button className="icon-btn" onClick={() => setDrawer(true)} aria-label={t("menu")}>
                <Menu size={20} />
              </button>
              <input
                value={query}
                placeholder={t("search")}
                aria-label={t("search")}
                onChange={(e) => {
                  setQuery(e.target.value);
                  search("search", e.target.value);
                }}
                onKeyDown={(e) => e.key === "Enter" && suggest?.items[0] && goTo(suggest.items[0])}
              />
              <button className="icon-btn" onClick={voice} aria-label={t("voice")}>
                <Mic size={18} />
              </button>
              <span className="divider" />
              <button className="icon-btn accent" onClick={() => setDirOpen(true)} aria-label={t("directions")} title={t("directions")}>
                <Navigation size={18} />
              </button>
            </div>
            {suggest?.field === "search" && <Suggestions items={suggest.items} onPick={goTo} />}
          </div>
        )}
        {view === "nav" && !showDir && (
          <div className="chips" role="radiogroup" aria-label="Travel mode">
            {MODES.map((m) => {
              const I = MODE_ICON[m];
              return (
                <button key={m} role="radio" aria-checked={mode === m} className={`chip ${mode === m ? "on" : ""}`} onClick={() => setMode(m)}>
                  <I size={16} /> {t(m)}
                </button>
              );
            })}
          </div>
        )}
        {view === "engine" && (
          <div className="engine-title card">
            <button className="icon-btn" onClick={() => setDrawer(true)} aria-label={t("menu")}>
              <Menu size={20} />
            </button>
            <span className="brand">
              <ShieldCheck size={18} /> NorthStar
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
          <button className="icon-btn card round" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? t("light") : t("dark")} title={theme === "dark" ? t("light") : t("dark")}>
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </div>

      {/* ----- directions panel ----- */}
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
                  onFocus={(e) => fromIsMe && e.currentTarget.select()}
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
                      meInCity ? (
                        <button
                          role="option"
                          aria-selected={false}
                          onClick={() => {
                            setFromIsMe(true);
                            setSuggest(null);
                          }}
                        >
                          <LocateFixed size={16} /> {t("yourLocation")}
                        </button>
                      ) : null
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
          </div>
          {busy && <div className="progress" role="progressbar" aria-label={t("finding")} />}

          <div className="dir-body">
            {!start && <p className="notice">{t("locationOff")}</p>}
            {error && <p className="notice error" role="alert">{error}</p>}

            {r && (
              <>
                <div className="options" role="radiogroup" aria-label="Routes">
                  <RouteOption
                    on={pick === "safer" || same}
                    onClick={() => setPick("safer")}
                    minutes={r.safer.minutes}
                    km={r.safer.km}
                    title={same ? `${t("saferRoute")} · ${t("fastestRoute")}` : t("saferRoute")}
                    tag={same ? undefined : `${pctLess}% ${t("lessRisk")}`}
                    sub={same ? t("sameRoute") : `${t("recommended")} · +${Math.max(0, Math.round(r.safer.minutes - r.fastest.minutes))} ${t("extraMin")}`}
                  />
                  {!same && <RouteOption on={pick === "fastest"} onClick={() => setPick("fastest")} minutes={r.fastest.minutes} km={r.fastest.km} title={t("fastestRoute")} sub={`${t("risk")} ${Math.round(r.fastest.risk)} vs ${Math.round(r.safer.risk)}`} />}
                </div>

                {r.avoided.length > 0 && (
                  <section className="block">
                    <h3>{t("why")}</h3>
                    <ul className="reasons">
                      {r.avoided.map((a) => (
                        <li key={a.cell}>
                          <button
                            onClick={() => {
                              setData("sel", fc([hexFeature(a.cell)]));
                              mapRef.current?.flyTo({ center: cellCenter(a.cell), zoom: 16, padding: window.innerWidth > 760 ? { left: 420, right: 0, top: 0, bottom: 0 } : { bottom: window.innerHeight * 0.5, top: 0, left: 0, right: 0 } });
                            }}
                          >
                            <Reason a={a} lang={lang} t={t} />
                            <ChevronRight size={16} className="chev" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

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
                          {/* eslint-disable-next-line @next/next/no-img-element */}
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
                            {s.km > 0 && <span className="fine">{s.km < 1 ? `${Math.round(s.km * 1000)} m` : `${s.km.toFixed(1)} km`}</span>}
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

      {/* ----- engine ----- */}
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
        />
      )}

      {/* ----- floating controls ----- */}
      <div className="fab-col">
        {view === "nav" && (
          <button className="fab card" onClick={() => setReportOpen(true)} aria-label={t("report")} title={t("report")}>
            <Flag size={18} />
          </button>
        )}
        <button className="fab card" onClick={locate} aria-label={t("yourLocation")} title={t("yourLocation")}>
          <LocateFixed size={18} />
        </button>
      </div>

      {listenOn && (
        <div className="pill listening card" role="status">
          <Ear size={14} /> {t("listening")}
        </div>
      )}
      {!online && (
        <div className="pill offline card" role="status">
          Offline · showing saved map and routes
        </div>
      )}

      {/* ----- dropped pin ----- */}
      {view === "nav" && pin && (
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
          </div>
        </div>
      )}

      {view === "nav" && reportCard && (
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

      {/* ----- menu drawer ----- */}
      {drawer && (
        <div className="scrim" onClick={() => setDrawer(false)}>
          <nav className="drawer" onClick={(e) => e.stopPropagation()} aria-label={t("menu")}>
            <div className="drawer-head">
              <span className="brand">
                <ShieldCheck size={20} /> NorthStar
              </span>
              <button className="icon-btn" onClick={() => setDrawer(false)} aria-label={t("close")}>
                <X size={20} />
              </button>
            </div>
            <p className="fine">{t("tagline")}</p>

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
            <span>{p.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RouteOption(p: { on: boolean; onClick: () => void; minutes: number; km: number; title: string; tag?: string; sub: string }) {
  return (
    <button role="radio" aria-checked={p.on} className={`option ${p.on ? "on" : ""}`} onClick={p.onClick}>
      <div className="o-main">
        <span className="o-title">{p.title}</span>
        <span className="o-sub">{p.sub}</span>
      </div>
      <div className="o-side">
        <span className="o-min">{Math.round(p.minutes)} min</span>
        <span className="o-km">{p.km.toFixed(1)} km</span>
        {p.tag && <span className="o-tag">{p.tag}</span>}
      </div>
    </button>
  );
}

function Reason({ a, lang, t }: { a: Avoided; lang: Lang; t: (k: Key) => string }) {
  if (a.live) {
    return (
      <span className="r-text">
        <strong className="r-live">{a.live.kind === "sound" ? (a.live.level === "confirmed" ? t("confirmed") : t("caution")) : t(`cat_${a.live.category}` as Key)}</strong>
      </span>
    );
  }
  const counts = new Map<string, number>();
  for (const e of a.events) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);
  const latest = [...a.events].sort((x, y) => y.d.localeCompare(x.d))[0];
  const summary = [...counts]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 2)
    .map(([type, n]) => `${n} × ${EVENT_LABEL[lang][type] ?? type}`)
    .join(" · ");
  return (
    <span className="r-text">
      <strong>{summary}</strong>
      {latest && (
        <span className="fine">
          {t("latest")}: {latest.x} · {latest.d}
        </span>
      )}
    </span>
  );
}
