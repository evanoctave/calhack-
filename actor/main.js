// night-search-radius: everything a family needs to search for a missing person with dementia around a home.
// Hazards (water, rail, motorway, construction) from OpenStreetMap Overpass; open-at-night places with phones
// and hours from Apify's Google Maps Scraper; familiar places pinned with distances. Runs at setup, cached by Nightfall.
import { Actor, log } from 'apify';

const UA = 'nightfall-night-search-radius/0.2 (+https://github.com/evanoctave/calhack-)';
const R_EARTH_MI = 3958.8;
const haversine = (a, b, c, d) => {
    const p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dp = (c - a) * Math.PI / 180, dl = (d - b) * Math.PI / 180;
    const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R_EARTH_MI * Math.asin(Math.sqrt(x));
};
const HAZARDS = ['water', 'rail', 'motorway', 'construction'];
const WHY = {
    water: 'Drowning is a leading cause of death in wandering cases; check banks and edges first.',
    rail: 'People follow tracks as a path; check crossings and the right-of-way.',
    motorway: 'On-ramps draw walkers onto the freeway shoulder.',
    construction: 'Open trenches and unlit sites; easy to fall or hide in.',
    fuel: 'Open all night and lit; staff see walkers. Call and describe the person.',
    convenience: 'Open all night and lit; staff see walkers. Call and describe the person.',
    diner: 'Somewhere warm to sit; ask staff to check the room.',
    hospital: 'Found persons are often brought here; call the ER desk.',
    pharmacy: 'Familiar errand; ask staff to check the store.',
    transit: 'People board buses and trains to go "home" or "to work"; call the station.',
    familiar: 'People with dementia head for places from their past; check here early.',
};
const SEARCHES = { '24 hour gas station': 'fuel', '24 hour convenience store': 'convenience', '24 hour restaurant': 'diner',
    'hospital emergency room': 'hospital', '24 hour pharmacy': 'pharmacy', 'train station': 'transit' };
const CATS = [[/gas station|fuel|petrol/i, 'fuel'], [/pharmacy|drug ?store/i, 'pharmacy'], [/hospital|emergency|urgent care/i, 'hospital'],
    [/convenience|grocery|supermarket|market|7-?eleven/i, 'convenience'], [/train|transit|bus|metro|station|railway|muni/i, 'transit'],
    [/restaurant|diner|cafe|coffee|fast food|donut|taco|burger|pizza/i, 'diner']];
const NOT_FOR_PEOPLE = /veterinar|animal|pet |pet$|dental|dentist|optometr|chiropract|physical therapy/i;
const cat = (it) => {
    const c = String(it.categoryName || ''), name = String(it.title || '');
    return (CATS.find(([re]) => re.test(c)) || CATS.find(([re]) => re.test(name)) || [null, SEARCHES[it.searchString] || 'diner'])[1];
};
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
const mapsUrl = (la, ln) => `https://www.google.com/maps/search/?api=1&query=${la},${ln}`;
const row = (o, home) => {
    const distance_mi = +haversine(home.lat, home.lng, o.lat, o.lng).toFixed(2);
    const section = HAZARDS.includes(o.category) ? 'check_first' : o.category === 'familiar' ? 'familiar' : 'call_first';
    return { section, category: o.category, name: o.name, distance_mi, phone: o.phone || '', hours: o.hours || '', open_24h: !!o.open_24h,
        address: o.address || '', why: WHY[o.category] || '', maps_url: mapsUrl(o.lat, o.lng), lat: o.lat, lng: o.lng, source: o.source };
};

async function geocode(address) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const [hit] = await r.json();
    if (!hit) throw new Error(`Could not find the address "${address}". Try adding the city and state, or give lat and lng.`);
    return { lat: +hit.lat, lng: +hit.lon, label: hit.display_name };
}

async function overpass(q) {
    for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
        try {
            const r = await fetch(host, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': UA } });
            if (r.ok) return (await r.json()).elements || [];
            log.warning(`overpass ${host} returned ${r.status}`);
        } catch (e) { log.warning(`overpass ${host} failed: ${e.message}`); }
    }
    return [];
}

await Actor.init();
const input = await Actor.getInput() ?? {};
const { address = '', radius_mi = 1.5, familiar_places = [], google_maps = true, max_per_search = 6 } = input;
let { lat, lng } = input;
let label = '';
if (typeof lat !== 'number' || typeof lng !== 'number') {
    if (!address.trim()) throw new Error('Give a home address, or lat and lng.');
    ({ lat, lng, label } = await geocode(address.trim()));
    log.info(`geocoded "${address}" -> ${lat}, ${lng} (${label})`);
}
const home = { lat, lng };
const radiusM = Math.round(radius_mi * 1609.34);
const raw = [];

// 1. Hazards from Overpass.
const around = `(around:${radiusM},${lat},${lng})`;
const q = `[out:json][timeout:25];(way["waterway"~"^(river|stream|canal|ditch|drain)$"]${around};nwr["natural"~"^(water|bay|beach)$"]${around};way["natural"="coastline"]${around};way["railway"="rail"]${around};way["highway"~"^motorway"]${around};way["landuse"="construction"]${around};);out tags geom 120;`;
const WATERWAY = { river: 'River', stream: 'Creek', canal: 'Canal', ditch: 'Drainage ditch', drain: 'Storm drain channel' };
for (const e of await overpass(q)) {
    // Nearest point of the feature, so a long shoreline or freeway counts at its closest edge, not its middle.
    const pts = e.geometry || (e.members || []).flatMap((m) => m.geometry || []) || [];
    if (e.lat != null) pts.push({ lat: e.lat, lon: e.lon });
    const c = pts.filter((p) => p && p.lat != null).reduce((best, p) => (!best || haversine(lat, lng, p.lat, p.lon) < haversine(lat, lng, best.lat, best.lon) ? p : best), null);
    if (!c) continue;
    const t = e.tags || {};
    let category, name;
    if (t.waterway) { category = 'water'; name = t.name || WATERWAY[t.waterway] || 'Creek'; }
    else if (t.natural === 'coastline' || t.natural === 'bay') { category = 'water'; name = t.name || 'Shoreline'; }
    else if (t.natural === 'beach') { category = 'water'; name = t.name || 'Beach'; }
    else if (t.natural === 'water') { category = 'water'; name = t.name || ({ pond: 'Pond', lake: 'Lake', reservoir: 'Reservoir', lagoon: 'Lagoon', basin: 'Retention basin', canal: 'Canal' }[t.water] || 'Pond'); }
    else if (t.railway === 'rail') { category = 'rail'; name = t.name || 'Rail line'; }
    else if (String(t.highway || '').startsWith('motorway')) { category = 'motorway'; name = t.name || t.ref || 'Freeway on-ramp'; }
    else if (t.landuse === 'construction') { category = 'construction'; name = t.name || 'Construction site'; }
    else continue;
    const d = haversine(lat, lng, c.lat, c.lon);
    const named = !!(t.name || t.ref);
    const dup = raw.findIndex((p) => p.name === name && (named || haversine(p.lat, p.lng, c.lat, c.lon) < 0.4));
    if (dup >= 0) { if (d < haversine(lat, lng, raw[dup].lat, raw[dup].lng)) raw[dup] = { ...raw[dup], lat: c.lat, lng: c.lon }; continue; }
    raw.push({ category, name, lat: c.lat, lng: c.lon, source: 'overpass' });
}
log.info(`overpass: ${raw.length} hazards`);

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
            if (NOT_FOR_PEOPLE.test(`${it.title} ${it.categoryName}`)) continue;
            const name = String(it.title || '').trim(); if (!name || seen.has(name.toLowerCase())) continue; seen.add(name.toLowerCase());
            const hours = hoursSpec(it.openingHours);
            raw.push({ category: cat(it), name, lat: loc.lat, lng: loc.lng, phone: String(it.phone || ''), hours, open_24h: hours === '24/7', address: String(it.address || ''), source: 'google_maps' });
        }
        log.info(`google maps: ${raw.filter((r) => r.source === 'google_maps').length} open places`);
    } catch (e) { log.warning(`google maps scraper failed: ${e.message}`); }
}

// 3. Familiar places with distances, in the caregiver's order.
for (const f of familiar_places) if (typeof f.lat === 'number' && typeof f.lng === 'number') raw.push({ category: 'familiar', name: f.name, lat: f.lat, lng: f.lng, source: 'caregiver' });

const order = { check_first: 0, familiar: 1, call_first: 2 };
const rows = raw.map((o) => row(o, home)).filter((r) => r.distance_mi <= radius_mi * 1.25 || r.section === 'familiar')
    .sort((a, b) => order[a.section] - order[b.section] || (a.section === 'call_first' && b.open_24h - a.open_24h) || a.distance_mi - b.distance_mi);
await Actor.pushData(rows);

const count = (s) => rows.filter((r) => r.section === s).length;
const near = (s, n = 3) => rows.filter((r) => r.section === s).slice(0, n).map((r) => `${r.name} (${r.distance_mi} mi)`).join(', ');
await Actor.setValue('SUMMARY', {
    home: { lat, lng, address: label || address || null, radius_mi },
    check_first: count('check_first'), call_first: count('call_first'), familiar: count('familiar'),
    brief: [count('check_first') && `Check first: ${near('check_first')}.`, count('familiar') && `Familiar: ${near('familiar')}.`,
        count('call_first') && `Call first: ${near('call_first')}.`].filter(Boolean).join(' '),
});
log.info(`done: ${rows.length} rows`);
await Actor.exit();
