// Urban form measures from OpenStreetMap data. Pure functions: no browser or network code, so they can be tested in Node.
// Every measure, its formula and its assumptions are described in methods.html.

export const R_EARTH = 6371008.8;
export const FLOOR_HEIGHT_M = 3.0;   // assumed storey height when only building:levels is tagged, and to turn heights into floors
export const LANE_WIDTH_M = 3.0;     // assumed lane width when only lanes is tagged

// ---------- geometry ----------

// Local projection: metres east and north of an origin. Equirectangular; error under 0.1% over a few kilometres.
export function projector(lat0, lon0) {
  const k = Math.cos((lat0 * Math.PI) / 180);
  return {
    xy: (lat, lon) => [((lon - lon0) * Math.PI / 180) * R_EARTH * k, ((lat - lat0) * Math.PI / 180) * R_EARTH],
    ll: (x, y) => [lat0 + (y / R_EARTH) * 180 / Math.PI, lon0 + (x / (R_EARTH * k)) * 180 / Math.PI],
  };
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polygonArea(ring) {           // shoelace formula, absolute value, ring as [[x, y], ...]
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) return ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
  return [cx / (3 * a), cy / (3 * a)];
}

export const inBox = (p, box) => p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];

// Compass bearing of a segment, degrees clockwise from north, 0-360.
export const bearing = (a, b) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;

// ---------- tags ----------

export function parseLength(v) {               // "12", "12 m", "12.5m", "40'" or "40 ft" -> metres
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(",", ".");
  const ft = s.match(/^([\d.]+)\s*(ft|')/);
  if (ft) return parseFloat(ft[1]) * 0.3048;
  const m = s.match(/^([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

export function parseSpeed(v) {                // "30", "30 mph", "RU:urban" -> km/h or null
  if (v == null) return null;
  const s = String(v).toLowerCase();
  const n = s.match(/^([\d.]+)/);
  if (!n) return null;
  return s.includes("mph") ? parseFloat(n[1]) * 1.609 : parseFloat(n[1]);
}

const NOT_WALKABLE = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "construction", "proposed", "raceway", "bus_guideway", "abandoned", "platform"]);
export function isWalkable(t) {
  if (!t.highway || NOT_WALKABLE.has(t.highway)) {
    return Boolean(t.highway && (t.sidewalk && t.sidewalk !== "no" && t.sidewalk !== "none")) && !["construction", "proposed"].includes(t.highway);
  }
  if (t.foot === "no" || t.access === "private" || t.access === "no") return t.foot === "yes" || t.foot === "designated";
  if (t.area === "yes") return false;
  return true;
}

// Streets proper (carriageways and pedestrian streets) for measures of network structure. Separately mapped pavements,
// crossings, paths, steps, cycleways and service roads (driveways, parking aisles, yards) would otherwise multiply
// intersections wherever mappers have drawn them, and make places look more or less connected by mapping style alone.
const STREETS = new Set(["trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
  "residential", "unclassified", "living_street", "pedestrian", "road", "busway"]);
export const isStreet = (t) => STREETS.has(t.highway) && t.area !== "yes";
export const LOW_SPEED_KMH = 32.5;   // 30 km/h, or 20 mph (32.2 km/h)

export function hasCycleInfra(t) {
  if (t.highway === "cycleway") return true;
  if (t.bicycle === "designated") return true;
  const keys = ["cycleway", "cycleway:left", "cycleway:right", "cycleway:both"];
  // "separate" means the track is mapped as its own way (counted there, not twice); "share_busway" is a bus lane, not cycle infrastructure
  return keys.some((k) => t[k] && ["lane", "track", "opposite_lane", "opposite_track"].includes(t[k]));
}

export function streetWidth(t) {
  const w = parseLength(t.width);
  if (w && w > 0.5 && w < 80) return { width: w, source: "width tag" };
  const lanes = parseFloat(t.lanes);
  if (lanes > 0 && lanes < 20) return { width: lanes * LANE_WIDTH_M, source: "lanes x 3 m" };
  return { width: null, source: null };
}

export function buildingFloors(t) {
  const lv = parseFloat(t["building:levels"]);
  if (lv > 0 && lv < 200) return { floors: lv, height: parseLength(t.height) || lv * FLOOR_HEIGHT_M, source: "levels" };
  const h = parseLength(t.height);
  if (h && h > 1 && h < 900) return { floors: Math.max(1, Math.round(h / FLOOR_HEIGHT_M)), height: h, source: "height" };
  return { floors: null, height: null, source: null };
}

export const POI_CATEGORIES = {
  groceries: (t) => ["supermarket", "convenience", "greengrocer", "bakery", "butcher", "grocery", "deli", "general"].includes(t.shop) || t.amenity === "marketplace",
  "eating and drinking": (t) => ["restaurant", "cafe", "fast_food", "pub", "bar", "food_court", "ice_cream"].includes(t.amenity),
  education: (t) => ["school", "kindergarten", "college", "university", "library", "childcare"].includes(t.amenity),
  health: (t) => ["pharmacy", "clinic", "doctors", "hospital", "dentist"].includes(t.amenity) || t.healthcare != null,
  "parks and play": (t) => ["park", "playground", "garden", "sports_centre", "pitch", "fitness_station", "recreation_ground"].includes(t.leisure),
  "other shops": (t) => t.shop != null && !POI_CATEGORIES.groceries(t),
  "services and civic": (t) => ["post_office", "bank", "atm", "townhall", "community_centre", "place_of_worship", "police", "fire_station", "social_facility"].includes(t.amenity),
  culture: (t) => ["theatre", "cinema", "arts_centre", "museum"].includes(t.amenity) || t.tourism === "museum",
  "public transport": (t) => t.highway === "bus_stop" || ["platform", "stop_position", "station"].includes(t.public_transport) ||
    ["station", "halt", "tram_stop", "subway_entrance"].includes(t.railway),
};
export const EVERYDAY = ["groceries", "eating and drinking", "education", "health", "parks and play", "other shops", "services and civic", "public transport"];

export function poiCategory(t) {
  for (const [name, test] of Object.entries(POI_CATEGORIES)) if (test(t)) return name;
  return null;
}

// ---------- street network ----------

// Build a topological graph from OSM ways: a node is kept where a way ends, where ways meet, or where a way revisits a
// node; the vertices between are folded into the edge's geometry (as osmnx's simplification does).
// ways: [{tags, nodes: [id...], coords: [[x, y]...]}]
export function buildGraph(ways) {
  const uses = new Map();
  for (const w of ways) {
    w.nodes.forEach((id, i) => {
      const u = uses.get(id) || { n: 0, end: false };
      u.n += 1;
      if (i === 0 || i === w.nodes.length - 1) u.end = true;
      uses.set(id, u);
    });
  }
  const isNode = (id) => { const u = uses.get(id); return u.end || u.n > 1; };
  const pos = new Map(), edges = [];
  for (const w of ways) {
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (!isNode(w.nodes[i]) && i < w.nodes.length - 1) continue;
      const geom = w.coords.slice(start, i + 1);
      let len = 0;
      for (let k = 1; k < geom.length; k++) len += dist(geom[k - 1], geom[k]);
      const u = w.nodes[start], v = w.nodes[i];
      pos.set(u, w.coords[start]); pos.set(v, w.coords[i]);
      if (len > 0) edges.push({ u, v, length: len, geom, tags: w.tags });
      start = i;
    }
  }
  const adj = new Map();
  for (const [k, e] of edges.entries()) {
    for (const [a, b] of [[e.u, e.v], [e.v, e.u]]) {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push({ to: b, w: e.length, edge: k });
    }
  }
  return { pos, edges, adj, degree: (id) => (adj.get(id) || []).length };
}

export function dijkstra(graph, source, maxDist = Infinity) {
  const d = new Map([[source, 0]]);
  const heap = [[0, source]];
  const push = (item) => { heap.push(item); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [du, u] = pop();
    if (du > (d.get(u) ?? Infinity) || du > maxDist) continue;
    for (const { to, w } of graph.adj.get(u) || []) {
      const nd = du + w;
      if (nd < (d.get(to) ?? Infinity)) { d.set(to, nd); push([nd, to]); }
    }
  }
  return d;
}

export function nearestNode(graph, p, candidates = null) {
  let best = null, bd = Infinity;
  for (const id of candidates || graph.pos.keys()) {
    const q = graph.pos.get(id);
    const dd = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (dd < bd) { bd = dd; best = id; }
  }
  return { id: best, dist: Math.sqrt(bd) };
}

// Orientation order (Boeing 2019): entropy of street bearings in 36 bins of 10 degrees, each segment counted in both
// directions and weighted by length; phi = 1 - ((H - H_grid) / (H_max - H_grid))^2, from 0 (no order) to 1 (perfect grid).
export function orientation(edges) {
  const bins = new Array(36).fill(0);
  for (const e of edges) {
    for (let k = 1; k < e.geom.length; k++) {
      const L = dist(e.geom[k - 1], e.geom[k]);
      if (L <= 0) continue;
      const b = bearing(e.geom[k - 1], e.geom[k]);
      for (const bb of [b, (b + 180) % 360]) bins[Math.floor(((bb + 5) % 360) / 10)] += L;
    }
  }
  const tot = bins.reduce((a, b) => a + b, 0);
  if (!tot) return { bins, entropy: null, order: null };
  const H = -bins.reduce((s, v) => (v > 0 ? s + (v / tot) * Math.log(v / tot) : s), 0);
  const Hmax = Math.log(36), Hg = Math.log(4);
  return { bins: bins.map((v) => v / tot), entropy: H, order: 1 - ((H - Hg) / (Hmax - Hg)) ** 2 };
}

export function networkStats(graph, core, areaKm2, rng = Math.random, walkGraph = null) {
  const inCore = (id) => inBox(graph.pos.get(id), core);
  const nodes = [...graph.pos.keys()].filter((id) => inCore(id) && graph.degree(id) !== 2);
  const coreEdges = graph.edges.filter((e) => { const m = e.geom[Math.floor(e.geom.length / 2)]; return inBox(m, core); });
  const deg = nodes.map((id) => graph.degree(id));
  const inter = deg.filter((d) => d >= 3).length, dead = deg.filter((d) => d === 1).length;
  // a street that ends but carries on as a path, crossing or square is a dead end for vehicles only
  const deadAll = walkGraph ? nodes.filter((id) => graph.degree(id) === 1 && walkGraph.degree(id) <= 1).length : null;
  const lengthKm = coreEdges.reduce((s, e) => s + e.length, 0) / 1000;
  const straight = coreEdges.reduce((s, e) => s + dist(e.geom[0], e.geom[e.geom.length - 1]), 0);
  const v = nodes.length, eCount = coreEdges.length;
  // route directness: network distance / straight-line distance between random pairs of intersections 300-1500 m apart
  const inters = nodes.filter((id) => graph.degree(id) >= 3);
  const ratios = [];
  for (let t = 0; t < 60 && inters.length > 2; t++) {
    const s = inters[Math.floor(rng() * inters.length)];
    const dmap = dijkstra(graph, s, 4000);
    for (let j = 0; j < 8; j++) {
      const g = inters[Math.floor(rng() * inters.length)];
      const eu = dist(graph.pos.get(s), graph.pos.get(g));
      if (eu < 300 || eu > 1500 || !dmap.has(g)) continue;
      ratios.push(dmap.get(g) / eu);
    }
  }
  ratios.sort((a, b) => a - b);
  const degHist = {};
  deg.forEach((d) => { const k = d >= 5 ? "5+" : String(d); degHist[k] = (degHist[k] || 0) + 1; });
  return {
    street_length_km: lengthKm,
    street_density_km_per_km2: lengthKm / areaKm2,
    intersections: inter,
    intersection_density_per_km2: inter / areaKm2,
    dead_end_share: v ? dead / v : null,
    dead_end_share_on_foot: v && deadAll != null ? deadAll / v : null,
    streets_per_node: v ? deg.reduce((a, b) => a + b, 0) / v : null,
    mean_segment_length_m: eCount ? (lengthKm * 1000) / eCount : null,
    edge_circuity: straight ? (lengthKm * 1000) / straight : null,
    route_directness_median: ratios.length ? ratios[Math.floor(ratios.length / 2)] : null,
    route_pairs: ratios.length,
    meshedness: v > 2 ? Math.max(0, (eCount - v + 1) / (2 * v - 5)) : null,
    degree_histogram: degHist,
    orientation: orientation(coreEdges),
  };
}

// ---------- buildings ----------

export function buildingStats(buildings, areaM2) {
  // buildings: [{tags, ring: [[x, y]...]}] already limited to the core (centroid inside)
  const rows = buildings.map((b) => ({ area: polygonArea(b.ring), type: b.tags.building || "yes", ...buildingFloors(b.tags) }))
    .filter((r) => r.area > 2);
  const foot = rows.reduce((s, r) => s + r.area, 0);
  const known = rows.filter((r) => r.floors != null);
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const knownShare = rows.length ? known.length / rows.length : 0;
  const knownAreaShare = foot ? known.reduce((s, r) => s + r.area, 0) / foot : 0;
  const medFloors = median(known.map((r) => r.floors));
  // floor area: tagged floors where known; others take the median of tagged buildings in view, only if at least 20% are tagged
  let fsi = null, fsiMethod = "not estimated: fewer than 20% of buildings have heights or floors in OpenStreetMap";
  if (knownShare >= 0.2 && medFloors) {
    const floorArea = rows.reduce((s, r) => s + r.area * (r.floors ?? medFloors), 0);
    fsi = floorArea / areaM2;
    fsiMethod = `tagged floors for ${(100 * knownShare).toFixed(0)}% of buildings; the rest assumed ${medFloors} (the median of tagged ones)`;
  }
  const gsi = foot / areaM2;
  const types = {};
  rows.forEach((r) => { types[r.type] = (types[r.type] || 0) + 1; });
  return {
    buildings: rows.length,
    building_density_per_ha: rows.length / (areaM2 / 1e4),
    footprint_ha: foot / 1e4,
    gsi,
    mean_footprint_m2: rows.length ? foot / rows.length : null,
    median_footprint_m2: median(rows.map((r) => r.area)),
    floors_tagged_share: knownShare,
    floors_tagged_area_share: knownAreaShare,
    median_floors_tagged: medFloors,
    median_height_tagged_m: median(known.map((r) => r.height)),
    fsi, fsi_method: fsiMethod,
    mean_floors_L: fsi && gsi ? fsi / gsi : null,
    open_space_ratio_OSR: fsi ? (1 - gsi) / fsi : null,
    types,
    floors_list: known.map((r) => r.floors),
    areas_list: rows.map((r) => r.area),
  };
}

// Spacematrix position (Berghauser Pont and Haupt 2010), simplified to a readable label. Thresholds on methods.html.
export function spacematrixLabel(gsi, L) {
  if (gsi == null) return "unknown";
  const height = L == null ? "" : L < 3 ? "low-rise" : L < 6 ? "mid-rise" : "high-rise";
  const cover = gsi < 0.15 ? "spacious" : gsi < 0.35 ? "compact" : "very compact";
  return [cover, height].filter(Boolean).join(" ");
}

// ---------- access to everyday needs ----------

// Network distance from the view centre to the nearest place in each category. Score per category: 1 within 400 m,
// falling linearly to 0 at 1,600 m (a 5- and 20-minute walk at 4.8 km/h). Index = mean score x 100.
export function accessScores(graph, centreXY, pois) {
  const start = nearestNode(graph, centreXY);
  const d = dijkstra(graph, start.id, 2500);
  const reached = [...d.keys()];
  const out = {};
  for (const cat of EVERYDAY) {
    let best = Infinity;
    for (const p of pois.filter((q) => q.category === cat)) {
      const n = nearestNode(graph, p.xy, reached);
      if (n.id == null) continue;
      const total = start.dist + (d.get(n.id) ?? Infinity) + n.dist;
      if (total < best) best = total;
    }
    const score = best <= 400 ? 1 : best >= 1600 ? 0 : 1 - (best - 400) / 1200;
    out[cat] = { distance_m: Number.isFinite(best) ? best : null, score };
  }
  const scores = Object.values(out).map((v) => v.score);
  const within15 = Object.values(out).filter((v) => v.distance_m != null && v.distance_m <= 1200).length;
  return { by_category: out, access_index: (100 * scores.reduce((a, b) => a + b, 0)) / scores.length,
           fifteen_minute_categories: within15, categories: EVERYDAY.length };
}

export function mixEntropy(pois) {
  const c = {};
  pois.forEach((p) => { if (p.category && p.category !== "public transport") c[p.category] = (c[p.category] || 0) + 1; });
  const n = Object.values(c).reduce((a, b) => a + b, 0), k = Object.keys(POI_CATEGORIES).length - 1;
  if (!n) return 0;
  const H = -Object.values(c).reduce((s, v) => s + (v / n) * Math.log(v / n), 0);
  return H / Math.log(k);
}

// ---------- composite indices (indicative; components always shown beside them) ----------

const clip01 = (x) => Math.max(0, Math.min(1, x));
export function walkabilityIndex({ intersection_density_per_km2 }, mix, access) {
  const parts = { connectivity: clip01(intersection_density_per_km2 / 150), "land-use mix": clip01(mix), "access to everyday needs": access / 100 };
  return { index: (100 * Object.values(parts).reduce((a, b) => a + b, 0)) / 3, parts };
}

export function cyclabilityIndex(infraShare, lowSpeedShare, interDensity) {
  const parts = { "cycle infrastructure": clip01(infraShare / 0.3), "low speed streets": clip01(lowSpeedShare), connectivity: clip01(interDensity / 150) };
  return { index: 100 * (0.5 * parts["cycle infrastructure"] + 0.3 * parts["low speed streets"] + 0.2 * parts.connectivity), parts };
}

export function neighbourhoodType(net, bld, mix) {
  const words = [];
  const o = net.orientation.order;
  if (o != null) words.push(o > 0.5 ? "grid-like streets" : o > 0.2 ? "semi-regular streets" : "irregular (organic) streets");
  if ((net.dead_end_share_on_foot ?? net.dead_end_share) > 0.25) words.push("many cul-de-sacs");
  else if (net.intersection_density_per_km2 > 120) words.push("finely connected");
  words.push(spacematrixLabel(bld.gsi, bld.mean_floors_L) + " buildings");
  words.push(mix > 0.6 ? "mixed uses" : mix > 0.3 ? "some mixed uses" : "mostly single use");
  return words.join(", ");
}
