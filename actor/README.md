# night-search-radius

Everything a family needs in the first minutes after a person with dementia walks out: within a radius of the home,
the places to **check first** (water, rail lines, freeway ramps, construction, from OpenStreetMap), the places to
**call first** (24-hour gas stations, stores, diners, ER, pharmacy, transit, with phone numbers and hours, from Apify's
Google Maps Scraper), and the person's **familiar places** with distances.

Input: `{lat, lng, radius_mi, familiar_places[], google_maps, max_per_search}`.
Output dataset rows: `{category, name, lat, lng, distance_mi, phone, hours, open_24h, address?, source}`.

Built for [Nightfall](https://github.com/evanoctave/calhack-) at Cal Hacks 13.0: the product runs this Actor once at
setup for the home address and caches the result, never at 2 AM.
