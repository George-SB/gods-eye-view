/**
 * Offline country/city gazetteer — a keyless fallback for `searchAndFlyTo()`
 * (src/locations.js) when no Google Maps API key is configured, or a live
 * geocode misses. Data: `local_data/gazetteer/{countries,cities}.json`,
 * curated from the Natural Earth 110m cultural vectors (public domain; see
 * each file's `meta` header and DATA_SOURCES.md).
 *
 * PURE data module — no Cesium imports, node-testable. Same lazy-load /
 * memoize-with-retry shape as naturalEarthRegions.js / neighborhoodPolygons.js.
 *
 * Result shape mirrors the fields searchAndFlyTo() already reads off a Google
 * Geocoding API result (`lat`/`lng`, `types`, a `{southwest,northeast}`
 * viewport), so it slots into the same downstream framing logic unchanged.
 */

import { createRetryableLoader } from './retryableLoad.js';

/**
 * Normalize a query/name for matching: lowercase, strip diacritics and
 * punctuation, collapse whitespace, strip a leading "the ". Same recipe as
 * naturalEarthRegions.js's normalizeName — kept as a separate local copy
 * since the two packs (physical regions vs. countries/cities) are otherwise
 * unrelated.
 */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/** Common colloquial names -> the pack's canonical (normalized) name. */
const ALIASES = {
  usa: 'united states of america',
  us: 'united states of america',
  'united states': 'united states of america',
  america: 'united states of america',
  uk: 'united kingdom',
  britain: 'united kingdom',
  'great britain': 'united kingdom',
  uae: 'united arab emirates',
  'ivory coast': 'cote d ivoire',
  'dr congo': 'dem rep congo',
  drc: 'dem rep congo',
  'democratic republic of congo': 'dem rep congo',
  'democratic republic of the congo': 'dem rep congo',
  'congo kinshasa': 'dem rep congo',
  'congo brazzaville': 'congo',
  'czech republic': 'czechia',
  burma: 'myanmar',
  bosnia: 'bosnia and herz',
  'bosnia and herzegovina': 'bosnia and herz',
  holland: 'netherlands',
  'south korea': 'south korea',
  'north korea': 'north korea',
};

async function loadPackFile(name) {
  // Vite bundles these JSON files as modules; the import attribute is what
  // Node needs to load the same files under node:test (same pattern as
  // naturalEarthRegions.js / neighborhoodPolygons.js). One path, so no node:
  // import reaches the browser.
  const mod = name === 'countries'
    ? await import('./local_data/gazetteer/countries.json', { with: { type: 'json' } })
    : await import('./local_data/gazetteer/cities.json', { with: { type: 'json' } });
  return mod.default || mod;
}

function indexPut(index, key, entry) {
  if (!key) return;
  const list = index.get(key);
  if (list) list.push(entry); else index.set(key, [entry]);
}

/**
 * Load + index both packs, once. A failure is NOT memoized: callers
 * `.catch(() => null)` and would otherwise report "place not found" for the
 * rest of the session rather than "the pack didn't load".
 */
const loadIndex = createRetryableLoader(async () => {
  const [countryPack, cityPack] = await Promise.all([
    loadPackFile('countries'),
    loadPackFile('cities'),
  ]);

  const countryIndex = new Map();
  for (const c of countryPack.countries || []) {
    for (const key of new Set([
      normalizeName(c.name),
      normalizeName(c.nameLong),
      normalizeName(c.formal),
      normalizeName((c.abbrev || '').replace(/\./g, '')),
      c.iso2 ? c.iso2.toLowerCase() : '',
      c.iso3 ? c.iso3.toLowerCase() : '',
    ])) {
      indexPut(countryIndex, key, c);
    }
  }

  // Cities are pre-sorted by population (desc) at build time, so a bucket's
  // first entry is already the most-likely intended match for a shared name.
  const cityIndex = new Map();
  for (const city of cityPack.cities || []) {
    for (const key of new Set([normalizeName(city.name), normalizeName(city.nameAscii)])) {
      indexPut(cityIndex, key, city);
    }
  }

  return { countryIndex, cityIndex };
});

/** A country's label point + antimeridian-safe bbox, framed as `region-overview`. */
function countryResult(c) {
  return {
    lat: c.center[1],
    lon: c.center[0],
    label: c.nameLong || c.name,
    types: ['country'],
    viewport: {
      southwest: { lat: c.bbox.sw[1], lng: c.bbox.sw[0] },
      northeast: { lat: c.bbox.ne[1], lng: c.bbox.ne[0] },
    },
  };
}

const CITY_VIEWPORT_HALF_LAT_DEG = 0.12;
const CITY_VIEWPORT_MAX_HALF_LON_DEG = 2.0;

/**
 * Synthesize a small framing box around a city point — the source pack has no
 * viewport of its own (just a point), and framing a bare point falls through
 * to a 250 m landmark shot, which reads as "zoomed into a random street" for
 * something the user searched for as a city. Longitude half-width widens
 * toward the poles (1/cos(lat)) so the box stays a similar ground distance
 * east-west as north-south; capped so a near-polar city doesn't blow up.
 */
function cityViewport(lat, lon) {
  const halfLat = CITY_VIEWPORT_HALF_LAT_DEG;
  const halfLon = Math.min(
    CITY_VIEWPORT_MAX_HALF_LON_DEG,
    halfLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180)),
  );
  return {
    southwest: { lat: lat - halfLat, lng: lon - halfLon },
    northeast: { lat: lat + halfLat, lng: lon + halfLon },
  };
}

/** A city point, framed as `city-overview` via a synthesized viewport (see cityViewport). */
function cityResultOf(city) {
  return {
    lat: city.lat,
    lon: city.lon,
    label: city.country ? `${city.name}, ${city.country}` : city.name,
    types: ['locality'],
    viewport: cityViewport(city.lat, city.lon),
  };
}

/**
 * Look up a country or major city by name, offline. Case-insensitive; strips
 * "the"; resolves common colloquial names (USA, UK, UAE, Ivory Coast, DRC, …)
 * and ISO 3166 alpha-2/alpha-3 codes. Countries are tried before cities (a
 * bare "Georgia" means the country, not any city).
 *
 * @param {string} query e.g. "Australia", "the Netherlands", "USA", "Tokyo"
 * @returns {Promise<{lat:number, lon:number, label:string,
 *   types:string[], viewport:{southwest:{lat,lng}, northeast:{lat,lng}}}|null>}
 */
export async function lookupGazetteer(query) {
  const norm = normalizeName(query);
  if (!norm) return null;
  const { countryIndex, cityIndex } = await loadIndex();
  const candidates = [norm, ALIASES[norm]].filter(Boolean);

  for (const key of candidates) {
    const list = countryIndex.get(key);
    if (list && list.length) return countryResult(list[0]);
  }
  for (const key of candidates) {
    const list = cityIndex.get(key);
    if (list && list.length) return cityResultOf(list[0]);
  }
  return null;
}

// exported for tests
export { normalizeName as _normalizeName, cityViewport as _cityViewport };
