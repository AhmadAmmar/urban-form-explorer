// Fetch OpenStreetMap data for an area from the Overpass API and turn it into projected features for metrics.js.
import { projector, centroid, inBox, poiCategory, isWalkable } from "./metrics.js";

export const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
                          "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];

const bb = ([s, w, n, e]) => `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;

export function query(core, outer) {
  const o = bb(outer), c = bb(core);
  return `[out:json][timeout:90];
(
  way["highway"](${o});
  way["building"](${c});
  relation["building"](${c});
  nwr["amenity"](${o});
  nwr["shop"](${o});
  nwr["leisure"~"^(park|playground|garden|sports_centre|pitch|fitness_station|recreation_ground)$"](${o});
  nwr["healthcare"](${o});
  nwr["tourism"="museum"](${o});
  node["highway"="bus_stop"](${o});
  node["public_transport"~"^(platform|stop_position|station)$"](${o});
  nwr["railway"~"^(station|halt|tram_stop|subway_entrance)$"](${o});
);
out body geom qt;`;
}

export async function fetchOSM(core, outer, onStatus = () => {}) {
  const body = "data=" + encodeURIComponent(query(core, outer));
  let lastErr;
  for (const url of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        onStatus(`asking ${new URL(url).host} for OpenStreetMap data...`);
        const r = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" },
                                     signal: AbortSignal.timeout(60000) });
        if (r.status === 429 || r.status === 504) { lastErr = new Error(`${r.status} busy`); await new Promise((res) => setTimeout(res, 4000 * (attempt + 1))); continue; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) { lastErr = e; }
    }
  }
  throw new Error(`all Overpass servers failed (${lastErr && lastErr.message}); try again in a minute or zoom in`);
}

// Turn the Overpass response into projected ways, buildings and places. core/outer are [s, w, n, e] in degrees.
export function parse(json, core) {
  const lat0 = (core[0] + core[2]) / 2, lon0 = (core[1] + core[3]) / 2;
  const P = projector(lat0, lon0);
  const [cx0, cy0] = P.xy(core[0], core[1]), [cx1, cy1] = P.xy(core[2], core[3]);
  const coreXY = [cx0, cy0, cx1, cy1];
  const walk = [], cycleAll = [], buildings = [], pois = [];
  for (const el of json.elements) {
    const t = el.tags || {};
    if (el.type === "way" && t.highway && el.geometry && el.nodes) {
      const coords = el.geometry.map((g) => P.xy(g.lat, g.lon));
      const way = { tags: t, nodes: el.nodes, coords, ll: el.geometry.map((g) => [g.lon, g.lat]) };
      if (isWalkable(t)) walk.push(way);
      cycleAll.push(way);
    }
    if (t.building && t.building !== "no") {
      const rings = [];
      if (el.type === "way" && el.geometry && el.geometry.length > 3) rings.push(el.geometry);
      if (el.type === "relation" && el.members) {
        for (const m of el.members) if (m.role === "outer" && m.geometry && m.geometry.length > 3) rings.push(m.geometry);
      }
      for (const g of rings) {
        const ring = g.map((p) => P.xy(p.lat, p.lon));
        if (inBox(centroid(ring), coreXY)) buildings.push({ tags: t, ring, ll: g.map((p) => [p.lon, p.lat]) });
      }
    }
    const cat = poiCategory(t);
    if (cat) {
      let lat, lon;
      if (el.type === "node") { lat = el.lat; lon = el.lon; }
      else if (el.bounds) { lat = (el.bounds.minlat + el.bounds.maxlat) / 2; lon = (el.bounds.minlon + el.bounds.maxlon) / 2; }
      if (lat != null && !(t.building && cat === null)) pois.push({ category: cat, tags: t, name: t.name || "", xy: P.xy(lat, lon), ll: [lon, lat] });
    }
  }
  return { P, coreXY, walk, cycleAll, buildings, pois };
}
