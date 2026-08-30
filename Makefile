.PHONY: launch cover

launch:
	@echo "Launching the application..."
	npm run dev

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
