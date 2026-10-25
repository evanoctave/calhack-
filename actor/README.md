# Night search radius for a missing person with dementia

**Type a home address. Get the search plan a family, a neighbor or a deputy needs in the first hour after someone with dementia walks out at night:** the dangers to check first, the places from their past they may be heading for, and the open-all-night places to call, each with distance, phone, hours and a map link.

Six in ten people living with dementia will wander at least once ([Alzheimer's Association](https://www.alz.org/help-support/caregiving/stages-behaviors/wandering)). If they are not found within 24 hours, up to half are seriously hurt or die. Most are found within 1.5 miles of where they went missing, often near water, roads or a place they used to go. This Actor turns that knowledge into a ready list for one home: hazards in seconds, the full list with phone numbers in two to three minutes.

## What you get

| Section | What's in it | Why it comes first |
|---|---|---|
| **Check first** | Water (creeks, ponds, lagoons, canals), rail lines, freeway ramps, construction sites, from OpenStreetMap | These are where wandering cases turn fatal |
| **Familiar** | The places you list: an old job, a church, a childhood street | People with dementia head for places from their past |
| **Call first** | 24-hour gas stations and stores, diners, the ER, pharmacies, transit stations, with phone numbers and today's hours, from Apify's Google Maps Scraper | Lit and staffed at 2 AM; one call can end the search |

Every row has a plain-language **why** line, so the list can be read aloud to a volunteer or a dispatcher.

## How to use it

1. Enter the **home address** (or exact latitude and longitude).
2. Optional: add **familiar places** as `{name, lat, lng}`.
3. Run. Open the **Search plan** view in the dataset, or read the `SUMMARY` record for a one-paragraph brief.

Leave **Find places open at night** off for a free, hazards-only run (OpenStreetMap only, about 5 seconds).

## Input example

```json
{
  "address": "3601 Lyon St, San Francisco, CA",
  "radius_mi": 1.5,
  "familiar_places": [{ "name": "Old office, Chestnut St", "lat": 37.8005, "lng": -122.4382 }],
  "google_maps": true
}
```

## Output example

Real rows from a run on the default input (49 rows, about 2.5 minutes, under one cent). Sorted check first → familiar → call first; call-first places open 24 hours come before the rest, then nearest first:

```json
{
  "section": "check_first",
  "category": "water",
  "name": "Shoreline",
  "distance_mi": 0.08,
  "phone": "",
  "hours": "",
  "open_24h": false,
  "address": "",
  "why": "Drowning is a leading cause of death in wandering cases; check banks and edges first.",
  "maps_url": "https://www.google.com/maps/search/?api=1&query=37.8053699,-122.4471681",
  "lat": 37.8053699,
  "lng": -122.4471681,
  "source": "overpass"
}
```

```json
{
  "section": "call_first",
  "category": "fuel",
  "name": "Fuel 24:7 - Lombard",
  "distance_mi": 0.46,
  "phone": "(415) 921-1132",
  "hours": "24/7",
  "open_24h": true,
  "address": "2601 Lombard St, San Francisco, CA 94123",
  "why": "Open all night and lit; staff see walkers. Call and describe the person.",
  "maps_url": "https://www.google.com/maps/search/?api=1&query=37.7985302,-122.4445552",
  "lat": 37.7985302,
  "lng": -122.4445552,
  "source": "google_maps"
}
```

`SUMMARY` key-value record:

```json
{
  "home": {
    "lat": 37.8045628,
    "lng": -122.4481491,
    "address": "3601, Lyon Street, Harbor District, San ...",
    "radius_mi": 1.5
  },
  "check_first": 21,
  "call_first": 27,
  "familiar": 1,
  "brief": "Check first: Beach (0.07 mi), Shoreline (0.08 mi), East Beach (0.15 mi). Familiar: Old office, Chestnut St (0.61 mi). Call first: Fuel 24:7 - Lombard (0.46 mi), Chevron (0.97 mi), ExtraMile (0.97 mi)."
}
```

## Who it's for

- **Families caring for a parent with dementia at home.** Run it once for the house; keep the list on the fridge and in your phone.
- **Search and rescue teams and sheriff's offices.** A first-hour hasty-search list for any address, before a full search plan exists.
- **Memory care communities and adult day centers.** One list per site for staff drills and real incidents.
- **Apps and devices** for caregivers (GPS trackers, door sensors, doorbell cameras) that need a search plan through an API.

## Use it from code

```bash
curl -X POST "https://api.apify.com/v2/acts/evanoctave~night-search-radius/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"address": "3601 Lyon St, San Francisco, CA", "radius_mi": 1.5}'
```

```python
from apify_client import ApifyClient
run = ApifyClient(TOKEN).actor("evanoctave/night-search-radius").call(run_input={"address": "3601 Lyon St, San Francisco, CA"})
for place in ApifyClient(TOKEN).dataset(run["defaultDatasetId"]).iterate_items():
    print(place["section"], place["name"], place["distance_mi"], place["phone"])
```

## Cost

Hazards come from the public Overpass API and cost nothing beyond Actor compute (a few seconds). With **Find places open at night** on, the Actor calls the Google Maps Scraper for six searches (6 places each by default), typically a few cents per run. Run it once per home and cache the result; the places don't change overnight.

## Built for Nightfall

This Actor powers the search section of [Nightfall](https://github.com/evanoctave/calhack-) (Cal Hacks 13.0), a doorbell-camera guardian for families keeping a parent with dementia at home. When the person leaves at night, Nightfall speaks to them at the door, calls the family one by one, and hands whoever answers a missing-person brief. This Actor's output is that brief's "where to look and whom to call" section, computed at setup so nothing waits on the network at 2 AM.

## Limits

- OpenStreetMap coverage varies; unnamed creeks show as "stream channel" and similar.
- Hours are for today, from Google Maps; call to confirm.
- This is a search aid, not an emergency service. **If someone is missing, call 911 first** and say "missing and at risk, has dementia".
