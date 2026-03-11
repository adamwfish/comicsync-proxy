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

// ─── SCHEDULED JOBS ──────────────────────────────────────────────────────────
// In-memory map of pending auto-publish jobs.
// Jobs are lost on proxy restart — fine for same-day scheduling.
const scheduledJobs = new Map();

// POST /schedule — schedule a product to auto-publish at a future time
// Body: { productId: string, publishAt: ISO8601 string }
app.post("/schedule", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });

  const { productId, publishAt } = req.body;
  if (!productId || !publishAt) return res.status(400).json({ error: "productId and publishAt are required" });

  const delay = new Date(publishAt).getTime() - Date.now();
  if (delay <= 0) return res.status(400).json({ error: "Scheduled time is in the past" });

  // Cancel any existing job for this product
  for (const [jid, job] of scheduledJobs.entries()) {
    if (job.productId === productId) {
      clearTimeout(job.timer);
      scheduledJobs.delete(jid);
    }
  }

  const jobId = `${productId}-${Date.now()}`;

  const timer = setTimeout(async () => {
    try {
      // Fetch the current product first, then PUT back with isVisible: true
      const getRes = await fetch(`https://api.squarespace.com/1.0/commerce/products/${productId}`, {
        headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" }
      });
      const product = await getRes.json();
      if (!getRes.ok) {
        console.error(`[schedule] Failed to fetch product ${productId}:`, product);
        scheduledJobs.delete(jobId);
        return;
      }

      // PATCH visibility to true
      const patchRes = await fetch(`https://api.squarespace.com/1.0/commerce/products/${productId}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SQSP_KEY}`,
          "Content-Type": "application/json",
          "User-Agent": "ComicSync/1.0"
        },
        body: JSON.stringify({ ...product, isVisible: true })
      });
      const patchData = await patchRes.json();
      if (patchRes.ok) {
        console.log(`[schedule] Auto-published product ${productId} ✓`);
      } else {
        console.error(`[schedule] Failed to publish product ${productId}:`, patchData);
      }
    } catch (err) {
      console.error(`[schedule] Error publishing product ${productId}:`, err.message);
    } finally {
      scheduledJobs.delete(jobId);
    }
  }, delay);

  scheduledJobs.set(jobId, { productId, publishAt, timer });
  console.log(`[schedule] Job ${jobId} queued — publishes at ${publishAt} (in ${Math.round(delay / 60000)} min)`);

  res.json({ jobId, productId, publishAt, delayMs: delay });
});

// GET /scheduled — list all pending scheduled jobs
app.get("/scheduled", (req, res) => {
  const jobs = [];
  for (const [jobId, job] of scheduledJobs.entries()) {
    jobs.push({ jobId, productId: job.productId, publishAt: job.publishAt });
  }
  res.json({ jobs });
});

// DELETE /schedule/:jobId — cancel a scheduled job
app.delete("/schedule/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = scheduledJobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  clearTimeout(job.timer);
  scheduledJobs.delete(jobId);
  console.log(`[schedule] Job ${jobId} cancelled`);
  res.json({ cancelled: true, jobId });
});

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", squarespace: !!SQSP_KEY, scheduledJobs: scheduledJobs.size });
});

// ─── PUSH PRODUCT ──────────────────────────────────────────────────────────
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

// ─── UPLOAD IMAGES ──────────────────────────────────────────────────────────
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

// ─── FETCH PRODUCTS ──────────────────────────────────────────────────────────
// Fetch all products from inventory (paginated)
app.get("/products", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });
  const { storePageId, cursor: startCursor } = req.query;
  try {
    let products = [];
    let cursor = startCursor || null;

    // Fetch up to 5 pages (500 products) per request to avoid timeout
    let pages = 0;
    do {
      const url = cursor
        ? `https://api.squarespace.com/1.0/commerce/products?cursor=${cursor}&pageSize=100`
        : `https://api.squarespace.com/1.0/commerce/products?pageSize=100`;

      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" }
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.message || JSON.stringify(data) });

      for (const p of data.products || []) {
        // Only include if storePageId matches (or no filter)
        const matchesPage = !storePageId || (p.storePageId === storePageId);
        if (matchesPage) {
          const variant = p.variants?.[0];
          const price = variant?.pricing?.basePrice?.value || "0.00";
          const sku   = variant?.sku || "";
          products.push({
            id: p.id,
            name: p.name || "",
            sku,
            price,
            tags: p.tags || [],
            categories: p.categories || [],
            isVisible: p.isVisible,
            thumbnail: p.images?.[0]?.url || "",
            createdOn: p.createdOn || "",
          });
        }
      }
      cursor = data.pagination?.nextPageCursor || null;
      pages++;
    } while (cursor && pages < 5);

    res.json({ products, nextCursor: cursor || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── FETCH CATEGORIES ──────────────────────────────────────────────────────
// Fetch store categories (unique tags across all products)
app.get("/categories", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });
  try {
    let categories = [];
    let cursor = null;

    do {
      const url = cursor
        ? `https://api.squarespace.com/1.0/commerce/products?cursor=${cursor}&pageSize=100`
        : `https://api.squarespace.com/1.0/commerce/products?pageSize=100`;

      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" }
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.message || JSON.stringify(data) });

      for (const product of data.products || []) {
        for (const tag of product.tags || []) {
          if (!categories.includes(tag)) categories.push(tag);
        }
      }
      cursor = data.pagination?.nextPageCursor || null;
    } while (cursor);

    categories.sort();
    res.json({ categories });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── STORE PAGE CATEGORIES ──────────────────────────────────────────────────
app.get("/store-categories", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });
  const { storePageId } = req.query;
  if (!storePageId) return res.status(400).json({ error: "storePageId required" });
  try {
    const r = await fetch(
      `https://api.squarespace.com/1.0/commerce/store_pages/${storePageId}/categories`,
      { headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" } }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || JSON.stringify(data) });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`ComicSync proxy running on port ${PORT}`));
