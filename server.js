import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT || 10000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storageRoot = process.env.STORAGE_PATH || "/var/data";
const assetDirectory = path.join(storageRoot, "assets");

await fs.mkdir(assetDirectory, { recursive: true });

app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

function safeName(value) {
  return (
    String(value || "asset")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "asset"
  );
}

function extensionFor(mimeType) {
  const types = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/svg+xml": ".svg"
  };

  return types[mimeType] || ".bin";
}

app.post("/api/assets", async (request, response) => {
  try {
    const { name, mimeType, dataUrl } = request.body || {};

    if (typeof dataUrl !== "string") {
      return response.status(400).json({
        error: "Missing image data."
      });
    }

    const mime = String(mimeType || "application/octet-stream");
    const encoded = dataUrl.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(encoded, "base64");

    if (!buffer.length) {
      return response.status(400).json({
        error: "The image is empty."
      });
    }

    if (buffer.length > 20 * 1024 * 1024) {
      return response.status(413).json({
        error: "Image exceeds the 20 MB limit."
      });
    }

    const baseName = safeName(name);
    const extension = path.extname(baseName)
      ? ""
      : extensionFor(mime);

    const filename =
      crypto.randomUUID().slice(0, 8) +
      "-" +
      baseName +
      extension;

    await fs.writeFile(
      path.join(assetDirectory, filename),
      buffer
    );

    response.json({
      ok: true,
      filename,
      url: `/stored-assets/${filename}`,
      size: buffer.length,
      mimeType: mime
    });
  } catch (error) {
    console.error(error);

    response.status(500).json({
      error: "The server could not save the asset."
    });
  }
});

app.get("/api/assets", async (_request, response) => {
  const filenames = await fs.readdir(assetDirectory);

  response.json({
    assets: filenames.map((filename) => ({
      filename,
      url: `/stored-assets/${filename}`
    }))
  });
});

app.use("/stored-assets", express.static(assetDirectory));

app.get("/{*path}", (_request, response) => {
  response.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Codem8s running on port ${port}`);
});
