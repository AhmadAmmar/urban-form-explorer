// Known-answer tests for src/metrics.js. Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/metrics.js";

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// a grid of n x n streets spaced s metres apart, as OSM-like ways with shared node ids
function grid(n, s) {
  const id = (i, j) => i * 1000 + j, ways = [];
  for (let i = 0; i < n; i++) {
    ways.push({ tags: { highway: "residential" }, nodes: [...Array(n).keys()].map((j) => id(i, j)), coords: [...Array(n).keys()].map((j) => [j * s, i * s]) });
    ways.push({ tags: { highway: "residential" }, nodes: [...Array(n).keys()].map((j) => id(j, i)), coords: [...Array(n).keys()].map((j) => [i * s, j * s]) });
  }
  return ways;
}

test("polygon area and centroid", () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(M.polygonArea(sq), 100);
  assert.deepEqual(M.centroid(sq), [5, 5]);
});

test("projection round trip and scale", () => {
  const p = M.projector(54.6, -5.9);
  const [x, y] = p.xy(54.6 + 0.01, -5.9 + 0.01);
  close(y, 1111.95, 0.5, "0.01 deg latitude");
  close(x, 1111.95 * Math.cos(54.6 * Math.PI / 180), 0.5, "0.01 deg longitude");
  const [la, lo] = p.ll(x, y);
  close(la, 54.61, 1e-9, "lat back"); close(lo, -5.89, 1e-9, "lon back");
});

test("tag parsing", () => {
  assert.equal(M.parseLength("12 m"), 12);
  close(M.parseLength("40'"), 12.192, 1e-9, "feet");
  close(M.parseSpeed("20 mph"), 32.18, 0.01, "mph");
  assert.deepEqual(M.buildingFloors({ "building:levels": "4" }), { floors: 4, height: 12, source: "levels" });
  assert.equal(M.buildingFloors({ height: "31" }).floors, 10);
  assert.equal(M.streetWidth({ lanes: "2" }).width, 6);
  assert.equal(M.isWalkable({ highway: "motorway" }), false);
  assert.equal(M.isWalkable({ highway: "residential" }), true);
  assert.equal(M.poiCategory({ shop: "supermarket" }), "groceries");
  assert.equal(M.poiCategory({ shop: "books" }), "other shops");
});

test("a perfect grid: orientation order 1, degrees and directness", () => {
  const g = M.buildGraph(grid(6, 100));
  assert.equal(g.pos.size, 36);
  const s = M.networkStats(g, [-1, -1, 501, 501], 0.25, () => 0.5);
  close(s.orientation.order, 1, 1e-9, "grid order");
  assert.equal(s.intersections, 32);                 // 16 interior 4-way + 16 edge 3-way
  assert.equal(s.dead_end_share, 0);                 // the 4 corners have degree 2 and are not counted as nodes
  close(s.street_length_km, 6, 1e-9, "12 streets of 500 m");
  close(s.edge_circuity, 1, 1e-9, "straight edges");
});

test("orientation of a circle is close to disorder", () => {
  const pts = [...Array(361).keys()].map((a) => [100 * Math.sin(a * Math.PI / 180), 100 * Math.cos(a * Math.PI / 180)]);
  const o = M.orientation([{ geom: pts }]);
  close(o.order, 0, 0.01, "circle order");
});

test("dijkstra on a grid equals Manhattan distance", () => {
  const g = M.buildGraph(grid(4, 100));
  const d = M.dijkstra(g, 0);
  assert.equal(d.get(3 * 1000 + 3), 600);
});

test("access score decay", () => {
  const g = M.buildGraph(grid(21, 100));             // 2 km square of streets
  const pois = [{ category: "groceries", xy: [300, 0] }, { category: "health", xy: [1000, 0] }];
  const a = M.accessScores(g, [0, 0], pois);
  assert.equal(a.by_category.groceries.score, 1);    // 300 m
  close(a.by_category.health.score, 0.5, 1e-9, "1000 m -> halfway between 400 and 1600");
  assert.equal(a.by_category.education.score, 0);    // none at all
});

test("building measures: GSI, FSI, L and OSR", () => {
  const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const b = [{ tags: { building: "house", "building:levels": "2" }, ring: sq(0, 0, 10) },
             { tags: { building: "apartments", "building:levels": "4" }, ring: sq(20, 0, 10) }];
  const s = M.buildingStats(b, 1000);
  close(s.gsi, 0.2, 1e-12, "GSI"); close(s.fsi, 0.6, 1e-12, "FSI"); close(s.mean_floors_L, 3, 1e-12, "L");
  close(s.open_space_ratio_OSR, (1 - 0.2) / 0.6, 1e-12, "OSR");
  assert.equal(M.spacematrixLabel(0.2, 3), "compact mid-rise");
});

test("streets proper and low speed limits", () => {
  assert.equal(M.isStreet({ highway: "residential" }), true);
  assert.equal(M.isStreet({ highway: "footway", footway: "sidewalk" }), false);
  assert.equal(M.isStreet({ highway: "service" }), false);
  assert.ok(M.parseSpeed("20 mph") <= M.LOW_SPEED_KMH, "20 mph counts as low speed");
  assert.ok(M.parseSpeed("30") <= M.LOW_SPEED_KMH, "30 km/h counts as low speed");
  assert.ok(M.parseSpeed("30 mph") > M.LOW_SPEED_KMH, "30 mph does not");
});

test("cycle infrastructure tags", () => {
  assert.equal(M.hasCycleInfra({ highway: "primary", "cycleway:left": "lane" }), true);
  assert.equal(M.hasCycleInfra({ highway: "primary", "cycleway:left": "share_busway" }), false);
  assert.equal(M.hasCycleInfra({ highway: "primary", "cycleway:right": "separate" }), false);
  assert.equal(M.hasCycleInfra({ highway: "cycleway" }), true);
});

test("dead ends for vehicles and on foot", () => {
  const ways = [{ tags: { highway: "residential" }, nodes: [1, 2, 3], coords: [[0, 0], [100, 0], [200, 0]] },
                { tags: { highway: "residential" }, nodes: [2, 4], coords: [[100, 0], [100, 100]] },
                { tags: { highway: "footway" }, nodes: [3, 5], coords: [[200, 0], [300, 0]] }];   // path carries on from node 3
  const streets = M.buildGraph(ways.filter((w) => M.isStreet(w.tags))), walk = M.buildGraph(ways);
  const s = M.networkStats(streets, [-1, -1, 250, 150], 0.04, () => 0.5, walk);
  close(s.dead_end_share, 3 / 4, 1e-12, "vehicles: nodes 1, 3, 4 of 4");
  close(s.dead_end_share_on_foot, 2 / 4, 1e-12, "on foot: node 3 continues as a path");
});
