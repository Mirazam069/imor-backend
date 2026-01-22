const express = require("express");
const cors = require("cors");

// dotenv birinchi yuklansin
require("dotenv").config();

// db pool
const pool = require("./db");

const app = express();

app.use(cors());
app.use(express.json());

/* =========================
   Helpers
========================= */

const DEFAULT_IMAGE_URL = "https://picsum.photos/400";

/**
 * image_url ni tozalash:
 * - base64 data:image... bo‘lsa DBga yozmaymiz (og‘irlashmasin)
 * - bo‘sh bo‘lsa default qo‘yishimiz mumkin
 */
function sanitizeImageUrl(image_url) {
  let img = image_url || null;

  if (typeof img === "string") {
    const s = img.trim();

    // base64 kelib qolsa — DBni shishirmaslik uchun bloklaymiz
    if (s.startsWith("data:image")) {
      return DEFAULT_IMAGE_URL; // yoki null qaytarsang ham bo‘ladi
    }

    // juda qisqa/bo‘sh bo‘lsa
    if (!s) return DEFAULT_IMAGE_URL;

    return s;
  }

  // string bo‘lmasa
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
    const a = await pool.query(
      "SELECT current_database() as db, current_user as user"
    );
    const b = await pool.query(
      "SELECT COUNT(*)::int as products_count FROM products"
    );
    res.json({ ok: true, ...a.rows[0], ...b.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   PRODUCTS
========================= */

// GET all products
app.get("/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET product by id
app.get("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id noto‘g‘ri" });

    const result = await pool.query("SELECT * FROM products WHERE id=$1", [id]);

    if (!result.rows[0]) {
      return res.status(404).json({ error: "topilmadi" });
    }

    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CREATE product (FULL)
app.post("/products", async (req, res) => {
  try {
    const {
      title,
      price,
      category,
      unit,
      image_url,
      description,

      // extended fields
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

    // ✅ base64 bo‘lsa DBga yozmaydi (default rasm qo‘yadi)
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

// UPDATE product (FULL)
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

    // ✅ base64 bo‘lsa DBga yozmaydi (default rasm qo‘yadi)
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

    if (!result.rows[0]) {
      return res.status(404).json({ error: "topilmadi" });
    }

    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE product
app.delete("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id noto‘g‘ri" });

    const result = await pool.query(
      "DELETE FROM products WHERE id=$1 RETURNING id",
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "topilmadi" });
    }

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
});
