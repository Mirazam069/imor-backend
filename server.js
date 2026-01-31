const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

// dotenv birinchi yuklansin
require("dotenv").config();

// db pool
const pool = require("./db");

const app = express();

/* =========================
   MIDDLEWARES
========================= */
app.use(
  cors({
    origin: true, // devda hammasiga ruxsat
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

/* =========================
   Uploads (REAL)
========================= */

// uploads papka yo‘q bo‘lsa yaratib qo‘yamiz
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ✅ static serve: /uploads/xxx.jpg orqali rasm ochiladi
// ⚠️ faqat bitta marta yoziladi!
app.use("/uploads", express.static(UPLOAD_DIR));

// (ixtiyoriy) agar no-photo.png yo‘q bo‘lsa — yaratib qo‘yamiz (minimal placeholder)
const NO_PHOTO_PATH = path.join(UPLOAD_DIR, "no-photo.png");
if (!fs.existsSync(NO_PHOTO_PATH)) {
  // 1x1 px PNG (base64) — juda kichik placeholder
  const tinyPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/1m9bXcAAAAASUVORK5CYII=";
  fs.writeFileSync(NO_PHOTO_PATH, Buffer.from(tinyPngBase64, "base64"));
}

// fayl nomini xavfsiz qilish
function safeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_.]/g, "")
    .slice(0, 60);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const base = safeName(path.basename(file.originalname || "image", ext));
    const uniq = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${base}-${uniq}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const ok = ["image/jpeg", "image/png", "image/webp", "image/jpg"].includes(
    file.mimetype
  );
  if (!ok) return cb(new Error("Faqat JPG/PNG/WEBP ruxsat."), false);
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB
});

// ✅ upload endpoint: file -> { ok:true, url:"/uploads/xxx.jpg" }
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Fayl topilmadi." });

    const base = `${req.protocol}://${req.get("host")}`; // ✅ https://imor-backend.onrender.com
    const url = `${base}/uploads/${req.file.filename}`;

    return res.status(201).json({ ok: true, url });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   Helpers
========================= */

// ✅ Lokal placeholder
const DEFAULT_IMAGE_URL = "/uploads/no-photo.png";

/**
 * image_url ni tozalash:
 * - base64 data:image... bo‘lsa DBga yozmaymiz
 * - bo‘sh bo‘lsa default
 */
function sanitizeImageUrl(image_url) {
  let img = image_url || null;

  if (typeof img === "string") {
    const s = img.trim();

    // base64 bo‘lsa — DBni shishirmaymiz
    if (s.startsWith("data:image")) return DEFAULT_IMAGE_URL;

    // bo‘sh bo‘lsa
    if (!s) return DEFAULT_IMAGE_URL;

    // agar user faqat "rasm.jpg" yuborsa, uni /uploads/ ga o‘rab qo‘yamiz (xatoni kamaytiradi)
    if (!s.startsWith("http") && !s.startsWith("/uploads/") && !s.startsWith("/")) {
      return `/uploads/${s}`;
    }

    return s;
  }

  return DEFAULT_IMAGE_URL;
}

/* =========================
   Health / Debug
========================= */

app.get("/health", (req, res) => {
  res.json({ ok: true, app: "imor-backend" });
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

// (oddiy) list
app.get("/products", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// by id
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

// create
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

// update
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

// delete
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
  console.log("Uploads served at: http://localhost:" + PORT + "/uploads/<file>");
});
