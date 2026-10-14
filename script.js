/* =========================================================
   GOD'S EYE VIEW — $EYE
   Single-screen live globe. Edit CONFIG before launch.
   ========================================================= */
const CONFIG = {
  contractAddress: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxx",   // paste the real CA here at launch
  links: {
    buy: "https://pump.fun",                          // pump.fun / Raydium / Jupiter link
    chart: "https://dexscreener.com/solana",          // Dexscreener pair link
    x: "https://x.com",                               // X / Twitter profile
    telegram: "https://t.me",                         // Telegram group
  },
  flightsUrl: "/api/flights",                         // Vercel function (api/flights.js)
  flightsRefreshMs: 60_000,
  camerasUrl: "/cameras.json",
  estoniaUrl: "/api/estonia",                         // Vercel function (api/estonia.js)
  windyUrl: "/api/windy",                             // optional worldwide webcams (set WINDY_API_KEY on Vercel)
  // Optional upgrades (both free tiers): a Cesium ion token adds real 3D terrain and
  // OSM 3D buildings; a Google Maps key adds Photorealistic 3D Tiles like the original.
  cesiumIonToken: "",
  googleMapsApiKey: "",
};

const $ = (id) => document.getElementById(id);
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pad = (n, w = 3) => String(n).padStart(w, "0");
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const haversine = (la1, lo1, la2, lo2) => {
  const R = 6371, p = Math.PI / 180, dLa = (la2 - la1) * p, dLo = (lo2 - lo1) * p;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

/* ---------- links / CA / nav ---------- */
document.querySelectorAll("[data-link]").forEach((a) => { const href = CONFIG.links[a.dataset.link]; if (href) a.href = href; });
document.querySelectorAll("#ca-text, #ca-text-2, .ca-text-3").forEach((el) => (el.textContent = CONFIG.contractAddress || "Coming at launch"));
async function copyCA(btn, labelEl) {
  const el = labelEl || btn, label = el.textContent;
  if (!CONFIG.contractAddress) { el.textContent = "SOON"; setTimeout(() => (el.textContent = label), 1200); return; }
  try { await navigator.clipboard.writeText(CONFIG.contractAddress); el.textContent = "COPIED"; btn.classList.add("done"); }
  catch { el.textContent = "FAILED"; }
  setTimeout(() => { el.textContent = label; btn.classList.remove("done"); }, 1500);
}
$("ca-copy").addEventListener("click", (e) => copyCA(e.currentTarget));
$("ca-pill").addEventListener("click", (e) => copyCA(e.currentTarget, $("ca-pill-copy")));
document.querySelectorAll("[data-copy-ca]").forEach((b) => b.addEventListener("click", () => copyCA(b)));

const dock = $("dock"), dockToggle = $("dock-toggle");
dockToggle.addEventListener("click", () => { const open = dock.classList.toggle("open"); dockToggle.setAttribute("aria-expanded", String(open)); });
const mission = $("mission"), missionToggle = $("mission-toggle");
function setMission(collapsed) { mission.classList.toggle("collapsed", collapsed); missionToggle.textContent = collapsed ? "SHOW" : "HIDE"; }
missionToggle.addEventListener("click", () => setMission(!mission.classList.contains("collapsed")));
if (window.innerWidth < 1080 || window.innerHeight < 640) setMission(true);

/* ---------- windows ---------- */
const panels = [...document.querySelectorAll(".panel")];
function openPanel(name) {
  panels.forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
  dock.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
  dock.classList.remove("open");
  if (name === "cameras") buildWall();
  if (name === "flights") buildBoard();
  if (window.innerWidth < 820) setMission(true);
}
function closePanels() { panels.forEach((p) => (p.hidden = true)); dock.querySelectorAll("button").forEach((b) => b.classList.remove("active")); }
dock.querySelectorAll("[data-panel]").forEach((b) => b.addEventListener("click", () => {
  const already = !$(`panel-${b.dataset.panel}`).hidden; already ? closePanels() : openPanel(b.dataset.panel);
}));
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closePanels));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePanels(); globe.clearTarget?.(); } });

/* ---------- HUD ---------- */
const hud = Object.fromEntries(["clock", "mode", "alt", "lat", "lon", "planes", "cams", "sats", "quakes", "feed", "sensor", "log"].map((k) => [k, $(`hud-${k}`)]));
const logQueue = [];
function log(msg) { logQueue.push(msg); if (logQueue.length > 6) logQueue.shift(); }
setInterval(() => { if (logQueue.length) hud.log.textContent = `> ${logQueue.shift()}`; }, 2200);
const BANTER = ["ALERT: JEET DETECTED · SELLING AT A LOSS", "LOCK: WHALE WALLET ACQUIRED · HOLDING", "RUG SIGNATURE 250 KM NE · AVOIDED",
  "FLIR: PORTFOLIO THERMAL · STILL RED", "ORBIT NOMINAL · LP BURNED · MINT REVOKED", "CONTACT LOST: PAPER HANDS LEFT ORBIT"];
setInterval(() => { if (!logQueue.length) log(rand(BANTER)); }, 11000);

/* ---------- state ---------- */
const state = { cams: [], camSources: {}, planes: [], sats: [], quakes: [], feed: "INIT", feedTime: 0, source: "", selected: null };
const SRC_FLAG = { tallinn: "Tallinn", ee: "Estonia", fi: "Finland", no: "Norway", tfl: "London", it: "Italy", hu: "Hungary", hk: "Hong Kong", sg: "Singapore", nsw: "Sydney / NSW", nz: "New Zealand", austin: "Austin", or: "Oregon", ga: "Georgia", pa: "Pennsylvania", az: "Arizona", nv: "Nevada", la: "Louisiana", ak: "Alaska", on: "Ontario", ab: "Alberta", bc: "British Columbia", calgary: "Calgary", fl: "Florida", ct: "Connecticut", id: "Idaho", yt: "Yukon", fw: "Alps weather", osm: "OpenStreetMap", windy: "Windy" };

/* ---------- data: cameras ---------- */
const camsReady = fetch(CONFIG.camerasUrl).then((r) => r.json()).then((j) => {
  state.camSources = j.sources;
  state.cams = j.cams.map(([s, k, n, la, lo]) => ({ id: `${s}:${k}`, s, k, n, place: j.sources[s].place, la, lo }));
  hud.cams.textContent = pad(state.cams.length, 4); $("cam-count").textContent = fmtInt(state.cams.length);
  const sel = $("wall-source");
  Object.entries(j.sources).forEach(([s, src]) => { if (!state.cams.some((c) => c.s === s)) return; const o = document.createElement("option"); o.value = s; o.textContent = `${(SRC_FLAG[s] || src.place).toUpperCase()} · ${state.cams.filter((c) => c.s === s).length}`; sel.appendChild(o); });
  log(`CAMERA NETWORK ONLINE · ${fmtInt(state.cams.length)} CAMERAS · ${Object.keys(j.sources).length} NETWORKS`); $("cam-networks").textContent = Object.keys(j.sources).filter((k) => state.cams.some((c) => c.s === k)).length;
  return state.cams;
}).catch(() => { hud.cams.textContent = "ERR"; return []; });
const dynCache = {};
/* ---------- optional: worldwide webcams via Windy (needs WINDY_API_KEY on the server) ---------- */
const windy = { enabled: false, loaded: new Map() };
fetch(CONFIG.windyUrl).then((r) => r.json()).then((j) => {
  windy.enabled = Boolean(j.enabled);
  document.querySelectorAll("[data-windy]").forEach((b) => (b.hidden = !windy.enabled));
  if (windy.enabled) { state.camSources.windy = { name: "Windy.com webcams", place: "Worldwide", tpl: "{k}" }; log("WORLDWIDE WEBCAM UPLINK · WINDY · READY"); }
}).catch(() => {});
async function loadWindyNear(lat, lon, radius = 250) {
  if (!windy.enabled) return [];
  try {
    const j = await fetch(`${CONFIG.windyUrl}?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&radius=${radius}`).then((r) => r.json());
    const fresh = [];
    for (const [id, title, la, lo, preview, place] of j.rows || []) {
      if (windy.loaded.has(id)) continue;
      const c = { id: `windy:${id}`, s: "windy", k: preview, n: title, place: place || "Windy webcam", la, lo };
      windy.loaded.set(id, c); state.cams.push(c); fresh.push(c);
    }
    if (fresh.length) { hud.cams.textContent = pad(state.cams.length, 4); $("cam-count").textContent = fmtInt(state.cams.length); globe.addCams?.(fresh); }
    if (fresh.length && !$("wall-source").querySelector('option[value="windy"]')) { const o = document.createElement("option"); o.value = "windy"; o.textContent = "WINDY · WORLDWIDE"; $("wall-source").appendChild(o); }
    log(`WINDY · ${j.rows?.length || 0} WEBCAMS WITHIN ${radius} KM · ${fresh.length} NEW`);
    return fresh;
  } catch { log("WINDY UPLINK FAILED"); return []; }
}
async function camUrl(c, bust = true) {
  const src = state.camSources[c.s];
  if (src.dyn) {
    const d = (dynCache[src.dyn] ||= { t: 0, map: null, inflight: null });
    if (!d.map || Date.now() - d.t > 60_000) {
      d.inflight ||= fetch(src.dyn, { cache: "no-store" }).then((r) => r.json()).then((map) => { d.map = map; d.t = Date.now(); }).catch(() => { d.t = Date.now() - 50_000; }).finally(() => { d.inflight = null; });
      await d.inflight;
    }
    return d.map?.[c.k] || null;
  }
  const u = src.tpl.replace("{k}", c.k);
  return bust ? `${u}${u.includes("?") ? "&" : "?"}_=${Date.now()}` : u;
}

/* ---------- data: flights ---------- */
function planePos(p, t = Date.now()) {
  const dt = (t - p.t0) / 1000, h = (p.hdg * Math.PI) / 180, d = p.v * dt;
  const lat = p.lat + (d * Math.cos(h)) / 111320;
  let lon = p.lon + (d * Math.sin(h)) / (111320 * Math.max(0.2, Math.cos((p.lat * Math.PI) / 180)));
  if (lon > 180) lon -= 360; if (lon < -180) lon += 360;
  return { lon, lat, alt: Math.max(50, p.alt + p.vr * dt) };
}
async function loadFlights() {
  try {
    const r = await fetch(CONFIG.flightsUrl, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    if (!j.rows || !j.rows.length) throw new Error("empty");
    const t0 = Date.now();
    state.planes = j.rows.map((r) => ({ icao: r[0], cs: r[1], lon: r[2], lat: r[3], alt: r[4], v: r[5], hdg: r[6], country: r[7], vr: r[8], t0 }));
    state.feedTime = (j.time || t0 / 1000) * 1000; state.source = j.source || "feed";
    state.feed = r.headers.get("X-Feed-State") === "stale" ? "STALE" : "LIVE";
    hud.planes.textContent = pad(state.planes.length, 4);
    hud.feed.textContent = `${state.feed} · ${state.source.toUpperCase()}`;
    log(`ADS-B FEED ${state.feed} · ${fmtInt(j.total || state.planes.length)} AIRCRAFT · ${state.source.toUpperCase()}`);
    globe.renderFlights?.(state.planes);
    if (!$("panel-flights").hidden) buildBoard();
  } catch {
    state.feed = state.planes.length ? "STALE" : "OFFLINE";
    hud.feed.textContent = state.feed; hud.planes.textContent = state.planes.length ? pad(state.planes.length, 4) : "----";
    log(`ADS-B FEED ${state.feed}`);
  }
}
loadFlights();
setInterval(loadFlights, CONFIG.flightsRefreshMs);

/* ---------- data: satellites (CelesTrak TLE + satellite.js) ---------- */
const satsReady = (async () => {
  if (typeof satellite === "undefined") return [];
  const groups = ["stations", "visual"];
  const seen = new Map();
  for (const g of groups) {
    try {
      const txt = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`).then((r) => r.text());
      const lines = txt.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
      for (let i = 0; i + 2 < lines.length; i += 3) {
        const name = lines[i].trim(), l1 = lines[i + 1], l2 = lines[i + 2];
        if (!l1.startsWith("1 ") || !l2.startsWith("2 ")) { i -= 2; continue; }
        const norad = l1.slice(2, 7).trim();
        if (seen.has(norad)) continue;
        const rec = satellite.twoline2satrec(l1, l2);
        seen.set(norad, { norad, name, rec, group: g, period: (2 * Math.PI) / rec.no });
      }
    } catch {}
  }
  state.sats = [...seen.values()];
  hud.sats.textContent = pad(state.sats.length, 4);
  if (state.sats.length) log(`ORBITAL CATALOG · ${state.sats.length} OBJECTS · CELESTRAK`);
  return state.sats;
})();
function satGeo(s, date = new Date()) {
  const pv = satellite.propagate(s.rec, date);
  if (!pv.position || typeof pv.position !== "object") return null;
  const gmst = satellite.gstime(date), g = satellite.eciToGeodetic(pv.position, gmst);
  const v = pv.velocity ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) : 0;
  return { lon: satellite.degreesLong(g.longitude), lat: satellite.degreesLat(g.latitude), alt: g.height * 1000, speed: v };
}

/* ---------- data: earthquakes (USGS, past 24 h, M2.5+) ---------- */
const quakesReady = fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson").then((r) => r.json()).then((j) => {
  state.quakes = j.features.map((f) => ({ id: f.id, mag: f.properties.mag, place: f.properties.place, time: f.properties.time, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], depth: f.geometry.coordinates[2] }));
  hud.quakes.textContent = pad(state.quakes.length, 3);
  const big = state.quakes.reduce((a, b) => (b.mag > (a?.mag || 0) ? b : a), null);
  if (big) log(`SEISMIC · ${state.quakes.length} EVENTS 24H · MAX M${big.mag.toFixed(1)} ${big.place?.toUpperCase() || ""}`);
  return state.quakes;
}).catch(() => { hud.quakes.textContent = "ERR"; return []; });

/* =========================================================
   GLOBE (CesiumJS)
   ========================================================= */
const globe = {};
(function initGlobe() {
  const loading = $("globe-loading");
  const fail = (msg) => { loading.classList.add("done"); const f = $("globe-fallback"); f.hidden = false; f.querySelector("p").textContent = msg; };
  if (typeof Cesium === "undefined") return fail("GLOBE ENGINE FAILED TO LOAD — check your connection and reload.");
  if (CONFIG.cesiumIonToken) Cesium.Ion.defaultAccessToken = CONFIG.cesiumIonToken;
  let viewer;
  try {
    viewer = new Cesium.Viewer("cesium", {
      baseLayer: false, terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
      animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false, vrButton: false,
      creditContainer: $("cesium-credits"), contextOptions: { webgl: { powerPreference: "high-performance" } },
    });
  } catch { return fail("WEBGL UNAVAILABLE — the live globe needs a browser with WebGL enabled."); }
  const scene = viewer.scene, camera = viewer.camera, g = scene.globe;
  globe.viewer = viewer;
  const C3 = Cesium.Cartesian3, CM = Cesium.Math;
  g.enableLighting = true; g.dynamicAtmosphereLighting = true; g.dynamicAtmosphereLightingFromSun = true;
  g.vertexShadowDarkness = 0.7; g.showGroundAtmosphere = true; g.baseColor = Cesium.Color.fromCssColorString("#06111a");
  scene.skyAtmosphere.show = true; scene.moon.show = false; scene.highDynamicRange = false; scene.fog.enabled = true;
  scene.screenSpaceCameraController.minimumZoomDistance = 120;
  scene.screenSpaceCameraController.maximumZoomDistance = 1.2e8;
  viewer.clock.shouldAnimate = true;

  // Height at which the whole Earth fits the viewport with a margin.
  function fitHeight() {
    const w = scene.canvas.clientWidth || 1, h = scene.canvas.clientHeight || 1, fov = camera.frustum.fov || 1.047;
    const halfMin = w >= h ? Math.atan(Math.tan(fov / 2) / (w / h)) : fov / 2;
    return Math.max(1.6e7, 6378137 / Math.sin(halfMin * 0.78));
  }
  const HOME = () => C3.fromDegrees(18, 24, fitHeight());
  camera.setView({ destination: HOME() });

  /* ---- imagery ---- */
  const GIBS = (layer, ext, time = "") => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${time ? time + "/" : ""}GoogleMapsCompatible_Level8/{z}/{y}/{x}.${ext}`;
  let lightsLayer = null, radarLayer = null, labelsLayer = null;
  (async () => {
    try {
      const p = await Cesium.ArcGisMapServerImageryProvider.fromUrl("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer", { enablePickFeatures: false });
      viewer.imageryLayers.addImageryProvider(p);
    } catch {
      viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: GIBS("BlueMarble_ShadedRelief_Bathymetry", "jpeg"), maximumLevel: 8, credit: "NASA GIBS Blue Marble" }));
    }
    // VIIRS city lights, only on the night side of the terminator.
    lightsLayer = viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: GIBS("VIIRS_Black_Marble", "png", "2016-01-01"), maximumLevel: 8, credit: "NASA GIBS Black Marble" }));
    lightsLayer.dayAlpha = 0.0; lightsLayer.nightAlpha = 0.65; lightsLayer.brightness = 2.2;
    // Country borders, admin boundaries and place names (Esri reference overlay).
    try {
      labelsLayer = viewer.imageryLayers.addImageryProvider(await Cesium.ArcGisMapServerImageryProvider.fromUrl("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer", { enablePickFeatures: false }));
      labelsLayer.show = layerState.labels;
    } catch { log("BORDERS + NAMES OVERLAY UNAVAILABLE"); }
    if (radarLayer) viewer.imageryLayers.raiseToTop(radarLayer);
    if (labelsLayer) viewer.imageryLayers.raiseToTop(labelsLayer);
  })();
  // Optional: terrain + 3D buildings (Cesium ion) and Google Photorealistic 3D Tiles.
  (async () => {
    try {
      if (CONFIG.cesiumIonToken) {
        viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
        scene.primitives.add(await Cesium.createOsmBuildingsAsync());
        g.depthTestAgainstTerrain = true; log("3D TERRAIN + BUILDINGS ONLINE · CESIUM ION");
      }
      if (CONFIG.googleMapsApiKey) {
        Cesium.GoogleMaps.defaultApiKey = CONFIG.googleMapsApiKey;
        scene.primitives.add(await Cesium.createGooglePhotorealistic3DTileset());
        log("PHOTOREALISTIC 3D TILES ONLINE · GOOGLE");
      }
    } catch (e) { log("3D UPGRADE FAILED · CHECK TOKEN"); }
  })();

  let sawTiles = false;
  const doneLoading = () => { if (loading.classList.contains("done")) return; loading.classList.add("done"); log("SATELLITE LINK ESTABLISHED · EYE-01 ON STATION"); };
  g.tileLoadProgressEvent.addEventListener((n) => { if (n > 0) sawTiles = true; else if (sawTiles) doneLoading(); });
  setTimeout(doneLoading, 8000);

  /* ---- sensors ---- */
  const FLIR = `uniform sampler2D colorTexture; in vec2 v_textureCoordinates;
    void main(){ vec4 c = texture(colorTexture, v_textureCoordinates); float l = dot(c.rgb, vec3(0.299,0.587,0.114));
    float v = smoothstep(0.03, 0.85, l); v = pow(v, 0.85); out_FragColor = vec4(vec3(v) * vec3(1.0, 0.97, 0.9), 1.0); }`;
  const CRT = `uniform sampler2D colorTexture; in vec2 v_textureCoordinates;
    void main(){ vec4 c = texture(colorTexture, v_textureCoordinates); float l = dot(c.rgb, vec3(0.299,0.587,0.114));
    float scan = 0.82 + 0.18 * sin(gl_FragCoord.y * 1.6); vec2 d = v_textureCoordinates - 0.5; float vig = 1.0 - dot(d, d) * 0.9;
    out_FragColor = vec4(vec3(l * 0.25, l * 1.05, l * 0.35) * scan * vig, 1.0); }`;
  const stages = {
    flir: scene.postProcessStages.add(new Cesium.PostProcessStage({ fragmentShader: FLIR })),
    nvg: scene.postProcessStages.add(Cesium.PostProcessStageLibrary.createNightVisionStage()),
    crt: scene.postProcessStages.add(new Cesium.PostProcessStage({ fragmentShader: CRT })),
  };
  Object.values(stages).forEach((s) => (s.enabled = false));
  function setSensor(k, quiet) {
    Object.entries(stages).forEach(([n, s]) => (s.enabled = n === k));
    document.querySelectorAll("[data-sensor]").forEach((x) => x.classList.toggle("on", x.dataset.sensor === k));
    hud.sensor.textContent = k.toUpperCase(); if (!quiet) log(`SENSOR SWITCH · ${k.toUpperCase()}`);
  }
  document.querySelectorAll("[data-sensor]").forEach((b) => b.addEventListener("click", () => setSensor(b.dataset.sensor)));

  /* ---- layers ---- */
  const AMBER = Cesium.Color.fromCssColorString("#ffb800"), CYAN = Cesium.Color.fromCssColorString("#22e6e6"), RED = Cesium.Color.fromCssColorString("#ff6b7a"), WHITE = Cesium.Color.fromCssColorString("#e8feff");
  const camPoints = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const planes = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  const satPoints = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const satLabels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
  const quakePoints = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  let cablesDs = null;
  const PLANE_IMG = "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M12 1.5 L13.6 8.5 L22.5 13 L22.5 15.2 L13.8 12.4 L13.3 18 L16.2 20.2 L16.2 22 L12 20.8 L7.8 22 L7.8 20.2 L10.7 18 L10.2 12.4 L1.5 15.2 L1.5 13 L10.4 8.5 Z" fill="#22e6e6" stroke="#04171a" stroke-width="0.8"/></svg>`);
  const layerState = { planes: true, cams: true, labels: true, sats: true, quakes: true, radar: false, lights: true, cables: false };
  async function setLayer(name, on, quiet) {
    layerState[name] = on;
    document.querySelector(`[data-layer="${name}"]`)?.classList.toggle("on", on);
    if (name === "planes") planes.show = on;
    if (name === "cams") camPoints.show = on;
    if (name === "sats") { satPoints.show = on; satLabels.show = on; }
    if (name === "quakes") quakePoints.show = on;
    if (name === "lights" && lightsLayer) lightsLayer.show = on;
    if (name === "labels" && labelsLayer) labelsLayer.show = on;
    if (name === "radar") {
      if (on && !radarLayer) {
        try {
          const j = await fetch("https://api.rainviewer.com/public/weather-maps.json").then((r) => r.json());
          const frame = j.radar.past[j.radar.past.length - 1];
          radarLayer = viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: `${j.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, maximumLevel: 7, credit: "RainViewer" }));
          radarLayer.alpha = 0.78; if (labelsLayer) viewer.imageryLayers.raiseToTop(labelsLayer);
          log(`WEATHER RADAR · ${new Date(frame.time * 1000).toISOString().slice(11, 16)}Z · RAINVIEWER`);
        } catch { log("RADAR FEED UNAVAILABLE"); }
      } else if (radarLayer) radarLayer.show = on;
    }
    if (name === "cables") {
      if (on && !cablesDs) {
        try {
          cablesDs = await Cesium.GeoJsonDataSource.load("https://www.submarinecablemap.com/api/v3/cable/cable-geo.json", { stroke: CYAN.withAlpha(0.7), strokeWidth: 1.4, clampToGround: true });
          viewer.dataSources.add(cablesDs); log(`SUBMARINE CABLES · ${cablesDs.entities.values.length} SYSTEMS · TELEGEOGRAPHY`);
        } catch { log("CABLE MAP UNAVAILABLE"); }
      } else if (cablesDs) cablesDs.show = on;
    }
    if (!quiet) log(`LAYER ${name.toUpperCase()} ${on ? "ON" : "OFF"}`);
  }
  document.querySelectorAll("[data-layer]").forEach((b) => b.addEventListener("click", () => setLayer(b.dataset.layer, !layerState[b.dataset.layer])));
  // Refresh the radar frame every 10 minutes while it is on.
  setInterval(() => { if (layerState.radar && radarLayer) { viewer.imageryLayers.remove(radarLayer); radarLayer = null; setLayer("radar", true, true); } }, 600_000);

  const MAGENTA = Cesium.Color.fromCssColorString("#ff7ad9");
  globe.addCams = (cams) => {
    for (const c of cams) camPoints.add({
      position: C3.fromDegrees(c.lo, c.la, 30), color: c.s === "windy" ? MAGENTA : AMBER, pixelSize: 6, outlineColor: Cesium.Color.BLACK.withAlpha(0.7), outlineWidth: 1,
      scaleByDistance: new Cesium.NearFarScalar(2e4, 1.5, 1.2e7, 0.5), id: { type: "cam", cam: c },
    });
  };
  camsReady.then((cams) => { globe.addCams(cams); applyHashTarget(); });
  quakesReady.then((qs) => {
    for (const q of qs) quakePoints.add({
      position: C3.fromDegrees(q.lon, q.lat, 1000), color: RED.withAlpha(0.85), pixelSize: 4 + Math.max(0, q.mag - 2) * 3,
      outlineColor: RED.withAlpha(0.35), outlineWidth: 3, disableDepthTestDistance: 0, id: { type: "quake", q },
    });
  });

  function northAxis(pos) {
    const up = C3.normalize(pos, new C3());
    const n = C3.subtract(C3.UNIT_Z, C3.multiplyByScalar(up, C3.dot(C3.UNIT_Z, up), new C3()), new C3());
    return C3.magnitude(n) < 1e-6 ? C3.UNIT_X : C3.normalize(n, n);
  }
  globe.renderFlights = (list) => {
    planes.removeAll();
    for (const p of list) {
      const pos = C3.fromDegrees(p.lon, p.lat, Math.max(p.alt, 50));
      planes.add({ position: pos, image: PLANE_IMG, width: 16, height: 16, rotation: -CM.toRadians(p.hdg || 0), alignedAxis: northAxis(pos),
        scaleByDistance: new Cesium.NearFarScalar(5e4, 1.3, 2.2e7, 0.5), id: { type: "plane", p } });
    }
    if (state.selected?.type === "plane") {
      const fresh = list.find((p) => p.icao === state.selected.p.icao);
      if (fresh) { state.selected.p = fresh; showTarget(state.selected, false); }
    }
    applyHashTarget();
  };
  if (state.planes.length) globe.renderFlights(state.planes);
  // Dead reckoning: move every aircraft along its track between feed updates.
  setInterval(() => {
    if (!planes.show || scene.mode !== Cesium.SceneMode.SCENE3D && scene.mode !== Cesium.SceneMode.SCENE2D) return;
    const now = Date.now();
    for (let i = 0; i < planes.length; i++) { const bb = planes.get(i), p = bb.id.p; if (!p.v) continue; const q = planePos(p, now); bb.position = C3.fromDegrees(q.lon, q.lat, q.alt); }
  }, 2000);

  satsReady.then((sats) => {
    for (const s of sats) {
      const named = /ISS \(ZARYA\)|CSS \(TIANHE\)|HST/.test(s.name);
      satPoints.add({ position: C3.ZERO, color: named ? WHITE : CYAN.withAlpha(0.9), pixelSize: named ? 7 : 4, outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1, id: { type: "sat", s } });
      if (named) satLabels.add({ position: C3.ZERO, text: s.name.replace(/ \(.*\)/, ""), font: "500 11px 'JetBrains Mono', monospace", fillColor: WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(10, -8), horizontalOrigin: Cesium.HorizontalOrigin.LEFT, id: { type: "sat", s } });
    }
    tickSats(); applyHashTarget();
  });
  function tickSats() {
    if (!state.sats.length) return;
    const now = new Date();
    for (let i = 0; i < satPoints.length; i++) { const pt = satPoints.get(i), geo = satGeo(pt.id.s, now); if (geo) { pt.id.s.geo = geo; pt.position = C3.fromDegrees(geo.lon, geo.lat, geo.alt); } }
    for (let i = 0; i < satLabels.length; i++) { const lb = satLabels.get(i), geo = lb.id.s.geo; if (geo) lb.position = C3.fromDegrees(geo.lon, geo.lat, geo.alt); }
  }
  setInterval(tickSats, 1000);

  /* ---- selection / target window ---- */
  const marker = viewer.entities.add({ show: false, position: C3.ZERO, point: { pixelSize: 26, color: Cesium.Color.TRANSPARENT, outlineColor: AMBER, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
  const T = { panel: $("panel-target"), kind: $("target-kind"), title: $("target-title"), sub: $("target-sub"), fig: $("target-figure"), img: $("target-img"), cap: $("target-caption"), meta: $("target-meta"),
    follow: $("target-follow"), cockpit: $("target-cockpit"), open: $("target-open"), nearby: $("nearby"), nearbyList: $("nearby-list") };
  let imgTimer = null, follow = null, cockpit = null;
  const setMeta = (rows) => (T.meta.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(""));
  const stopFollow = (quiet) => {
    if (follow || cockpit) { camera.lookAtTransform(Cesium.Matrix4.IDENTITY); scene.screenSpaceCameraController.enableInputs = true; }
    follow = null; cockpit = null; T.follow.textContent = "FOLLOW"; T.cockpit.textContent = "COCKPIT"; T.follow.classList.remove("on"); T.cockpit.classList.remove("on");
    hud.mode.textContent = state.selected ? "TRACK" : scene.mode === Cesium.SceneMode.SCENE2D ? "2D MAP" : "ORBIT";
    if (!quiet) pauseRotation();
  };
  function livePos(sel) {
    if (sel.type === "plane") return planePos(sel.p);
    if (sel.type === "sat") return satGeo(sel.s) || sel.s.geo;
    if (sel.type === "cam") return { lon: sel.cam.lo, lat: sel.cam.la, alt: 30 };
    return { lon: sel.q.lon, lat: sel.q.lat, alt: 1000 };
  }
  function liveHeading(sel) {
    if (sel.type === "plane") return CM.toRadians(sel.p.hdg || 0);
    if (sel.type === "sat") { const a = satGeo(sel.s, new Date()), b = satGeo(sel.s, new Date(Date.now() + 2000)); if (!a || !b) return 0;
      const y = Math.sin(CM.toRadians(b.lon - a.lon)) * Math.cos(CM.toRadians(b.lat)), x = Math.cos(CM.toRadians(a.lat)) * Math.sin(CM.toRadians(b.lat)) - Math.sin(CM.toRadians(a.lat)) * Math.cos(CM.toRadians(b.lat)) * Math.cos(CM.toRadians(b.lon - a.lon)); return Math.atan2(y, x); }
    return 0;
  }
  function flyToSel(sel) {
    stopFollow(true);
    const pos = livePos(sel);
    if (sel.type === "cam") camera.flyTo({ destination: C3.fromDegrees(pos.lon, pos.lat - 0.012, 1400), orientation: { heading: 0, pitch: CM.toRadians(-48), roll: 0 }, duration: 3.2 });
    else if (sel.type === "plane") camera.flyToBoundingSphere(new Cesium.BoundingSphere(C3.fromDegrees(pos.lon, pos.lat, pos.alt), 12000), { offset: new Cesium.HeadingPitchRange(liveHeading(sel), CM.toRadians(-28), 38000), duration: 3.2 });
    else if (sel.type === "sat") camera.flyTo({ destination: C3.fromDegrees(pos.lon, pos.lat, pos.alt + 2.2e6), orientation: { heading: 0, pitch: -CM.PI_OVER_TWO, roll: 0 }, duration: 3 });
    else camera.flyTo({ destination: C3.fromDegrees(pos.lon, pos.lat - 1.2, 260000), orientation: { heading: 0, pitch: CM.toRadians(-55), roll: 0 }, duration: 3 });
  }
  function nearby(sel) {
    const pos = livePos(sel); if (!pos || !state.planes.length) { T.nearby.hidden = true; return; }
    const now = Date.now();
    const list = state.planes.filter((p) => p !== sel.p).map((p) => { const q = planePos(p, now); return { p, d: haversine(pos.lat, pos.lon, q.lat, q.lon) }; }).filter((x) => x.d < 250).sort((a, b) => a.d - b.d).slice(0, 6);
    T.nearby.hidden = !list.length;
    T.nearbyList.innerHTML = list.map((x, i) => `<li>${esc(x.p.cs || x.p.icao.toUpperCase())}<span>${fmtInt(x.d)} km · ${fmtInt(x.p.alt * 3.281)} ft</span><button type="button" data-n="${i}">TRACK</button></li>`).join("");
    T.nearbyList.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => globe.selectPlane(list[+b.dataset.n].p)));
  }
  async function showTarget(sel, fly) {
    const changed = state.selected?.type !== sel.type || livePos(state.selected) !== livePos(sel);
    if (changed) stopFollow(true);
    state.selected = sel;
    panels.forEach((p) => (p.hidden = p !== T.panel)); dock.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    clearInterval(imgTimer); T.fig.hidden = true; T.open.hidden = true; T.follow.hidden = true; T.cockpit.hidden = true;
    hud.mode.textContent = follow ? "FOLLOW" : cockpit ? "COCKPIT" : "TRACK";
    if (sel.type === "cam") {
      const c = sel.cam, src = state.camSources[c.s];
      T.kind.textContent = "CAMERA · LIVE"; T.title.textContent = c.n; T.sub.textContent = `${c.place} · ${src.name}`;
      T.fig.hidden = false; T.cap.textContent = "acquiring frame…";
      const refresh = async () => { const u = await camUrl(c); if (u) { T.img.src = u; T.open.href = u; T.open.hidden = false; T.cap.textContent = `snapshot refreshes every 20 s · ${new Date().toISOString().slice(11, 19)}Z`; } else T.cap.textContent = "frame unavailable right now"; };
      refresh(); imgTimer = setInterval(refresh, 20000);
      T.img.onerror = () => (T.cap.textContent = "frame unavailable right now");
      setMeta([["ID", esc(c.k.toUpperCase())], ["LAT", c.la.toFixed(5)], ["LON", c.lo.toFixed(5)], ["NETWORK", esc(src.name)]]);
      marker.position = C3.fromDegrees(c.lo, c.la, 30);
      log(`CAMERA LOCK · ${c.n.toUpperCase()} · ${c.place.toUpperCase()}`);
    } else if (sel.type === "plane") {
      const p = sel.p, cs = p.cs || "NO CALLSIGN";
      T.kind.textContent = "AIRCRAFT · ADS-B"; T.title.textContent = cs; T.sub.textContent = p.country ? `Registered in ${p.country}` : "Live transponder contact";
      T.follow.hidden = false; T.cockpit.hidden = false;
      setMeta([["ICAO24", p.icao.toUpperCase()], ["ALTITUDE", `${fmtInt(p.alt)} m · ${fmtInt(p.alt * 3.281)} ft`], ["SPEED", `${fmtInt(p.v * 3.6)} km/h · ${fmtInt(p.v * 1.944)} kt`],
        ["HEADING", `${p.hdg}°`], ["V/S", `${p.vr > 0 ? "+" : ""}${p.vr} m/s`], ["POSITION", `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`], ["FEED", `${state.source} · ${state.feed}`]]);
      const q = planePos(p); marker.position = C3.fromDegrees(q.lon, q.lat, q.alt);
      log(`TRACKING ${cs} · FL${pad(Math.round(p.alt * 3.281 / 100), 3)} · ${fmtInt(p.v * 1.944)} KT`);
    } else if (sel.type === "sat") {
      const s = sel.s, geo = satGeo(s) || s.geo || { lon: 0, lat: 0, alt: 0, speed: 0 };
      T.kind.textContent = "SATELLITE · TLE"; T.title.textContent = s.name; T.sub.textContent = `NORAD ${s.norad} · CelesTrak ${s.group} group`;
      T.follow.hidden = false; T.cockpit.hidden = false;
      setMeta([["ALTITUDE", `${fmtInt(geo.alt / 1000)} km`], ["SPEED", `${geo.speed.toFixed(2)} km/s`], ["PERIOD", `${s.period.toFixed(1)} min`], ["INCLINATION", `${CM.toDegrees(s.rec.inclo).toFixed(1)}°`], ["POSITION", `${geo.lat.toFixed(2)}, ${geo.lon.toFixed(2)}`]]);
      marker.position = C3.fromDegrees(geo.lon, geo.lat, geo.alt);
      log(`ORBITAL TRACK · ${s.name} · ${fmtInt(geo.alt / 1000)} KM`);
    } else {
      const q = sel.q;
      T.kind.textContent = "EARTHQUAKE · USGS"; T.title.textContent = `M${q.mag.toFixed(1)}`; T.sub.textContent = q.place || "";
      const ago = Math.round((Date.now() - q.time) / 60000);
      setMeta([["TIME", `${new Date(q.time).toISOString().slice(0, 16).replace("T", " ")}Z`], ["AGO", ago < 60 ? `${ago} min` : `${(ago / 60).toFixed(1)} h`], ["DEPTH", `${q.depth.toFixed(1)} km`], ["POSITION", `${q.lat.toFixed(3)}, ${q.lon.toFixed(3)}`]]);
      marker.position = C3.fromDegrees(q.lon, q.lat, 1000);
      log(`SEISMIC EVENT · M${q.mag.toFixed(1)} · ${(q.place || "").toUpperCase()}`);
    }
    marker.show = true;
    nearby(sel);
    if (fly) flyToSel(sel);
    pauseRotation();
  }
  globe.selectCam = (c, fly = true) => showTarget({ type: "cam", cam: c }, fly);
  globe.selectPlane = (p, fly = true) => showTarget({ type: "plane", p }, fly);
  globe.selectSat = (s, fly = true) => showTarget({ type: "sat", s }, fly);
  globe.selectQuake = (q, fly = true) => showTarget({ type: "quake", q }, fly);
  globe.clearTarget = () => { marker.show = false; state.selected = null; clearInterval(imgTimer); stopFollow(); T.nearby.hidden = true; };
  T.panel.querySelector("[data-close]").addEventListener("click", globe.clearTarget);
  $("target-fly").addEventListener("click", () => state.selected && flyToSel(state.selected));
  $("target-next").addEventListener("click", () => {
    const s = state.selected; if (!s) return;
    if (s.type === "cam") globe.selectCam(rand(state.cams)); else if (s.type === "sat") globe.selectSat(rand(state.sats));
    else if (s.type === "quake") globe.selectQuake(rand(state.quakes)); else trackRandom();
  });
  T.follow.addEventListener("click", () => {
    if (follow) return stopFollow();
    const sel = state.selected; if (!sel) return;
    cockpit = null; scene.screenSpaceCameraController.enableInputs = true;
    const pos = livePos(sel); const range = sel.type === "sat" ? 2.5e6 : 25000;
    camera.lookAt(C3.fromDegrees(pos.lon, pos.lat, pos.alt), new Cesium.HeadingPitchRange(liveHeading(sel), CM.toRadians(-30), range));
    follow = { sel }; T.follow.textContent = "UNFOLLOW"; T.follow.classList.add("on"); T.cockpit.textContent = "COCKPIT"; T.cockpit.classList.remove("on");
    hud.mode.textContent = "FOLLOW"; log(`FOLLOW MODE · ${T.title.textContent.toUpperCase()}`);
  });
  T.cockpit.addEventListener("click", () => {
    if (cockpit) return stopFollow();
    const sel = state.selected; if (!sel) return;
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY); follow = null; T.follow.textContent = "FOLLOW"; T.follow.classList.remove("on");
    cockpit = { sel }; scene.screenSpaceCameraController.enableInputs = false;
    T.cockpit.textContent = "EXIT COCKPIT"; T.cockpit.classList.add("on"); hud.mode.textContent = "COCKPIT"; log(`COCKPIT VIEW · ${T.title.textContent.toUpperCase()}`);
  });
  scene.preRender.addEventListener(() => {
    if (follow) {
      const pos = livePos(follow.sel); if (!pos) return;
      const range = C3.magnitude(camera.position), hpr = new Cesium.HeadingPitchRange(camera.heading, camera.pitch, range);
      camera.lookAtTransform(Cesium.Transforms.eastNorthUpToFixedFrame(C3.fromDegrees(pos.lon, pos.lat, pos.alt)), hpr);
      marker.position = C3.fromDegrees(pos.lon, pos.lat, pos.alt);
    } else if (cockpit) {
      const sel = cockpit.sel, pos = livePos(sel); if (!pos) return;
      const h = liveHeading(sel), isSat = sel.type === "sat";
      camera.setView({ destination: C3.fromDegrees(pos.lon, pos.lat, pos.alt + (isSat ? 0 : 6)), orientation: { heading: h, pitch: CM.toRadians(isSat ? -38 : -9), roll: 0 } });
    } else if (state.selected && (state.selected.type === "plane" || state.selected.type === "sat")) {
      const pos = livePos(state.selected); if (pos) marker.position = C3.fromDegrees(pos.lon, pos.lat, pos.alt);
    }
  });

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((m) => {
    const picked = scene.pick(m.position), id = picked && picked.id;
    if (!id) return;
    if (id.type === "cam") globe.selectCam(id.cam); else if (id.type === "plane") globe.selectPlane(id.p);
    else if (id.type === "sat") globe.selectSat(id.s); else if (id.type === "quake") globe.selectQuake(id.q);
    else if (id.properties?.name) log(`CABLE · ${String(id.name || id.properties.name).toUpperCase()}`);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction((m) => { const p = scene.pick(m.endPosition); scene.canvas.style.cursor = p?.id?.type ? "pointer" : "grab"; }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  /* ---- auto-rotation + HUD ---- */
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let idleAt = 0, rotating = !reduceMotion;
  function pauseRotation() { rotating = false; idleAt = Date.now(); }
  ["pointerdown", "wheel", "touchstart"].forEach((ev) => scene.canvas.addEventListener(ev, pauseRotation, { passive: true }));
  scene.canvas.style.cursor = "grab";
  let lastHud = 0, flyUntil = 0;
  for (const m of ["flyTo", "flyToBoundingSphere"]) { const orig = camera[m].bind(camera); camera[m] = (a, b) => { const o = m === "flyTo" ? a : b; flyUntil = Date.now() + (((o && o.duration) ?? 3) * 1000) + 150; return orig(a, b); }; }
  scene.postRender.addEventListener(() => {
    const now = Date.now();
    // Far from Earth, ease the view back to nadir so the whole planet stays centred while zooming out.
    if (!follow && !cockpit && scene.mode === Cesium.SceneMode.SCENE3D && now > flyUntil) {
      const h = camera.positionCartographic.height;
      if (h > 2.5e6 && camera.pitch > -CM.PI_OVER_TWO + 0.01) {
        const k = Math.min(1, (h - 2.5e6) / 3e6) * 0.12;
        camera.setView({ destination: C3.clone(camera.position), orientation: { heading: camera.heading, pitch: CM.lerp(camera.pitch, -CM.PI_OVER_TWO, k), roll: 0 } });
      }
    }
    const canRotate = scene.mode === Cesium.SceneMode.SCENE3D && !follow && !cockpit && !state.selected;
    if (!rotating && !reduceMotion && canRotate && now - idleAt > 25000 && camera.positionCartographic.height > 3e6) rotating = true;
    if (rotating && canRotate) camera.rotate(C3.UNIT_Z, -0.0006);
    if (now - lastHud > 250) {
      lastHud = now;
      const c = camera.positionCartographic, lat = CM.toDegrees(c.latitude), lon = CM.toDegrees(c.longitude);
      hud.clock.textContent = new Date().toISOString().slice(11, 19) + "Z";
      hud.lat.textContent = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}`;
      hud.lon.textContent = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
      hud.alt.textContent = c.height > 1e5 ? `${fmtInt(c.height / 1000)} KM` : `${fmtInt(c.height)} M`;
    }
  });

  /* ---- views ---- */
  function setViewMode(mode) {
    document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === mode));
    stopFollow(true);
    if (mode === "2d") { scene.morphTo2D(1.0); hud.mode.textContent = "2D MAP"; log("VIEW · FLAT MAP"); return; }
    if (scene.mode !== Cesium.SceneMode.SCENE3D) scene.morphTo3D(1.0);
    const c = camera.positionCartographic, height = c.height;
    const center = scene.pickPosition ? camera.pickEllipsoid(new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2)) : null;
    if (mode === "top") {
      const target = center ? Cesium.Cartographic.fromCartesian(center) : c;
      camera.flyTo({ destination: C3.fromRadians(target.longitude, target.latitude, Math.min(height, 2e7)), orientation: { heading: 0, pitch: -CM.PI_OVER_TWO, roll: 0 }, duration: 1.6 });
      hud.mode.textContent = "TOP DOWN"; log("VIEW · TOP DOWN · NORTH UP");
    } else {
      if (height > 6e6 || !center) { camera.flyTo({ destination: HOME(), orientation: { heading: 0, pitch: -CM.PI_OVER_TWO, roll: 0 }, duration: 1.6 }); }
      else camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, height * 0.4), { offset: new Cesium.HeadingPitchRange(camera.heading, CM.toRadians(-35), height * 1.1), duration: 1.6 });
      hud.mode.textContent = "3D"; log("VIEW · 3D OBLIQUE");
    }
  }
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setViewMode(b.dataset.view)));

  /* ---- actions ---- */
  $("btn-reset").addEventListener("click", () => {
    closePanels(); globe.clearTarget(); setViewMode("3d");
    camera.flyTo({ destination: HOME(), orientation: { heading: 0, pitch: -CM.PI_OVER_TWO, roll: 0 }, duration: 2.2, complete: () => { rotating = !reduceMotion; } });
    log("RESET GLOBE · FULL EARTH");
  });
  $("btn-cam").addEventListener("click", () => state.cams.length && globe.selectCam(rand(state.cams)));
  globe.viewCentre = () => {
    const c = camera.pickEllipsoid(new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2));
    const carto = c ? Cesium.Cartographic.fromCartesian(c) : camera.positionCartographic;
    return { lat: CM.toDegrees(carto.latitude), lon: CM.toDegrees(carto.longitude) };
  };
  // With a Windy key, webcams around the view load by themselves once the camera settles below 3,000 km.
  let windyIdle = null;
  camera.moveEnd.addEventListener(() => {
    if (!windy.enabled) return;
    clearTimeout(windyIdle);
    windyIdle = setTimeout(() => {
      const h = camera.positionCartographic.height; if (h > 3e6) return;
      const { lat, lon } = globe.viewCentre();
      const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
      if (windy.lastKey === key) return; windy.lastKey = key;
      loadWindyNear(lat, lon, h > 8e5 ? 400 : 200);
    }, 900);
  });
  $("btn-windy").addEventListener("click", async () => {
    const { lat, lon } = globe.viewCentre();
    const fresh = await loadWindyNear(lat, lon, camera.positionCartographic.height > 2e6 ? 500 : 250);
    if (fresh.length) { openPanel("cameras"); $("wall-source").value = "windy"; buildWall(); }
  });
  $("wall-random").addEventListener("click", () => state.cams.length && globe.selectCam(rand(state.cams)));
  function trackRandom() { const pool = state.planes.filter((p) => p.cs && p.alt > 2000); if (pool.length) globe.selectPlane(rand(pool)); else log("NO AIRCRAFT IN FEED YET"); }
  globe.trackRandom = trackRandom;
  $("btn-track").addEventListener("click", trackRandom);
  $("board-track").addEventListener("click", trackRandom);
  $("btn-iss").addEventListener("click", () => { const iss = state.sats.find((s) => s.norad === "25544"); if (iss) globe.selectSat(iss); else log("ISS ELEMENTS NOT LOADED YET"); });

  // Search: "lat, lon", a bundled city, or Photon (OpenStreetMap) place search.
  const CITIES = { budapest: [19.04, 47.5], london: [-0.12, 51.5], "new york": [-74.0, 40.71], tokyo: [139.69, 35.69], paris: [2.35, 48.86], dubai: [55.27, 25.2], "hong kong": [114.17, 22.3], sydney: [151.21, -33.87],
    "los angeles": [-118.24, 34.05], singapore: [103.82, 1.35], berlin: [13.4, 52.52], moscow: [37.62, 55.75], istanbul: [28.98, 41.01], tallinn: [24.75, 59.44], helsinki: [24.94, 60.17], oslo: [10.75, 59.91], austin: [-97.74, 30.27], calgary: [-114.07, 51.05], portland: [-122.68, 45.52], kyiv: [30.52, 50.45], beijing: [116.4, 39.9], "sao paulo": [-46.63, -23.55], cairo: [31.24, 30.04], mumbai: [72.88, 19.08] };
  async function search(q) {
    q = q.trim(); if (!q) return;
    let lon, lat, label = q;
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) { lat = +m[1]; lon = +m[2]; label = `${lat.toFixed(3)}, ${lon.toFixed(3)}`; }
    else if (CITIES[q.toLowerCase()]) [lon, lat] = CITIES[q.toLowerCase()];
    else {
      try { const j = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`).then((r) => r.json()); const f = j.features?.[0]; if (f) { [lon, lat] = f.geometry.coordinates; label = [f.properties.name, f.properties.country].filter(Boolean).join(", "); } }
      catch {}
    }
    if (lon == null) return log(`NO FIX · ${q.toUpperCase()}`);
    globe.clearTarget(); closePanels(); stopFollow(true);
    camera.flyTo({ destination: C3.fromDegrees(lon, lat - 0.12, 18000), orientation: { heading: 0, pitch: CM.toRadians(-42), roll: 0 }, duration: 3 });
    log(`FLY TO · ${label.toUpperCase()}`); pauseRotation();
    loadWindyNear(lat, lon, 150);
  }
  $("search-form").addEventListener("submit", (e) => { e.preventDefault(); search($("search").value); $("search").blur(); });

  /* ---- share links ---- */
  function buildHash() {
    const c = camera.positionCartographic;
    const parts = [`c=${CM.toDegrees(c.longitude).toFixed(4)},${CM.toDegrees(c.latitude).toFixed(4)},${Math.round(c.height)},${camera.heading.toFixed(3)},${camera.pitch.toFixed(3)}`];
    parts.push(`l=${Object.entries(layerState).filter(([, v]) => v).map(([k]) => k).join(",")}`);
    const sensor = document.querySelector("[data-sensor].on")?.dataset.sensor; if (sensor && sensor !== "eo") parts.push(`s=${sensor}`);
    const sel = state.selected;
    if (sel?.type === "cam") parts.push(`t=cam:${sel.cam.id}`); if (sel?.type === "plane") parts.push(`t=plane:${sel.p.icao}`);
    if (sel?.type === "sat") parts.push(`t=sat:${sel.s.norad}`); if (sel?.type === "quake") parts.push(`t=quake:${sel.q.id}`);
    return "?" + parts.join("&");
  }
  $("btn-share").addEventListener("click", async () => {
    const url = location.origin + location.pathname + buildHash(); history.replaceState(null, "", url);
    try { await navigator.clipboard.writeText(url); log("SHARE LINK COPIED · CAMERA, LAYERS AND TARGET"); } catch { log("SHARE LINK IN ADDRESS BAR"); }
  });
  const hash = Object.fromEntries((location.search.slice(1) || location.hash.slice(1)).split("&").filter(Boolean).map((kv) => kv.split("=").map(decodeURIComponent)));
  let hashTargetDone = !hash.t;
  globe.hash = hash;
  if (hash.c) { const [lon, lat, h, heading, pitch] = hash.c.split(",").map(Number); if ([lon, lat, h].every(Number.isFinite)) { camera.setView({ destination: C3.fromDegrees(lon, lat, h), orientation: { heading: heading || 0, pitch: Number.isFinite(pitch) ? pitch : -CM.PI_OVER_TWO, roll: 0 } }); pauseRotation(); globe.restored = true; log("SHARED VIEW RESTORED"); } }
  if (hash.l) { const on = new Set(hash.l.split(",")); Object.keys(layerState).forEach((k) => { if (layerState[k] !== on.has(k)) setLayer(k, on.has(k), true); }); }
  if (hash.s && stages[hash.s]) setSensor(hash.s, true);
  function applyHashTarget() {
    if (hashTargetDone) return;
    const [kind, ...rest] = hash.t.split(":"), key = rest.join(":");
    if (kind === "cam") { const c = state.cams.find((x) => x.id === key); if (c) { hashTargetDone = true; globe.selectCam(c, !hash.c); } }
    if (kind === "plane") { const p = state.planes.find((x) => x.icao === key); if (p) { hashTargetDone = true; globe.selectPlane(p, !hash.c); } else if (state.feed !== "INIT") hashTargetDone = true; }
    if (kind === "sat") { const s = state.sats.find((x) => x.norad === key); if (s) { hashTargetDone = true; globe.selectSat(s, !hash.c); } }
    if (kind === "quake") quakesReady.then((qs) => { const q = qs.find((x) => x.id === key); if (q && !hashTargetDone) { hashTargetDone = true; globe.selectQuake(q, !hash.c); } });
  }
})();

/* =========================================================
   CAMERA WALL + CONTACTS BOARD (window content)
   ========================================================= */
let wallTimer = null;
function wallPool() {
  const s = $("wall-source").value, f = $("wall-filter").value.trim().toLowerCase();
  return state.cams.filter((c) => (!s || c.s === s) && (!f || c.n.toLowerCase().includes(f) || c.place.toLowerCase().includes(f)));
}
async function buildWall() {
  const wall = $("wall");
  if (!state.cams.length) { wall.innerHTML = `<p class="panel-sub">Loading camera network…</p>`; camsReady.then(buildWall); return; }
  const pool = wallPool();
  if (!pool.length) { wall.innerHTML = `<p class="panel-sub">No cameras match.</p>`; return; }
  const srcs = [...new Set(pool.map((c) => c.s))];
  const picks = []; const used = new Set();
  for (let i = 0; i < 9 && picks.length < Math.min(9, pool.length); i++) {
    const s = srcs[i % srcs.length], sub = pool.filter((c) => c.s === s && !used.has(c.id));
    const c = sub.length ? rand(sub) : rand(pool.filter((c) => !used.has(c.id))); if (!c) break; used.add(c.id); picks.push(c);
  }
  wall.innerHTML = "";
  for (const c of picks) {
    const t = document.createElement("button"); t.type = "button"; t.className = "tile"; t.title = `${c.n} — ${c.place}`;
    t.innerHTML = `<img alt="" loading="lazy" /><span class="tile-live">LIVE</span><span class="tile-cap">${esc(c.n)} · ${esc(SRC_FLAG[c.s] || c.place)}</span>`;
    const img = t.querySelector("img");
    camUrl(c).then((u) => { if (u) img.src = u; else t.remove(); });
    img.onerror = () => t.remove();
    t.onclick = () => globe.selectCam?.(c);
    wall.appendChild(t);
  }
  clearInterval(wallTimer);
  wallTimer = setInterval(() => {
    if ($("panel-cameras").hidden) return clearInterval(wallTimer);
    wall.querySelectorAll(".tile").forEach((t) => { const img = t.querySelector("img"); if (img.src && /[?&]_=\d+/.test(img.src)) img.src = img.src.replace(/([?&]_=)\d+/, `$1${Date.now()}`); });
  }, 30000);
}
$("wall-shuffle").addEventListener("click", buildWall);
$("wall-source").addEventListener("change", buildWall);
let filterTimer; $("wall-filter").addEventListener("input", () => { clearTimeout(filterTimer); filterTimer = setTimeout(buildWall, 300); });

let boardTab = "planes";
document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.addEventListener("click", () => { boardTab = b.dataset.tab; document.querySelectorAll(".tabs [data-tab]").forEach((x) => x.classList.toggle("on", x === b)); buildBoard(); }));
function buildBoard() {
  const body = $("board"), head = $("board-head"), status = $("flights-status");
  const sample = (arr, n) => { const pool = [...arr]; return Array.from({ length: Math.min(n, pool.length) }, () => pool.splice(Math.floor(Math.random() * pool.length), 1)[0]); };
  if (boardTab === "planes") {
    if (!state.planes.length) { status.textContent = state.feed === "OFFLINE" ? "Aircraft feed offline. Retrying every minute." : "Waiting for aircraft feed…"; body.innerHTML = ""; head.innerHTML = ""; return; }
    status.innerHTML = `<b>${fmtInt(state.planes.length)}</b> aircraft on the globe · ${esc(state.source)} · ${state.feed} · ${new Date(state.feedTime).toISOString().slice(11, 19)}Z`;
    head.innerHTML = `<tr><th>CALLSIGN</th><th>ORIGIN</th><th>ALT</th><th>SPD</th><th></th></tr>`;
    const rows = sample(state.planes.filter((p) => p.cs && p.alt > 1000), 12);
    body.innerHTML = rows.map((p, i) => `<tr><td>${esc(p.cs)}</td><td class="dim">${esc(p.country || "—")}</td><td>${fmtInt(p.alt * 3.281)} ft</td><td>${fmtInt(p.v * 1.944)} kt</td><td><button type="button" data-i="${i}">TRACK</button></td></tr>`).join("");
    body.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => globe.selectPlane?.(rows[+b.dataset.i])));
  } else if (boardTab === "sats") {
    if (!state.sats.length) { status.textContent = "Loading orbital elements…"; body.innerHTML = ""; head.innerHTML = ""; return; }
    status.innerHTML = `<b>${state.sats.length}</b> objects propagated live from CelesTrak elements (stations + brightest).`;
    head.innerHTML = `<tr><th>OBJECT</th><th>ALT</th><th>SPEED</th><th>PERIOD</th><th></th></tr>`;
    const named = state.sats.filter((s) => /ISS|TIANHE|HST/.test(s.name)), rows = [...named, ...sample(state.sats.filter((s) => !named.includes(s)), 10)];
    body.innerHTML = rows.map((s, i) => { const g = s.geo || {}; return `<tr><td class="dim">${esc(s.name)}</td><td>${g.alt ? fmtInt(g.alt / 1000) + " km" : "—"}</td><td>${g.speed ? g.speed.toFixed(1) + " km/s" : "—"}</td><td>${s.period.toFixed(0)} min</td><td><button type="button" data-i="${i}">TRACK</button></td></tr>`; }).join("");
    body.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => globe.selectSat?.(rows[+b.dataset.i])));
  } else {
    if (!state.quakes.length) { status.textContent = "Loading USGS feed…"; body.innerHTML = ""; head.innerHTML = ""; return; }
    status.innerHTML = `<b>${state.quakes.length}</b> earthquakes M2.5+ in the last 24 hours · USGS`;
    head.innerHTML = `<tr><th>MAG</th><th>PLACE</th><th>AGO</th><th></th></tr>`;
    const rows = [...state.quakes].sort((a, b) => b.mag - a.mag).slice(0, 14);
    body.innerHTML = rows.map((q, i) => { const ago = Math.round((Date.now() - q.time) / 60000); return `<tr><td>M${q.mag.toFixed(1)}</td><td class="dim">${esc(q.place)}</td><td>${ago < 60 ? ago + " min" : (ago / 60).toFixed(1) + " h"}</td><td><button type="button" data-i="${i}">VIEW</button></td></tr>`; }).join("");
    body.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => globe.selectQuake?.(rows[+b.dataset.i])));
  }
}
$("board-refresh").addEventListener("click", buildBoard);
