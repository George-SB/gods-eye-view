import { lookupGazetteer } from '../data/gazetteer.js';

/**
 * Last-resort offline fallback for the forward-geocode chain: the bundled
 * country/city gazetteer (src/data/gazetteer.js, ~420 Natural Earth entries)
 * answers with zero network dependency. Every other provider ahead of it in
 * the chain (Google, Photon, the local Nominatim route) is keyless-friendly
 * but still needs a reachable network; this is the one that still works with
 * none at all — genuinely offline, not just no-API-key.
 *
 * Narrower by design: only ~177 countries + ~243 major cities, vs. the full
 * address coverage a live geocoder gives. That's why it sits last, not first.
 */
export function createGazetteerGeocoder() {
  return {
    async geocode(query, { signal } = {}) {
      signal?.throwIfAborted();
      const hit = await lookupGazetteer(query);
      if (!hit) return { place: null, answered: true };
      return {
        place: {
          lat: hit.lat,
          lng: hit.lon,
          name: hit.label,
          label: hit.label,
          types: hit.types,
          viewport: hit.viewport,
        },
        answered: true,
      };
    },
  };
}
