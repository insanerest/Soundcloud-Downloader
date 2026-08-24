const { App } = require("volten");
const app = new App();
const path = require("path");
const manager = new (require("./manager"))("./tracks.json");
const PORT = process.env.PORT || 3009;
const { spawn } = require("child_process");
const clientId =
  process.env.SOUNDCLOUD_CLIENT_ID ??
  (() => {
    process.loadEnvFile();
    return process.env.SOUNDCLOUD_CLIENT_ID;
  })();
if (!clientId) {
  throw Error("Client ID was not provided in env");
}
let ongoingDownloads = new Map();
const ytDlpPath = path.join(__dirname, "bin", "yt-dlp");
const ffmpegPath = require("ffmpeg-static");

app.static(path.join(__dirname, "public"));

async function getTracks(q) {
  const response = await fetch(
    `https://api-v2.soundcloud.com/search?q=${q}&client_id=${clientId}&limit=20`,
  );
  const parasedResponse = await response.json();
  return parasedResponse;
}

async function downloadTrack(trackUrl, realName) {
  return new Promise(async (resolve, reject) => {
    if (await manager.hasValue(realName)) {
      return resolve({
        success: true,
        output: "downloads/" + (await manager.getKeyOfValue(realName)) + ".mp3",
      });
    }
    const outputName = `track${Math.round(Math.random() * 100000)}`;
    const outputPath = path.resolve(__dirname, `downloads/${outputName}.mp3`);
    const ytDlp = spawn(ytDlpPath, [
      "--verbose",
      "--ffmpeg-location",
      ffmpegPath,
      "-x",
      "--audio-format",
      "mp3",
      "-o",
      outputPath,
      trackUrl,
    ]);

    ytDlp.stdout.on("data", (data) => {
      console.log(`stdout: ${data}`);
    });

    ytDlp.stderr.on("data", (data) => {
      console.error(`stderr: ${data}`);
    });

    ytDlp.on("error", (err) => {
      reject({
        success: false,
        error: `Failed to start process: ${err.message}`,
      });
    });

    ytDlp.on("close", (code) => {
      if (code === 0) {
        console.log("✅ Download complete:", outputPath);
        manager.writeJSON({
          [outputName]: realName,
        });
        resolve({
          success: true,
          output: outputPath.split("/").slice(-2).join("/"),
        });
      } else {
        console.error(`❌ yt-dlp exited with code ${code}`);
        reject({
          success: false,
          code,
        });
      }
    });
  });
}

app.get("/", (ctx) => {
  ctx.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/downloads/:file", async (ctx) => {
  const requestedFile = ctx.params.file;

  if (!/^[\w\-.]+\.mp3$/.test(requestedFile)) {
    return ctx.status(400).send("Invalid file name.");
  }

  const filePath = path.resolve(__dirname, "downloads", requestedFile);
  const downloadsRoot = path.resolve(__dirname, "downloads");

  if (!filePath.startsWith(downloadsRoot)) {
    return ctx.status(403).send("Access denied.");
  }

  const trackFile = await manager.getFile();
  const newName = trackFile[requestedFile.split(".").shift()] + ".mp3";
  await ctx.download(filePath, newName, 200, (err) => {
    if (err && !ctx.headersSent) {
      console.error("Download error:", err.message);
      ctx.status(500).send("Download failed.");
    }
  });
});

app.get("/stream/:file", (ctx) => {
  const requestedFile = ctx.params.file;

  // 1. Validate filename
  if (!/^[\w\-.]+\.mp3$/.test(requestedFile)) {
    return ctx.status(400).send("Invalid file name.");
  }

  const filePath = path.resolve(__dirname, "downloads", requestedFile);
  const downloadsRoot = path.resolve(__dirname, "downloads");

  // 2. Check for directory traversal
  if (!filePath.startsWith(downloadsRoot)) {
    return ctx.status(403).send("Access denied.");
  }
  ctx.sendFile(path.join(__dirname, "downloads", requestedFile));
});
app.get("/api/search", async (ctx) => {
  console.time("Tracks");
  const query = ctx.query.q;
  if (!query || typeof query !== "string" || query.length > 100) {
    return ctx.status(400).json({ error: "Invalid query parameter." });
  }

  try {
    const TrackResponse = await getTracks(query);
    async function getInfo() {
      let names = [];
      let images = [];
      let urls = [];
      let titles = [];
      for (const track of TrackResponse.collection) {
        let isTrack = false;
        isTrack = !!track.artwork_url && track.kind === "track";
        if (isTrack) {
          let username = track.user.username;
          let picture = track.artwork_url;
          let url = track.permalink_url;
          let title = track.title;
          names.push(username);
          images.push(picture);
          urls.push(url);
          titles.push(title);
        }
      }
      return names.map((_, i) => ({
        username: names[i],
        title: titles[i],
        url: urls[i],
        img: images[i],
      }));
    }
    const results = await getInfo();
    const response = {
      length: results.length,
      results: results,
    };
    console.timeEnd("Tracks");
    ctx.json(response);
  } catch (err) {
    console.log(err);
    ctx.status(500).json({ error: "SoundCloud fetch failed." });
  }
});

// Proxy to resolve stream URLs

app.post("/api/download", async (ctx) => {
  const { url, name } = await ctx.body();
  if (!url) {
    return ctx.status(400).json({ error: "Missing URL parameter." });
  }
  if (ongoingDownloads.has(url)) {
    try {
      const result = await ongoingDownloads.get(url); // Wait for existing one
      if (result.success) {
        // Respond with download info (e.g., file path, name, size, etc.)
        return ctx.json(result);
      } else {
        return ctx
          .status(400)
          .json({ success: false, error: "Download failed." });
      }
    } catch (err) {
      console.error("Download error:", err);
      return ctx
        .status(500)
        .json({ success: false, error: "Failed to download." });
    }
  }

  try {
    const promise = downloadTrack(url, name);
    ongoingDownloads.set(url, promise);
    const download = await promise;

    if (download.success) {
      // Respond with download info (e.g., file path, name, size, etc.)
      return ctx.json(download);
    } else {
      return ctx
        .status(400)
        .json({ success: false, error: "Download failed." });
    }
  } catch (err) {
    console.error("Download error:", err);
    return ctx
      .status(500)
      .json({ success: false, error: "Failed to download." });
  }
});
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

// node index.js
