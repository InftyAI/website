// Current GitHub star counts for the InftyAI org, keyed by lowercased
// `owner/repo`.
//
// The homepage renders star counts at build time; this endpoint lets the
// browser refresh them without waiting for a rebuild. It exists as a function
// rather than a direct browser fetch for three reasons: it is same-origin, so
// the `connect-src 'self'` CSP in netlify.toml needs no loosening; it can hold
// a token server-side; and the CDN caches its response, so GitHub sees roughly
// one request an hour regardless of traffic.

const ORG = "InftyAI";

// One org-wide request instead of one per project, so adding a project to
// data/projects.yaml needs no change here. 100 is the page-size ceiling; the
// org would need to outgrow that before pagination mattered.
const UPSTREAM = `https://api.github.com/orgs/${ORG}/repos?per_page=100&type=public`;

export default async () => {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "inftyai-website",
  };

  // Optional: raises the rate limit from 60 to 5,000 requests an hour. Set it
  // in Netlify's environment variables if the unauthenticated budget ever runs
  // short.
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let repos;
  try {
    const upstream = await fetch(UPSTREAM, { headers });
    if (!upstream.ok) {
      return failed(`GitHub responded ${upstream.status}`);
    }
    repos = await upstream.json();
  } catch (err) {
    return failed(err.message);
  }

  // Lowercased because the casing GitHub reports does not always match the
  // slugs in data/projects.yaml (`InftyAI/SandD` vs `InftyAI/sandd`).
  const stars = {};
  for (const repo of repos) {
    stars[repo.full_name.toLowerCase()] = repo.stargazers_count;
  }

  return new Response(JSON.stringify(stars), {
    headers: {
      "Content-Type": "application/json",
      // Set explicitly so the catch-all `Cache-Control` in netlify.toml cannot
      // pin this response for a year.
      "Cache-Control": "public, max-age=600",
      "Netlify-CDN-Cache-Control":
        "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
};

// The page falls back to its build-time counts on any failure, so the body is
// only ever read by a human debugging. `no-store` keeps a transient GitHub
// outage from being cached for an hour.
function failed(reason) {
  return new Response(JSON.stringify({ error: reason }), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
