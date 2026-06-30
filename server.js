/*
  ComicSync Proxy — server.js v1.5
  Handles Squarespace API communication, scheduling, and image uploads.
  ======================================================================
*/

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import multer from "multer";
import FormData from "form-data";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const app = express();
const PORT = process.env.PORT || 3001;
const SQSP_KEY = process.env.SQUARESPACE_API_KEY;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));
app.use(express.static(__dirname));

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
    const { isFeatured, key, ...cleanBody } = req.body;
    
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

// ─── REORDER (Internal Squarespace API) ──────────────────────────────────────
// Uses Squarespace's internal content-service endpoint (found via DevTools).
// Much simpler than the public API — just pass the product ID and target index.
// Requires SQSP_SESSION_COOKIE, SQSP_WEBSITE_ID, and SQSP_CATEGORY_ID env vars.
// Session cookie expires when your Squarespace admin session expires (~30 days).
const SQSP_SITE_HOST   = "rp-co.squarespace.com";
const SQSP_WEBSITE_ID  = process.env.SQSP_WEBSITE_ID  || "65f0daa76c615e0706f50fd9";
const SQSP_STORE_PAGE  = process.env.SQSP_STORE_PAGE  || "65fa302391232642d07c17b1"; // store/page ID
const SQSP_CATEGORY_ID = process.env.SQSP_CATEGORY_ID || "65fa302391232642d07c17be"; // category ID (NOT the store page)

app.post("/reorder", async (req, res) => {
  const { productId, storePageId, position } = req.body;
  const sessionCookie = process.env.SQSP_SESSION_COOKIE;

  if (!sessionCookie) return res.status(500).json({ error: "SQSP_SESSION_COOKIE not set in environment" });
  if (!productId)     return res.status(400).json({ error: "productId required" });

  // Extract crumb token from cookie string
  const crumbMatch = sessionCookie.match(/crumb=([^;]+)/);
  const crumb = crumbMatch ? crumbMatch[1] : "";

  // Use provided storePageId, env override, or hardcoded fallback — NEVER fall back to API key
  const pageId   = storePageId || SQSP_STORE_PAGE;
  const insertAt = (position !== undefined && position !== null) ? position : 0;
  const url = `https://${SQSP_SITE_HOST}/api/content-service/product/1.1/websites/${SQSP_WEBSITE_ID}/products/${pageId}/categories/${SQSP_CATEGORY_ID}/reorder-items`;
  console.log(`[reorder] URL: ${url}`);
  console.log(`[reorder] pageId=${pageId}, categoryId=${SQSP_CATEGORY_ID}, websiteId=${SQSP_WEBSITE_ID}, crumb=${crumb ? crumb.slice(0,8)+'...' : 'MISSING'}`);

  try {
    console.log(`[reorder] Pinning ${productId} to position ${insertAt} via internal API...`);
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
      body: JSON.stringify({ itemIds: [productId], insertAtIndex: insertAt }),
    });

    const responseText = await response.text();
    console.log(`[reorder] Response ${response.status}: ${responseText.slice(0, 200)}`);

    if (!response.ok) {
      return res.status(response.status).json({ error: responseText || "Reorder failed", status: response.status });
    }

    console.log(`[reorder] ✅ Pinned ${productId} to position ${insertAt}`);
    res.json({ success: true, movedTo: insertAt });
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
  const { q, mode, cursor } = req.query;
  const searchMode = mode || "title";
  const query = (q || "").toLowerCase().trim();

  try {
    const url = `https://api.squarespace.com/1.0/commerce/products?pageSize=100` + (cursor ? `&cursor=${cursor}` : "");
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${SQSP_KEY}`, "User-Agent": "ComicSync/1.0" }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message);

    let results = data.products.map(p => {
      const v = p.variants?.[0];
      return { id: p.id, name: p.name, sku: v?.sku, price: v?.pricing?.basePrice?.value, thumbnail: p.images?.[0]?.url, tags: p.tags || [] };
    });

    if (query) {
      results = results.filter(p => 
        searchMode === "sku" ? (p.sku || "").toLowerCase().includes(query) : (p.name || "").toLowerCase().includes(query)
      );
    }
    res.json({ products: results, pagination: data.pagination });
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

// ─── HOMEPAGE WIDGET DATA ───────────────────────────────────────────────────
const COMIC_FUN_FACTS = [
  // Golden Age (1938-1956)
  "Action Comics #1 (1938) featuring Superman is the most valuable comic book ever, worth over $6 million.",
  "The first superhero appearance was Superman in 1938, created by Jerry Siegel and Joe Shuster.",
  "Batman debuted in Detective Comics #27 (1939) and became DC's most popular character.",
  "Wonder Woman was created in 1941 by William Moulton Marston as a feminist icon.",
  "Captain America made his debut in Captain America Comics #1 (1941), before America entered WWII.",
  "Timely Comics (now Marvel) published the first Human Torch in 1939.",
  "The Incredible Hulk was created in 1962, but the Hulk origin story was retroactively set in Golden Age.",
  "Golden Age comics were sold for 10 cents and came with a surprising amount of content.",
  "Subversive Comic Book Hearings began in 1954, leading to the Comics Code Authority.",
  "The Flash (Jay Garrick) first appeared in Flash Comics #1 (1940).",
  "Green Lantern (Alan Scott) debuted in All American Comics #16 (1940) with a magical green lantern.",
  "Hawkman made his first appearance in Flash Comics #1 (1940).",
  "The Atom (Al Pratt) appeared in All American Comics #19 (1940), the first tiny hero.",
  "Johnny Thunder debuted in Flash Comics #1 (1940) with a magical thunderbolt.",

  // Silver Age (1956-1970)
  "The Silver Age began in 1956 when The Flash was reinvented with a scientific origin.",
  "Spider-Man was created in 1962 by Stan Lee and Steve Ditko, revolutionizing the hero archetype.",
  "The X-Men first appeared in X-Men #1 (1963), pioneering the 'misunderstood heroes' concept.",
  "Ant-Man debuted in Tales to Astonish #35 (1962), created by Stan Lee and Jack Kirby.",
  "The Fantastic Four #1 (1961) launched the Silver Age of Marvel Comics.",
  "Thor made his first appearance in Journey into Mystery #83 (1962).",
  "The Hulk debuted in The Incredible Hulk #1 (1962), created by Stan Lee and Jack Kirby.",
  "Iron Man first appeared in Tales of Suspense #39 (1963) during the Vietnam War.",
  "Daredevil was created in 1964 by Stan Lee and artist Bill Everett.",
  "Black Widow debuted as a villain in Tales of Suspense #52 (1964).",
  "Doctor Strange appeared in Strange Tales #110 (1963), created by Stan Lee and Steve Ditko.",
  "Silver Age comics cost 12 cents and featured full-color printing.",
  "The Comics Code Authority relaxed restrictions in the 1960s, allowing more mature storylines.",
  "Stan Lee's famous 'cameos' became a signature in Marvel Comics during the Silver Age.",
  "Kirby's 'Kirby Krackle' technology-inspired visual effect became iconic in Silver Age comics.",
  "Black Panther debuted in Fantastic Four #52 (1966), Marvel's first Black superhero.",
  "The Inhumans were introduced in Fantastic Four #36 (1965).",
  "Galactus, one of Marvel's most powerful beings, first appeared in Fantastic Four #48 (1966).",
  "The Watcher first appeared in Fantastic Four #13 (1963) as an immortal observer of the universe.",
  "Silver Surfer debuted in Fantastic Four #48 (1966), originally as Galactus's herald.",
];

// Rotate through fun facts with pagination
let factIndex = 0;

app.get("/widget/blog-latest", async (req, res) => {
  try {
    // Fetch latest post from 'derailed' blog
    const response = await fetch("https://derailed.co/feed.json");
    if (!response.ok) throw new Error("Failed to fetch blog");

    const feed = await response.json();
    const latestPost = feed.items?.[0] || null;

    res.json({
      success: true,
      title: latestPost?.title || "Latest Post",
      url: latestPost?.url || "#",
      date: latestPost?.date_published || new Date().toISOString(),
      excerpt: latestPost?.summary || "New post available",
    });
  } catch (e) {
    res.json({
      success: false,
      title: "Blog Unavailable",
      url: "#",
      date: new Date().toISOString(),
      excerpt: "Latest posts coming soon",
    });
  }
});

app.get("/widget/weather", async (req, res) => {
  try {
    // Using Open-Meteo (free, no API key required)
    // Default to New York City, but can be changed with lat/lon params
    const lat = req.query.lat || "40.7128";
    const lon = req.query.lon || "-74.0060";

    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day&timezone=auto`
    );

    if (!response.ok) throw new Error("Weather API error");

    const data = await response.json();
    const current = data.current;

    // Map WMO weather codes to descriptions
    const weatherDescriptions = {
      0: "Clear",
      1: "Mostly Clear",
      2: "Partly Cloudy",
      3: "Overcast",
      45: "Foggy",
      48: "Foggy",
      51: "Light Drizzle",
      53: "Drizzle",
      55: "Heavy Drizzle",
      61: "Light Rain",
      63: "Rain",
      65: "Heavy Rain",
      71: "Light Snow",
      73: "Snow",
      75: "Heavy Snow",
      80: "Rain Showers",
      81: "Heavy Rain Showers",
      82: "Violent Rain Showers",
      85: "Snow Showers",
      86: "Heavy Snow Showers",
      95: "Thunderstorm",
      96: "Thunderstorm with Hail",
      99: "Thunderstorm with Hail",
    };

    res.json({
      success: true,
      temp: Math.round(current.temperature_2m),
      condition: weatherDescriptions[current.weather_code] || "Unknown",
      isDaytime: current.is_day,
    });
  } catch (e) {
    res.json({
      success: false,
      temp: "--",
      condition: "N/A",
      isDaytime: true,
    });
  }
});

app.get("/widget/fun-facts", async (req, res) => {
  const page = parseInt(req.query.page || "0");
  const limit = 5; // Show 5 facts at a time

  // Infinite cycle through facts
  const startIdx = (page * limit) % COMIC_FUN_FACTS.length;
  const facts = [];

  for (let i = 0; i < limit; i++) {
    facts.push(COMIC_FUN_FACTS[(startIdx + i) % COMIC_FUN_FACTS.length]);
  }

  res.json({
    success: true,
    facts,
    page,
    total: COMIC_FUN_FACTS.length,
    hasMore: true, // Always has more (infinite)
  });
});

app.listen(PORT, () => console.log(`ComicSync proxy v1.5 running on port ${PORT}`));
