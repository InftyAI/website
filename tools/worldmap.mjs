// Regenerates data/worldmap.json — the land silhouette the contributor map is
// drawn on. Run by `make worldmap`; the output is committed, so a normal build
// needs neither this script nor network access.
//
// The source is Natural Earth's 110m land layer, as published in TopoJSON by
// world-atlas. TopoJSON is decoded here by hand rather than with topojson-client
// + d3-geo, to keep tools/ dependency-free the way tools/og-shot.mjs is: the
// whole job is a delta-decode and an equirectangular projection, which is less
// code than the install would be.
//
// Usage: node tools/worldmap.mjs [land-110m.json]

import { writeFile, readFile } from "node:fs/promises";

const SOURCE = "https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json";

// Equirectangular, because the projection has to be reproduced in a Hugo
// template to place the dots (see layouts/_default/home.html) and this is the
// only projection whose formula is one multiply per axis.
const WIDTH = 1000;

// Antarctica is dropped and the Arctic is trimmed to where land actually is:
// keeping them would spend a third of the map's height on two empty bands, and
// no contributor has ever lived on either.
const LAT_TOP = 84;
const LAT_BOTTOM = -58;

// Degrees to pixels. Stored in the output so the template can project a
// contributor's coordinates with the same constant.
const K = WIDTH / 360;

// Vertices closer together than a pixel are dropped, matching the whole-pixel
// grid the path is emitted on. Natural Earth at 110m is already coarse at this
// width, so this removes little — the size win comes from the encoding below.
const TOLERANCE = 1;

const local = process.argv[2];
const topology = JSON.parse(
  local
    ? await readFile(local, "utf8")
    : await (await fetchOrDie(SOURCE)).text(),
);

// TopoJSON quantises coordinates to integers and stores each arc as a run of
// deltas from the previous point, so a decoded arc is a running sum scaled back
// into degrees. Cached because arcs are shared between rings — that sharing is
// the entire point of the format.
const decoded = new Map();
function arc(index) {
  if (!decoded.has(index)) {
    const [sx, sy] = topology.transform.scale;
    const [tx, ty] = topology.transform.translate;
    let x = 0;
    let y = 0;
    decoded.set(
      index,
      topology.arcs[index].map(([dx, dy]) => {
        x += dx;
        y += dy;
        return [x * sx + tx, y * sy + ty];
      }),
    );
  }
  return decoded.get(index);
}

// A ring is a list of arc indices. A negative index means that arc traversed
// backwards, and is written `~i` (so -1 is arc 0 reversed). Consecutive arcs
// share an endpoint, hence the skipped first point on every arc but the first.
function ring(indices) {
  const points = [];
  for (const index of indices) {
    const forward = index >= 0;
    const segment = forward ? arc(index) : arc(~index).slice().reverse();
    for (let i = points.length ? 1 : 0; i < segment.length; i++) {
      points.push(segment[i]);
    }
  }
  return points;
}

const project = ([lng, lat]) => [K * (lng + 180), K * (LAT_TOP - lat)];

// Russia and Fiji straddle 180°, where the map is cut. Their rings step from
// +179 to -179 between two neighbouring vertices, which an equirectangular
// projection draws as a line right across the map — the two streaks this
// function exists to remove.
//
// Undoing the wrap first puts every vertex of a ring in one continuous
// longitude space, so a ring over Chukotka runs 170°..190° instead of jumping.
function unwrap(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [lng, lat] = points[i];
    const previous = out[i - 1][0];
    // The shortest way round is always under 180°, so the wrapped copy of this
    // vertex is the one within that of its predecessor.
    const turns = Math.round((lng - previous) / 360);
    out.push([lng - turns * 360, lat]);
  }
  return out;
}

// Sutherland–Hodgman against one vertical edge. Valid for a concave ring because
// the region being kept — a longitude strip — is convex; where the ring leaves
// and re-enters, the seam it walks lies exactly along the cut, hidden under the
// map's own edge.
function clipHalf(points, inside, edge) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const aIn = inside(a[0]);
    if (aIn) out.push(a);
    if (aIn !== inside(b[0])) {
      const t = (edge - a[0]) / (b[0] - a[0]);
      out.push([edge, a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

// The ring, reduced to the part of it that falls on the map.
const clipToMap = (points) =>
  clipHalf(
    clipHalf(points, (lng) => lng >= -180, -180),
    (lng) => lng <= 180,
    180,
  );

// Drops vertices within TOLERANCE of the last one kept. Rings are open — the
// path's `Z` closes them — so the first and last vertices are both kept.
function thin(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [px, py] = out[out.length - 1];
    if (Math.abs(x - px) >= TOLERANCE || Math.abs(y - py) >= TOLERANCE) {
      out.push(points[i]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

const round = (n) => Math.round(n * 10) / 10;

// Rings are emitted as whole-pixel relative steps: `M` to the start, then one
// `l` run of deltas. Deltas beat absolute coordinates by 3x compressed (4.8 KB
// against 13.9 KB brotli for this dataset) because a coastline's steps are small
// and repetitive, where its absolute coordinates are all distinct. A pixel of
// quantisation is invisible in a filled silhouette — and the dots on top are
// still placed at full precision, since the template projects them itself.
//
// The residual is carried rather than dropped, so rounding cannot accumulate
// into a visible drift along a long coastline.
function encode(points) {
  let cx = 0;
  let cy = 0;
  let start = null;
  const steps = [];
  for (const [x, y] of points) {
    const dx = Math.round(x - cx);
    const dy = Math.round(y - cy);
    // A step that quantises to nothing would draw a zero-length line.
    if (start !== null && dx === 0 && dy === 0) continue;
    cx += dx;
    cy += dy;
    if (start === null) start = `${dx} ${dy}`;
    else steps.push([dx, dy]);
  }

  let out = `M${start}`;
  if (steps.length) {
    out += "l";
    // A minus sign separates two numbers on its own, so the space before it is
    // dead weight. Nothing is needed straight after the `l` either.
    let separate = false;
    for (const [dx, dy] of steps) {
      out += (separate && dx >= 0 ? " " : "") + dx;
      out += (dy >= 0 ? " " : "") + dy;
      separate = true;
    }
  }
  return `${out}Z`;
}

const rings = [];
for (const geometry of topology.objects.land.geometries) {
  const polygons =
    geometry.type === "MultiPolygon" ? geometry.arcs : [geometry.arcs];
  for (const polygon of polygons) {
    for (const indices of polygon) {
      const closed = ring(indices);

      // Antarctica, and anything else entirely outside the latitude band. Tested
      // on the northernmost point so a ring merely reaching south is kept whole.
      if (Math.max(...closed.map((p) => p[1])) < LAT_BOTTOM) continue;

      // TopoJSON repeats the first vertex to close a ring; the clip walks the
      // edges itself, and the path's `Z` closes the result.
      const lngLat = unwrap(closed.slice(0, -1));

      // A ring that crossed the cut has a piece on each side of the map, so both
      // its own longitudes and those a turn away are clipped. Only one of the
      // three survives for the rings that sit well inside the map.
      for (const turn of [0, -360, 360]) {
        const piece = clipToMap(lngLat.map(([lng, lat]) => [lng + turn, lat]));
        if (piece.length < 3) continue;

        const points = thin(piece.map(project));

        // An outline needs three distinct corners; anything less thinned away to
        // a dot or a hairline that would not have been visible.
        if (points.length < 3) continue;
        const xs = points.map((p) => p[0]);
        const ys = points.map((p) => p[1]);
        if (
          Math.max(...xs) - Math.min(...xs) < 1 &&
          Math.max(...ys) - Math.min(...ys) < 1
        ) {
          continue;
        }

        rings.push(points);
      }
    }
  }
}

// One path for all of the land: it is filled with a single flat colour, so
// splitting it per landmass would only add markup.
const d = rings.map(encode).join("");

const output = {
  // Provenance, since the geometry is generated rather than authored.
  source: SOURCE,
  license: "Natural Earth, public domain",
  width: WIDTH,
  height: round(K * (LAT_TOP - LAT_BOTTOM)),
  // The projection, for placing dots: x = k * (lng + 180), y = k * (latTop - lat)
  k: K,
  latTop: LAT_TOP,
  land: d,
};

await writeFile("data/worldmap.json", JSON.stringify(output) + "\n");
console.log(
  `data/worldmap.json: ${rings.length} rings, ${(d.length / 1024).toFixed(1)} KB of path data`,
);

async function fetchOrDie(url) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`${url} responded ${response.status}`);
    process.exit(1);
  }
  return response;
}
