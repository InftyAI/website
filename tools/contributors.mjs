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

import { readFile, utimes, writeFile } from "node:fs/promises";

const TARGET = "data/contributors.json";

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

// An alias in tools/locations.json is a string: the key whose entry it stands for.
// Written out in full, every spelling of Shanghai carried its own copy of the
// coordinates, so correcting one meant finding the rest — and the table is now
// long enough that "the rest" is not visible on one screen.
//
// One hop, not a chain: an alias must name an entry, so there is no cycle to guard
// against and no order to resolve in. Checked here rather than at the point of use,
// because a typo in an alias for a city nobody has contributed from yet would
// otherwise sit in the file until the day someone did.
for (const [key, value] of Object.entries(known)) {
  if (typeof value !== "string" || key.startsWith("//")) continue;
  const target = known[value];
  if (target === undefined) {
    exit(
      `locations.json: alias ${JSON.stringify(key)} names a missing entry ${JSON.stringify(value)}`,
    );
  }
  if (typeof target === "string") {
    exit(
      `locations.json: alias ${JSON.stringify(key)} names another alias ${JSON.stringify(value)} — point it at the entry itself`,
    );
  }
}

// The project list is data/projects.yaml's to own — the map should cover exactly
// the projects the page shows. Read with a regex rather than a YAML parser to
// keep tools/ dependency-free, which the one shape being matched allows.
const projects = await readFile("data/projects.yaml", "utf8");
const repos = [...projects.matchAll(/^\s*repo:\s*(\S+)\s*$/gm)].map(
  (m) => m[1],
);
if (!repos.length) {
  exit("found no `repo:` entries in data/projects.yaml");
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  // 60 requests an hour unauthenticated, against roughly one per contributor.
  console.warn("warning: no GITHUB_TOKEN set, expect to be rate limited\n");
}

// `missing`: what to return for a 404 instead of stopping the run. Only the profile
// lookups pass it, and only because a login read out of a commit is a login as it was
// on the day of the commit — an account renamed or deleted since is a 404 and is not a
// reason to leave the whole map stale.
async function request(path, { missing } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "inftyai-website",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(
    path.startsWith("https://") ? path : `https://api.github.com/${path}`,
    { headers },
  );
  if (response.status === 404 && missing !== undefined) return null;
  if (!response.ok) {
    exit(`GET ${path} responded ${response.status} ${response.statusText}`);
  }
  return response;
}

async function github(path, options) {
  const response = await request(path, options);
  return response === null ? options.missing : response.json();
}

// Every page, not just the first. A repository with more than one page of commits
// used to be counted from its first hundred alone.
//
// The `Link` header rather than a page counter: it is what tells us there is a next
// page at all, and following it means never asking for a page that is not there.
async function githubAll(path) {
  const items = [];
  let next = path;
  while (next) {
    const response = await request(next);
    items.push(...(await response.json()));
    next = /<([^>]+)>;\s*rel="next"/.exec(
      response.headers.get("link") ?? "",
    )?.[1];
  }
  return items;
}

// Contributors are collected across every project, then deduplicated: someone who
// has worked on three of them is one person on the map, not three.
//
// From the commits, not from `repos/{repo}/contributors`, which is where this
// started and which is a cached statistic GitHub recomputes on its own schedule. On
// 2026-09-03 it reported 17 people for Awesome-LLMOps against 27 with commits on
// `main` — every one of the ten it omitted had arrived that August, and the repo's
// `stats/contributors` had been answering "still computing" for as long as anyone
// looked. A map of who is here cannot be a month behind on who is here, and there is
// no parameter to ask that endpoint for a fresh answer.
//
// The cost is pagination — about twenty requests across the seven projects instead of
// seven — which is nothing against the hourly limit, and the per-contributor profile
// lookups below already dwarf it.
//
// Everyone with a commit, keyed by their login lowercased: GitHub logins are
// case-insensitive, and the same person arrives spelled two ways — `googs1025` from
// the API's author field and `CYJiang <86391540+googs1025@users.noreply.github.com>`
// from a co-author trailer. Keyed by the login itself, that was two contributors.
//
// How much each has done travels with them, for the order the cards list faces in.
// Both numbers come out of the commit pages that are already being read for the
// headcount, so the ranking costs no extra requests — which is the only reason it is
// commit-based rather than something the API would have to be asked for separately.
const contributors = new Map();

// A commit's `author` is the one person GitHub attributed it to. Where two people
// wrote it, the second is a `Co-authored-by:` trailer in the message and appears in no
// field of the API's response — so reading `author` alone silently dropped them.
//
// Not a corner case here. Every project added to Awesome-LLMOps arrives as a pull
// request that inftyai-agent squash-merges, which makes that machine account the
// author and the person who did the work the co-author. They were counted as nobody,
// while the same contribution to a repo whose merges a human presses counted as a
// contributor — and around twenty of the people already on the map are Awesome-LLMOps
// submitters, so the map was applying two rules to one kind of work.
const COAUTHOR = /^co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/gim;

// The only address that names a GitHub account rather than a mailbox:
// `id+login@users.noreply.github.com`, or the older `login@…`. The login is taken from
// there and nowhere else — the display name beside it is free text, and guessing from
// it would be wrong in both directions: `Kerry He` is the account `kerry-he`, which
// looks guessable, and `Se7en <chengzw258@163.com>` is `cr7258`, which does not. A
// name that happens to be somebody else's login would credit a stranger. Unresolved
// trailers are reported at the end instead, and in practice they are people a
// noreply trailer or an ordinary commit elsewhere has already found.
//
// Loose about the login's own shape, because the profile lookup below is what decides
// whether an account exists.
const NOREPLY = /^(?:\d+\+)?([\w-]+)@users\.noreply\.github\.com$/i;

// Co-authors that are not people and have no account to look for: the assistants that
// sign commits in these repositories. Skipped rather than reported, so the report of
// unresolved trailers stays a list of contributors to look into rather than one line
// of noise per model release.
const NOT_PEOPLE = new Set(["noreply@anthropic.com"]);

// Trailers naming somebody no login could be read from, for the report at the end.
const unresolved = new Map();

// Adds one commit to somebody's total, and returns the spelling of their login that
// the rest of the run uses. Null for anyone who is not a person to count.
function credit(login, repo) {
  const key = login.toLowerCase();
  // `[bot]` is the suffix GitHub gives every App's account, and EXCLUDE covers the
  // machine accounts that are ordinary users as far as the API is concerned.
  if (key.endsWith("[bot]") || EXCLUDE.has(key)) return null;
  let entry = contributors.get(key);
  if (!entry) {
    entry = { login, commits: 0, repos: new Set() };
    contributors.set(key, entry);
  }
  entry.commits += 1;
  entry.repos.add(repo);
  return entry.login;
}

for (const repo of repos) {
  const commits = await githubAll(`repos/${repo}/commits?per_page=100`);
  const seen = new Set();
  let unattributed = 0;
  for (const commit of commits) {
    const { author } = commit;
    // Everyone this commit is the work of: the author GitHub linked to an account,
    // then every co-author a login can be read from. A Map keyed on the lowercased
    // login, so that the common `Signed-off-by` plus `Co-authored-by` pair naming the
    // author again is one commit for them rather than two.
    const writers = new Map();
    const writer = (login) => {
      if (!writers.has(login.toLowerCase()))
        writers.set(login.toLowerCase(), login);
    };
    // `type` is "Bot" for GitHub Apps. A missing author is a commit whose author
    // email belongs to no GitHub user — there is nothing to look a location up for,
    // and a co-author trailer may yet name somebody, so it is left to the count below.
    if (author?.type === "User") writer(author.login);
    for (const [, name, email] of commit.commit.message.matchAll(COAUTHOR)) {
      if (NOT_PEOPLE.has(email.toLowerCase())) continue;
      const login = NOREPLY.exec(email)?.[1];
      if (login) {
        writer(login);
        continue;
      }
      if (name.toLowerCase().endsWith("[bot]")) continue;
      const trailer = `${name} <${email}>`;
      unresolved.set(trailer, (unresolved.get(trailer) ?? 0) + 1);
    }
    const credited = [...writers.values()]
      .map((login) => credit(login, repo))
      .filter((login) => login !== null);
    // A commit whose author email belongs to no GitHub user and whose trailers named
    // nobody either: there is no account to look a location up for, so all it can be
    // is counted and reported. A bot's commit is not this — it has an account, and
    // that account is deliberately not a person.
    if (!author && !credited.length) unattributed += 1;
    for (const login of credited) seen.add(login);
  }
  console.log(
    `${repo}: ${seen.size} contributors across ${commits.length} commits` +
      (unattributed ? ` (${unattributed} by no GitHub account)` : ""),
  );
}

// `?s=` on an avatar URL asks GitHub for that many pixels square. Set through the
// URL rather than appended, so this cannot depend on the `?v=4` that happens to be
// on every avatar_url today.
function sized(url, size) {
  const parsed = new URL(url);
  parsed.searchParams.set("s", String(size));
  return parsed.toString();
}

// Lowercased, trimmed, and with one space after each comma, so "Shenzhen,China",
// "shenzhen, china" and "Shenzhen, China " are one key rather than three.
const normalise = (value) =>
  value.toLowerCase().replace(/,/g, ", ").replace(/\s+/g, " ").trim();

const places = new Map();
const unmatched = new Map();
let located = 0;

// Everyone, whether or not they could be placed — the card on each mark is built
// from this, matched back to its place below.
const people = [];

for (const [id, entry] of [...contributors].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const { login, commits, repos } = entry;
  const profile = await github(`users/${login}`, { missing: null });

  // A login is a login as it was on the day of the commit it was read from, and three
  // of the ones in these repositories now 404: renamed or deleted since. Dropped
  // rather than counted, because there is no profile to place them by and no avatar to
  // show — all they could add is another line to the "Unlisted" share.
  if (profile === null) {
    contributors.delete(id);
    console.warn(
      `warning: no account for ${login}, named in a commit — skipping`,
    );
    continue;
  }
  const { location, avatar_url: avatar } = profile;

  // `place` stays null until one is matched, and a null is somebody no card will
  // ever list: no location, a location the table has not learned, and a known
  // non-place like "Remote" all end up here, which is exactly the set that
  // `total - located` counts.
  const person = {
    login,
    // Requested at a size rather than at whatever GitHub's default is (460px): the
    // card draws these at 24px, and 23 cards' worth of full-size avatars is most of
    // a megabyte to show a few dozen faces the size of a full stop.
    avatar: sized(avatar, 64),
    // Only the ranking, and only until the sort below — neither number reaches
    // data/contributors.json. The card shows a face and a handle; a commit count
    // beside them invited a reading of the map as a scoreboard.
    commits,
    repos: repos.size,
    place: null,
  };
  people.push(person);

  if (!location || !location.trim()) continue;

  const key = normalise(location);
  if (!(key in known)) {
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    continue;
  }

  // A string is an alias for another key; the loop above has already proved it
  // resolves to an entry.
  const place = typeof known[key] === "string" ? known[known[key]] : known[key];
  // An explicit null: a known non-place, already decided about.
  if (place === null) continue;

  // The mark whose card will list them. The label, because that is what identifies
  // one mark on the map — and it can be a country-level fallback, which is a mark
  // like any other and gets a card like any other.
  person.place = place.label;

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

// Every mark that was matched is drawn, country-level fallbacks included.
//
// This used to prune them: a country mark said "somewhere in this country", and once
// a city there was on the map the country's own mark went, on the grounds that a blob
// over China beside five Chinese cities reads as a sixth city that nobody lives in.
// That is true of the blob and it was the wrong thing to weigh. The mark was not the
// only thing dropped — the people it stood for went with it, off the card that names
// them and into a region percentage, so writing "India" instead of "Bengaluru" was
// enough to be counted and not shown. The contributors are the baseline here: a mark
// exists to name whoever is under it, so no mark that has somebody under it is
// dropped for the drawing's sake.
//
// What is left of the blob problem is a label, and the label is the answer to it:
// "India" beside a dot in the middle of India is not a city, and the card it opens
// lists the people who wrote it that way.
const matched = [...places.values()];

// The summary beside the map is by region, not by city or country. Ten cities was
// a longer list than the map has dots worth explaining, and five of them were
// Chinese, which made it read as a ranking of Chinese cities rather than as the
// spread the map is there to show. Countries had the same problem in miniature:
// four of the six were one contributor each.
//
// A country with no region in tools/locations.json is counted under "Unknown"
// rather than dropped: silently omitting one would leave the column adding up to
// 100% of the wrong total. The warning is what gets it mapped properly. Distinct
// from the "Unlisted" row added below — an Unknown has a dot on the map and only
// wants a line in tools/locations.json, so in a healthy run it never appears.
const regionCounts = new Map();
for (const place of matched) {
  let region = regions[place.country];
  if (!region) {
    region = "Unknown";
    console.warn(
      `warning: no region for ${place.country} in tools/locations.json`,
    );
  }
  regionCounts.set(region, (regionCounts.get(region) ?? 0) + place.count);
}

// Who is at each mark, for the card it opens. Ordered by commits, then by how many of
// the seven projects they have touched, then by login so that two people with one
// commit each do not swap places between runs.
//
// The order is all that survives: neither number is emitted. Commits are a rough
// measure of activity and a poor thing to publish beside someone's face — a one-line
// addition to Awesome-LLMOps counts the same as a feature in llmaz, and reviewing,
// filing and answering count for nothing at all. They are a defensible way to decide
// which ten faces a card has room for, and not much more than that.
//
// Ten, not the five this started at: five cut the largest city on the map short by one
// face, which is a cap earning nothing. Ten clears every city today — the largest is
// six — so the ordering above decides nothing at present and the cap is headroom. It is
// still a cap because a card is a card: ten rows is already 300px of it, and a city that
// ever passes ten is a city whose card has to say "and more" rather than grow.
const TOP = 10;
const placePeople = new Map();
for (const person of people) {
  if (!person.place) continue;
  if (!placePeople.has(person.place)) placePeople.set(person.place, []);
  placePeople.get(person.place).push(person);
}
for (const list of placePeople.values()) {
  list.sort(
    (a, b) =>
      b.commits - a.commits ||
      b.repos - a.repos ||
      a.login.localeCompare(b.login),
  );
}

// A mark's count and the people its card lists are arrived at separately — the count
// by tallying places as they are matched, the card by grouping the people afterwards
// — so they can disagree, and a card showing four faces on a dot drawn for six would
// be a bug nobody would catch by looking at the map. Checked rather than assumed.
for (const place of places.values()) {
  const listed = placePeople.get(place.label)?.length ?? 0;
  if (listed !== place.count) {
    exit(
      `${place.label} is drawn for ${place.count} contributor(s) but ${listed} are listed` +
        ` — the dot and its card are counting different things`,
    );
  }
}

// Nobody the table placed is off the map any more: the report that used to stand here
// listed the contributors whose country mark a city had replaced, and there is no
// longer such a thing. Every located person is on the mark their `place` names, which
// the check above proves mark by mark.

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
const unlocated = contributors.size - located;
if (unlocated > 0) {
  ranked.push({
    name: "Unlisted",
    count: unlocated,
    note: "Contributors whose GitHub profile does not say where they are.",
  });
}

const shares = share(
  ranked.map((r) => r.count),
  contributors.size,
);

const output = {
  // Not rendered anywhere — it is here so that a reader of the file, or of a
  // diff, can tell how old the snapshot is without going through git log.
  generated: new Date().toISOString().slice(0, 10),
  total: contributors.size,
  located,
  // One mark each on the map. Largest first, so the template draws the big dots
  // before the small ones and a city of one is never hidden underneath a city of
  // six. A country-level fallback is one of these marks, drawn wherever somebody
  // gave their country and no more than that.
  //
  // `people` is the card the mark opens: a handle and an avatar each, capped at ten
  // because the card is a panel floating over the map and a mark of thirty would cover
  // the continent it sits on. `more` is what stops the cap from quietly hiding
  // the rest. Most marks are one person, so most cards are one face — that is the
  // shape of the contributor list, not a limitation of the card.
  places: [...places.values()]
    .sort((a, b) => b.count - a.count)
    .map((place) => {
      const list = placePeople.get(place.label) ?? [];
      return {
        ...place,
        people: list.slice(0, TOP).map(({ login, avatar }) => ({
          login,
          avatar,
        })),
        more: Math.max(0, list.length - TOP),
      };
    }),
  // Marks that are actually cities, which is not `len places`: a country-level
  // fallback is a mark too. Only used by the map's accessible name, which called
  // India a city before this existed.
  cities: matched.filter((place) => !place.countryOnly).length,
  // How many countries the located contributors are in, which is fewer than there
  // are marks: six of these are American. Not shown, but it is what the map's
  // accessible name says, being more use to a screen reader than "4 regions".
  countryCount: new Set(matched.map((p) => p.country)).size,
  // Regions plus the "Unlisted" remainder: one row each in the summary. `count` is
  // not rendered — `percent` is — but it stays so the file can be checked against
  // itself: the counts sum to `total`, and the percents to 100.
  //
  // Shares only. The people are on the marks now, where the question "who is in
  // Shanghai" is asked by pointing at Shanghai; a second list of them under a region
  // heading was the same names twice, and the coarser of the two.
  regions: ranked.map((region, index) => ({
    ...region,
    percent: shares[index],
  })),
};

// Same data as last time, only a newer date: the file is left exactly as it is.
//
// `generated` moves on every run, so writing unconditionally made every run a
// change. That is a commit a week that says nothing once this is on a schedule
// (.github/workflows/refresh-data.yaml), and locally it meant `make launch` left
// the working tree dirty.
//
// The comparison neutralises the date rather than dropping it, so a run that does
// find something new still stamps today.
let previous = null;
try {
  previous = JSON.parse(await readFile(TARGET, "utf8"));
} catch {
  // Missing, or not readable as JSON. Either way it is about to be written.
}
const unchanged =
  previous !== null &&
  JSON.stringify({ ...output, generated: previous.generated }) ===
    JSON.stringify(previous);

if (unchanged) {
  // The Makefile decides whether to refresh from this file's modification time, so
  // it has to move even when the bytes do not — otherwise a file that is correct
  // and a file that is a month stale look the same to it, and every `make` refetches.
  const now = new Date();
  await utimes(TARGET, now, now);
} else {
  await writeFile(TARGET, JSON.stringify(output, null, 2) + "\n");
}

console.log(
  `\n${TARGET}: ${output.located} of ${output.total} contributors placed` +
    ` in ${output.cities} cities across ${output.countryCount} countries` +
    `${unchanged ? " (unchanged)" : ""}`,
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

// Co-authors written with an ordinary email address, which names a mailbox and not an
// account. Reported rather than resolved, for the reasons NOREPLY carries: there is no
// rule that turns "Se7en <chengzw258@163.com>" into `cr7258`, and a guess from the name
// would sooner or later credit a stranger.
//
// Not a list of people missing from the map. Most of these are somebody an ordinary
// commit or a noreply trailer elsewhere has already found — the list is here so that
// one who is not can be noticed, and the answer to that is a commit of their own, not
// a table of email addresses to keep.
if (unresolved.size) {
  console.log(
    `\n${unresolved.size} co-author(s) named by email rather than by account, so not` +
      ` counted from those commits (they may be counted from others):`,
  );
  for (const [trailer, count] of [...unresolved].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${trailer}${count > 1 ? ` (x${count})` : ""}`);
  }
}

function exit(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
