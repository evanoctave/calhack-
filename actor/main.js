// night-search-radius: everything a family needs to search for a missing person with dementia around a home.
// Hazards (water, rail, motorway, construction) from OpenStreetMap Overpass; open-at-night places with phones
// and hours from Apify's Google Maps Scraper; familiar places pinned with distances. Runs at setup, cached by Nightfall.
import { Actor } from 'apify';

const R_EARTH_MI = 3958.8;
const haversine = (a, b, c, d) => {
    const p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dp = (c - a) * Math.PI / 180, dl = (d - b) * Math.PI / 180;
    const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R_EARTH_MI * Math.asin(Math.sqrt(x));
};
const CATS = [[/gas|fuel|petrol/i, 'fuel'], [/convenience|grocery|market|7-?eleven/i, 'convenience'], [/hospital|emergency|urgent|medical|clinic/i, 'hospital'],
    [/pharmacy|drug/i, 'pharmacy'], [/train|transit|bus|metro|station/i, 'transit'], [/restaurant|diner|cafe|coffee|fast food|donut|taco|burger/i, 'diner']];
const cat = (name, c) => (CATS.find(([re]) => re.test(c) || re.test(name)) || [null, 'diner'])[1];
const hoursSpec = (oh) => {
    if (!oh || !oh.length) return '';
    const day = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const row = oh.find((r) => String(r.day).toLowerCase().startsWith(day.toLowerCase().slice(0, 3))) || oh[0];
    const t = String(row.hours || '');
    if (/24 hours/i.test(t)) return '24/7';
    const m = [...t.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/gi)];
    if (m.length < 2) return '';
    const hh = (x) => { let h = parseInt(x[1]) % 12 + (x[3].toUpperCase() === 'PM' ? 12 : 0); return `${String(h).padStart(2, '0')}:${x[2] || '00'}`; };
    return `${hh(m[0])}-${hh(m[1])}`;
};

await Actor.init();
const input = await Actor.getInput() ?? {};
const { lat, lng, radius_mi = 1.5, familiar_places = [], google_maps = true, max_per_search = 6 } = input;
if (typeof lat !== 'number' || typeof lng !== 'number') throw new Error('lat and lng are required numbers');
const radiusM = Math.round(radius_mi * 1609.34);
const rows = [];

// 1. Hazards from Overpass.
const q = `[out:json][timeout:25];(way["waterway"](around:${radiusM},${lat},${lng});way["natural"="water"](around:${radiusM},${lat},${lng});way["railway"="rail"](around:${radiusM},${lat},${lng});way["highway"~"^motorway"](around:${radiusM},${lat},${lng});way["landuse"="construction"](around:${radiusM},${lat},${lng}););out center tags 80;`;
try {
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': 'nightfall-night-search-radius/0.1' } });
    const els = (await r.json()).elements || [];
    for (const e of els) {
        const t = e.tags || {}, c = e.center || { lat: e.lat, lon: e.lon };
        if (c.lat == null) continue;
        let category, name;
        if (t.waterway || t.natural === 'water') { category = 'water'; name = t.name || `${t.waterway || 'water'} channel`; }
        else if (t.railway === 'rail') { category = 'rail'; name = t.name || 'Rail line'; }
        else if (String(t.highway || '').startsWith('motorway')) { category = 'motorway'; name = t.name || t.ref || 'Freeway on-ramp'; }
        else if (t.landuse === 'construction') { category = 'construction'; name = t.name || 'Construction site'; }
        else continue;
        if (rows.some((p) => p.name === name && haversine(p.lat, p.lng, c.lat, c.lon) < 0.25)) continue;
        rows.push({ category, name, lat: c.lat, lng: c.lon, distance_mi: +haversine(lat, lng, c.lat, c.lon).toFixed(2), phone: '', hours: '', open_24h: false, source: 'overpass' });
    }
} catch (e) { console.warn('overpass failed', e.message); }

// 2. Open-at-night places from the Google Maps Scraper.
if (google_maps) {
    try {
        const run = await Actor.call('compass/crawler-google-places', {
            searchStringsArray: ['24 hour gas station', '24 hour convenience store', '24 hour restaurant', 'hospital emergency room', '24 hour pharmacy', 'train station'],
            customGeolocation: { type: 'Point', coordinates: [String(lng), String(lat)], radiusKm: radius_mi * 1.609 },
            maxCrawledPlacesPerSearch: max_per_search, language: 'en', skipClosedPlaces: true, maxReviews: 0, maxImages: 0,
        });
        const { items } = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems();
        const seen = new Set();
        for (const it of items) {
            const loc = it.location || {};
            if (it.isAdvertisement || it.permanentlyClosed || it.temporarilyClosed || loc.lat == null) continue;
            const name = String(it.title || '').trim(); if (!name || seen.has(name.toLowerCase())) continue; seen.add(name.toLowerCase());
            const hours = hoursSpec(it.openingHours);
            rows.push({ category: cat(name, String(it.categoryName || '')), name, lat: loc.lat, lng: loc.lng, distance_mi: +haversine(lat, lng, loc.lat, loc.lng).toFixed(2), phone: String(it.phone || ''), hours, open_24h: hours === '24/7', address: String(it.address || ''), source: 'google_maps' });
        }
    } catch (e) { console.warn('google maps scraper failed', e.message); }
}

// 3. Familiar places with distances, in the caregiver's order.
for (const f of familiar_places) if (typeof f.lat === 'number') rows.push({ category: 'familiar', name: f.name, lat: f.lat, lng: f.lng, distance_mi: +haversine(lat, lng, f.lat, f.lng).toFixed(2), phone: '', hours: '', open_24h: false, source: 'caregiver' });

rows.sort((a, b) => a.distance_mi - b.distance_mi);
await Actor.pushData(rows);
await Actor.setValue('SUMMARY', { home: { lat, lng, radius_mi }, hazards: rows.filter((r) => ['water', 'rail', 'motorway', 'construction'].includes(r.category)).length, open_places: rows.filter((r) => r.source === 'google_maps').length, familiar: familiar_places.length });
await Actor.exit();
