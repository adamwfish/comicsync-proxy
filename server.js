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
  const { productId, publishAt, storePageId } = req.body;
  if (!productId || !publishAt) return res.status(400).json({ error: "productId and publishAt are required" });
  const delay = new Date(publishAt).getTime() - Date.now();
  if (delay <= 0) return res.status(400).json({ error: "Scheduled time is in the past" });
  for (const [jid, job] of scheduledJobs.entries()) {
    if (job.productId === productId) { clearTimeout(job.timer); scheduledJobs.delete(jid); }
  }
  const jobId = `${productId}-${Date.now()}`;
  const timer = setTimeout(async () => {
    try {
      // Try PUT first (full update), then PATCH (partial) if that fails
      const tryPublish = async (method) => {
        const r = await fetch(`https://api.squarespace.com/1.0/commerce/products/${productId}`, {
          method,
          headers: { Authorization: `Bearer ${SQSP_KEY}`, "Content-Type": "application/json", "User-Agent": "ComicSync/1.0" },
          body: JSON.stringify({ isVisible: true })
        });
        const body = await r.json().catch(() => ({}));
        console.log(`[schedule] ${method} visibility → ${r.status}:`, JSON.stringify(body).slice(0, 200));
        return r.ok;
      };

      const ok = await tryPublish("PUT") || await tryPublish("PATCH");
      if (ok) {
        console.log(`[schedule] Auto-published product ${productId} ✓`);
      } else {
        console.error(`[schedule] All publish attempts failed for ${productId}`);
      }
    } catch (err) {
      console.error(`[schedule] Error:`, err.message);
    } finally {
      scheduledJobs.delete(jobId);
    }
  }, delay);
  scheduledJobs.set(jobId, { productId, publishAt, timer, storePageId });
  console.log(`[schedule] Job queued — publishes at ${publishAt} (in ${Math.round(delay / 60000)} min)`);
  res.json({ jobId, productId, publishAt, delayMs: delay, storePageId });
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

    // --- NEW: SqaureSpace Reorder Hack ---
    try {
      console.log(`[push] Attempting to send product ${data.id} to top of store...`);
      const reorderUrl = "https://rp-co.squarespace.com/api/content-service/product/1.1/websites/65f0daa76c615e0706f50fd9/products/65fa302391232642d07c17b1/categories/65fa302391232642d07c17be/reorder-items";
      const reorderHeaders = {
        'accept': 'application/json',
        'content-type': 'application/json',
        'cookie': 'SS_ANALYTICS_ID=7be6c7e7-9398-4baa-86a7-4b704fe6866c; _gcl_au=1.1.883033486.1767641073; _ga=GA1.1.1953302461.1767641073; _fbp=fb.1.1767641075504.518936450599139868; __stripe_mid=8c80f5e4-48b0-4917-b0bd-c30c41b916fc2d7a09; ss_i18n=%7B%22language%22%3A%22en-US%22%2C%22currency%22%3A%22USD%22%7D; IR_PI=bc29e449-eb23-11f0-b525-919900eae983%7C1767719915792; _pin_unauth=dWlkPU9XRXhPVFV6WmpJdE9XUmlPQzAwTlRZeExUZ3pOR1l0TVROa05HRTFNamRrTnprMQ; SS_MID=f318065f-c466-429b-a6b8-0b132aa75bd3iz8rxffc; cf_clearance=uHRy99muPPKbh0_Yy39.YRMZXNIhFaOL7eKP22K0w4Y-1767972018-1.2.1.1-rquJb6_wQ3B7WXLlKmWOP0uNBepiaraeMYu8Msg_Mi7dObWOr8OUOozt.bwl_C4l21j5Bt5JI.WdyjRNiMsQBzS1JLk.Wg__T0TZgVD3Md1OJR8fRj0EBymFlxLe2kqXyq_beJf3slaX4sZFcPJEg8qQHTfcOQ.s1ZWrvg86NvJ.wTM2hdtPX3VM_Tb0aiG1lT1SqtSLhWLRyDh.nD_IpRLyPBpF8m6xJ1V7HMtVOL0; _ga_E5RVG86DKP=GS2.1.s1767972017$o1$g1$t1767972054$j60$l0$h0; ai_terms=true; _pin_unauth=dWlkPU9XRXhPVFV6WmpJdE9XUmlPQzAwTlRZeExUZ3pOR1l0TVROa05HRTFNamRrTnprMQ; iterableEndUserId=adamwfish%40gmail.com; __ssid=f11a0723-8f7b-458c-b65f-906aa819490e; member-session=1|6190BIUSsjbspvrh/S84AKrTrnf4+YY69bt1EhFUvL/s|7KiShRXJD2ekrGLF6vH5+HTzyb6Aqt3qAXWYBbBM09g=; SS_SESSION_ID=12513fd3-0ce4-44b2-b4c1-d2c2683e28d9; IR_gbd=squarespace.com; notice_behavior=implied,us; crumb=ml71/hCYI1J6onpLKzgBPmF5RRnGyrS1QqKavmRTEt2D; seven_one_migration_preview_message_seen=; ss_lastid=eyJpZGVudGlmaWVyIjoicnAtY28ifQ%3D%3D; notice_behavior=implied,us; _rdt_uuid=1767719915948.28c87040-9b73-4a77-9a01-6923ae89855b; _rdt_em=a30606cae890c96207f73fa4cf2c2bbd186bce67e027791447ba447754fde85f; __stripe_sid=91e0e74f-e2ff-488d-9a0f-6134e84daed370cec1; TAsessionID=7a4cf402-bddd-4acd-af95-039e3edf16ea|NEW; _uetsid=6aef00f01b4d11f1a522dde1b3d106b4; _uetvid=29954480ea6c11f0a10ee75ab8747509; IR_9084=1773238703668%7C1332152%7C1773238703668%7C%7C; _ga_1L8CXRNJCG=GS2.1.s1773238688$o136$g1$t1773238780$j55$l0$h0; _ga_TWWC2ZW70V=GS2.1.s1773238700$o120$g1$t1773238851$j60$l0$h0',
        'x-csrf-token': 'ml71/hCYI1J6onpLKzgBPmF5RRnGyrS1QqKavmRTEt2D',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
      };

      const reorderBody = JSON.stringify({
        itemIds: [data.id],
        insertAtIndex: 0
      });

      const reorderRes = await fetch(reorderUrl, { method: 'POST', headers: reorderHeaders, body: reorderBody });
      if (reorderRes.ok) {
        console.log(`[push] Product ${data.id} successfully sent to center stage!`);
      } else {
        console.log(`[push] Failed to send product ${data.id} to top: ${reorderRes.status}`);
      }
    } catch (err) {
      console.error(`[push] Reorder Error:`, err.message);
    }

    res.json({ success: true, productId: data.id, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── UPLOAD IMAGES ──────────────────────────────────────────────────────────
// Accepts multipart: front (file), back (file), productId (string)
app.post("/upload-images", upload.fields([{ name: "thumb", maxCount: 1 }, { name: "front", maxCount: 1 }, { name: "back", maxCount: 1 }]), async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });

  const { productId } = req.body;
  if (!productId) return res.status(400).json({ error: "productId required" });

  const results = [];
  const files = [];
  // thumb uploads first so Squarespace uses it as the product thumbnail
  if (req.files?.thumb?.[0]) files.push({ file: req.files.thumb[0], label: "thumb" });
  if (req.files?.front?.[0]) files.push({ file: req.files.front[0], label: "front" });
  if (req.files?.back?.[0]) files.push({ file: req.files.back[0], label: "back" });

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
          const sku = variant?.sku || "";
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
            description: "",
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

// ─── SEARCH PROXY ────────────────────────────────────────────────────────────
// Acts as a CORS bypass for the frontend Metron API calls
app.post("/search", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL parameter is required" });

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "ComicSync/1.0 (robopictocomics.com)"
      }
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.detail || "Search API Error" });
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SEARCH PRODUCTS ─────────────────────────────────────────────────────────
// Used by the Reprint Label modal — searches Squarespace inventory by SKU or title
// In-memory cache: fetches ALL products once, then searches in-memory for 3 min
let _productCache = null;
let _productCacheAt = 0;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

async function getAllProducts(sqspKey) {
  const now = Date.now();
  if (_productCache && (now - _productCacheAt) < CACHE_TTL_MS) {
    console.log(`[search-products] Cache hit (${_productCache.length} products, ${Math.round((now - _productCacheAt) / 1000)}s old)`);
    return _productCache;
  }
  console.log(`[search-products] Cache miss — fetching from Squarespace...`);
  const products = [];
  let cursor = null;
  do {
    const url = cursor
      ? `https://api.squarespace.com/1.0/commerce/products?cursor=${cursor}&pageSize=100`
      : `https://api.squarespace.com/1.0/commerce/products?pageSize=100`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${sqspKey}`, "User-Agent": "ComicSync/1.0" }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || JSON.stringify(data));
    for (const p of data.products || []) {
      const variant = p.variants?.[0];
      products.push({
        id: p.id,
        name: p.name || "",
        sku: variant?.sku || "",
        skuLower: (variant?.sku || "").toLowerCase(),
        nameLower: (p.name || "").toLowerCase(),
        price: variant?.pricing?.basePrice?.value || "0.00",
        tags: p.tags || [],
        isVisible: p.isVisible,
        thumbnail: p.images?.[0]?.url || "",
        createdOn: p.createdOn || "",
        body: p.body || "",
      });
    }
    cursor = data.pagination?.nextPageCursor || null;
  } while (cursor);

  _productCache = products;
  _productCacheAt = Date.now();
  console.log(`[search-products] Cached ${products.length} products`);
  return products;
}

// GET /search-products?q=<query>&mode=sku|title|date
// mode=date: q is an ISO date (YYYY-MM-DD); converts to SKU prefix {M}{DD}{YY}-
app.get("/search-products", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });
  const { q, mode } = req.query;
  if (!q) return res.status(400).json({ error: "q (query) parameter is required" });

  const searchMode = mode || "title";

  try {
    const all = await getAllProducts(SQSP_KEY);
    let results;

    if (searchMode === "latest") {
      // Return 25 most recently added products (sorted by createdOn desc)
      results = [...all]
        .sort((a, b) => (b.createdOn > a.createdOn ? 1 : -1))
        .slice(0, 25)
        .map(({ skuLower, nameLower, ...p }) => p);
    } else if (searchMode === "date") {
      // q expected as YYYY-MM-DD; convert to SKU prefix M[DD][YY]-
      // e.g. 2026-03-11 → "31126-"
      const d = new Date(q + "T00:00:00");
      const month = d.getMonth() + 1;          // 1-12 (no leading zero)
      const day = String(d.getDate()).padStart(2, "0");
      const year2 = String(d.getFullYear()).slice(-2);
      const prefix = `${month}${day}${year2}-`;
      console.log(`[search-products] date mode — prefix: "${prefix}"`);
      results = all
        .filter(p => p.skuLower.startsWith(prefix))
        .map(({ skuLower, nameLower, ...p }) => p);
    } else {
      const query = q.toLowerCase().trim();
      results = all
        .filter(p => searchMode === "sku" ? p.skuLower.includes(query) : p.nameLower.includes(query))
        .slice(0, 20)
        .map(({ skuLower, nameLower, ...p }) => p);
    }

    res.json({ products: results, cached: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /cache — manually bust the product cache
app.delete("/cache", (req, res) => {
  _productCache = null;
  _productCacheAt = 0;
  res.json({ cleared: true });
});

// GET /product-details?id=<productId>
// Fetches a single product including its full description HTML
// NOTE: Squarespace wraps even single-product responses in { products: [...] }
app.get("/product-details", async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "id parameter required" });
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  try {
    const r = await fetch(`https://api.squarespace.com/1.0/commerce/products/${id}`, {
      headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" }
    });
    if (!r.ok) return res.status(r.status).json({ error: `Squarespace error ${r.status}` });
    const raw = await r.json();
    // Squarespace wraps single-product responses in { products: [...] }
    const p = raw.products?.[0] || raw;
    const variant = p.variants?.[0];
    const description = p.description || p.body || "";
    console.log(`[product-details] ${id} → desc ${description.length} chars, urlSlug: ${p.urlSlug}`);
    res.json({
      id: p.id,
      name: p.name || "",
      description,
      urlSlug: p.urlSlug || "",
      url: p.url || "",
      sku: variant?.sku || "",
      price: variant?.pricing?.basePrice?.value || "0.00",
      tags: p.tags || [],
      isVisible: p.isVisible,
      thumbnail: p.images?.[0]?.url || "",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PRODUCT PAGE DESCRIPTION (scrapes public page) ─────────────────────────
// Extracts inner HTML of first div whose class includes a given name
function extractDivContent(html, className) {
  const startMatch = html.match(new RegExp('<div[^>]+class="' + className + '[^"]*"[^>]*>', 'i'));
  if (!startMatch) return '';
  const startIdx = startMatch.index + startMatch[0].length;
  let depth = 1, i = startIdx;
  while (i < html.length && depth > 0) {
    const openDiv = html.indexOf('<div', i);
    const closeDiv = html.indexOf('</div>', i);
    if (closeDiv === -1) break;
    if (openDiv !== -1 && openDiv < closeDiv) { depth++; i = openDiv + 4; }
    else { depth--; if (depth === 0) return html.slice(startIdx, closeDiv); i = closeDiv + 6; }
  }
  return '';
}

// GET /product-page-description?id=<productId>
// 1. Fetches urlSlug from Commerce API
// 2. GETs the public product page
// 3. Extracts and returns the .product-description div inner HTML
app.get("/product-page-description", async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "id parameter required" });
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set" });
  try {
    // Step 1 — get urlSlug
    const apiRes = await fetch(`https://api.squarespace.com/1.0/commerce/products/${id}`, {
      headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" }
    });
    if (!apiRes.ok) return res.status(apiRes.status).json({ error: `Squarespace API ${apiRes.status}` });
    const raw = await apiRes.json();
    // Squarespace wraps single-product responses in { products: [...] }
    const product = raw.products?.[0] || raw;
    // urlSlug already includes "p/" prefix e.g. "p/the-incredible-hulk-181-f-55"
    const urlSlug = (product.urlSlug || product.slug || product.handle || "").replace(/^p\//, "");
    if (!urlSlug) return res.status(404).json({ error: "Product has no URL slug — cannot scrape page" });

    // Step 2 — fetch public page
    const pageUrl = `https://www.robopictocomics.com/1st-floor-shop/p/${urlSlug}`;
    console.log(`[product-page-description] Fetching: ${pageUrl}`);
    const pageRes = await fetch(pageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ComicSync/1.0)" }
    });
    if (!pageRes.ok) return res.status(pageRes.status).json({ error: `Page fetch ${pageRes.status}` });
    const html = await pageRes.text();

    // Step 3 — extract description div
    const description = extractDivContent(html, 'product-description');
    console.log(`[product-page-description] ${urlSlug} → ${description.length} chars`);

    res.json({ id, urlSlug, name: product.name || "", description });
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
