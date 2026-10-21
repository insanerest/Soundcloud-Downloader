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

// --- Helper: Resolve Stream URL via yt-dlp (Fallback) ---
async function resolveStreamUrlWithYtDlp(trackUrl) {
  return new Promise((resolve, reject) => {
    const yt = spawn(ytDlpPath, [
      "-g",
      "-f",
      "ba[ext=mp3][protocol=https]/ba[ext=mp3]/ba",
      trackUrl,
    ]);
    let out = "",
      err = "";

    yt.stdout.on("data", (d) => (out += d.toString()));
    yt.stderr.on("data", (d) => (err += d.toString()));

    yt.on("close", (code) => {
      const url = out.trim();
      if (code === 0 && url) resolve(url);
      else reject(new Error(`yt-dlp exited with code ${code}: ${err.trim()}`));
    });
    yt.on("error", (e) =>
      reject(new Error(`yt-dlp spawn error: ${e.message}`)),
    );
  });
}

// --- Helper: Fast Track & Stream URL Resolution ---
async function resolveTrackStream(trackUrl) {
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
      const resolveRes = await fetch(resolveApiUrl);
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
          trackMetaCache.set(trackUrl, trackMeta);
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
          const sRes = await fetch(streamReqUrl);
          if (sRes.ok) {
            const sData = await sRes.json();
            if (sData.url) {
              const isHls =
                candidate.format?.protocol === "hls" ||
                /\.m3u8/i.test(sData.url);
              const result = {
                streamUrl: sData.url,
                isHls,
                type: isHls ? "hls" : "progressive",
                title: trackMeta.title,
                artist: trackMeta.username,
                expiresAt: Date.now() + 15 * 60 * 1000,
              };
              streamUrlCache.set(trackUrl, result);
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
      streamUrl: ytUrl,
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
  console.time("Search Time");
  const query = ctx.query.q;
  if (!query || typeof query !== "string" || query.length > 100) {
    return ctx.status(400).json({ error: "Invalid query parameter." });
  }

  try {
    const res = await fetch(
      `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=20`,
    );
    const data = await res.json();
    const collection = Array.isArray(data.collection) ? data.collection : [];

    // Filter and map tracks, and prime trackMetaCache for instant streaming
    const results = [];
    for (const t of collection) {
      if (t.kind === "track" && (t.artwork_url || t.user?.avatar_url)) {
        if (t.permalink_url && t.media) {
          trackMetaCache.set(t.permalink_url, {
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

    console.timeEnd("Search Time");
    ctx.json({ length: results.length, results });
  } catch (err) {
    console.error("Search error:", err);
    ctx.status(500).json({ error: "SoundCloud fetch failed." });
  }
});

// Endpoint for instant client-side streaming info (Zero disk usage)
app.get("/api/stream-info", async (ctx) => {
  const url = ctx.query.url;
  if (!url) return ctx.status(400).json({ error: "Missing URL parameter." });

  try {
    const info = await resolveTrackStream(url);
    return ctx.json({
      type: info.type,
      isHls: info.isHls,
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

  const safeName = (name || "track").replace(/[/\\?%*:|"<>]/g, "_");
  const fileName = `${safeName}.mp3`;
  const isAttachment =
    ctx.query.download === "1" || ctx.query.download === "true";
  const contentDisposition = `${isAttachment ? "attachment" : "inline"}; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

  // Resolve direct stream URL fast
  let streamInfo;
  try {
    streamInfo = await resolveTrackStream(url);
  } catch (err) {
    console.error("Track resolution error:", err.message);
    return ctx.status(500).json({ error: "Failed to resolve track URL." });
  }

  const resolvedUrl = streamInfo.streamUrl;
  const isHLS = streamInfo.isHls;

  const res = ctx.res;
  const req = ctx.req;

  // Immediate TCP delivery (disable Nagle algorithm)
  if (res && res.socket) {
    try {
      res.socket.setNoDelay(true);
    } catch {}
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Disposition", contentDisposition);

  if (!isHLS) {
    // Direct HTTP MP3: stream directly to client
    console.log("📡 Streaming direct HTTP MP3 (diskless pass-through)");
    const httpReq = https.get(resolvedUrl, (httpRes) => {
      if (httpRes.headers["content-length"]) {
        res.setHeader("Content-Length", httpRes.headers["content-length"]);
      }
      res.writeHead(200);

      httpRes.pipe(res);
      httpRes.on("error", (e) => {
        console.error("HTTP stream error:", e.message);
        if (res && !res.writableEnded) res.end();
      });
    });

    httpReq.on("error", (e) => {
      console.error("HTTP request error:", e.message);
      if (res && !res.writableEnded) res.end();
    });
    req.on("close", () => httpReq.destroy());
  } else {
    // HLS via ffmpeg: transcode on the fly directly to response (0 disk usage)
    console.log("📡 Streaming HLS via ffmpeg (diskless pass-through)");
    res.setHeader("Transfer-Encoding", "chunked");
    res.writeHead(200);

    const ffmpeg = spawn(ffmpegPath, [
      "-probesize",
      "32768",
      "-analyzeduration",
      "0",
      "-fflags",
      "+nobuffer+fastseek+discardcorrupt",
      "-flags",
      "low_delay",
      "-i",
      resolvedUrl,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      "-flush_packets",
      "1",
      "-f",
      "mp3",
      "pipe:1",
    ]);

    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg && msg.includes("Error")) console.error("ffmpeg:", msg);
    });

    ffmpeg.on("close", () => {
      if (res && !res.writableEnded) res.end();
    });

    ffmpeg.on("error", (e) => {
      console.error("ffmpeg spawn error:", e.message);
      if (res && !res.writableEnded) res.end();
    });

    req.on("close", () => {
      try {
        if (res) ffmpeg.stdout.unpipe(res);
      } catch {}
      if (!ffmpeg.killed && ffmpeg.exitCode === null) ffmpeg.kill();
    });
  }
}

app.get("/api/download", handleDownloadStream);
app.post("/api/download", handleDownloadStream);

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
