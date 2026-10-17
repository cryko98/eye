/**
 * /api/config — public, browser-side keys read from Vercel environment variables, so none of
 * them has to live in the repository. Only keys that are meant to be used from the browser
 * (and therefore must be domain-restricted at the provider) are exposed here:
 *   CESIUM_ION_TOKEN      Cesium ion (3D terrain + OSM buildings)
 *   GOOGLE_MAPS_API_KEY   Google Photorealistic 3D Tiles / Street View Embed API
 *   TOMTOM_KEY            TomTom traffic flow tiles
 * Server-only secrets (OPENSKY_*, WINDY_API_KEY, REWARD_SECRET_KEY, ...) are never returned.
 */
module.exports = function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600, max-age=60");
  res.statusCode = 200;
  res.end(JSON.stringify({
    cesiumIonToken: process.env.CESIUM_ION_TOKEN || "",
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
    tomtomKey: process.env.TOMTOM_KEY || "",
  }));
};
