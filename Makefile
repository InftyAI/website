.PHONY: launch data cover worldmap contributors

launch: data
	@echo "Launching the application..."
	npm run dev

# The generated data the homepage reads, brought up to date before the dev server
# starts so that neither target has to be remembered.
#
# Nothing in here may stop the server. Working offline, or without GitHub auth, is
# a normal thing to be doing, and a day-old map is a far smaller problem than a dev
# server that refuses to come up — so a failed refresh warns and carries on with
# the committed file.
#
# `cover` is deliberately not part of this. It runs a full production build and a
# headless browser to redraw an image that only changes when the card design does.
data:
	@# The land is fixed geometry — only the projection, crop or level of detail
	@# could change it — so this is a one-off, not a refresh. `make worldmap`
	@# forces it after an edit to tools/worldmap.mjs.
	@test -s data/worldmap.json || $(MAKE) --no-print-directory worldmap
	@# Refreshed when it is old, and when anything it is derived from is newer than
	@# it. Two conditions because there are two ways for it to be wrong: a
	@# contributor list goes stale on GitHub's clock, but adding a city to
	@# tools/locations.json invalidates it immediately, however recently it ran.
	@if [ -n "$$(find data/contributors.json -mtime -1 2>/dev/null)" ] && \
	   [ -z "$$(find tools/contributors.mjs tools/locations.json data/projects.yaml \
	            -newer data/contributors.json 2>/dev/null)" ]; then \
	  echo "data/contributors.json is current (\`make contributors\` to force a refresh)"; \
	else \
	  $(MAKE) --no-print-directory contributors || \
	    echo "warning: could not refresh data/contributors.json, keeping the committed one"; \
	fi

# Rebuild data/contributors.json — the dots on the homepage map. Run this to
# refresh the map; the output is committed, so builds never call GitHub for it.
#
# New profile locations are reported rather than guessed at: the script prints
# any it cannot find in tools/locations.json, to be added there by hand.
contributors:
	@GITHUB_TOKEN="$${GITHUB_TOKEN:-$$(gh auth token 2>/dev/null)}" \
	  node tools/contributors.mjs

# Rebuild data/worldmap.json — the land the map is drawn on. Only needed to
# change the projection, the crop or the level of detail; the geometry itself
# does not go out of date.
worldmap:
	node tools/worldmap.mjs

# Rebuild static/cover.png (the og:image) from tools/og-card.html.
#
# The card is copied into public/ and served over HTTP rather than opened as a
# file:// URL, so the Jost webfont and the logo are same-origin — woff2 is
# CORS-gated, and a cross-origin miss fails silently to the fallback font.
cover:
	npm run build
	cp tools/og-card.html public/og-card.html
	@python3 -m http.server 8899 --directory public >/dev/null 2>&1 & \
	  srv=$$!; sleep 1; \
	  node tools/og-shot.mjs http://127.0.0.1:8899/og-card.html static/cover.png 1200 630; \
	  kill $$srv
	rm -f public/og-card.html
	@echo "static/cover.png regenerated"
