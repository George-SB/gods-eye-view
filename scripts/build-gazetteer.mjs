#!/usr/bin/env node
/**
 * Build src/data/local_data/gazetteer/{countries,cities}.json — an offline
 * name -> location lookup used by searchAndFlyTo() (src/locations.js) when no
 * Google Maps API key is configured, or a live geocode misses. Same role as
 * the existing Natural Earth / neighborhood packs: a public-domain dataset
 * bundled so a common case works with zero network dependency.
 *
 * Source: Natural Earth 110m CULTURAL vectors, via the canonical
 *   https://github.com/nvkelso/natural-earth-vector repo (same repo already
 *   used for the 10m PHYSICAL packs in local_data/natural_earth/).
 *   - ne_110m_admin_0_countries.geojson       -> countries.json
 *   - ne_110m_populated_places_simple.geojson -> cities.json
 * License: public domain (https://www.naturalearthdata.com/about/terms-of-use/).
 *
 * Only the small set of fields a text search needs is kept — no polygon
 * geometry, so the packs stay tiny (a search only needs a point + a framing
 * box, never an outline).
 *
 * Country bbox note: Natural Earth clips antimeridian-spanning countries
 * (Fiji, Russia) to exactly +/-180 on each side of the cut, so a naive
 * min/max over all ring points collapses to [-180, 180]. computeCountryBbox()
 * shifts longitudes into 0..360 (excluding the exact +/-180 seam points,
 * which exist on every such country and would otherwise always collapse the
 * shifted range too) before taking min/max, then converts back — producing
 * the same "southwest.lng > northeast.lng means wraparound" shape
 * src/locations.js's flyToViewportBounds() already expects and handles (see
 * its own comment citing this exact Alaska case).
 *
 * Usage:
 *   node scripts/build-gazetteer.mjs [countries.geojson] [places.geojson]
 * With no arguments it downloads both live; with arguments it reads the given
 * raw GeoJSON files (the exact bytes retrieved on 2026-09-14 in our case).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const BASE_URL = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${COMMIT}/geojson`;
const COUNTRIES_URL = `${BASE_URL}/ne_110m_admin_0_countries.geojson`;
const PLACES_URL = `${BASE_URL}/ne_110m_populated_places_simple.geojson`;

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'data', 'local_data', 'gazetteer');

const DECIMALS = 4; // ~11 m — plenty for a label point / framing box, keeps the pack tiny

const round = (v) => Number(v.toFixed(DECIMALS));

async function loadGeoJson(argPath, url) {
  if (argPath) {
    console.log(`read ${argPath}`);
    return JSON.parse(fs.readFileSync(argPath, 'utf8'));
  }
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function ringsOf(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error(`unexpected geometry type ${geometry.type}`);
}

/**
 * Antimeridian-safe bbox: {sw:[lon,lat], ne:[lon,lat]}. See file header for
 * why the +/-180 seam points are excluded from the "crosses" branch.
 */
function computeCountryBbox(geometry) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const poly of ringsOf(geometry)) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  if (!(minLon < -170 && maxLon > 170)) {
    return { sw: [round(minLon), round(minLat)], ne: [round(maxLon), round(maxLat)] };
  }
  let minShift = Infinity, maxShift = -Infinity;
  for (const poly of ringsOf(geometry)) {
    for (const ring of poly) {
      for (const [lon] of ring) {
        if (Math.abs(lon) >= 179.999) continue; // the clip seam itself, both sides
        const shifted = lon < 0 ? lon + 360 : lon;
        if (shifted < minShift) minShift = shifted;
        if (shifted > maxShift) maxShift = shifted;
      }
    }
  }
  const toSigned = (s) => (s > 180 ? s - 360 : s);
  return { sw: [round(toSigned(minShift)), round(minLat)], ne: [round(toSigned(maxShift)), round(maxLat)] };
}

function buildCountries(raw) {
  if (raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    throw new Error('countries: unexpected payload, not a FeatureCollection');
  }
  const countries = [];
  for (const f of raw.features) {
    const p = f.properties || {};
    if (!p.NAME || !f.geometry) throw new Error(`country feature missing NAME/geometry: ${JSON.stringify(p)}`);
    if (!Number.isFinite(p.LABEL_X) || !Number.isFinite(p.LABEL_Y)) {
      throw new Error(`country ${p.NAME} missing LABEL_X/LABEL_Y`);
    }
    countries.push({
      name: p.NAME,
      nameLong: p.NAME_LONG || p.NAME,
      formal: p.FORMAL_EN || null,
      abbrev: p.ABBREV || null,
      iso2: p.ISO_A2 || null,
      iso3: p.ISO_A3 || null,
      center: [round(p.LABEL_X), round(p.LABEL_Y)],
      bbox: computeCountryBbox(f.geometry),
    });
  }
  countries.sort((a, b) => a.name.localeCompare(b.name));
  return countries;
}

function buildCities(raw) {
  if (raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    throw new Error('places: unexpected payload, not a FeatureCollection');
  }
  const cities = [];
  for (const f of raw.features) {
    const p = f.properties || {};
    if (!p.name || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) {
      throw new Error(`place feature missing name/lat/lon: ${JSON.stringify(p)}`);
    }
    cities.push({
      name: p.name,
      nameAscii: p.nameascii || p.name,
      country: p.adm0name || p.sov0name || null,
      lat: round(p.latitude),
      lon: round(p.longitude),
      pop: Number.isFinite(p.pop_max) ? p.pop_max : null,
      capital: p.adm0cap === 1,
    });
  }
  cities.sort((a, b) => (b.pop || 0) - (a.pop || 0) || a.name.localeCompare(b.name));
  return cities;
}

function writePack(filename, key, entries, sourceFeaturecla) {
  const out = {
    meta: {
      source: `Natural Earth 110m cultural vectors — ${sourceFeaturecla}`,
      url: sourceFeaturecla.includes('countries') ? COUNTRIES_URL : PLACES_URL,
      commit: COMMIT,
      license: 'Public domain (Natural Earth — naturalearthdata.com)',
      fetched: new Date().toISOString(),
      featureCount: entries.length,
    },
    [key]: entries,
  };
  const outPath = path.join(OUT_DIR, filename);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(out)}\n`);
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`wrote ${outPath}: ${entries.length} entries, ${kb} KB`);
}

async function main() {
  const countriesRaw = await loadGeoJson(process.argv[2], COUNTRIES_URL);
  const placesRaw = await loadGeoJson(process.argv[3], PLACES_URL);

  const countries = buildCountries(countriesRaw);
  const cities = buildCities(placesRaw);

  writePack('countries.json', 'countries', countries, 'ne_110m_admin_0_countries');
  writePack('cities.json', 'cities', cities, 'ne_110m_populated_places_simple');
}

main().catch((err) => { console.error(err); process.exit(1); });
