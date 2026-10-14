# God's Eye View — $EYE

Single-screen site for the **$EYE** memecoin on Solana: a live 3D globe (CesiumJS) with real satellite imagery, a day-night terminator with city lights, live ADS-B aircraft, satellites propagated from CelesTrak elements, USGS earthquakes, RainViewer weather radar, the submarine cable map and 16,867 real public cameras in 21 networks on five continents. Everything else (intel, tokenomics, how to buy, roadmap, cameras, contacts, socials) opens in floating windows over the globe. No scrolling.

Inspired by the look and feature set of the open-source [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) project; rebuilt from scratch as a static site plus two small serverless functions.

## Edit before launch

Open `script.js` and fill in the `CONFIG` block at the top:

```js
const CONFIG = {
  contractAddress: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxx",   // paste the real CA here
  links: {
    buy: "https://pump.fun",                          // swap / pump.fun link
    chart: "https://dexscreener.com/solana",
    x: "https://x.com",
    telegram: "https://t.me",
  },
  cesiumIonToken: "",      // optional, free: real 3D terrain + OSM 3D buildings
  googleMapsApiKey: "",    // optional: Google Photorealistic 3D Tiles
  ...
};
```

The CA shows in the top bar, the mission card, the Tokenomics and How-to-buy windows, and every COPY button copies it.

## What is on the globe

| Layer | Source | Notes |
| --- | --- | --- |
| Aircraft | OpenSky Network via `api/flights.js` (adsb.lol fallback) | up to 6,000 contacts, refreshed every minute, dead-reckoned in between; click, follow or ride in the cockpit |
| Cameras | 21 public networks, `cameras.json` | North America: Georgia, Pennsylvania, Arizona, Nevada, Louisiana, Alaska, Oregon, Austin, Ontario, Alberta, British Columbia, Calgary. Europe: London, Norway, Finland, Estonia, Tallinn. Asia-Pacific: Hong Kong, Singapore, Sydney/NSW, New Zealand. Estonian and Singapore frames resolve through `api/estonia.js` and `api/singapore.js` |
| Satellites | CelesTrak `stations` + `visual` TLEs, satellite.js | ISS, Tiangong, Hubble labelled; follow and cockpit modes |
| Earthquakes | USGS M2.5+ past 24 h | sized by magnitude |
| Radar | RainViewer | latest frame, refreshed every 10 min while on |
| Night lights | NASA GIBS VIIRS Black Marble | shown only on the dark side |
| Cables | TeleGeography submarine cable map | loaded on demand |
| Imagery | Esri World Imagery (NASA Blue Marble fallback) | |

Views: 3D oblique, top-down north-up, flat 2D map. Sensors: EO, FLIR, NVG, CRT. Search accepts `lat, lon`, a bundled city name or any place (Photon / OpenStreetMap). SHARE copies a link that restores camera, layers, sensor and tracked target.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Globe, HUD, mission card, controls and every window |
| `style.css` | Theme, windows, responsive rules (windows become bottom sheets under 820 px) |
| `script.js` | Config, Cesium globe, layers, sensors, views, search, share, windows |
| `api/flights.js` | Vercel function: proxies and caches OpenSky state vectors |
| `api/estonia.js` | Vercel function: latest Estonian camera frame URLs |
| `api/singapore.js` | Vercel function: latest Singapore (LTA) camera frame URLs |
| `api/windy.js` | Vercel function (optional, needs `WINDY_API_KEY`): nearby worldwide webcams from Windy.com |
| `cameras.json` | Camera catalog (source templates + compact rows) |
| `dev-server.js` | Local dev server (static files + `/api/*`) |
| `logo.svg`, `og.png` | Favicon / logo and social share image |
| `vercel.json` | Cache headers |

## Run locally

```bash
npm run dev
```

Then open http://localhost:5173.

## Deploy on Vercel

Import the GitHub repo. Framework preset **Other**, no build command, output directory root. The `api/` folder is picked up automatically as serverless functions.

Optional environment variables:

- `WINDY_API_KEY`: a free key from https://api.windy.com/keys turns on the **WEBCAMS HERE** button and the `api/windy.js` function, which pulls Windy.com webcams (tens of thousands worldwide, including Africa, Asia and South America) around the current view and around every search result. Attribution "Webcams by Windy.com" is shown in the Socials window.
- `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` (OAuth2 client credentials from a free OpenSky account) raise the aircraft-feed quota. Without them anonymous access is used and, if OpenSky throttles, the function falls back to adsb.lol samples around major hubs.

## Data credits

OpenSky Network, adsb.lol, CelesTrak, USGS, RainViewer, TeleGeography, Georgia 511, PennDOT 511PA, ADOT AZ511, NDOT Nevada Roads, Louisiana 511, Alaska 511, Ontario 511 (OGL Ontario), Alberta 511, DriveBC (OGL BC), NZTA, LTA via data.gov.sg, TfL Open Data, Hong Kong Transport Department (data.gov.hk), Live Traffic NSW (CC BY 4.0), City of Austin Open Data, Oregon DOT TripCheck, Open Calgary, Statens vegvesen (NLOD 2.0), Fintraffic Digitraffic (CC BY 4.0), Transpordiamet / Tarktee, City of Tallinn, Esri and partners, NASA GIBS, Photon (komoot), CesiumJS.
