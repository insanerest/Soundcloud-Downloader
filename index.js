const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const { App } = require("volten");

const ffmpegPath = process.env.FFMPEG_BIN || require("ffmpeg-static");

// --- Configuration ---
const PORT = process.env.PORT || 3009;
const ytDlpPath = process.env.YT_DLP_PATH || path.join(__dirname, "bin", "yt-dlp");

// Ensure Environment / Client ID
let clientId = process.env.SOUNDCLOUD_CLIENT_ID;
if (!clientId) {
  try {
    process.loadEnvFile();
    clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  } catch {}
}
if (!clientId) {
  throw new Error("Client ID was not provided in env");
}

const app = new App();
app.static(path.join(__dirname, "public"));

// --- In-Memory Caches for Semi-Instant Streaming & Resolution ---
const streamUrlCache = new Map(); // trackUrl -> { streamUrl, isHls, type, title, artist, expiresAt }
const trackMetaCache = new Map(); // permalink_url -> { media, track_authorization, title, username, duration }

const MAX_CACHE_ENTRIES = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const PROCESS_TIMEOUT_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();

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
    host === "soundcloud.com" ||
    host.endsWith(".soundcloud.com");
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

async function fetchTimed(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Redirects from an allowed SoundCloud API endpoint must not be trusted blindly.
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (
      finalUrl.protocol !== "https:" ||
      !(finalUrl.hostname === "soundcloud.com" ||
        finalUrl.hostname.endsWith(".soundcloud.com") ||
        finalUrl.hostname === "sndcdn.com" ||
        finalUrl.hostname.endsWith(".sndcdn.com"))
    ) {
      await response.body?.cancel();
      throw new Error("Unexpected redirect host.");
    }
  }
  return response;
}

function allowRequest(ctx, limit) {
  const ip = ctx.req?.socket?.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 2000) {
    for (const [key, entry] of rateBuckets) {
      if (now - entry.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  if (bucket.count > limit) {
    ctx.status(429).json({ error: "Too many requests. Please retry shortly." });
    return false;
  }
  return true;
}

// --- Helper: Resolve Stream URL via yt-dlp (Fallback) ---
async function resolveStreamUrlWithYtDlp(trackUrl) {
  const safeTrackUrl = validateTrackUrl(trackUrl);
  return new Promise((resolve, reject) => {
    const yt = spawn(ytDlpPath, [
      "-g",
      "-f",
      "ba[ext=mp3][protocol=https]/ba[ext=mp3]/ba",
      safeTrackUrl,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "";

    const timeout = setTimeout(() => {
      yt.kill("SIGKILL");
      reject(new Error("yt-dlp timed out."));
    }, PROCESS_TIMEOUT_MS);
    yt.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > 16_384) yt.kill("SIGKILL");
    });
    yt.stderr.on("data", (d) => (err += d.toString()));

    yt.on("close", (code) => {
      clearTimeout(timeout);
      const url = out.trim();
      if (code === 0 && url) {
        try { resolve(validateStreamUrl(url)); } catch (error) { reject(error); }
      }
      else reject(new Error(`yt-dlp exited with code ${code}: ${err.trim()}`));
    });
    yt.on("error", (e) =>
      reject(new Error(`yt-dlp spawn error: ${e.message}`)),
    );
  });
}

// --- Helper: Fast Track & Stream URL Resolution ---
async function resolveTrackStream(trackUrl) {
  trackUrl = validateTrackUrl(trackUrl);
  // Check memory cache first (15-min TTL)
  const cached = streamUrlCache.get(trackUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  // 1. Direct SoundCloud API resolution (semi-instant ~150-300ms)
  try {
    let trackMeta = trackMetaCache.get(trackUrl);
    if (!trackMeta || !trackMeta.media) {
      const resolveApiUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(trackUrl)}&client_id=${clientId}`;
      const resolveRes = await fetchTimed(resolveApiUrl);
      if (resolveRes.ok) {
        const d = await resolveRes.json();
        if (d && d.media && Array.isArray(d.media.transcodings)) {
          trackMeta = {
            media: d.media,
            track_authorization: d.track_authorization,
            title: d.title,
            username: d.user?.username || "",
            duration: d.duration,
          };
          setBoundedCache(trackMetaCache, trackUrl, trackMeta);
        }
      }
    }

    if (trackMeta && Array.isArray(trackMeta.media?.transcodings)) {
      const transcodings = trackMeta.media.transcodings;
      const fullTracks = transcodings.filter((t) => !t.snipped);
      const pool = fullTracks.length > 0 ? fullTracks : transcodings;

      // Prefer progressive MP3 > HLS AAC > other
      const sorted = [...pool].sort((a, b) => {
        const aScore =
          (a.format?.protocol === "progressive" ? 10 : 0) +
          (a.preset?.includes("aac") ? 5 : 0);
        const bScore =
          (b.format?.protocol === "progressive" ? 10 : 0) +
          (b.preset?.includes("aac") ? 5 : 0);
        return bScore - aScore;
      });

      for (const candidate of sorted) {
        try {
          const authParam = trackMeta.track_authorization
            ? `&track_authorization=${trackMeta.track_authorization}`
            : "";
          const streamReqUrl = `${candidate.url}?client_id=${clientId}${authParam}`;
          const sRes = await fetchTimed(streamReqUrl);
          if (sRes.ok) {
            const sData = await sRes.json();
            if (sData.url) {
              const isHls =
                candidate.format?.protocol === "hls" ||
                /\.m3u8/i.test(sData.url);
              const streamUrl = validateStreamUrl(sData.url);
              const mimeType = candidate.format?.mime_type || "";
              const isMp3 = /audio\\/(mpeg|mp3)/i.test(mimeType) || /mp3/i.test(candidate.preset || "");
              const result = {
                streamUrl,
                isMp3,
                isHls,
                type: isHls ? "hls" : "progressive",
                title: trackMeta.title,
                artist: trackMeta.username,
                expiresAt: Date.now() + 15 * 60 * 1000,
              };
              setBoundedCache(streamUrlCache, trackUrl, result);
              return result;
            }
          }
        } catch {}
      }
    }
  } catch (err) {
    console.warn("SoundCloud direct resolution notice:", err.message);
  }

  // 2. Fallback to yt-dlp if direct API resolution failed
  try {
    const ytUrl = await resolveStreamUrlWithYtDlp(trackUrl);
    const isHls = /\.m3u8/i.test(ytUrl);
    const result = {
      streamUrl: validateStreamUrl(ytUrl),
      isMp3: false,
      isHls,
      type: isHls ? "hls" : "progressive",
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
    streamUrlCache.set(trackUrl, result);
    return result;
  } catch (err) {
    throw new Error(`Failed to resolve track stream: ${err.message}`);
  }
}

// --- Routes ---

app.get("/", (ctx) => {
  ctx.sendFile(path.join(__dirname, "public", "index.html"));
});

// Search SoundCloud
app.get("/api/search", async (ctx) => {
  if (!allowRequest(ctx, 60)) return;
  const query = ctx.query.q;
  if (!query || typeof query !== "string" || query.length > 100) {
    return ctx.status(400).json({ error: "Invalid query parameter." });
  }

  try {
    const res = await fetchTimed(
      `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=20`,
    );
    if (!res.ok) throw new Error(`SoundCloud search returned ${res.status}`);
    const data = await res.json();
    const collection = Array.isArray(data.collection) ? data.collection : [];

    // Filter and map tracks, and prime trackMetaCache for instant streaming
    const results = [];
    for (const t of collection) {
      if (t.kind === "track" && (t.artwork_url || t.user?.avatar_url)) {
        if (t.permalink_url && t.media) {
          try { validateTrackUrl(t.permalink_url); } catch { continue; }
          setBoundedCache(trackMetaCache, t.permalink_url, {
            media: t.media,
            track_authorization: t.track_authorization,
            title: t.title,
            username: t.user?.username || "",
            duration: t.duration,
          });
        }
        results.push({
          username: t.user?.username || "Unknown",
          title: t.title,
          url: t.permalink_url,
          img: t.artwork_url || t.user?.avatar_url || "/blur.png",
        });
      }
    }

    ctx.json({ length: results.length, results });
  } catch (err) {
    console.error("Search error:", err);
    ctx.status(500).json({ error: "SoundCloud fetch failed." });
  }
});

// Endpoint for instant client-side streaming info (Zero disk usage)
app.get("/api/stream-info", async (ctx) => {
  if (!allowRequest(ctx, 30)) return;
  const url = ctx.query.url;
  if (!url) return ctx.status(400).json({ error: "Missing URL parameter." });

  try {
    const info = await resolveTrackStream(validateTrackUrl(url));
    return ctx.json({
      type: info.type,
      isHls: info.isHls,
      isMp3: info.isMp3,
      streamUrl: info.streamUrl,
      title: info.title,
      artist: info.artist,
    });
  } catch (err) {
    console.error("Stream info error:", err.message);
    return ctx.status(500).json({ error: "Failed to resolve stream URL." });
  }
});

// Main Stream/Download Handler (100% Diskless Pass-Through Streaming)
async function handleDownloadStream(ctx) {
  if (!allowRequest(ctx, 30)) return;
  let url = ctx.query.url;
  let name = ctx.query.name;

  if (ctx.method === "POST") {
    try {
      const body = await ctx.body();
      url = url || body?.url;
      name = name || body?.name;
    } catch {}
  }

  if (!url) return ctx.status(400).json({ error: "Missing URL parameter." });

  let trackUrl;
  try {
    trackUrl = validateTrackUrl(url);
  } catch {
    return ctx.status(400).json({ error: "Only valid HTTPS SoundCloud track URLs are accepted." });
  }

  const safeName = String(name || "track")
    .replace(/[\\/\\?%*:|"< >\\x00-\\x1f\\x7f]/g, "_")
    .replace(/\\s+/g, " ")
    .slice(0, 160) || "track";
  const fileName = `${safeName}.mp3`;
  const isAttachment = ctx.query.download === "1" || ctx.query.download === "true";
  const contentDisposition = `${isAttachment ? "attachment" : "inline"}; filename="track.mp3"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

  let streamInfo;
  try {
    streamInfo = await resolveTrackStream(trackUrl);
  } catch (err) {
    console.error("Track resolution error:", err.message);
    return ctx.status(502).json({ error: "Failed to resolve track URL." });
  }

  let resolvedUrl;
  try {
    resolvedUrl = validateStreamUrl(streamInfo.streamUrl);
  } catch {
    return ctx.status(502).json({ error: "Resolved stream URL was rejected." });
  }

  const res = ctx.res;
  const shouldTranscode = streamInfo.isHls || !streamInfo.isMp3;
  if (res?.socket) {
    try { res.socket.setNoDelay(true); } catch {}
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Disposition", contentDisposition);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");

  if (!shouldTranscode) {
    const upstream = https.get(resolvedUrl, (upstreamRes) => {
      const contentType = String(upstreamRes.headers["content-type"] || "").toLowerCase();
      if (upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300 ||
          (contentType && !contentType.includes("audio/mpeg") && !contentType.includes("audio/mp3"))) {
        upstreamRes.destroy();
        if (!res.headersSent) res.statusCode = 502;
        if (!res.writableEnded) res.end();
        return;
      }
      if (upstreamRes.headers["content-length"]) {
        res.setHeader("Content-Length", upstreamRes.headers["content-length"]);
      }
      res.writeHead(200);
      upstreamRes.pipe(res);
      upstreamRes.on("error", (error) => {
        console.error("Upstream audio error:", error.message);
        if (!res.writableEnded) res.destroy(error);
      });
    });
    upstream.setTimeout(REQUEST_TIMEOUT_MS, () => upstream.destroy(new Error("Upstream stream timed out.")));
    upstream.on("error", (error) => {
      console.error("Upstream request error:", error.message);
      if (!res.headersSent && !res.writableEnded) {
        res.statusCode = 502;
        res.end();
      } else if (!res.writableEnded) res.destroy(error);
    });
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    return;
  }

  res.writeHead(200);
  const ffmpeg = spawn(ffmpegPath, [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-rw_timeout", String(REQUEST_TIMEOUT_MS * 1000),
    "-i", resolvedUrl,
    "-vn", "-c:a", "libmp3lame", "-b:a", "128k",
    "-f", "mp3", "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let finished = false;
  const killFfmpeg = () => {
    if (!ffmpeg.killed && ffmpeg.exitCode === null) ffmpeg.kill("SIGKILL");
  };
  const timeout = setTimeout(() => {
    console.error("ffmpeg process timed out.");
    killFfmpeg();
  }, PROCESS_TIMEOUT_MS);
  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on("data", (data) => {
    const message = data.toString().trim();
    if (message) console.error("ffmpeg:", message.slice(0, 500));
  });
  ffmpeg.on("error", (error) => {
    clearTimeout(timeout);
    console.error("ffmpeg spawn error:", error.message);
    if (!res.writableEnded) res.destroy(error);
  });
  ffmpeg.on("close", (code) => {
    clearTimeout(timeout);
    finished = true;
    if (code !== 0 && !res.writableEnded) res.destroy(new Error("Audio transcoding failed."));
    else if (!res.writableEnded) res.end();
  });
  res.on("close", () => {
    if (!finished) {
      clearTimeout(timeout);
      ffmpeg.stdout.unpipe(res);
      killFfmpeg();
    }
  });
}

app.get("/api/download", handleDownloadStream);
app.post("/api/download", handleDownloadStream);

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
