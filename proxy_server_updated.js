import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import multer from "multer";
import FormData from "form-data";

const app = express();
const PORT = process.env.PORT || 3001;
const SQSP_KEY = process.env.SQUARESPACE_API_KEY;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));

// ─── SCHEDULED JOBS ──────────────────────────────────────────────────────────
const scheduledJobs = new Map();

app.post("/schedule", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  const { productId, publishAt, storePageId } = req.body;
  if (!productId || !publishAt) return res.status(400).json({ error: "productId and publishAt required" });
  const delay = new Date(publishAt).getTime() - Date.now();
  if (delay <= 0) return res.status(400).json({ error: "Time is in the past" });
  for (const [jid, job] of scheduledJobs.entries()) {
    if (job.productId === productId) { clearTimeout(job.timer); scheduledJobs.delete(jid); }
  }
  const jobId = `${productId}-${Date.now()}`;
  const timer = setTimeout(async () => {
    try {
      const tryPublish = async (method) => {
        const r = await fetch(`https://api.squarespace.com/1.0/commerce/products/${productId}`, {
          method,
          headers: { Authorization: `Bearer ${SQSP_KEY}`, "Content-Type": "application/json", "User-Agent": "ComicSync/1.1" },
          body: JSON.stringify({ isVisible: true })
        });
        return r.ok;
      };
      await tryPublish("PUT") || await tryPublish("PATCH");
    } finally { scheduledJobs.delete(jobId); }
  }, delay);
  scheduledJobs.set(jobId, { productId, publishAt, timer, storePageId });
  res.json({ jobId, productId, publishAt });
});

app.get("/scheduled", (req, res) => {
  const jobs = [];
  for (const [jobId, job] of scheduledJobs.entries()) {
    jobs.push({ jobId, productId: job.productId, publishAt: job.publishAt });
  }
  res.json({ jobs });
});

app.delete("/schedule/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = scheduledJobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  clearTimeout(job.timer);
  scheduledJobs.delete(jobId);
  res.json({ cancelled: true });
});

// ─── PUSH PRODUCT ──────────────────────────────────────────────────────────
app.post("/push", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  try {
    const response = await fetch("https://api.squarespace.com/1.0/commerce/products", {
      method: "POST",
      headers: { Authorization: `Bearer ${SQSP_KEY}`, "Content-Type": "application/json", "User-Agent": "ComicSync/1.1" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.message || JSON.stringify(data) });
    res.json({ success: true, productId: data.id, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── OFFICIAL REORDER (Pin to Top) ─────────────────────────────────────────
app.post("/reorder", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  const { productId, storePageId, position } = req.body;
  try {
    const response = await fetch("https://api.squarespace.com/1.0/commerce/products/reorder", {
      method: "POST",
      headers: { Authorization: `Bearer ${SQSP_KEY}`, "Content-Type": "application/json", "User-Agent": "ComicSync/1.1" },
      body: JSON.stringify({ collectionId: storePageId, productIds: [productId], index: position || 0 }),
    });
    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.message || "Reorder failed" });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── UPLOAD IMAGES ──────────────────────────────────────────────────────────
app.post("/upload-images", upload.fields([{ name: "thumb", maxCount: 1 }, { name: "front", maxCount: 1 }, { name: "back", maxCount: 1 }]), async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  const { productId } = req.body;
  const results = [];
  const files = [];
  if (req.files?.thumb?.[0]) files.push({ file: req.files.thumb[0], label: "thumb" });
  if (req.files?.front?.[0]) files.push({ file: req.files.front[0], label: "front" });
  if (req.files?.back?.[0]) files.push({ file: req.files.back[0], label: "back" });

  for (const { file, label } of files) {
    try {
      const form = new FormData();
      form.append("file", file.buffer, { filename: `${label}.jpg`, contentType: "image/jpeg" });
      const imgRes = await fetch(`https://api.squarespace.com/1.0/commerce/products/${productId}/images`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SQSP_KEY}`, ...form.getHeaders(), "User-Agent": "ComicSync/1.1" },
        body: form,
      });
      const imgData = await imgRes.json();
      results.push({ label, success: imgRes.ok, id: imgData.id });
    } catch (e) { results.push({ label, success: false, error: e.message }); }
  }
  res.json({ results });
});

// ─── INVENTORY & CATEGORIES ─────────────────────────────────────────────────
app.get("/products", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  const { storePageId, cursor: startCursor } = req.query;
  try {
    let products = [];
    let cursor = startCursor || null;
    let pages = 0;
    do {
      const url = cursor ? `https://api.squarespace.com/1.0/commerce/products?cursor=${cursor}&pageSize=100` : `https://api.squarespace.com/1.0/commerce/products?pageSize=100`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.1" } });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.message });
      for (const p of data.products || []) {
        if (!storePageId || (p.storePageId === storePageId)) {
          products.push({ id: p.id, name: p.name, sku: p.variants?.[0]?.sku, price: p.variants?.[0]?.pricing?.basePrice?.value, createdOn: p.createdOn, isVisible: p.isVisible });
        }
      }
      cursor = data.pagination?.nextPageCursor || null;
      pages++;
    } while (cursor && pages < 5);
    res.json({ products, nextCursor: cursor });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/categories", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  try {
    let categories = [];
    let cursor = null;
    do {
      const r = await fetch(`https://api.squarespace.com/1.0/commerce/products?pageSize=100${cursor ? `&cursor=${cursor}` : ''}`, { headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.1" } });
      const data = await r.json();
      data.products.forEach(p => p.tags.forEach(t => { if (!categories.includes(t)) categories.push(t); }));
      cursor = data.pagination?.nextPageCursor;
    } while (cursor);
    res.json({ categories: categories.sort() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SEARCH & SCRAPING ──────────────────────────────────────────────────────
app.post("/search", async (req, res) => {
  try {
    const r = await fetch(req.body.url, { headers: { "User-Agent": "ComicSync/1.1" } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/product-details", async (req, res) => {
  try {
    const r = await fetch(`https://api.squarespace.com/1.0/commerce/products/${req.query.id}`, { headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.1" } });
    const raw = await r.json();
    const p = raw.products?.[0] || raw;
    res.json({ id: p.id, name: p.name, description: p.description || p.body, isVisible: p.isVisible, sku: p.variants?.[0]?.sku });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/", (req, res) => res.json({ status: "ok", proxy: "ComicSync 1.1" }));
app.listen(PORT, () => console.log(`Proxy v1.1 live on port ${PORT}`));
