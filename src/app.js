import * as M from "./metrics.js";
import { fetchOSM, parse } from "./overpass.js";
import { rose, bars, hist, meter } from "./charts.js";

const MIN_ZOOM = 14.5, MAX_SIDE_M = 2000, MARGIN_M = 800;
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "n/a" : Number(v).toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (v, d = 0) => (v == null ? "n/a" : fmt(100 * v, d) + "%");
let last = null;

// ---------- map ----------
const start = (() => {
  const m = location.hash.match(/#([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/);
  return m ? { zoom: +m[1], center: [+m[3], +m[2]] } : { zoom: 15.5, center: [-5.9301, 54.5973] };
})();
const map = new maplibregl.Map({ container: "map", style: "https://tiles.openfreemap.org/styles/positron", ...start, hash: false, attributionControl: { compact: false } });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

function syncHash() {
  const c = map.getCenter();
  history.replaceState(null, "", `#${map.getZoom().toFixed(2)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`);
  const ok = map.getZoom() >= MIN_ZOOM;
  $("#analyse").disabled = !ok;
  $("#zoom-hint").textContent = ok ? "Analyses the area inside the frame (up to 2 x 2 km)." : `Zoom in further to analyse (now ${map.getZoom().toFixed(1)}, needs ${MIN_ZOOM}).`;
}
map.on("moveend", syncHash);
map.on("load", () => { syncHash(); addLayers(); });

function addLayers() {
  const empty = { type: "FeatureCollection", features: [] };
  for (const id of ["frame", "streets", "buildings", "pois"]) map.addSource(id, { type: "geojson", data: empty });
  map.addLayer({ id: "buildings", type: "fill", source: "buildings", paint: {
    "fill-color": ["case", ["==", ["get", "floors"], null], "#c9c4ba",
      ["step", ["get", "floors"], "#f1e3c6", 2, "#e3bf86", 4, "#c98d4a", 7, "#9a5a2a", 12, "#5c3115"]],
    "fill-opacity": 0.85 } });
  map.addLayer({ id: "streets", type: "line", source: "streets", paint: {
    "line-color": ["step", ["get", "walk_m"], "#1b6e5a", 400, "#3c9a7d", 800, "#88c0a8", 1200, "#c8ddd2", 100000, "#d0d0d0"],
    "line-width": ["case", ["get", "cycle"], 3, 1.6] } });
  map.addLayer({ id: "pois", type: "circle", source: "pois", paint: { "circle-radius": 3.2, "circle-color": "#1f3b73", "circle-stroke-color": "#fff", "circle-stroke-width": 0.8 } });
  map.addLayer({ id: "frame", type: "line", source: "frame", paint: { "line-color": "#222", "line-width": 1.2, "line-dasharray": [3, 2] } });
  map.on("click", "pois", (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setHTML(`<b>${p.name || "(no name)"}</b><br>${p.category}`).addTo(map);
  });
  map.on("click", "buildings", (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat)
      .setHTML(`building=${p.type}<br>footprint ${fmt(p.area)} m&sup2;<br>floors ${p.floors ?? "not tagged"}`).addTo(map);
  });
}

// ---------- place search (Nominatim; one request per search) ----------
$("#search").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const q = $("#q").value.trim();
  if (!q) return;
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
  const [hit] = await r.json();
  if (hit) map.flyTo({ center: [+hit.lon, +hit.lat], zoom: 15.5 });
  else status("No place found by that name.");
});

const status = (s) => { $("#status").textContent = s; };

// ---------- analysis ----------
function frameBox() {
  const b = map.getBounds(), c = map.getCenter();
  const P = M.projector(c.lat, c.lng);
  const [x0, y0] = P.xy(b.getSouth(), b.getWest()), [x1, y1] = P.xy(b.getNorth(), b.getEast());
  const hx = Math.min((x1 - x0) / 2, MAX_SIDE_M / 2) * 0.92, hy = Math.min((y1 - y0) / 2, MAX_SIDE_M / 2) * 0.92;
  const [s, w] = P.ll(-hx, -hy), [n, e] = P.ll(hx, hy);
  const [os, ow] = P.ll(-hx - MARGIN_M, -hy - MARGIN_M), [on, oe] = P.ll(hx + MARGIN_M, hy + MARGIN_M);
  return { core: [s, w, n, e], outer: [os, ow, on, oe], centre: [c.lat, c.lng] };
}

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

$("#analyse").addEventListener("click", async () => {
  const btn = $("#analyse");
  btn.disabled = true;
  try {
    const box = frameBox();
    const json = await fetchOSM(box.core, box.outer, status);
    status("calculating...");
    await new Promise((r) => setTimeout(r, 20));
    last = analyse(json, box);
    render(last);
    status(`Analysed ${new Date().toLocaleTimeString()} from OpenStreetMap data as it is now.`);
  } catch (e) {
    status(e.message);
  } finally {
    btn.disabled = map.getZoom() < MIN_ZOOM;
  }
});

function analyse(json, box) {
  const d = parse(json, box.core);
  const [x0, y0, x1, y1] = d.coreXY, areaM2 = (x1 - x0) * (y1 - y0), areaKm2 = areaM2 / 1e6;
  const graph = M.buildGraph(d.walk);                                   // every walkable way: for routes on foot
  const streets = M.buildGraph(d.cycleAll.filter((w) => M.isStreet(w.tags)));   // streets proper: for network structure
  const net = M.networkStats(streets, d.coreXY, areaKm2, mulberry32(1), graph);
  const bld = M.buildingStats(d.buildings, areaM2);
  const corePois = d.pois.filter((p) => M.inBox(p.xy, d.coreXY));
  const mix = M.mixEntropy(corePois);
  const centreXY = d.P.xy(box.centre[0], box.centre[1]);
  const access = graph.pos.size ? M.accessScores(graph, centreXY, d.pois) : null;
  const walkDist = graph.pos.size ? M.dijkstra(graph, M.nearestNode(graph, centreXY).id, 3000) : new Map();

  // streets inside the frame: lengths by class, cycle infrastructure, speed limits, widths
  const coreWays = d.cycleAll.filter((w) => w.coords.some((p) => M.inBox(p, d.coreXY)));
  // length of a way inside the frame: segments whose midpoint lies in it
  const len = (w) => w.coords.reduce((s, p, i) => {
    if (!i) return 0;
    const q = w.coords[i - 1];
    return M.inBox([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], d.coreXY) ? s + M.dist(q, p) : s;
  }, 0);
  const carry = coreWays.filter((w) => M.isStreet(w.tags) && w.tags.highway !== "pedestrian");   // carriageways
  const L = (ws) => ws.reduce((s, w) => s + len(w), 0);
  const totalCarry = L(carry) || 1;
  const infra = L(carry.filter((w) => M.hasCycleInfra(w.tags))) + L(coreWays.filter((w) => w.tags.highway === "cycleway"));
  const speedTagged = carry.filter((w) => M.parseSpeed(w.tags.maxspeed) != null);
  const lowSpeed = L(speedTagged.filter((w) => M.parseSpeed(w.tags.maxspeed) <= M.LOW_SPEED_KMH));
  const widths = carry.map((w) => ({ ...M.streetWidth(w.tags), cls: w.tags.highway, L: len(w) })).filter((r) => r.width);
  const byClass = {};
  carry.forEach((w) => { byClass[w.tags.highway] = (byClass[w.tags.highway] || 0) + len(w) / 1000; });
  const footLen = L(coreWays.filter((w) => ["footway", "path", "pedestrian", "steps"].includes(w.tags.highway)));
  const cyc = M.cyclabilityIndex(infra / totalCarry, speedTagged.length ? lowSpeed / L(speedTagged) : 0, net.intersection_density_per_km2);
  const walk = M.walkabilityIndex(net, mix, access ? access.access_index : 0);

  const stops = d.pois.filter((p) => p.category === "public transport");
  const near = (p, r) => M.dist(p.xy, centreXY) <= r;
  const stations = stops.filter((p) => ["station", "halt"].includes(p.tags.railway) || p.tags.public_transport === "station");   // not entrances
  // a station is often mapped twice (a node and an area, or railway= and public_transport=); count names once
  const uniq = (ps) => new Set(ps.map((p) => p.name || `${p.ll[0].toFixed(4)},${p.ll[1].toFixed(4)}`)).size;
  const transit = { stops_in_frame_per_km2: stops.filter((p) => M.inBox(p.xy, d.coreXY)).length / areaKm2,
                    stops_within_400m: stops.filter((p) => near(p, 400)).length, stations_within_800m: uniq(stations.filter((p) => near(p, 800))) };
  const poiCounts = {};
  corePois.forEach((p) => { poiCounts[p.category] = (poiCounts[p.category] || 0) + 1; });

  const geo = {
    frame: { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString",
      coordinates: [[box.core[1], box.core[0]], [box.core[3], box.core[0]], [box.core[3], box.core[2]], [box.core[1], box.core[2]], [box.core[1], box.core[0]]] } }] },
    buildings: { type: "FeatureCollection", features: d.buildings.map((b) => ({ type: "Feature",
      properties: { type: b.tags.building, floors: M.buildingFloors(b.tags).floors, area: Math.round(M.polygonArea(b.ring)) },
      geometry: { type: "Polygon", coordinates: [b.ll] } })) },
    streets: { type: "FeatureCollection", features: d.walk.map((w) => ({ type: "Feature",
      properties: { highway: w.tags.highway, cycle: M.hasCycleInfra(w.tags),
        walk_m: Math.round(Math.min(...w.nodes.map((id) => walkDist.get(id) ?? 1e5))) },
      geometry: { type: "LineString", coordinates: w.ll } })) },
    pois: { type: "FeatureCollection", features: d.pois.map((p) => ({ type: "Feature", properties: { category: p.category, name: p.name },
      geometry: { type: "Point", coordinates: p.ll } })) },
  };
  return { box, areaKm2, net, bld, mix, access, walk, cyc, transit, poiCounts, byClass, widths,
           infraShare: infra / totalCarry, speedCoverage: speedTagged.length / Math.max(1, carry.length), footKm: footLen / 1000,
           type: M.neighbourhoodType(net, bld, mix), geo,
           // OSM buildings are often mapped later than streets; little footprint among a dense street grid suggests gaps
           sparseBuildings: bld.gsi < 0.12 && net.intersection_density_per_km2 > 80, counts: { ways: d.walk.length, buildings: d.buildings.length, pois: d.pois.length } };
}

// ---------- report ----------
function row(label, value, note = "", anchor = "") {
  return `<tr><th>${anchor ? `<a href="methods.html#${anchor}">${label}</a>` : label}</th><td>${value}</td><td class="note">${note}</td></tr>`;
}

function render(r) {
  for (const k of Object.keys(r.geo)) map.getSource(k).setData(r.geo[k]);
  const n = r.net, b = r.bld;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const widthMed = med(r.widths.map((w) => w.width));
  $("#report").innerHTML = `
  <section>
    <p class="kicker">${fmt(r.areaKm2, 2)} km&sup2; analysed &middot; centre ${r.box.centre[0].toFixed(4)}, ${r.box.centre[1].toFixed(4)}</p>
    <h2>${r.type[0].toUpperCase() + r.type.slice(1)}</h2>
    ${r.sparseBuildings ? `<p class="warn">Buildings look incompletely mapped here: little ground is covered by buildings although the
    streets are dense. Building figures, and the form in the heading, may understate how built-up the area is.
    <a href="https://www.openstreetmap.org/#map=17/${r.box.centre[0]}/${r.box.centre[1]}">Check or add buildings in OpenStreetMap</a>.</p>` : ""}
    <p class="lede">A reading of the area from its streets, buildings and places as mapped in OpenStreetMap. Every figure links to how
    it is calculated; read the coverage notes before comparing places, since mapping completeness varies.</p>
    <table class="scores">
      ${row("Walkability", `${fmt(r.walk.index)} ${meter(r.walk.index)}`, Object.entries(r.walk.parts).map(([k, v]) => `${k} ${fmt(100 * v)}`).join(" &middot; "), "walkability")}
      ${row("Everyday needs on foot", r.access ? `${fmt(r.access.access_index)} ${meter(r.access.access_index)}` : "n/a", r.access ? `${r.access.fifteen_minute_categories} of ${r.access.categories} kinds of place within a 15-minute walk of the centre` : "", "access")}
      ${row("Cyclability", `${fmt(r.cyc.index)} ${meter(r.cyc.index)}`, Object.entries(r.cyc.parts).map(([k, v]) => `${k} ${fmt(100 * v)}`).join(" &middot; "), "cyclability")}
      ${row("Public transport", `${r.transit.stops_within_400m} stops within 400 m`, `${r.transit.stations_within_800m} rail or metro stations within 800 m; ${fmt(r.transit.stops_in_frame_per_km2, 1)} stops per km&sup2;`, "transit")}
    </table>
  </section>
  <section>
    <h3>Streets</h3>
    <div class="two">
      <table>
        ${row("Street length", `${fmt(n.street_length_km, 1)} km`, `${fmt(n.street_density_km_per_km2, 1)} km per km&sup2;`, "street-density")}
        ${row("Intersections", fmt(n.intersections), `${fmt(n.intersection_density_per_km2)} per km&sup2;`, "intersection-density")}
        ${row("Streets per node", fmt(n.streets_per_node, 2), `dead ends ${pct(n.dead_end_share)} for vehicles, ${pct(n.dead_end_share_on_foot)} on foot`, "streets-per-node")}
        ${row("Block edge length", `${fmt(n.mean_segment_length_m)} m`, "mean length between junctions", "segment-length")}
        ${row("Circuity", fmt(n.edge_circuity, 3), `route directness ${fmt(n.route_directness_median, 2)} (median of ${n.route_pairs} trips)`, "circuity")}
        ${row("Meshedness", fmt(n.meshedness, 2), "0 tree-like, 1 fully meshed", "meshedness")}
        ${row("Orientation order", fmt(n.orientation.order, 2), `entropy ${fmt(n.orientation.entropy, 2)}; 0 disordered, 1 a perfect grid`, "orientation")}
        ${row("Street width", widthMed ? `${fmt(widthMed, 1)} m median` : "not tagged", `${r.widths.length} street ways carry a width or lanes tag`, "width")}
        ${row("Paths and footways", `${fmt(r.footKm, 1)} km`, "separate from carriageways", "")}
      </table>
      <figure>${rose(n.orientation.bins)}<figcaption>Street bearings, weighted by length</figcaption></figure>
    </div>
    <figure>${bars(Object.fromEntries(Object.entries(r.byClass).sort((a, b) => b[1] - a[1]).slice(0, 8)), { fmt: (v) => fmt(v, 1) + " km" })}<figcaption>Street length by type (OSM highway=*)</figcaption></figure>
  </section>
  <section>
    <h3>Buildings</h3>
    <table>
      ${row("Buildings", fmt(b.buildings), `${fmt(b.building_density_per_ha, 1)} per hectare`, "buildings")}
      ${row("Ground coverage (GSI)", fmt(b.gsi, 2), `${fmt(b.footprint_ha, 1)} ha of footprint`, "spacematrix")}
      ${row("Floor area ratio (FSI)", fmt(b.fsi, 2), b.fsi_method, "spacematrix")}
      ${row("Mean floors (L)", fmt(b.mean_floors_L, 1), `open space ratio ${fmt(b.open_space_ratio_OSR, 2)}`, "spacematrix")}
      ${row("Footprint", `${fmt(b.median_footprint_m2)} m&sup2; median`, `mean ${fmt(b.mean_footprint_m2)} m&sup2;`, "footprint")}
      ${row("Heights in OSM", pct(b.floors_tagged_share), `of buildings tag floors or height; median ${fmt(b.median_floors_tagged)} floors, ${fmt(b.median_height_tagged_m)} m`, "heights")}
      ${row("Form", M.spacematrixLabel(b.gsi, b.mean_floors_L), "Spacematrix position, simplified", "spacematrix")}
    </table>
    <div class="two">
      <figure>${hist(b.floors_list, [1, 2, 3, 4, 6, 8, 12, 20, 40, 200], { label: "floors (tagged)" })}<figcaption>Floors, where tagged</figcaption></figure>
      <figure>${hist(b.areas_list, [0, 50, 100, 200, 400, 800, 1600, 5000, 1e7], { label: "m&sup2;" })}<figcaption>Footprint sizes</figcaption></figure>
    </div>
    <figure>${bars(Object.fromEntries(Object.entries(b.types).sort((a, c) => c[1] - a[1]).slice(0, 8)))}<figcaption>Building types (OSM building=*); "yes" means not specified</figcaption></figure>
  </section>
  <section>
    <h3>Places and uses</h3>
    <table>
      ${row("Mix of uses", fmt(r.mix, 2), "0 one kind of place only, 1 all kinds equally", "mix")}
      ${r.access ? Object.entries(r.access.by_category).map(([k, v]) => row(k, v.distance_m == null ? "none within 2.5 km" : `${fmt(v.distance_m)} m walk`, `score ${fmt(100 * v.score)}`, "access")).join("") : ""}
    </table>
    <figure>${bars(r.poiCounts)}<figcaption>Places in the frame by kind</figcaption></figure>
  </section>
  <section class="small">
    <h3>Coverage and limits</h3>
    <p>${r.counts.ways} street ways, ${r.counts.buildings} buildings and ${r.counts.pois} places read. Speed limits are tagged on ${pct(r.speedCoverage)} of streets;
    building heights or floors on ${pct(b.floors_tagged_share)} of buildings. OpenStreetMap has no population counts; for those use a census or gridded
    population such as GHSL or WorldPop (see the <a href="https://ahmadammar.github.io/teaching/urban-form/">guide</a>). Indices are indicative and their
    components are shown beside them.</p>
  </section>`;
  $("#downloads").hidden = false;
}

// ---------- downloads ----------
function save(name, text, type) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("#dl-json").addEventListener("click", () => {
  if (!last) return;
  const { geo, ...rest } = last;
  const clean = JSON.parse(JSON.stringify(rest, (k, v) => (k.endsWith("_list") ? undefined : v)));
  save("urban-form.json", JSON.stringify({ source: "OpenStreetMap contributors, ODbL", made: new Date().toISOString(), ...clean }, null, 2), "application/json");
});
$("#dl-geojson").addEventListener("click", () => {
  if (!last) return;
  save("urban-form-data.geojson", JSON.stringify({ type: "FeatureCollection", features: [...last.geo.buildings.features, ...last.geo.streets.features, ...last.geo.pois.features] }), "application/geo+json");
});
