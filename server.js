// server.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");

// dotenv birinchi yuklansin
require("dotenv").config();

// db pool
const pool = require("./db");

// AWS S3 compatible (R2) SDK
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();

// ✅ Render/Proxy ortida protocol/headerlar to‘g‘ri o‘qilishi uchun
app.set("trust proxy", 1);

/* =========================
   MIDDLEWARES
========================= */
app.use(
  cors({
    origin: true, // dev/prodda kelgan origin’ni qaytaradi
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

/* =========================
   R2 (S3-compatible)
========================= */

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "imor-uploads";

// ✅ Asosiy env nomi: R2_PUBLIC_BASE_URL
// ✅ Fallback: R2_PUBLIC_BASE
const R2_PUBLIC_BASE_URL = String(
  process.env.R2_PUBLIC_URL ||          // ✅ Render’da bor
  process.env.R2_PUBLIC_BASE_URL ||     // optional
  process.env.R2_PUBLIC_BASE ||         // optional
  "https://pub-1eba283b4eb44ecbbb9af8ab84fddca2.r2.dev"
).replace(/\/+$/, "");

// ✅ credential bor/yo‘qligini flag qilib olamiz
const R2_READY = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);

if (!R2_READY) {
  console.warn("[R2] Credentials yo‘q. Render ENV ga R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY ni qo‘ying.");
}

// client faqat credential bo‘lsa ishlaydi
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

/* =========================
   Upload (RAM -> R2)
========================= */

function safeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_.]/g, "")
    .slice(0, 60);
}

const upload = multer({
  storage: multer.memoryStorage(), // ✅ disk emas
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB
  fileFilter(req, file, cb) {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/jpg"].includes(file.mimetype);
    if (!ok) return cb(new Error("Faqat JPG/PNG/WEBP ruxsat."), false);
    cb(null, true);
  },
});

// ✅ upload endpoint: file -> { ok:true, url:"https://...r2.dev/<key>" }
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!R2_READY) {
      return res.status(500).json({
        ok: false,
        error: "R2 sozlanmagan. Render ENV’da R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY yo‘q.",
      });
    }

    if (!req.file) return res.status(400).json({ ok: false, error: "Fayl topilmadi." });

    const extFromMime = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
    };

    const original = req.file.originalname || "image";
    const base = safeName(original.replace(/\.[^/.]+$/, ""));
    const ext = extFromMime[req.file.mimetype] || ".jpg";
    const uniq = crypto.randomBytes(8).toString("hex");

    // ✅ tartib uchun folder bilan saqlaymiz
    const key = `imor/${base}-${Date.now()}-${uniq}${ext}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const url = `${R2_PUBLIC_BASE_URL}/${key}`;
    return res.status(201).json({ ok: true, url, key });
  } catch (e) {
    console.error("[UPLOAD ERROR]", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   Helpers
========================= */

// R2’da default rasm bo‘lsa shu yerga qo‘yasan, hozir bo‘sh qoldiramiz
const DEFAULT_IMAGE_URL = "";

// base64 kelib qolsa — DBga yozmaymiz
function sanitizeImageUrl(image_url) {
  let img = image_url || null;

  if (typeof img === "string") {
    const s = img.trim();
    if (!s) return DEFAULT_IMAGE_URL;

    if (s.startsWith("data:image")) return DEFAULT_IMAGE_URL;

    return s; // ✅ endi URLlar absolute bo‘ladi (r2.dev)
  }

  return DEFAULT_IMAGE_URL;
}

/* =========================
   Health / Debug
========================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    app: "imor-backend",
    r2: {
      ready: R2_READY,
      bucket: R2_BUCKET,
      publicBase: R2_PUBLIC_BASE_URL,
    },
  });
});

app.get("/db-test", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ ok: true, time: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/db-info", async (req, res) => {
  try {
    const a = await pool.query("SELECT current_database() as db, current_user as user");
    const b = await pool.query("SELECT COUNT(*)::int as products_count FROM products");
    res.json({ ok: true, ...a.rows[0], ...b.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   PRODUCTS
========================= */

app.get("/products", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id noto‘g‘ri" });

    const result = await pool.query("SELECT * FROM products WHERE id=$1", [id]);
    if (!result.rows[0]) return res.status(404).json({ error: "topilmadi" });

    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/products", async (req, res) => {
  try {
    const {
      title,
      price,
      category,
      unit,
      image_url,
      description,

      seller_id,
      seller_name,
      status,
      region,
      catalog_key,
      min_qty,
      delivery,
      phone,
      telegram,
    } = req.body;

    if (!title || !category) {
      return res.status(400).json({ error: "title va category majburiy" });
    }

    const p = Number(price || 0);
    const img = sanitizeImageUrl(image_url);

    const result = await pool.query(
      `INSERT INTO products
      (
        title, price, category, unit, image_url, description,
        seller_id, seller_name, status, region, catalog_key,
        min_qty, delivery, phone, telegram
      )
      VALUES
      (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,
        $12,$13,$14,$15
      )
      RETURNING *`,
      [
        title,
        p,
        category,
        unit || "dona",
        img,
        description || null,

        seller_id || "s_1",
        seller_name || "IMOR Seller",
        status || "active",
        region || null,
        catalog_key || null,
        Number(min_qty || 1),
        Boolean(delivery),
        phone || null,
        telegram || null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id noto‘g‘ri" });

    const {
      title,
      price,
      category,
      unit,
      image_url,
      description,

      seller_id,
      seller_name,
      status,
      region,
      catalog_key,
      min_qty,
      delivery,
      phone,
      telegram,
    } = req.body;

    if (!title || !category) {
      return res.status(400).json({ error: "title va category majburiy" });
    }

    const p = Number(price || 0);
    const img = sanitizeImageUrl(image_url);

    const result = await pool.query(
      `UPDATE products SET
        title=$1,
        price=$2,
        category=$3,
        unit=$4,
        image_url=$5,
        description=$6,
        seller_id=$7,
        seller_name=$8,
        status=$9,
        region=$10,
        catalog_key=$11,
        min_qty=$12,
        delivery=$13,
        phone=$14,
        telegram=$15
       WHERE id=$16
       RETURNING *`,
      [
        title,
        p,
        category,
        unit || "dona",
        img,
        description || null,
        seller_id || "s_1",
        seller_name || "IMOR Seller",
        status || "active",
        region || null,
        catalog_key || null,
        Number(min_qty || 1),
        Boolean(delivery),
        phone || null,
        telegram || null,
        id,
      ]
    );

    if (!result.rows[0]) return res.status(404).json({ error: "topilmadi" });

    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id noto‘g‘ri" });

    const result = await pool.query("DELETE FROM products WHERE id=$1 RETURNING id", [id]);
    if (!result.rows[0]) return res.status(404).json({ error: "topilmadi" });

    res.json({ ok: true, deletedId: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("IMOR backend running on port", PORT);
  console.log("R2 READY:", R2_READY, "| BUCKET:", R2_BUCKET);
});
