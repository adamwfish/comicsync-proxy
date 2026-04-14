/*
  ComicSync Proxy - server.js v1.6
  Handles Squarespace API communication, scheduling, and image uploads.

  v1.6 changes:
  - Added SQSP_SESSION_COOKIE health check on startup + every 24h
  - Added /cookie-status endpoint to inspect session state
  - /reorder now falls back gracefully to isFeatured PATCH when cookie is dead
  - /push always attempts reorder immediately after product creation
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

// ─── SITE CONSTANTS ───────────────────────────────────────────────────────────
const SQSP_SITE_HOST   = "rp-co.squarespace.com";
const SQSP_WEBSITE_ID  = process.env.SQSP_WEBSITE_ID  || "65f0daa76c615e0706f50fd9";
const SQSP_STORE_PAGE  = process.env.SQSP_STORE_PAGE  || "65fa302391232642d07c17b1";
const SQSP_CATEGORY_ID = process.env.SQSP_CATEGORY_ID || "65fa302391232642d07c17be";

// ─── COOKIE HEALTH TRACKING ───────────────────────────────────────────────────
let cookieStatus = {
  alive: null,          // true / false / null (unknown)
  lastChecked: null,    // ISO timestamp
  lastError: null,      // error message if dead
};

function extractCrumb(cookie) {
  const m = cookie?.match(/crumb=([^;]+)/);
  return m ? m[1] : "";
}

async function checkCookieHealth() {
  const sessionCookie = process.env.SQSP_SESSION_COOKIE;
  if (!sessionCookie) {
    cookieStatus = { alive: false, lastChecked: new Date().toISOString(), lastError: "SQSP_SESSION_COOKIE env var not set" };
    console.warn("[cookie] ⚠️  SQSP_SESSION_COOKIE is not set — /reorder will use isFeatured fallback");
    return false;
  }

  const crumb = extractCrumb(sessionCookie);
  // Hit a lightweight authenticated endpoint to test the session
  const testUrl = `https://${SQSP_SITE_HOST}/api/content-service/product/1.1/websites/${SQSP_WEBSITE_ID}/products/${SQSP_STORE_PAGE}/categories/${SQSP_CATEGORY_ID}/reorder-items`;

  try {
    const r = await fetch(testUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": sessionCookie,
        "Crumb": crumb,
        "Origin": `https://${SQSP_SITE_HOST}`,
        "Referer": `https://${SQSP_SITE_HOST}/config/pages/${SQSP_STORE_PAGE}/categories/${SQSP_CATEGORY_ID}`,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
      },
      // Empty reorder — not a real reorder, just testing auth
      body: JSON.stringify({ itemIds: [], insertAtIndex: 0 }),
    });

    // 401/403 = dead session. 400/200 = session is alive (400 = bad params but authed)
    if (r.status === 401 || r.status === 403) {
      const msg = `Session rejected with HTTP ${r.status} — cookie has expired`;
      cookieStatus = { alive: false, lastChecked: new Date().toISOString(), lastError: msg };
      console.warn(`[cookie] ❌ ${msg}`);
      return false;
    }

    cookieStatus = { alive: true, lastChecked: new Date().toISOString(), lastError: null };
    console.log(`[cookie] ✅ Session cookie is alive (HTTP ${r.status})`);
    return true;
  } catch (e) {
    cookieStatus = { alive: false, lastChecked: new Date().toISOString(), lastError: e.message };
    console.warn(`[cookie] ❌ Health check failed: ${e.message}`);
    return false;
  }
}

// Check on startup, then every 24 hours
checkCookieHealth();
setInterval(checkCookieHealth, 24 * 60 * 60 * 1000);

// ─── COOKIE STATUS ENDPOINT ───────────────────────────────────────────────────
app.get("/cookie-status", (req, res) => {
  const hasCookie = !!process.env.SQSP_SESSION_COOKIE;
  res.json({
    ...cookieStatus,
    hasCookie,
    instructions: cookieStatus.alive === false
      ? "Session expired. Log into rp-co.squarespace.com, open DevTools → Network, click any request, copy the full 'Cookie' header value, and update SQSP_SESSION_COOKIE in Render environment variables."
      : "Session looks healthy.",
  });
});

// ─── REORDER (Internal Squarespace API) ──────────────────────────────────────
async function reorderProduct(productId, storePageId, position = 0) {
  const sessionCookie = process.env.SQSP_SESSION_COOKIE;
  if (!sessionCookie || cookieStatus.alive === false) {
    return { success: false, fallback: true, reason: cookieStatus.lastError || "No session cookie" };
  }

  const crumb  = extractCrumb(sessionCookie);
  const pageId = storePageId || SQSP_STORE_PAGE;
  const url    = `https://${SQSP_SITE_HOST}/api/content-service/product/1.1/websites/${SQSP_WEBSITE_ID}/products/${pageId}/categories/${SQSP_CATEGORY_ID}/reorder-items`;

  console.log(`[reorder] Pinning ${productId} → position ${position}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": sessionCookie,
      "Crumb": crumb,
      "Origin": `https://${SQSP_SITE_HOST}`,
      "Referer": `https://${SQSP_SITE_HOST}/config/pages/${pageId}/categories/${SQSP_CATEGORY_ID}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({ itemIds: [productId], insertAtIndex: position }),
  });

  const text = await response.text();
  console.log(`[reorder] Response ${response.status}: ${text.slice(0, 200)}`);

  if (response.status === 401 || response.status === 403) {
    // Cookie just died mid-session — update status immediately
    cookieStatus = { alive: false, lastChecked: new Date().toISOString(), lastError: `Cookie rejected HTTP ${response.status}` };
    return { success: false, fallback: true, reason: `Cookie rejected (${response.status}) — needs refresh` };
  }

  if (!response.ok) {
    return { success: false, fallback: false, reason: text || `HTTP ${response.status}` };
  }

  return { success: true, movedTo: position };
}

// ─── isFEATURED FALLBACK ─────────────────────────────────────────────────────
// When the session cookie is dead, patch isFeatured=true as a best-effort
// pin. Not as precise as reorder but keeps new items near the top.
async function featuredFallback(productId) {
  if (!SQSP_KEY) return;
  console.log(`[fallback] Patching isFeatured=true for ${productId}`);
  await fetch(`https://api.squarespace.com/1.0/commerce/products/${productId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${SQSP_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "ComicSync/1.0",
    },
    body: JSON.stringify({ isFeatured: true }),
  });
}

// ─── SCHEDULED JOBS ───────────────────────────────────────────────────────────
const scheduledJobs = new Map();

app.post("/schedule", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  const { productId, publishAt, storePageId } = req.body;
  if (!productId || !publishAt) return res.status(400).json({ error: "productId and publishAt required" });

  const delay = new Date(publishAt).getTime() - Date.now();
  if (delay <= 0) return res.status(400).json({ error: "Scheduled time is in the past" });

  for (const [jid, job] of scheduledJobs.entries()) {
    if (job.productId === productId) { clearTimeout(job.timer); scheduledJobs.delete(jid); }
  }

  const jobId = `${productId}-${Date.now()}`;
  const timer = setTimeout(async () => {
    try {
      const tryPublish = async (method) => {
        const r = await fetch(`https://api.squarespace.com/1.0/commerce/products/${productId}`, {
          method,
          headers: { Authorization: `Bearer ${SQSP_KEY}`, "Content-Type": "application/json", "User-Agent": "ComicSync/1.0" },
          body: JSON.stringify({ isVisible: true })
        });
        return r.ok;
      };
      await tryPublish("PUT") || await tryPublish("PATCH");

      // Also attempt reorder when the scheduled publish fires
      const reorderResult = await reorderProduct(productId, storePageId, 0);
      if (!reorderResult.success) await featuredFallback(productId);
    } catch (err) {
      console.error(`[schedule] Error:`, err.message);
    } finally {
      scheduledJobs.delete(jobId);
    }
  }, delay);

  scheduledJobs.set(jobId, { productId, publishAt, timer, storePageId });
  res.json({ jobId, productId, publishAt });
});

// ─── STATUS ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    version: "1.6",
    squarespace: !!SQSP_KEY,
    scheduledJobs: scheduledJobs.size,
    sessionCookie: cookieStatus,
  });
});

// ─── PUSH PRODUCT ─────────────────────────────────────────────────────────────
app.post("/push", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });

  try {
    // 1. Create product (strip isFeatured to avoid 400)
    const { isFeatured, storePageId, ...cleanBody } = req.body;
    console.log(`[push] Creating: ${cleanBody.name}...`);

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
    console.log(`[push] Created ${productId} — attempting pin-to-top...`);

    // 2. Try hard reorder first, fall back to isFeatured
    const reorderResult = await reorderProduct(productId, storePageId, 0);
    let pinMethod = "reorder";

    if (!reorderResult.success) {
      console.warn(`[push] Reorder failed (${reorderResult.reason}) — using isFeatured fallback`);
      await featuredFallback(productId);
      pinMethod = "isFeatured_fallback";
    }

    res.json({
      success: true,
      productId,
      data,
      pinMethod,
      cookieAlive: cookieStatus.alive,
      reorderResult,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── REORDER (standalone endpoint) ───────────────────────────────────────────
app.post("/reorder", async (req, res) => {
  const { productId, storePageId, position } = req.body;
  if (!productId) return res.status(400).json({ error: "productId required" });

  const result = await reorderProduct(productId, storePageId, position ?? 0);
  if (!result.success && result.fallback) {
    // Attempt isFeatured as fallback
    await featuredFallback(productId);
    return res.json({ success: false, fallbackUsed: true, reason: result.reason });
  }
  if (!result.success) return res.status(500).json({ error: result.reason });
  res.json({ success: true, movedTo: result.movedTo });
});

// ─── UPLOAD IMAGES ────────────────────────────────────────────────────────────
app.post("/upload-images", upload.fields([
  { name: "thumb", maxCount: 1 },
  { name: "front", maxCount: 1 },
  { name: "back",  maxCount: 1 }
]), async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });

  const { productId } = req.body;
  const results = [];
  const uploadList = [];
  if (req.files?.thumb?.[0]) uploadList.push({ file: req.files.thumb[0], label: "thumb" });
  if (req.files?.front?.[0]) uploadList.push({ file: req.files.front[0], label: "front" });
  if (req.files?.back?.[0])  uploadList.push({ file: req.files.back[0],  label: "back"  });

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
            "User-Agent": "ComicSync/1.0",
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

// ─── SEARCH & INVENTORY ───────────────────────────────────────────────────────
app.get("/products", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  const { storePageId, cursor: startCursor } = req.query;
  try {
    let products = [], cursor = startCursor || null, pages = 0;
    do {
      const url = cursor
        ? `https://api.squarespace.com/1.0/commerce/products?cursor=${cursor}&pageSize=100`
        : `https://api.squarespace.com/1.0/commerce/products?pageSize=100`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" } });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.message });
      for (const p of data.products || []) {
        if (!storePageId || p.storePageId === storePageId) {
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
  const query = (q || "").toLowerCase().trim();
  const searchMode = mode || "title";
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
        searchMode === "sku" ? p.sku?.toLowerCase().includes(query) : p.name?.toLowerCase().includes(query)
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
    let categories = [], cursor = null;
    do {
      const r = await fetch(`https://api.squarespace.com/1.0/commerce/products?pageSize=100${cursor ? `&cursor=${cursor}` : ""}`, {
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
      id: p.id, name: p.name,
      description: p.description || p.body,
      isVisible: p.isVisible,
      sku: p.variants?.[0]?.sku,
      price: p.variants?.[0]?.pricing?.basePrice?.value,
      thumbnail: p.images?.[0]?.url,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`ComicSync proxy v1.6 running on port ${PORT}`));
