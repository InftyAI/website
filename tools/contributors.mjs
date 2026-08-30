// Regenerates data/contributors.json — where the people who contribute to the
// projects in data/projects.yaml say they are. Run by `make contributors`; the
// output is committed, so a normal build needs neither this script nor a GitHub
// token, and the map cannot be emptied by a rate limit mid-deploy.
//
// Deliberately not fetched at request time. These locations are free text that has
// to be matched against tools/locations.json by a human the first time each new
// value appears; doing that live would mean silently dropping people the table has
// not learned yet. So the map is as current as the last run of this script, and
// making it more current is a commit rather than a code path.
//
// Usage: GITHUB_TOKEN=... node tools/contributors.mjs

import { readFile, writeFile } from "node:fs/promises";

// Machine accounts. They commit, but they are not contributors and should not be
// counted as people.
const EXCLUDE = new Set(["inftyai-agent"]);

const {
  places: known,
  regions,
  labels,
} = JSON.parse(await readFile("tools/locations.json", "utf8"));

// Where a city's name is drawn on the map when tools/locations.json does not say:
// just to the right of its dot.
const DEFAULT_LABEL = { dx: 11, dy: 4, anchor: "start" };

// The project list is data/projects.yaml's to own — the map should cover exactly
// the projects the page shows. Read with a regex rather than a YAML parser to
// keep tools/ dependency-free, which the one shape being matched allows.
const projects = await readFile("data/projects.yaml", "utf8");
const repos = [...projects.matchAll(/^\s*repo:\s*(\S+)\s*$/gm)].map((m) => m[1]);
if (!repos.length) {
  exit("found no `repo:` entries in data/projects.yaml");
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  // 60 requests an hour unauthenticated, against roughly one per contributor.
  console.warn("warning: no GITHUB_TOKEN set, expect to be rate limited\n");
}

async function github(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "inftyai-website",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com/${path}`, { headers });
  if (!response.ok) {
    exit(`GET ${path} responded ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// Contributors are collected across every project, then deduplicated: someone who
// has worked on three of them is one person on the map, not three.
const logins = new Set();
for (const repo of repos) {
  const contributors = await github(`repos/${repo}/contributors?per_page=100`);
  for (const contributor of contributors) {
    // `type` is "Bot" for GitHub Apps; EXCLUDE covers machine accounts that are
    // ordinary users as far as the API is concerned.
    if (contributor.type !== "User") continue;
    if (EXCLUDE.has(contributor.login.toLowerCase())) continue;
    logins.add(contributor.login);
  }
  console.log(`${repo}: ${contributors.length} contributors`);
}

// Lowercased, trimmed, and with one space after each comma, so "Shenzhen,China",
// "shenzhen, china" and "Shenzhen, China " are one key rather than three.
const normalise = (value) =>
  value.toLowerCase().replace(/,/g, ", ").replace(/\s+/g, " ").trim();

const places = new Map();
const unmatched = new Map();
let located = 0;

for (const login of [...logins].sort()) {
  const { location } = await github(`users/${login}`);
  if (!location || !location.trim()) continue;

  const key = normalise(location);
  if (!(key in known)) {
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    continue;
  }

  const place = known[key];
  // An explicit null: a known non-place, already decided about.
  if (place === null) continue;

  const existing = places.get(place.label);
  if (existing) {
    existing.count += 1;
  } else {
    places.set(place.label, {
      ...place,
      // The city on its own, for the label on the map. "Shanghai" beside a dot in
      // China says everything "Shanghai, China" does, in half the width — and
      // width is what the labels run out of around the Pearl River Delta.
      short: place.label.split(",")[0].trim(),
      offset: { ...DEFAULT_LABEL, ...labels[place.label] },
      count: 1,
    });
  }
  located += 1;
}

// The summary beside the map is by region, not by city or country. Ten cities was
// a longer list than the map has dots worth explaining, and five of them were
// Chinese, which made it read as a ranking of Chinese cities rather than as the
// spread the map is there to show. Countries had the same problem in miniature:
// four of the six were one contributor each.
//
// A country with no region in tools/locations.json is counted under "Unknown"
// rather than dropped: silently omitting one would leave the column adding up to
// 100% of the wrong total. The warning is what gets it mapped properly. Distinct
// from the "Others" row added below — an Unknown has a dot on the map and only
// wants a line in tools/locations.json, so in a healthy run it never appears.
const regionCounts = new Map();
for (const place of places.values()) {
  let region = regions[place.country];
  if (!region) {
    region = "Unknown";
    console.warn(
      `warning: no region for ${place.country} in tools/locations.json`,
    );
  }
  regionCounts.set(region, (regionCounts.get(region) ?? 0) + place.count);
}

// Shares of every contributor, as whole numbers that still add to 100.
//
// Rounding each share on its own does not: 15, 2, 1, 1 and 16 of 35 round to 43,
// 6, 3, 3 and 46, which is 101. So the floors are taken first and the leftover
// points handed out to the largest remainders — the standard largest-remainder
// apportionment.
// Integer arithmetic throughout, because ties on the remainder are real and
// common: 2 of 35 and 16 of 35 both leave exactly five sevenths of a point. As
// floats their remainders differ at the fifteenth decimal, so which row got the
// spare point came down to IEEE rounding. `(count * 100) % total` is exact, which
// makes the tie a tie — and it is then broken on the count, largest first, so the
// same input always apportions the same way.
function share(counts, total) {
  const whole = counts.map((count) => Math.floor((count * 100) / total));
  const leftover = 100 - whole.reduce((sum, n) => sum + n, 0);
  const byRemainder = counts
    .map((count, index) => ({
      index,
      count,
      remainder: (count * 100) % total,
    }))
    .sort(
      (a, b) =>
        b.remainder - a.remainder || b.count - a.count || a.index - b.index,
    );
  for (let i = 0; i < leftover; i++) {
    whole[byRemainder[i % byRemainder.length].index] += 1;
  }
  return whole;
}

const ranked = [...regionCounts]
  .map(([name, count]) => ({ name, count }))
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

// Everyone whose profile says nothing this table can place, as one row. Without it
// the column was shares of the located contributors only, which read as shares of
// the project — and the located are barely half of it.
//
// Appended after the sort rather than ranked with the regions: it is currently the
// largest count of the five, and a residual bucket heading a list of regions reads
// as the biggest region. Last is where a reader expects the remainder.
//
// `note` is the only explanation the row gets — a visible one was tried and cut.
// It reaches the tooltip and the accessibility tree, and the label alone would
// otherwise suggest these people are somewhere else rather than unstated.
const unlocated = logins.size - located;
if (unlocated > 0) {
  ranked.push({
    name: "Others",
    count: unlocated,
    note: "Contributors whose GitHub profile does not say where they are.",
  });
}

const shares = share(
  ranked.map((r) => r.count),
  logins.size,
);

const output = {
  // Not rendered anywhere — it is here so that a reader of the file, or of a
  // diff, can tell how old the snapshot is without going through git log.
  generated: new Date().toISOString().slice(0, 10),
  total: logins.size,
  located,
  // Cities: one dot each on the map. Largest first, so the template draws the big
  // dots before the small ones and a city of one is never hidden underneath a
  // city of six.
  places: [...places.values()].sort((a, b) => b.count - a.count),
  // How many countries those cities are in. Not shown, but it is what the map's
  // accessible name says, being more use to a screen reader than "4 regions".
  countryCount: new Set([...places.values()].map((p) => p.country)).size,
  // Regions plus the "Others" remainder: one row each in the summary. `count` is
  // not rendered — `percent` is — but it stays so the file can be checked against
  // itself: the counts sum to `total`, and the percents to 100.
  regions: ranked.map((region, index) => ({
    ...region,
    percent: shares[index],
  })),
};

await writeFile(
  "data/contributors.json",
  JSON.stringify(output, null, 2) + "\n",
);

console.log(
  `\ndata/contributors.json: ${output.located} of ${output.total} contributors placed` +
    ` in ${output.places.length} cities across ${output.countryCount} countries`,
);

// Printed rather than thrown: an unknown location costs one dot, and blocking the
// regeneration over it would leave the whole map stale instead.
if (unmatched.size) {
  console.log(
    `\n${unmatched.size} location(s) not in tools/locations.json — add them there` +
      ` (or map them to null if they are not places):`,
  );
  for (const [key, count] of [...unmatched].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${JSON.stringify(key)}${count > 1 ? ` (x${count})` : ""}`);
  }
}

function exit(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
