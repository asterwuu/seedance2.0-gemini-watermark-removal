const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = 3000;

const UPLOADS = path.join(__dirname, "uploads");
const OUTPUT = path.join(__dirname, "output");
const THUMBS = path.join(__dirname, "public", "thumbs");
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(OUTPUT, { recursive: true });
fs.mkdirSync(THUMBS, { recursive: true });

const VIDEO_EXTS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"];
const ALL_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS];

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALL_EXTS.includes(ext));
  },
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(OUTPUT));

function isImage(filename) {
  return IMAGE_EXTS.includes(path.extname(filename).toLowerCase());
}

function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const stream = data.streams.find((s) => s.codec_type === "video");
      if (!stream) return reject(new Error("No video/image stream found"));
      resolve({ width: stream.width, height: stream.height });
    });
  });
}

// Preview: extract first frame for video, or just serve the image
app.post("/preview", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const inputPath = req.file.path;
  const id = crypto.randomBytes(6).toString("hex");
  const originalName = req.file.originalname;
  const imageMode = isImage(originalName);

  try {
    if (imageMode) {
      // Copy image to thumbs so it can be served
      const thumbName = `thumb_${id}${path.extname(originalName)}`;
      const thumbPath = path.join(THUMBS, thumbName);
      fs.copyFileSync(inputPath, thumbPath);

      const { width, height } = await probe(inputPath);

      res.json({
        thumb: `/thumbs/${thumbName}`,
        width,
        height,
        uploadPath: inputPath,
        originalName,
        type: "image",
      });
    } else {
      const thumbName = `thumb_${id}.jpg`;

      const { width, height } = await probe(inputPath);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .screenshots({
            count: 1,
            timemarks: ["0"],
            folder: THUMBS,
            filename: thumbName,
          })
          .on("end", resolve)
          .on("error", reject);
      });

      res.json({
        thumb: `/thumbs/${thumbName}`,
        width,
        height,
        uploadPath: inputPath,
        originalName,
        type: "video",
      });
    }
  } catch (err) {
    fs.unlink(inputPath, () => {});
    console.error(err);
    res.status(500).json({ error: "Failed to extract preview" });
  }
});

// Process with exact crop coordinates
app.post("/process", express.json(), async (req, res) => {
  const { uploadPath, originalName, cropX, cropY, cropW, cropH, origW, origH, sourceW, sourceH } = req.body;

  if (!uploadPath || !fs.existsSync(uploadPath)) {
    return res.status(400).json({ error: "Upload not found. Please re-upload." });
  }

  const id = crypto.randomBytes(6).toString("hex");
  const ext = path.extname(originalName || ".mp4").toLowerCase();
  const imageMode = IMAGE_EXTS.includes(ext);
  const outputExt = imageMode ? (ext === ".png" ? ".png" : ".jpg") : ext;
  const outputName = `processed_${id}${outputExt}`;
  const outputPath = path.join(OUTPUT, outputName);

  try {
    // Use browser-reported dimensions (handles EXIF rotation correctly)
    let width, height;
    if (sourceW && sourceH) {
      width = sourceW;
      height = sourceH;
    } else {
      ({ width, height } = await probe(uploadPath));
    }

    const scaleX = width / origW;
    const scaleY = height / origH;
    const cx = Math.round(cropX * scaleX);
    const cy = Math.round(cropY * scaleY);
    const cw = Math.round(cropW * scaleX);
    const ch = Math.round(cropH * scaleY);

    const finalX = Math.max(0, Math.min(cx, width - 1));
    const finalY = Math.max(0, Math.min(cy, height - 1));
    let finalW = Math.min(cw, width - finalX);
    let finalH = Math.min(ch, height - finalY);

    // Ensure even dimensions for codec compatibility
    finalW = finalW % 2 ? finalW - 1 : finalW;
    finalH = finalH % 2 ? finalH - 1 : finalH;
    const evenW = width % 2 ? width - 1 : width;
    const evenH = height % 2 ? height - 1 : height;

    if (imageMode) {
      // Images: crop only (no resize — output matches the preview exactly)
      const vf = `crop=${finalW}:${finalH}:${finalX}:${finalY}`;
      await new Promise((resolve, reject) => {
        ffmpeg(uploadPath)
          .videoFilters(vf)
          .frames(1)
          .output(outputPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    } else {
      // Videos: crop + resize to original dimensions
      const vf = `crop=${finalW}:${finalH}:${finalX}:${finalY},scale=${evenW}:${evenH}:flags=lanczos`;
      await new Promise((resolve, reject) => {
        ffmpeg(uploadPath)
          .videoFilters(vf)
          .outputOptions("-c:a", "copy")
          .output(outputPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    }

    // Copy original to output for comparison
    const origName = `original_${id}${ext}`;
    const origPath = path.join(OUTPUT, origName);
    fs.copyFileSync(uploadPath, origPath);
    fs.unlink(uploadPath, () => {});

    res.json({
      url: `/output/${outputName}`,
      originalUrl: `/output/${origName}`,
      filename: outputName,
      type: imageMode ? "image" : "video",
    });
  } catch (err) {
    fs.unlink(uploadPath, () => {});
    console.error(err);
    res.status(500).json({ error: "Processing failed" });
  }
});

app.get("/download/:filename", (req, res) => {
  const filePath = path.join(OUTPUT, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  res.download(filePath);
});

app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
});
