# Crude Maps

<img src="public/brand/logo.png" alt="Crude Maps logo" width="220">

A phone web app (installable on iPhone) for finding oil field locations and getting driving directions to them.

- Search 560 locations by name or operator, or sort by nearest to you.
- Pick a location and tap **Get directions** to see the route on a Google map, with a step list.
- Tap **Start** for live turn-by-turn guidance with voice. The screen stays on while you drive.
- When a pin is past the end of the mapped roads, a dashed line shows the last stretch.
- Map layers: Hybrid (the default), Map, Satellite, Terrain, plus Traffic and location names.
- Hand off to Google Maps, Apple Maps or Waze with one tap.
- **Live trucks** from Samsara: each truck's position, heading, speed and address, refreshed every 15 seconds.
  Tap a truck for details or directions to it. Locked behind a passcode.
- Star locations to keep them on the Saved tab. The list works offline once the app has loaded.

## How it runs

`server.js` is a small Node server with no dependencies. It serves the files in `public/` and gives the
browser the Google Maps key from an environment variable, so the key is never stored in this repo.

Start it with `npm start` (or `node server.js`). It listens on `PORT`, or 5000 by default.

### Secrets (set these in Replit Secrets, never in the code)

| Name | Required | What it is |
| --- | --- | --- |
| `GOOGLE_MAPS_API_KEY` | Yes | Google Maps Platform key with **Maps JavaScript API** and **Routes API** enabled |
| `GOOGLE_MAP_ID` | No | A Map ID from Google Cloud. Defaults to Google's demo map ID |
| `SAMSARA_API_TOKEN` | For live trucks | Samsara API token. Read-only access to vehicle stats is enough |
| `APP_PASSCODE` | For live trucks | Passcode the app asks for before it shows trucks. Pick something hard to guess |
| `SAMSARA_API_BASE` | No | Only for EU Samsara accounts: `https://api.eu.samsara.com` |

The Samsara token never leaves the server. Phones get truck positions from `/api/trucks`, which needs the
passcode and locks a device out for 15 minutes after 8 wrong tries. Samsara is asked at most once every 10 seconds.

### Protect the Google key

The key is visible to anyone who opens the website, which is normal for Google Maps on the web.
In Google Cloud Console, under Credentials, open the key and set:

- **Application restrictions:** Websites, set to your app's address (for example `https://crude-maps-yourname.replit.app/*`)
- **API restrictions:** Maps JavaScript API and Routes API only

## Updating the locations

Replace the spreadsheet, then run:

```
python3 tools/update_locations.py path/to/LocationsandOperators.xlsx
```

That rewrites `public/locations.js`. The first sheet needs the columns `name, lat, long, operator`.
After any file change, bump `VERSION` in `public/sw.js` so installed phones pick up the new copy.
