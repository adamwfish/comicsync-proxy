/*
  ComicSync Proxy — server.js v1.3
  Handles Squarespace API communication, scheduling, and image uploads.
  ======================================================================
*/

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import multer from "multer";
import FormData from "form-data";

const app = express();
const PORT = process.env.PORT || 3001;
const SQSP_KEY = process.env.SQUARESPACE_API_KEY;
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 25 * 1024 * 1024 } 
});

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));

// ─── SCHEDULED JOBS ──────────────────────────────────────────────────────────
const scheduledJobs = new Map();

app.post("/schedule", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  const { productId, publishAt, storePageId } = req.body;
  if (!productId || !publishAt) return res.status(400).json({ error: "productId and publishAt required" });
  
  const delay = new Date(publishAt).getTime() - Date.now();
  if (delay <= 0) return res.status(400).json({ error: "Scheduled time is in the past" });
  
  for (const [jid, job] of scheduledJobs.entries()) {
    if (job.productId === productId) { 
      clearTimeout(job.timer); 
      scheduledJobs.delete(jid); 
    }
  }

  const jobId = `${productId}-${Date.now()}`;
  const timer = setTimeout(async () => {
    try {
      const tryPublish = async (method) => {
        const r = await fetch(`https://api.squarespace.com/1.0/commerce/products/${productId}`, {
          method,
          headers: { 
            Authorization: `Bearer ${SQSP_KEY}`, 
            "Content-Type": "application/json", 
            "User-Agent": "ComicSync/1.0" 
          },
          body: JSON.stringify({ isVisible: true })
        });
        return r.ok;
      };
      await tryPublish("PUT") || await tryPublish("PATCH");
    } catch (err) {
      console.error(`[schedule] Error:`, err.message);
    } finally {
      scheduledJobs.delete(jobId);
    }
  }, delay);

  scheduledJobs.set(jobId, { productId, publishAt, timer, storePageId });
  res.json({ jobId, productId, publishAt });
});

app.get("/", (req, res) => {
  res.json({ status: "ok", squarespace: !!SQSP_KEY, scheduledJobs: scheduledJobs.size });
});

// ─── PUSH PRODUCT (Double-Push Fix for Pin-to-Top) ──────────────────────────
app.post("/push", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });

  try {
    // 1. Initial product creation WITHOUT isFeatured (avoids the 400 error)
    const { isFeatured, ...cleanBody } = req.body;
    
    console.log(`[push] Initial create for: ${cleanBody.name}...`);
    const response = await fetch("https://api.squarespace.com/1.0/commerce/products", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SQSP_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "ComicSync/1.0",
      },
      body: JSON.stringify(cleanBody),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.message || JSON.stringify(data) });

    const productId = data.id;

    // 2. IMMEDIATE UPDATE: Force it to "Featured" (Runs separately to avoid the 400 error)
    // This marks it as Featured which Squarespace often uses to prioritize sort order
    console.log(`[push] Secondary PATCH for ${productId} to pin via isFeatured...`);
    await fetch(`https://api.squarespace.com/1.0/commerce/products/${productId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${SQSP_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "ComicSync/1.0",
      },
      body: JSON.stringify({ isFeatured: true }),
    });

    res.json({ success: true, productId, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── REORDER (Official API) ──────────────────────────────────────────────────
// Squarespace requires the FULL ordered list of product IDs — you can't just
// pass one ID with an index. We fetch all current IDs, move the target to the
// desired position, then send the complete list.
app.post("/reorder", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  const { productId, storePageId, position } = req.body;

  try {
    // Step 1: Fetch all current product IDs in their existing store order
    console.log(`[reorder] Fetching all products to build full reorder list...`);
    let allIds = [];
    let cursor = null;
    let pages = 0;
    do {
      const url = `https://api.squarespace.com/1.0/commerce/products?pageSize=100${cursor ? `&cursor=${cursor}` : ''}`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" }
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Failed to fetch products for reorder");
      for (const p of data.products || []) {
        if (!storePageId || p.storePageId === storePageId) {
          allIds.push(p.id);
        }
      }
      cursor = data.pagination?.nextPageCursor || null;
      pages++;
    } while (cursor && pages < 20);

    // Step 2: Remove the target product from its current position
    allIds = allIds.filter(id => id !== productId);

    // Step 3: Insert it at the desired position (0 = top of store)
    const insertAt = position || 0;
    allIds.splice(insertAt, 0, productId);

    // Step 4: Send the complete ordered list to Squarespace
    console.log(`[reorder] Pinning ${productId} to position ${insertAt} of ${allIds.length} total products...`);
    const response = await fetch("https://api.squarespace.com/1.0/commerce/products/reorder", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SQSP_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "ComicSync/1.0",
      },
      body: JSON.stringify({
        collectionId: storePageId,
        productIds: allIds,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.message || "Reorder failed" });
    }

    res.json({ success: true, movedTo: insertAt, totalProducts: allIds.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── UPLOAD IMAGES ──────────────────────────────────────────────────────────
app.post("/upload-images", upload.fields([
  { name: "thumb", maxCount: 1 }, 
  { name: "front", maxCount: 1 }, 
  { name: "back", maxCount: 1 }
]), async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });

  const { productId } = req.body;
  const results = [];
  const uploadList = [];
  if (req.files?.thumb?.[0]) uploadList.push({ file: req.files.thumb[0], label: "thumb" });
  if (req.files?.front?.[0]) uploadList.push({ file: req.files.front[0], label: "front" });
  if (req.files?.back?.[0]) uploadList.push({ file: req.files.back[0], label: "back" });

  for (const { file, label } of uploadList) {
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
            "User-Agent": "ComicSync/1.0"
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

// ─── SEARCH & INVENTORY ──────────────────────────────────────────────────────
app.get("/products", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  const { storePageId, cursor: startCursor } = req.query;
  try {
    let products = [];
    let cursor = startCursor || null;
    let pages = 0;
    do {
      const url = cursor 
        ? `https://api.squarespace.com/1.0/commerce/products?cursor=${cursor}&pageSize=100` 
        : `https://api.squarespace.com/1.0/commerce/products?pageSize=100`;

      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" }
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.message });

      for (const p of data.products || []) {
        if (!storePageId || (p.storePageId === storePageId)) {
          products.push({
            id: p.id,
            name: p.name || "",
            sku: p.variants?.[0]?.sku || "",
            price: p.variants?.[0]?.pricing?.basePrice?.value || "0.00",
            createdOn: p.createdOn,
            isVisible: p.isVisible,
            thumbnail: p.images?.[0]?.url || "",
          });
        }
      }
      cursor = data.pagination?.nextPageCursor || null;
      pages++;
    } while (cursor && pages < 5);

    res.json({ products, nextCursor: cursor });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/search-products", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  const { q, mode } = req.query;
  const searchMode = mode || "title";
  const query = (q || "").toLowerCase().trim();

  try {
    const r = await fetch(`https://api.squarespace.com/1.0/commerce/products?pageSize=50`, {
      headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message);

    let results = data.products.map(p => {
      const v = p.variants?.[0];
      return { id: p.id, name: p.name, sku: v?.sku, price: v?.pricing?.basePrice?.value, thumbnail: p.images?.[0]?.url };
    });

    if (query) {
      results = results.filter(p => 
        searchMode === "sku" ? p.sku.toLowerCase().includes(query) : p.name.toLowerCase().includes(query)
      );
    }
    res.json({ products: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/categories", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  try {
    let categories = [];
    let cursor = null;
    do {
      const r = await fetch(`https://api.squarespace.com/1.0/commerce/products?pageSize=100${cursor ? `&cursor=${cursor}` : ''}`, {
        headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.1" }
      });
      const data = await r.json();
      data.products.forEach(p => p.tags.forEach(t => { if (!categories.includes(t)) categories.push(t); }));
      cursor = data.pagination?.nextPageCursor;
    } while (cursor);
    res.json({ categories: categories.sort() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/search", async (req, res) => {
  try {
    const r = await fetch(req.body.url, { headers: { "User-Agent": "ComicSync/1.0" } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/product-details", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  try {
    const r = await fetch(`https://api.squarespace.com/1.0/commerce/products/${req.query.id}`, {
      headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" }
    });
    const raw = await r.json();
    const p = raw.products?.[0] || raw;
    res.json({
      id: p.id,
      name: p.name,
      description: p.description || p.body,
      isVisible: p.isVisible,
      sku: p.variants?.[0]?.sku,
      price: p.variants?.[0]?.pricing?.basePrice?.value,
      thumbnail: p.images?.[0]?.url
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`ComicSync proxy v1.2 running on port ${PORT}`));
