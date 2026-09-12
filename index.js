const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");
const { App } = require("volten");

const Manager = require("./manager");
const ffmpegPath = require("ffmpeg-static");

// --- Configuration ---
const PORT = process.env.PORT || 3009;
const ytDlpPath = path.join(__dirname, "bin", "yt-dlp");
const manager = new Manager("./tracks.json");
const downloadsDir = path.resolve(__dirname, "downloads");

// Ensure downloads directory exists
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

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

// --- Helper: Resolve Stream URL ---
async function resolveStreamUrl(trackUrl) {
  return new Promise((resolve, reject) => {
    //   ba[ext=mp3][protocol=https] -> direct HTTP MP3 (fastest, no transcoding)
    //   ba[ext=mp3]                 -> HLS MP3 fallback
    //   ba                          -> any best audio (AAC HLS) as last resort
    const yt = spawn(ytDlpPath, ["-g", "-f", "ba[ext=mp3][protocol=https]/ba[ext=mp3]/ba", trackUrl]);
    let out = "", err = "";

    yt.stdout.on("data", (d) => (out += d.toString()));
    yt.stderr.on("data", (d) => (err += d.toString()));

    yt.on("close", (code) => {
      const url = out.trim();
      if (code === 0 && url) resolve(url);
      else reject(new Error(`yt-dlp exited with code ${code}: ${err.trim()}`));
    });
    yt.on("error", (e) => reject(new Error(`yt-dlp spawn error: ${e.message}`)));
  });
}

// --- Routes ---

app.get("/", (ctx) => {
  ctx.sendFile(path.join(__dirname, "public", "index.html"));
});

// Handle fetching cached files (download)
app.get("/downloads/:file", async (ctx) => {
  const file = ctx.params.file;
  if (!/^[\w\-.]+\.mp3$/.test(file)) return ctx.status(400).send("Invalid file name.");

  const filePath = path.join(downloadsDir, file);
  if (!filePath.startsWith(downloadsDir)) return ctx.status(403).send("Access denied.");

  try {
    const trackFile = await manager.getFile();
    const baseName = file.split(".").shift();
    const originalName = trackFile[baseName] || baseName;
    const newName = `${originalName}.mp3`;

    await ctx.download(filePath, newName, 200, (err) => {
      if (err && !ctx.headersSent) {
        console.error("Download error:", err.message);
        ctx.status(500).send("Download failed.");
      }
    });
  } catch (err) {
    ctx.status(500).send("Error reading file mappings.");
  }
});

// Handle fetching cached files (stream playback)
app.get("/stream/:file", (ctx) => {
  const file = ctx.params.file;
  if (!/^[\w\-.]+\.mp3$/.test(file)) return ctx.status(400).send("Invalid file name.");

  const filePath = path.join(downloadsDir, file);
  if (!filePath.startsWith(downloadsDir)) return ctx.status(403).send("Access denied.");

  ctx.sendFile(filePath);
});

// Search SoundCloud
app.get("/api/search", async (ctx) => {
  console.time("Search Time");
  const query = ctx.query.q;
  if (!query || typeof query !== "string" || query.length > 100) {
    return ctx.status(400).json({ error: "Invalid query parameter." });
  }

  try {
    const res = await fetch(`https://api-v2.soundcloud.com/search?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=20`);
    const data = await res.json();

    // Filter and map tracks
    const results = data.collection
      .filter((t) => t.kind === "track" && t.artwork_url)
      .map((t) => ({
        username: t.user.username,
        title: t.title,
        url: t.permalink_url,
        img: t.artwork_url,
      }));

    console.timeEnd("Search Time");
    ctx.json({ length: results.length, results });
  } catch (err) {
    console.error("Search error:", err);
    ctx.status(500).json({ error: "SoundCloud fetch failed." });
  }
});

// Main Stream/Download Handler
async function handleDownloadStream(ctx) {
  // 1. Extract URL and Name
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
  const isAttachment = ctx.query.download === "1" || ctx.query.download === "true";
  const contentDisposition = `${isAttachment ? "attachment" : "inline"}; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

  // 2. Serve from cache if available
  if (name && (await manager.hasValue(name))) {
    const key = await manager.getKeyOfValue(name);
    const cachedPath = path.join(downloadsDir, `${key}.mp3`);
    if (fs.existsSync(cachedPath)) {
      ctx.res.setHeader("Content-Type", "audio/mpeg");
      ctx.res.setHeader("Content-Disposition", contentDisposition);
      return fs.createReadStream(cachedPath).pipe(ctx.res);
    }
  }

  // 3. Resolve direct stream URL
  let resolvedUrl;
  try {
    resolvedUrl = await resolveStreamUrl(url);
  } catch (err) {
    console.error("yt-dlp error:", err.message);
    return ctx.status(500).json({ error: "Failed to resolve track URL." });
  }

  // 4. Setup streaming and caching
  const isHLS = /\.m3u8/i.test(resolvedUrl);
  const outputName = `track${Math.round(Math.random() * 100000)}`;
  const outputPath = path.join(downloadsDir, `${outputName}.mp3`);
  
  const writeStream = fs.createWriteStream(outputPath);
  writeStream.on("error", () => {}); // swallow write errors on disconnect

  let clientGone = false;
  let streamCompleted = false;

  const finishStream = () => {
    streamCompleted = true;
    console.log("✅ Stream complete:", outputPath);
    if (name) manager.writeJSON({ [outputName]: name });
    if (ctx.res && !ctx.res.writableEnded) ctx.res.end();
  };

  const abortStream = (msg) => {
    if (msg) console.error("Stream error:", msg);
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
    if (ctx.res && !ctx.res.writableEnded) ctx.res.end();
  };

  ctx.req.on("close", () => {
    clientGone = true;
    writeStream.destroy();
    if (!streamCompleted && fs.existsSync(outputPath)) {
      fs.unlink(outputPath, () => {});
    }
  });

  ctx.res.setHeader("Content-Type", "audio/mpeg");
  ctx.res.setHeader("Content-Disposition", contentDisposition);

  // 5. Proxy the audio
  if (!isHLS) {
    // Direct HTTP MP3
    console.log("📡 Streaming direct HTTP MP3");
    const httpReq = https.get(resolvedUrl, (httpRes) => {
      if (httpRes.headers["content-length"]) {
        ctx.res.setHeader("Content-Length", httpRes.headers["content-length"]);
      }
      ctx.res.writeHead(200);

      httpRes.pipe(ctx.res, { end: false });
      httpRes.pipe(writeStream);
      httpRes.on("end", finishStream);
      httpRes.on("error", (e) => { if (!clientGone) abortStream(e.message); });
    });
    
    httpReq.on("error", (e) => { if (!clientGone) abortStream(e.message); });
    ctx.req.on("close", () => httpReq.destroy());

  } else {
    // HLS via ffmpeg
    console.log("📡 Streaming HLS via ffmpeg");
    ctx.res.setHeader("Transfer-Encoding", "chunked");
    ctx.res.writeHead(200);

    const ffmpeg = spawn(ffmpegPath, [
      "-loglevel", "error",
      "-i", resolvedUrl,
      "-f", "mp3",
      "-b:a", "128k",
      "pipe:1",
    ]);

    ffmpeg.stdout.pipe(ctx.res, { end: false });
    ffmpeg.stdout.pipe(writeStream);

    ffmpeg.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) console.error("ffmpeg:", msg);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) finishStream();
      else abortStream(`ffmpeg exited with code ${code}`);
    });

    ffmpeg.on("error", (e) => abortStream(`ffmpeg spawn: ${e.message}`));

    ctx.req.on("close", () => {
      if (!ffmpeg.killed && ffmpeg.exitCode === null) ffmpeg.kill();
    });
  }
}

app.get("/api/download", handleDownloadStream);
app.post("/api/download", handleDownloadStream);

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
