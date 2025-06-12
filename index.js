const express = require("express");
const app = express();
const path = require("path");
const fs = require("fs/promises");
const PORT = process.env.PORT || 3009;
const { spawn } = require("child_process");
const clientId = "1JEFtFgP4Mocy0oEGJj2zZ0il9pEpBrM";

let downloadNames = {};
const ytDlpPath = path.join(__dirname, "bin", "yt-dlp");
const ffmpegPath = require("ffmpeg-static");
const downloadsPath = path.join(__dirname, "downloads");
let lastCalledTimestamp = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/download", async (req, res, next) => {
  const now = Date.now();
  if (!lastCalledTimestamp || now - lastCalledTimestamp > 24 * 60 * 60 * 1000) {
    try {
      await fs.access(downloadsPath);
      await fs.rm(downloadsPath, { recursive: true, force: true });
      downloadNames = {}
      console.log("Downloads folder deleted by middleware.");
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("Error checking or deleting folder:", err);
        return res.status(500).send("Server error during cleanup.");
      }
    }

    lastCalledTimestamp = now;
  }

  next();
});

async function getTracks(q) {
  const response = await fetch(
    `https://api-v2.soundcloud.com/search?q=${q}&client_id=${clientId}&limit=20`
  );
  const parasedResponse = await response.json();
  return await parasedResponse;
}

async function downloadTrack(trackUrl, realName) {
  return new Promise((resolve, reject) => {
    if (
      Object.values(downloadNames).some((savedName) => savedName === realName)
    ) {
      return resolve({
        success: true,
        output: "downloads/" + Object.keys(downloadNames).find(
          (k) => downloadNames[k] === realName
        ) + ".mp3"
      }); 
    }
    const outputName = `track${Math.round(Math.random() * 100000)}`;
    downloadNames[outputName] = realName;
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
        console.log(outputPath.split("/").slice(-2).join("/"));
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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/downloads/:file", (req, res) => {
  const requestedFile = req.params.file;

  if (!/^[\w\-.]+\.mp3$/.test(requestedFile)) {
    return res.status(400).send("Invalid file name.");
  }

  const filePath = path.resolve(__dirname, "downloads", requestedFile);
  const downloadsRoot = path.resolve(__dirname, "downloads");

  if (!filePath.startsWith(downloadsRoot)) {
    return res.status(403).send("Access denied.");
  }

  // Safe download logics
  console.log(downloadNames[requestedFile.split(".").shift()]);
  const newName = downloadNames[requestedFile.split(".").shift()] + ".mp3";
  res.download(filePath, newName, (err) => {
    if (err && !res.headersSent) {
      console.error("Download error:", err.message);
      res.status(500).send("Download failed.");
    }
  });
});

app.get("/stream/:file", (req, res) => {
  const requestedFile = req.params.file;

  // 1. Validate filename
  if (!/^[\w\-.]+\.mp3$/.test(requestedFile)) {
    return res.status(400).send("Invalid file name.");
  }

  const filePath = path.resolve(__dirname, "downloads", requestedFile);
  const downloadsRoot = path.resolve(__dirname, "downloads");

  // 2. Check for directory traversal
  if (!filePath.startsWith(downloadsRoot)) {
    return res.status(403).send("Access denied.");
  }
  res.sendFile(path.join(__dirname, "downloads", requestedFile));
});
app.get("/api/search", async (req, res) => {
  console.time("Tracks");
  const query = req.query.q;
  if (!query || typeof query !== "string" || query.length > 100) {
    return res.status(400).json({ error: "Invalid query parameter." });
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
    res.json(response);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "SoundCloud fetch failed." });
  }
});

// Proxy to resolve stream URLs

app.post("/api/download", async (req, res) => {
  const { url, name } = req.body;
  console.log(`Name: ${name}`);
  if (!url) {
    return res.status(400).json({ error: "Missing URL parameter." });
  }

  try {
    const download = await downloadTrack(url, name);

    if (download.success) {
      // Respond with download info (e.g., file path, name, size, etc.)
      res.json(download);
    } else {
      res.status(400).json({ success: false, error: "Download failed." });
    }
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).json({ success: false, error: "Failed to download." });
  }
});
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

// node download.js
