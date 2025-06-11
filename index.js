const express = require("express");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const app = express();
const path = require("path");
const PORT = 3009;
const cors = require("cors");
const puppeteer = require("puppeteer");
const htmlEntities = require("he");
const { spawn } = require("child_process");

const downloadNames = {}
const ytDlpPath = path.join(__dirname, "yt-dlp")

// Serve static files
// Serve static files from "public"
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const downloadsDir = path.join(__dirname, "downloads");

async function getTracks(q) {
  let tracks = [];
  const browser = await puppeteer.launch({
    headless: true, // Headless mode is required in most Docker environments
    defaultViewport: null,
  });

  const page = await browser.newPage();

  const query = q; // Arabic text or any search term
  const searchURL = `https://soundcloud.com/search?q=${query.replace(
    / /g,
    "%20"
  )}`;

  await page.goto(searchURL, {
    waitUntil: "networkidle2", // Wait until all requests finish
  });
  const timesToScroll = 1;
  const scrollDelay = 2000;
  for (let i = 0; i < timesToScroll; i++) {
    console.log(`Scrolling ${i + 1}/${timesToScroll}...`);

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    await new Promise((resolve) => setTimeout(resolve, scrollDelay));
  }

  const htmlContent = await page.content();

  await browser.close();
  const dom = new JSDOM(htmlContent);
  const document = dom.window.document;
  const resultList = document.querySelectorAll(
    ".search__listWrapper .searchList .lazyLoadingList__list li"
  );
  resultList.forEach((li) => {
    const resultMain = li.querySelectorAll(
      `.searchItem div[role="group"] .sound__body .sound__artwork .sound__coverArt`
    );
    resultMain.forEach((main) => {
      tracks.push(main);
    });
  });
  return tracks;
}

async function downloadTrack(trackUrl, realName) {
  return new Promise((resolve, reject) => {
    const outputName = `track${Math.round(Math.random() * 100000)}`;
    downloadNames[outputName] = realName
    const outputPath = path.resolve(__dirname, `downloads/${outputName}.mp3`);

    const ytDlp = spawn(ytDlpPath, [
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
        const relPath = outputPath.split("/").pop();
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
  const newName = downloadNames[requestedFile.split(".").shift()] + ".mp3"
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
  res.sendFile(path.join(__dirname,"downloads", requestedFile))
});
app.get("/api/search", async (req, res) => {
  console.time("Tracks");
  const query = req.query.q;
  if (!query || typeof query !== "string" || query.length > 100) {
    return res.status(400).json({ error: "Invalid query parameter." });
  }

  try {
    const matchingAnchors = await getTracks(query);
    const elements = [];
    async function getInfo() {
      let names = [];
      let images = [];
      let urls = [];
      for (const anchor of matchingAnchors) {
        let isTrack = false;
        isTrack = (anchor.href.match(/\//g) || []).length === 2;
        if (isTrack) {
          elements.push(anchor.outerHTML);
          const nameRes = await fetch(`https://soundcloud.com${anchor.href}`);
          const nameHTML = await nameRes.text();
          const nameDom = new JSDOM(nameHTML);
          const document = nameDom.window.document;
          const nameSelector = `noscript article header h1[itemprop="name"] a:not([itemprop="url"])`;
          const imgSelector = `noscript article p img[itemprop="image"]`;

          const namesTags = document.querySelectorAll(nameSelector);
          namesTags.forEach((name) => {
            let username = name.href.substring(1);
            if (username) {
              names.push(username);
              isTrack = true;
            }
          });
          const imgTags = document.querySelectorAll(imgSelector);
          imgTags.forEach((img) => {
            let picture = img.src;
            images.push(picture);
          });
          urls.push(`https://soundcloud.com${anchor.href}`);
        }
      }
      return { names: names, images: images, urls: urls };
    }
    const info = await getInfo();

    const results = elements
      .map((el) => {
        // Get the href from the <a> tag
        const hrefMatch = el.match(/<a[^>]+href="([^"]+)"/);
        // Get the aria-label from the <span> inside the <a>
        const labelMatch = el.match(/aria-label="([^"]+)"/);

        if (hrefMatch && labelMatch) {
          const href = hrefMatch[1];
          const title = htmlEntities.decode(labelMatch[1]); // optional
          return { href, title };
        }
      })
      .filter(Boolean);
    for (const result of results) {
      results[results.indexOf(result)].username =
        info.names[results.indexOf(result)];
      results[results.indexOf(result)].img =
        info.images[results.indexOf(result)];
      results[results.indexOf(result)].url = info.urls[results.indexOf(result)];
    }
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
  console.log(`Name: ${name}`)
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
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on http://192.168.1.81:${PORT}`);
});

// node download.js
