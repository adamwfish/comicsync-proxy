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

// Fetch store categories
app.get("/categories", async (req, res) => {
  if (!SQSP_KEY) return res.status(500).json({ error: "SQUARESPACE_API_KEY not set on server" });
  try {
    // Squarespace stores categories as product tags at the store level
    // We fetch all products and collect unique categories
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

// Fetch store page categories (navigation categories)
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
// ─── ADD THIS TO server.js (comicsync-proxy) ──────────────────────────────────
// Place it after your existing /categories route, before app.listen()
//
// This endpoint lets ComicSync search your Squarespace store inventory
// for reprint label lookup. Supports SKU-first, title fallback.
//
// Usage:
//   GET /search-products?q=030925-1430&mode=sku
//   GET /search-products?q=Amazing+Spider-Man&mode=title

app.get('/search-products', async (req, res) => {
  const { q, mode } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter: q' });
  }

  const SQSP_KEY = process.env.SQSP_KEY;
  const headers = {
    'Authorization': `Bearer ${SQSP_KEY}`,
    'User-Agent': 'ComicSync-Proxy/1.0'
  };

  try {
    // Squarespace Products API — paginate up to 200 products
    // (increase limit or add cursor loop if your store grows larger)
    const apiUrl = `https://api.squarespace.com/1.0/commerce/products?limit=200`;
    const response = await fetch(apiUrl, { headers });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Squarespace API error: ${err}` });
    }

    const data = await response.json();
    const allProducts = data.products || [];

    let matches = [];

    if (mode === 'sku') {
      // SKU match: check each product's variants for a matching variantSku
      matches = allProducts.filter(product => {
        const variants = product.variants || [];
        return variants.some(v => {
          const sku = (v.sku || v.variantSku || '').toLowerCase();
          return sku === q.toLowerCase();
        });
      });
    } else {
      // Title match: case-insensitive substring search on product name
      const needle = q.toLowerCase();
      matches = allProducts.filter(product => {
        const name = (product.name || '').toLowerCase();
        return name.includes(needle);
      });
    }

    // Shape the response for ComicSync's printReprintLabel()
    const products = matches.map(p => {
      const variant = (p.variants || [])[0] || {};
      const price = variant.pricing?.basePrice?.value || '0.00';
      const sku = variant.sku || variant.variantSku || '';

      // Pull structured data out of tags if present
      // Tags format from ComicSync: ["1988", "Bronze Age", "Superhero", "Marvel Comics", ...]
      const tags = p.tags || [];
      const year = tags.find(t => /^\d{4}$/.test(t)) || '';
      const publisher = tags.find(t =>
        ['Marvel', 'DC', 'Dell', 'Charlton', 'Harvey', 'Archie', 'ACG', 'EC', 'Atlas',
         'Gold Key', 'Quality', 'Fiction House', 'Fawcett', 'Street & Smith']
          .some(pub => t.toLowerCase().includes(pub.toLowerCase()))
      ) || '';

      return {
        id: p.id,
        name: p.name || '',
        sku,
        price,
        year,
        publisher,
        tags,
        // Pass through raw so the app can extract anything else it needs
        _raw: {
          isVisible: p.isVisible,
          createdOn: p.createdOn,
          modifiedOn: p.modifiedOn,
        }
      };
    });

    res.json({ products, total: products.length });

  } catch (err) {
    console.error('/search-products error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, () => console.log(`ComicSync proxy running on port ${PORT}`));
