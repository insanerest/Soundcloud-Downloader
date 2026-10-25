const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTrackUrl, validateStreamUrl, setBoundedCache } = require("../security");

test("accepts HTTPS SoundCloud track URLs", () => {
  assert.equal(validateTrackUrl("https://soundcloud.com/artist/track"), "https://soundcloud.com/artist/track");
  assert.equal(validateTrackUrl("https://m.soundcloud.com/artist/track"), "https://m.soundcloud.com/artist/track");
});

test("rejects non-SoundCloud, non-HTTPS and credentialed track URLs", () => {
  for (const value of [
    "http://soundcloud.com/artist/track",
    "https://example.com/track",
    "https://soundcloud.com.evil.example/track",
    "https://user:pass@soundcloud.com/track",
    "not a URL",
    "x".repeat(2049),
  ]) assert.throws(() => validateTrackUrl(value));
});

test("accepts trusted SoundCloud CDN stream URLs only", () => {
  assert.equal(validateStreamUrl("https://cf-media.sndcdn.com/stream"), "https://cf-media.sndcdn.com/stream");
  assert.throws(() => validateStreamUrl("http://sndcdn.com/stream"));
  assert.throws(() => validateStreamUrl("https://127.0.0.1/private"));
  assert.throws(() => validateStreamUrl("https://sndcdn.com.evil.example/stream"));
});

test("bounded cache evicts oldest entries", () => {
  const cache = new Map();
  for (let i = 0; i < 502; i++) setBoundedCache(cache, String(i), i);
  assert.equal(cache.size, 500);
  assert.equal(cache.has("0"), false);
  assert.equal(cache.get("501"), 501);
});
