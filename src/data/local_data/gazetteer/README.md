# Offline country/city gazetteer pack

The last-resort, network-free provider in the location search bar's geocoder
chain (`src/search/defaults.js`'s `createDefaultPlaceSearch()`, via
`src/search/gazetteerGeocoder.js` → `src/data/gazetteer.js`) — consulted only
once the coordinate parser, bundled city/landmark presets, Google, Photon and
the local Nominatim route have all missed or are unreachable. "Australia",
"USA", "Tokyo" and similar common queries still resolve with zero network
dependency at that point.

| File | Source dataset | Entries |
|------|-----------------|---------|
| `countries.json` | `ne_110m_admin_0_countries` (sovereign states + major territories) | 177 |
| `cities.json` | `ne_110m_populated_places_simple` (national capitals + major world cities) | 243 |

**Source:** Natural Earth 110m cultural vectors, via the canonical
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
GitHub repo, commit `ca96624a56bd078437bca8184e78163e5039ad19` (fetched
2026-09-14 — exact provenance is in each file's `meta` header). Same source
repo already used for the 10m physical-region pack in `../natural_earth/`.

**License:** public domain (https://www.naturalearthdata.com/about/terms-of-use/).
No attribution legally required; we credit "Natural Earth" anyway as a static
entry in `DATA_CREDITS` (`src/data/dataCredits.js`, key `gazetteer`) — static
rather than dynamically-registered like `NATURAL_EARTH_CREDIT`, since the
search package (`src/search/`) is deliberately free of application/viewer
state (see `createDefaultPlaceSearch()`'s own docstring) and has no `viewer`
to register a credit against. See DATA_SOURCES.md.

**Curation** (`scripts/build-gazetteer.mjs`, deterministic — re-run it against
the raw downloads to reproduce these files byte-for-byte):

- No polygon geometry is kept — a search only ever needs a point plus a
  framing box, never an outline, so the packs stay tiny (~65 KB combined vs.
  the ~1 MB raw GeoJSON pair).
- Countries keep `name` / `nameLong` / `formal` / `abbrev` / `iso2` / `iso3`,
  a label point (`LABEL_X`/`LABEL_Y` — usually better-centered than a
  geometric centroid for odd shapes), and a bounding box computed from the
  full geometry.
- **Antimeridian handling:** Natural Earth clips dateline-spanning countries
  (Fiji, Russia) to exactly ±180° on each side of the cut, so a naive
  min/max over ring points collapses to `[-180, 180]`. The build script
  shifts longitudes into 0..360° (excluding the exact ±180° seam points,
  which exist on every such country) before taking min/max, then converts
  back — producing a `southwest.lng > northeast.lng` box, the same
  wraparound convention `src/locations.js`'s `flyToViewportBounds()` already
  expects (see its own comment citing this exact case for Alaska).
- Cities keep `name` / `nameAscii` / `country` / `lat` / `lon` / `pop` /
  `capital`, sorted by population descending (breaks name-collision ties in
  the runtime index toward the more likely intended city).
- All coordinates rounded to 4 decimals (~11 m) — no need for tighter
  precision; this is a fallback for a first-order search miss, not a survey.

**Coverage caveat:** the 110m scale drops some sovereign micro-states from
the countries pack (e.g. Singapore) — they still resolve via their entry in
the cities pack instead (`lookupGazetteer()` tries countries, then cities).
This pack is a common-case fallback, not a complete gazetteer; a configured
Google Maps API key remains the primary, more complete path.
