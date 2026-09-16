// src/data/gazetteer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { lookupGazetteer, _normalizeName, _cityViewport } from './gazetteer.js';

const PACK_DIR = new URL('./local_data/gazetteer/', import.meta.url);

test('a country resolves with its label point and a real bounding viewport', async () => {
  const australia = await lookupGazetteer('Australia');
  assert.ok(australia, 'Australia must resolve');
  assert.deepEqual(australia.types, ['country']);
  assert.ok(australia.lat < 0 && australia.lat > -40, 'Australia label point is in the southern hemisphere');
  assert.ok(australia.lon > 100 && australia.lon < 160, 'Australia label point is roughly in-country');
  assert.ok(australia.viewport.southwest.lat < australia.viewport.northeast.lat);
  assert.ok(australia.viewport.southwest.lng < australia.viewport.northeast.lng);
});

test('common colloquial names and ISO codes resolve to the right country', async () => {
  assert.equal((await lookupGazetteer('USA'))?.label, 'United States');
  assert.equal((await lookupGazetteer('the United States'))?.label, 'United States');
  assert.equal((await lookupGazetteer('UK'))?.label, 'United Kingdom');
  assert.equal((await lookupGazetteer('au'))?.label, 'Australia');
  assert.equal((await lookupGazetteer('AUS'))?.label, 'Australia');
  assert.equal((await lookupGazetteer('  aUsTrAlIa  '))?.label, 'Australia');
});

test('a dateline-spanning country reports a wraparound bbox (southwest.lng > northeast.lng)', async () => {
  const fiji = await lookupGazetteer('Fiji');
  assert.ok(fiji, 'Fiji must resolve');
  assert.ok(
    fiji.viewport.southwest.lng > fiji.viewport.northeast.lng,
    `Fiji bbox should cross the antimeridian (got sw=${fiji.viewport.southwest.lng}, ne=${fiji.viewport.northeast.lng})`,
  );
});

test('a major city resolves as a locality with a synthesized framing box', async () => {
  const canberra = await lookupGazetteer('Canberra');
  assert.ok(canberra, 'Canberra must resolve');
  assert.deepEqual(canberra.types, ['locality']);
  assert.equal(canberra.label, 'Canberra, Australia');
  assert.ok(canberra.viewport.southwest.lat < canberra.lat && canberra.lat < canberra.viewport.northeast.lat);
  assert.ok(canberra.viewport.southwest.lng < canberra.lon && canberra.lon < canberra.viewport.northeast.lng);
});

test('countries are preferred over cities when both would match', async () => {
  // "Mexico" is a country whose capital's own name pack entry is "Mexico City"
  // (not "Mexico") — so this exercises country-before-city ordering without
  // relying on an exact name collision that may not exist in every pack build.
  const mexico = await lookupGazetteer('Mexico');
  assert.ok(mexico, 'Mexico must resolve');
  assert.deepEqual(mexico.types, ['country']);
});

test('a country too small for the 110m pack still resolves via its city entry', async () => {
  // City-states like Singapore drop out of the 110m admin-0 countries pack at
  // this scale but remain in the populated-places pack — the fallback should
  // still land somewhere useful rather than failing outright.
  const singapore = await lookupGazetteer('Singapore');
  assert.ok(singapore, 'Singapore must resolve via its city entry');
  assert.deepEqual(singapore.types, ['locality']);
});

test('an unresolvable query returns null rather than throwing', async () => {
  assert.equal(await lookupGazetteer('Not A Real Place Xyzzy'), null);
  assert.equal(await lookupGazetteer(''), null);
  assert.equal(await lookupGazetteer(null), null);
});

test('normalizeName strips articles, diacritics, and punctuation', () => {
  assert.equal(_normalizeName('The Bahamas'), 'bahamas');
  assert.equal(_normalizeName("Côte d'Ivoire"), 'cote d ivoire');
  assert.equal(_normalizeName('  U.S.A.  '), 'u s a');
});

test('the synthesized city viewport widens east-west toward the poles, capped', () => {
  const equator = _cityViewport(0, 0);
  const equatorWidth = equator.northeast.lng - equator.southwest.lng;
  const highLat = _cityViewport(75, 0);
  const highLatWidth = highLat.northeast.lng - highLat.southwest.lng;
  assert.ok(highLatWidth > equatorWidth, 'longitude half-width should widen away from the equator');
  assert.ok(highLatWidth <= 4.01, 'longitude half-width stays capped near the poles');
});

test('both packs stay small (offline gazetteer, not a full world atlas)', () => {
  for (const file of ['countries.json', 'cities.json']) {
    const { size } = statSync(new URL(file, PACK_DIR));
    assert.ok(size < 100 * 1024, `${file} should stay under 100 KB (got ${(size / 1024).toFixed(1)} KB)`);
  }
});
