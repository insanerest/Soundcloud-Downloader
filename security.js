const MAX_CACHE_ENTRIES = 500;

function setBoundedCache(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

function validateTrackUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Invalid SoundCloud track URL.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid SoundCloud track URL.");
  }
  const host = parsed.hostname.toLowerCase();
  const isSoundCloudHost =
    host === "soundcloud.com" || host.endsWith(".soundcloud.com");
  if (
    parsed.protocol !== "https:" ||
    !isSoundCloudHost ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443")
  ) {
    throw new Error("Only HTTPS SoundCloud URLs are accepted.");
  }
  return parsed.href;
}

function validateStreamUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid resolved stream URL.");
  }
  const host = parsed.hostname.toLowerCase();
  const allowedHost =
    host === "soundcloud.com" ||
    host.endsWith(".soundcloud.com") ||
    host === "sndcdn.com" ||
    host.endsWith(".sndcdn.com");
  if (
    parsed.protocol !== "https:" ||
    !allowedHost ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443")
  ) {
    throw new Error("Resolved stream host is not allowed.");
  }
  return parsed.href;
}

module.exports = { setBoundedCache, validateTrackUrl, validateStreamUrl };
