import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import multer from "multer";
import FormData from "form-data";

const app = express();
const PORT = process.env.PORT || 3001;
const SQSP_KEY = process.env.SQUARESPACE_API_KEY;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", squarespace: !!SQSP_KEY });
});

// Proxy POST → Squarespace Commerce API (create product)
app.post("/push", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });

  try {
    const response = await fetch("https://api.squarespace.com/1.0/commerce/products", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SQSP_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "ComicSync/1.0",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.message || JSON.stringify(data) });

    res.json({ success: true, productId: data.id, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload images to a Squarespace product
// Accepts multipart: front (file), back (file), productId (string)
app.post("/upload-images", upload.fields([{ name: "front", maxCount: 1 }, { name: "back", maxCount: 1 }]), async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });

  const { productId } = req.body;
  if (!productId) return res.status(400).json({ error: "productId required" });

  const results = [];
  const files = [];
  if (req.files?.front?.[0]) files.push({ file: req.files.front[0], label: "front" });
  if (req.files?.back?.[0])  files.push({ file: req.files.back[0],  label: "back"  });

  for (const { file, label } of files) {
    try {
      const form = new FormData();
      form.append("file", file.buffer, {
        filename: `${label}.jpg`,
        contentType: file.mimetype || "image/jpeg",
      });

      const imgRes = await fetch(
        `https://api.squarespace.com/1.0/commerce/products/${productId}/images`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SQSP_KEY}`,
            ...form.getHeaders(),
          },
          body: form,
        }
      );

      const imgData = await imgRes.json();
      if (!imgRes.ok) {
        results.push({ label, success: false, error: imgData.message || JSON.stringify(imgData) });
      } else {
        results.push({ label, success: true, imageId: imgData.id });
      }
    } catch (e) {
      results.push({ label, success: false, error: e.message });
    }
  }

  res.json({ results });
});

app.listen(PORT, () => console.log(`ComicSync proxy running on port ${PORT}`));
