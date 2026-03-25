import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import pool from "./db.js";
import multer from "multer";
import pdfParse from "pdf-parse/lib/pdf-parse.js";



dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

// middleware
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit – adjust if needed
  },
});

// ---------- Auth middleware (Sprint 2: token + role) ----------
/** Optional: verifies JWT from Authorization header and sets req.userId, req.role */
function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return next();
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.role = payload.role || "owner";
    req.tokenPayload = payload;
  } catch {
    // invalid or expired – leave req.userId unset
  }
  next();
}

/** Use after verifyToken: requires authenticated user, optionally owner-only */
function requireAuth(options = {}) {
  return (req, res, next) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (options.ownerOnly && req.role !== "owner") {
      return res.status(403).json({ error: "Owner access required" });
    }
    next();
  };
}

/**
 * SIGNUP
 * - New accounts are created as role 'owner'
 * - Sprint 2: role and token handling
 */
app.post("/api/signup", async (req, res) => {
  try {
    const { email, password, companyName } = req.body;

    if (!email || !password || !companyName) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Email already in use" });
    }

    let result;
    try {
      result = await pool.query(
`INSERT INTO users (email, password_hash, company_name, "role")
         VALUES ($1, $2, $3, 'owner')
         RETURNING id, email, company_name, "role", invited_by_user_id`,
        [email, password, companyName]
      );
    } catch (colErr) {
      if (colErr.code === "42703") {
        result = await pool.query(
          `INSERT INTO users (email, password_hash, company_name)
           VALUES ($1, $2, $3)
           RETURNING id, email, company_name`,
          [email, password, companyName]
        );
        result.rows[0].role = "owner";
        result.rows[0].invited_by_user_id = null;
      } else throw colErr;
    }

    const user = result.rows[0];
    const publicUser = { id: user.id, email: user.email, company_name: user.company_name, role: user.role || "owner", invited_by_user_id: user.invited_by_user_id ?? undefined };

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: publicUser.role,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const menu = await getOrCreateMainMenu(user.id);

    res.status(201).json({ user: publicUser, token, menu });
  } catch (err) {
    console.error("Error in /api/signup:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * LOGIN
 * - Returns user with role; JWT includes role for access control
 */
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email and password are required" });
    }

    let result;
    try {
result = await pool.query(
        `SELECT id, email, password_hash, company_name, "role", invited_by_user_id
         FROM users WHERE email = $1`,
        [email]
      );
    } catch (colErr) {
      if (colErr.code === "42703") {
        result = await pool.query(
          `SELECT id, email, password_hash, company_name FROM users WHERE email = $1`,
          [email]
        );
      } else throw colErr;
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = result.rows[0];

    if (user.password_hash !== password) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const role = user.role || "owner";
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const publicUser = {
      id: user.id,
      email: user.email,
      company_name: user.company_name,
      role,
      invited_by_user_id: user.invited_by_user_id ?? undefined,
    };

    return res.json({ user: publicUser, token });
  } catch (err) {
    console.error("Error in /api/login:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

async function getOrCreateMainMenu(userId) {
  // 1) check for existing active menu
    const existing = await pool.query(
      `
      SELECT id, user_id, name, description, is_active, created_at
      FROM menus
      WHERE user_id = $1 AND is_active = TRUE
      ORDER BY id
      LIMIT 1
      `,
      [userId]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    const inserted = await pool.query(
      `
      INSERT INTO menus (user_id, name, is_active)
      VALUES ($1, $2, TRUE)
      RETURNING id, user_id, name, description, is_active, created_at
      `,
      [userId, "Main menu"]
    );

    return inserted.rows[0];
    }

//   const existing = await pool.query(
//     `SELECT id, user_id, name, description, is_active, created_at
//      FROM menus
//      WHERE user_id = $1 AND is_active = TRUE
//      ORDER BY id
//      LIMIT 1`,
//     [userId]
//   );

//   if (existing.rows.length > 0) {
//     return existing.rows[0];
//   }

//   // 2) create a new main menu
//   const inserted = await pool.query(
//     `INSERT INTO menus (user_id, name, is_active)
//      VALUES ($1, $2, TRUE)
//      RETURNING id, user_id, name, description, is_active, created_at`,
//     [userId, "Main menu"]
//   );

//   return inserted.rows[0];
// }

app.get("/api/menu", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Optionally make sure the user exists
    const userCheck = await pool.query(
      "SELECT id FROM users WHERE id = $1",
      [userId]
    );
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // 🔹 Get or create the main menu
    const menu = await getOrCreateMainMenu(userId);

    // 🔹 Fetch menu items for this menu
      // Fetch menu items for this menu
      const itemsResult = await pool.query(
        `
        SELECT
          id,
          name,
          category,
          price_cents,
          estimated_emissions_kg_co2e,
          is_active,
          created_at
        FROM menu_items
        WHERE menu_id = $1 AND is_active = TRUE
        ORDER BY created_at ASC
        `,
        [menu.id]
      );
//     const itemsResult = await pool.query(
//       `SELECT id, name, category, price_cents, estimated_emissions_kg_co2e, is_active, created_at
//        FROM menu_items
//        WHERE menu_id = $1 AND is_active = TRUE
//        ORDER BY created_at ASC`,
//       [menu.id]
//     );

    res.json({
      menu,
      items: itemsResult.rows,
    });
  } catch (err) {
    console.error("Error in /api/menu:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/menu/items
// Body: { userId, name, category, price }
app.post("/api/menu/items", async (req, res) => {
  try {
    const { userId, name, category, price } = req.body;

    if (!userId || !name) {
      return res
        .status(400)
        .json({ error: "Missing required fields (userId, name)" });
    }

    // make sure user exists
    const userCheck = await pool.query("SELECT id FROM users WHERE id = $1", [
      userId,
    ]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // get or create main menu for this user
    const menu = await getOrCreateMainMenu(userId);

    // convert price in dollars to cents (if provided)
    let priceCents = null;
    if (price !== undefined && price !== null && price !== "") {
      const p = Number(price);
      if (Number.isNaN(p) || p < 0) {
        return res.status(400).json({ error: "Invalid price value" });
      }
      priceCents = Math.round(p * 100);
    }

    // for now, we handle emissions internally → start at 0
    const emissionsValue = 0;
      const insertResult = await pool.query(
        `
        INSERT INTO menu_items (
          menu_id,
          name,
          category,
          price_cents,
          estimated_emissions_kg_co2e,
          is_active
        )
        VALUES ($1,$2,$3,$4,$5,TRUE)
        RETURNING
          id,
          name,
          category,
          price_cents,
          estimated_emissions_kg_co2e,
          is_active,
          created_at
        `,
        [menu.id, name, category || null, priceCents, emissionsValue]
      );
//     const insertResult = await pool.query(
//       `INSERT INTO menu_items (
//          menu_id, name, category, price_cents, estimated_emissions_kg_co2e, is_active
//        )
//        VALUES ($1, $2, $3, $4, $5, TRUE)
//        RETURNING id, name, category, price_cents, estimated_emissions_kg_co2e, is_active, created_at`,
//       [menu.id, name, category || null, priceCents, emissionsValue]
//     );

    res.status(201).json({ item: insertResult.rows[0] });
  } catch (err) {
    console.error("Error in /api/menu/items:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
app.post("/api/onboarding/facility", async (req, res) => {
  try {
    const userId = req.userId || req.body.userId;
    const data = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Optional: verify user exists
    const userCheck = await pool.query("SELECT id FROM users WHERE id = $1", [
      userId,
    ]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Optional: clear any old profile for this user
    await pool.query("DELETE FROM facility_profiles WHERE user_id = $1", [
      userId,
    ]);

      const result = await pool.query(
        `
        INSERT INTO facility_profiles (
          user_id,
          energy_type,
          electricity_usage,
          efficient_appliances,
          renewables,
          food_waste_handling,
          food_waste_percent,
          recycling,
          water_tracking,
          water_efficient,
          sourcing,
          delivery_frequency,
          packaging_type,
          reusable_program,
          vehicles,
          weekly_km
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16
        )
        RETURNING *
        `,
        [
          userId,
          data.energyType,
          data.electricityUsage,
          data.efficientAppliances || [],
          data.renewables,
          data.foodWasteHandling,
          data.foodWastePercent,
          data.recycling,
          data.waterTracking,
          data.waterEfficient,
          data.sourcing,
          data.deliveryFrequency,
          data.packagingType,
          data.reusableProgram,
          data.vehicles,
          data.weeklyKm,
        ]
      );
//     const result = await pool.query(
//       `INSERT INTO facility_profiles (
//         user_id,
//         energy_type, electricity_usage, efficient_appliances, renewables,
//         food_waste_handling, food_waste_percent, recycling,
//         water_tracking, water_efficient,
//         sourcing, delivery_frequency,
//         packaging_type, reusable_program,
//         vehicles, weekly_km
//       ) VALUES (
//         $1, $2, $3, $4, $5,
//         $6, $7, $8,
//         $9, $10,
//         $11, $12,
//         $13, $14,
//         $15, $16
//       )
//       RETURNING *`,
//       [
//         userId,
//         data.energyType,
//         data.electricityUsage,
//         data.efficientAppliances || [],
//         data.renewables,
//         data.foodWasteHandling,
//         data.foodWastePercent,
//         data.recycling,
//         data.waterTracking,
//         data.waterEfficient,
//         data.sourcing,
//         data.deliveryFrequency,
//         data.packagingType,
//         data.reusableProgram,
//         data.vehicles,
//         data.weeklyKm,
//       ]
//     );

    res.status(201).json({ success: true, profile: result.rows[0] });
  } catch (err) {
    console.error("Error saving facility profile:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/onboarding/facility", async (req, res)=> {
  try {
    const userId = req.query.userId||req.userId;

    if (!userId) {
      return res.status(400).json({ error: "User ID Missing or Not Found" });
    }

    const result = await pool.query(
      `SELECT *
       FROM facility_profiles
       WHERE user_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({profile: null});
    }

    return res.json({profile: result.rows[0]});
  } catch (err) {
    console.error("Error in GET api onboarding:  ", err);
    res.status(500).json({
      error: "Internal server error"
    });
  }
});


// Very simple heuristic parser: look for lines with a price and treat them as menu items
function extractMenuCandidatesFromText(text) {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim()) // normalize spaces
    .filter((l) => l.length > 0);

  // price like: 12, 12.95, $12.95, 1,200.00
  const priceRegex = /\$?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/;

  const hasLetters = (s) => /[A-Za-z]/.test(s);

  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ---------------------------
    // Case A: name + price on SAME line
    // ---------------------------
    let match = line.match(priceRegex);

    if (match && hasLetters(line)) {
      const priceStr = match[0];
      const priceIndex = match.index ?? line.indexOf(priceStr);

      // Everything before the price is treated as the name
      let namePart = line.slice(0, priceIndex).trim();
      // Strip trailing dots/dashes: "THE RICHMOND ...."
      namePart = namePart.replace(/[\.\·\-]+$/g, "").trim();

      if (namePart.length >= 3 && hasLetters(namePart)) {
        const cleaned = priceStr.replace("$", "").replace(/,/g, "");
        const price = Number(cleaned);
        if (!Number.isNaN(price) && price > 0) {
          candidates.push({
            name: namePart,
            price,
            rawLine: line,
          });
          continue; // don’t also try Case B for this line
        }
      }
    }
    if (hasLetters(line) && !match && i + 1 < lines.length) {
      const next = lines[i + 1];
      const nextMatch = next.match(priceRegex);

      if (nextMatch) {
        const priceStr = nextMatch[0];
        const cleaned = priceStr.replace("$", "").replace(/,/g, "");
        const price = Number(cleaned);

        if (!Number.isNaN(price) && price > 0) {
          let namePart = line.replace(/[\.\·\-]+$/g, "").trim();

          if (namePart.length >= 3 && hasLetters(namePart)) {
            candidates.push({
              name: namePart,
              price,
              rawLine: line + " " + next,
            });
            i++; // skip the price line since we've consumed it
          }
        }
      }
    }
  }

  return candidates;
}


app.post(
  "/api/menu/import-pdf",
  upload.single("menuPdf"),
  async (req, res) => {
    console.log("HIT /api/menu/import-pdf");
    try {
      const { userId } = req.body;
      const file = req.file;

      if (!userId) {
        return res.status(400).json({ error: "Missing userId" });
      }

      if (!file) {
        return res.status(400).json({ error: "No PDF file uploaded" });
      }

      // Ensure user exists
      const userCheck = await pool.query("SELECT id FROM users WHERE id = $1", [
        userId,
      ]);
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      // Extract text from the PDF
      const pdfData = await pdfParse(file.buffer);
      const text = pdfData.text || "";


      if (!text.trim()) {
        return res.status(400).json({
          error: "Could not extract text from PDF (may be image-only).",
        });
      }

      const candidates = extractMenuCandidatesFromText(text);

      if (candidates.length === 0) {
        return res.status(200).json({
          candidates: [],
          message:
            "No menu-like lines were detected. You may need to add items manually.",
        });
      }

      // For now, we only detect + return them; frontend will confirm which to import
      res.json({ candidates });
    } catch (err) {
      console.error("Error in /api/menu/import-pdf:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
app.put("/api/menu/items/:id", async (req, res) => {
  try {
    const itemId = req.params.id;
    const { name, category, price } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    let priceCents = null;
    if (price !== undefined && price !== null && price !== "") {
      const p = Number(price);
      if (Number.isNaN(p) || p < 0) {
        return res.status(400).json({ error: "Invalid price value" });
      }
      priceCents = Math.round(p * 100);
    }

    const updateResult = await pool.query(
      `UPDATE menu_items
       SET name = $1,
           category = $2,
           price_cents = $3
       WHERE id = $4
       RETURNING id, name, category, price_cents,
                 estimated_emissions_kg_co2e, is_active, created_at`,
      [name, category || null, priceCents, itemId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: "Menu item not found" });
    }

    res.json({ item: updateResult.rows[0] });
  } catch (err) {
    console.error("Error in PUT /api/menu/items/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// SOFT-DELETE (deactivate) a menu item
// DELETE /api/menu/items/:id
app.delete("/api/menu/items/:id", async (req, res) => {
  try {
    const itemId = req.params.id;

    const deleteResult = await pool.query(
      `UPDATE menu_items
       SET is_active = FALSE
       WHERE id = $1
       RETURNING id`,
      [itemId]
    );

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ error: "Menu item not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error in DELETE /api/menu/items/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Menu item ingredients (per-dish emissions) ----------
async function recomputeMenuItemEmissions(menuItemId) {
  try {
      const result = await pool.query(
        `
        SELECT
          mi.quantity_grams,
          mi.unit,
          COALESCE(ing.emissions_kg_co2e_per_kg, ing.emissions_per_kg_co2e) AS emissions_factor
        FROM menu_item_ingredients mi
        JOIN ingredients ing ON ing.id = mi.ingredient_id
        WHERE mi.menu_item_id = $1
        `,
        [menuItemId]
        );
//     const rows = await pool.query(
//       `SELECT mi.quantity_grams, mi.unit, COALESCE(ing.emissions_kg_co2e_per_kg, ing.emissions_per_kg_co2e) AS emission_factor
//        FROM menu_item_ingredients mi
//        JOIN ingredients ing ON ing.id = mi.ingredient_id
//        WHERE mi.menu_item_id = $1`,
//       [menuItemId]
//     );
    let total = 0;
    //for (const r of rows.rows) {
      for (const r of result.rows) {
      const qtyKg = (r.unit === "g" ? Number(r.quantity_grams) / 1000 : Number(r.quantity_grams)) || 0;
      const factor = Number(r.emissions_factor) || 0;
      total += qtyKg * factor;
    }
    await pool.query(
      `UPDATE menu_items SET estimated_emissions_kg_co2e = $1 WHERE id = $2`,
      [total, menuItemId]
    );
    return total;
  } catch (err) {
    if (err.code === "42703") {
      try {
        const rows = await pool.query(
          `SELECT mi.quantity_grams, mi.unit, ing.emissions_per_kg_co2e AS emission_factor
           FROM menu_item_ingredients mi
           JOIN ingredients ing ON ing.id = mi.ingredient_id
           WHERE mi.menu_item_id = $1`,
          [menuItemId]
        );
        let total = 0;
        for (const r of rows.rows) {
          const qtyKg = (r.unit === "g" ? Number(r.quantity_grams) / 1000 : Number(r.quantity_grams)) || 0;
          total += qtyKg * (Number(r.emission_factor) || 0);
        }
        await pool.query(
          `UPDATE menu_items SET estimated_emissions_kg_co2e = $1 WHERE id = $2`,
          [total, menuItemId]
        );
        return total;
      } catch {
        await pool.query(
          `UPDATE menu_items SET estimated_emissions_kg_co2e = 0 WHERE id = $1`,
          [menuItemId]
        ).catch(() => {});
        return 0;
      }
    }
    throw err;
  }
}

app.get("/api/menu/items/:id/ingredients", async (req, res) => {
  const menuItemId = req.params.id;
  const emissionVal = (r) => Number(r.emissions_kg_co2e_per_kg ?? r.emissions_per_kg_co2e ?? 0);
  const mapRow = (r) => {
    const factor = emissionVal(r);
    return {
      id: r.id,
      menu_item_id: r.menu_item_id,
      ingredient_id: r.ingredient_id,
      quantity_grams: r.quantity_grams,
      quantity: Number(r.quantity_grams),
      unit: r.unit || "g",
      ingredient_name: r.ingredient_name,
      emissions_per_kg_co2e: factor,
      emissions_kg_co2e_per_kg: factor,
    };
  };
  try {
      const rows = await pool.query(
        `
        SELECT
          mi.id,
          mi.menu_item_id,
          mi.ingredient_id,
          mi.quantity_grams,
          mi.unit,
          ing.name AS ingredient_name,
          COALESCE(
            ing.emissions_kg_co2e_per_kg,
            ing.emissions_per_kg_co2e
          ) AS emissions_kg_co2e_per_kg,
          ing.emissions_per_kg_co2e
        FROM menu_item_ingredients mi
        JOIN ingredients ing
          ON ing.id = mi.ingredient_id
        WHERE mi.menu_item_id = $1
        ORDER BY mi.id ASC
        `,
        [menuItemId]
        );
//     const rows = await pool.query(
//       `SELECT mi.id, mi.menu_item_id, mi.ingredient_id, mi.quantity_grams, mi.unit,
//               ing.name AS ingredient_name,
//               COALESCE(ing.emissions_kg_co2e_per_kg, ing.emissions_per_kg_co2e) AS emissions_kg_co2e_per_kg,
//               ing.emissions_per_kg_co2e
//        FROM menu_item_ingredients mi
//        JOIN ingredients ing ON ing.id = mi.ingredient_id
//        WHERE mi.menu_item_id = $1
//        ORDER BY mi.id`,
//       [menuItemId]
//     );
    let totalEmissions = 0;
    for (const r of rows.rows) {
      const qtyKg = (r.unit === "g" ? Number(r.quantity_grams) / 1000 : Number(r.quantity_grams)) || 0;
      totalEmissions += qtyKg * (Number(r.emissions_kg_co2e_per_kg ?? r.emissions_per_kg_co2e) || 0);
    }
    return res.json({
      ingredients: rows.rows.map(mapRow),
      totalEmissionsKgCo2e: totalEmissions,
    });
  } catch (err) {
    if (err.code === "42703" && err.message && (err.message.includes("emissions_per_kg_co2e") || err.message.includes("emissions_kg_co2e_per_kg"))) {
      try {
          const rows = await pool.query(
            `
            SELECT
              mi.id,
              mi.menu_item_id,
              mi.ingredient_id,
              mi.quantity_grams,
              mi.unit,
              ing.name AS ingredient_name,
              COALESCE(ing.emissions_kg_co2e_per_kg, ing.emissions_per_kg_co2e) AS emissions_kg_co2e_per_kg,
              ing.emissions_per_kg_co2e
            FROM menu_item_ingredients mi
            JOIN ingredients ing ON ing.id = mi.ingredient_id
            WHERE mi.menu_item_id = $1
            ORDER BY mi.id ASC
            `,
            [menuItemId]
          );
//         const rows = await pool.query(
//           `SELECT mi.id, mi.menu_item_id, mi.ingredient_id, mi.quantity_grams, mi.unit, ing.name AS ingredient_name, ing.emissions_per_kg_co2e
//            FROM menu_item_ingredients mi
//            JOIN ingredients ing ON ing.id = mi.ingredient_id
//            WHERE mi.menu_item_id = $1 ORDER BY mi.id`,
//           [menuItemId]
//         );
        const withEmission = rows.rows.map((r) => ({ ...r, emissions_kg_co2e_per_kg: r.emissions_per_kg_co2e ?? 0 }));
        return res.json({
          ingredients: withEmission.map(mapRow),
          totalEmissionsKgCo2e: withEmission.reduce((sum, r) => {
            const qtyKg = (r.unit === "g" ? Number(r.quantity_grams) / 1000 : Number(r.quantity_grams)) || 0;
            return sum + qtyKg * (Number(r.emissions_per_kg_co2e) || 0);
          }, 0),
        });
      } catch (fallbackErr) {
        console.error("Error in GET /api/menu/items/:id/ingredients fallback:", fallbackErr);
      }
    }
    console.error("Error in GET /api/menu/items/:id/ingredients:", err);
    return res.json({ ingredients: [], totalEmissionsKgCo2e: 0 });
  }
});

app.post("/api/menu/items/:id/ingredients", async (req, res) => {
  try {
    const menuItemId = req.params.id;
    const { ingredientId, quantityGrams } = req.body;
    if (!ingredientId || quantityGrams == null) {
      return res.status(400).json({ error: "ingredientId and quantityGrams required" });
    }
    const qty = Number(quantityGrams);
    if (Number.isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: "quantityGrams must be a positive number" });
    }
    const existing = await pool.query(
      "SELECT id FROM menu_item_ingredients WHERE menu_item_id = $1 AND ingredient_id = $2",
      [menuItemId, ingredientId]
    );
    if (existing.rows.length > 0) {
      try {
        await pool.query(
          "UPDATE menu_item_ingredients SET quantity_grams = $1, quantity = $1 WHERE menu_item_id = $2 AND ingredient_id = $3",
          [qty, menuItemId, ingredientId]
        );
      } catch (updateErr) {
        if (updateErr.code === "42703") {
          await pool.query(
            "UPDATE menu_item_ingredients SET quantity_grams = $1 WHERE menu_item_id = $2 AND ingredient_id = $3",
            [qty, menuItemId, ingredientId]
          );
        } else {
          throw updateErr;
        }
      }
    } else {
      try {
          await pool.query(
            `
            INSERT INTO menu_item_ingredients (
              menu_item_id,
              ingredient_id,
              quantity_grams,
              quantity,
              unit
            )
            VALUES ($1,$2,$3,$3,'g')
            `,
            [menuItemId, ingredientId, qty]
          );
//         await pool.query(
//           `INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id, quantity_grams, quantity, unit)
//            VALUES ($1, $2, $3, $3, 'g')`,
//           [menuItemId, ingredientId, qty]
//         );
      } catch (insertErr) {
        if (insertErr.code === "42703") {
          await pool.query(
            `INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id, quantity_grams, unit)
             VALUES ($1, $2, $3, 'g')`,
            [menuItemId, ingredientId, qty]
          );
        } else {
          throw insertErr;
        }
      }
    }
    const totalEmissions = await recomputeMenuItemEmissions(menuItemId);
    const row = await pool.query(
      `
      SELECT
        mi.id,
        mi.ingredient_id,
        mi.quantity_grams,
        mi.unit,
        ing.name AS ingredient_name,
        COALESCE(
          ing.emissions_kg_co2e_per_kg,
          ing.emissions_per_kg_co2e
        ) AS emission_factor
      FROM menu_item_ingredients mi
      JOIN ingredients ing
        ON ing.id = mi.ingredient_id
      WHERE mi.menu_item_id = $1
      AND mi.ingredient_id = $2
      `,
      [menuItemId, ingredientId]
      );
    const r = row.rows[0];
    const factor = Number(r.emission_factor) || 0;
    res.status(201).json({
      ingredient: {
        id: r.id,
        menu_item_id: Number(menuItemId),
        ingredient_id: r.ingredient_id,
        quantity_grams: r.quantity_grams,
        quantity: Number(r.quantity_grams),
        unit: r.unit || "g",
        ingredient_name: r.ingredient_name,
        emissions_per_kg_co2e: factor,
        emissions_kg_co2e_per_kg: factor,
      },
      totalEmissionsKgCo2e: totalEmissions,
    });
  } catch (err) {
    console.error("Error in POST /api/menu/items/:id/ingredients:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/menu/items/:id/ingredients/:ingredientId", async (req, res) => {
  try {
    const menuItemId = req.params.id;
    const ingredientId = req.params.ingredientId;
    const del = await pool.query(
      "DELETE FROM menu_item_ingredients WHERE menu_item_id = $1 AND ingredient_id = $2 RETURNING id",
      [menuItemId, ingredientId]
    );
    if (del.rows.length === 0) {
      return res.status(404).json({ error: "Ingredient not linked to this menu item" });
    }
    const totalEmissions = await recomputeMenuItemEmissions(menuItemId);
    res.json({ totalEmissionsKgCo2e: totalEmissions });
  } catch (err) {
    console.error("Error in DELETE /api/menu/items/:id/ingredients/:ingredientId:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Ingredients (Sprint 2: expanded emissions dataset) ----------
/**
 * GET /api/ingredients
 * Returns all ingredients with name, category, emissions_per_kg_co2e for menu modeling.
 * If the ingredients table does not exist yet (migration not run), returns empty array so the UI still loads.
 */
app.get("/api/ingredients", async (req, res) => {
  try {
    const { category } = req.query;
    const emissionSelect = "COALESCE(emissions_kg_co2e_per_kg, emissions_per_kg_co2e) AS emissions_kg_co2e_per_kg, emissions_per_kg_co2e";
    let query = `SELECT id, name, category, ${emissionSelect} FROM ingredients ORDER BY category, name`;
    const params = [];
    if (category) {
      query = `SELECT id, name, category, ${emissionSelect} FROM ingredients WHERE category = $1 ORDER BY name`;
      params.push(category);
    }
    let result = await pool.query(query, params);
    const rows = (result.rows || []).map((r) => ({
      ...r,
      emissions_kg_co2e_per_kg: Number(r.emissions_kg_co2e_per_kg ?? r.emissions_per_kg_co2e ?? 0),
      emissions_per_kg_co2e: Number(r.emissions_kg_co2e_per_kg ?? r.emissions_per_kg_co2e ?? 0),
    }));
    res.json({ ingredients: rows });
  } catch (err) {
    // If column missing (old schema), fallback to minimal columns and add defaults
    if (err.code === "42703") {
      try {
        const fallback = await pool.query("SELECT id, name FROM ingredients ORDER BY name");
        const rows = (fallback.rows || []).map((r) => {
          const emission = Number(r.emissions_kg_co2e_per_kg ?? r.emissions_per_kg_co2e ?? 0);
          return {
            ...r,
            category: r.category ?? "other",
            emissions_per_kg_co2e: emission,
            emissions_kg_co2e_per_kg: emission,
          };
        });
        return res.json({ ingredients: rows });
      } catch (fallbackErr) {
        console.error("Error in /api/ingredients fallback:", fallbackErr);
      }
    }
    console.error("Error in /api/ingredients:", err);
    return res.json({
      ingredients: [],
      message: "Ingredients not loaded. Run: npm run migrate (in backend folder).",
    });
  }
});

// ---------- Ingredient purchases & waste (Waste page) ----------

app.get("/api/ingredient-purchases", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const result = await pool.query(
      "SELECT id, user_id, ingredient_id, quantity_grams, total_cost_cad, purchase_date, created_at FROM ingredient_purchases WHERE user_id = $1 ORDER BY purchase_date DESC, id DESC",
      [userId]
    );
    const rows = (result.rows || []).map((r) => ({
      ...r,
      total_cost_cad: r.total_cost_cad != null ? String(r.total_cost_cad) : null,
    }));
    res.json({ purchases: rows });
  } catch (err) {
    if (err.code === "42P01") {
      return res.json({ purchases: [] });
    }
    console.error("Error in GET /api/ingredient-purchases:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/ingredient-purchases", async (req, res) => {
  try {
    const { userId, ingredientId, quantityGrams, totalCostCad, purchaseDate } = req.body || {};
    if (!userId || ingredientId == null) return res.status(400).json({ error: "userId and ingredientId required" });
    const qty = Number(quantityGrams) || 0;
    const date = purchaseDate || new Date().toISOString().slice(0, 10);
    const cost = totalCostCad != null && totalCostCad !== "" ? Number(totalCostCad) : null;
    const result = await pool.query(
      `
      INSERT INTO ingredient_purchases (
        user_id,
        ingredient_id,
        quantity_grams,
        total_cost_cad,
        purchase_date
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, ingredient_id, quantity_grams, total_cost_cad, purchase_date, created_at
      `,
      [userId, Number(ingredientId), qty, cost, date]
    );
    const purchase = result.rows[0];
    if (purchase) purchase.total_cost_cad = purchase.total_cost_cad != null ? String(purchase.total_cost_cad) : null;
    res.status(201).json({ purchase });
  } catch (err) {
    console.error("Error in POST /api/ingredient-purchases:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/api/ingredient-purchases/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { userId, ingredientId, quantityGrams, totalCostCad, purchaseDate } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    const updates = [];
    const values = [];
    let paramIndex = 1;
    if (ingredientId != null) {
      updates.push(`ingredient_id = $${paramIndex++}`);
      values.push(Number(ingredientId));
    }
    if (quantityGrams != null) {
      updates.push(`quantity_grams = $${paramIndex++}`);
      values.push(Number(quantityGrams) ?? 0);
    }
    if (totalCostCad !== undefined) {
      updates.push(`total_cost_cad = $${paramIndex++}`);
      values.push(totalCostCad != null && totalCostCad !== "" ? Number(totalCostCad) : null);
    }
    if (purchaseDate != null) {
      updates.push(`purchase_date = $${paramIndex++}`);
      values.push(purchaseDate);
    }
    if (updates.length === 0) {
      const row = await pool.query(
        "SELECT id, user_id, ingredient_id, quantity_grams, total_cost_cad, purchase_date, created_at FROM ingredient_purchases WHERE id = $1 AND user_id = $2",
        [id, userId]
      );
      if (row.rows.length === 0) return res.status(404).json({ error: "Purchase not found" });
      const p = row.rows[0];
      p.total_cost_cad = p.total_cost_cad != null ? String(p.total_cost_cad) : null;
      return res.json({ purchase: p });
    }
    values.push(id, userId);
    const result = await pool.query(
      `UPDATE ingredient_purchases SET ${updates.join(", ")} WHERE id = $${paramIndex++} AND user_id = $${paramIndex} RETURNING id, user_id, ingredient_id, quantity_grams, total_cost_cad, purchase_date, created_at`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Purchase not found" });
    const p = result.rows[0];
    p.total_cost_cad = p.total_cost_cad != null ? String(p.total_cost_cad) : null;
    res.json({ purchase: p });
  } catch (err) {
    console.error("Error in PUT /api/ingredient-purchases/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/ingredient-purchases/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = req.body?.userId ?? req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const result = await pool.query(
      "DELETE FROM ingredient_purchases WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Purchase not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in DELETE /api/ingredient-purchases/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/ingredient-waste", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const result = await pool.query(
      "SELECT id, user_id, ingredient_id, purchase_id, quantity_grams, waste_date, created_at FROM ingredient_waste_events WHERE user_id = $1 ORDER BY waste_date DESC, id DESC",
      [userId]
    );
    res.json({ wasteEvents: result.rows });
  } catch (err) {
    console.error("Error in GET /api/ingredient-waste:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/ingredient-waste", async (req, res) => {
  try {
    const { userId, ingredientId, purchaseId, quantityGrams, wasteDate } = req.body || {};
    if (!userId || ingredientId == null) return res.status(400).json({ error: "userId and ingredientId required" });
    const qty = Number(quantityGrams) || 0;
    const date = wasteDate || new Date().toISOString().slice(0, 10);
    let purchaseIdVal = purchaseId != null && purchaseId !== "" ? Number(purchaseId) : null;
    try {
    const result = await pool.query(
      `
      INSERT INTO ingredient_waste_events (
        user_id,
        ingredient_id,
        purchase_id,
        quantity_grams,
        waste_date
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, ingredient_id, purchase_id, quantity_grams, waste_date, created_at
      `,
      [userId, Number(ingredientId), purchaseIdVal, qty, date]
    );
      return res.status(201).json({ wasteEvent: result.rows[0] });
    } catch (insertErr) {
      if (insertErr.code === "23503" && insertErr.constraint === "ingredient_waste_events_purchase_id_fkey" && purchaseIdVal != null) {
        const retry = await pool.query(
          `INSERT INTO ingredient_waste_events (user_id, ingredient_id, purchase_id, quantity_grams, waste_date)
           VALUES ($1, $2, NULL, $3, $4)
           RETURNING id, user_id, ingredient_id, purchase_id, quantity_grams, waste_date, created_at`,
          [userId, Number(ingredientId), qty, date]
        );
        return res.status(201).json({ wasteEvent: retry.rows[0] });
      }
      throw insertErr;
    }
  } catch (err) {
    console.error("Error in POST /api/ingredient-waste:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/api/ingredient-waste/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { userId, ingredientId, purchaseId, quantityGrams, wasteDate } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId required" });
    const updates = [];
    const values = [];
    let paramIndex = 1;
    if (ingredientId != null) {
      updates.push(`ingredient_id = $${paramIndex++}`);
      values.push(Number(ingredientId));
    }
    if (purchaseId !== undefined) {
      updates.push(`purchase_id = $${paramIndex++}`);
      values.push(purchaseId != null && purchaseId !== "" ? Number(purchaseId) : null);
    }
    if (quantityGrams != null) {
      updates.push(`quantity_grams = $${paramIndex++}`);
      values.push(Number(quantityGrams) ?? 0);
    }
    if (wasteDate != null) {
      updates.push(`waste_date = $${paramIndex++}`);
      values.push(wasteDate);
    }
    if (updates.length === 0) {
      const row = await pool.query(
        "SELECT id, user_id, ingredient_id, purchase_id, quantity_grams, waste_date, created_at FROM ingredient_waste_events WHERE id = $1 AND user_id = $2",
        [id, userId]
      );
      if (row.rows.length === 0) return res.status(404).json({ error: "Waste event not found" });
      return res.json({ wasteEvent: row.rows[0] });
    }
    values.push(id, userId);
    const result = await pool.query(
      `UPDATE ingredient_waste_events SET ${updates.join(", ")} WHERE id = $${paramIndex++} AND user_id = $${paramIndex} RETURNING id, user_id, ingredient_id, purchase_id, quantity_grams, waste_date, created_at`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Waste event not found" });
    res.json({ wasteEvent: result.rows[0] });
  } catch (err) {
    console.error("Error in PUT /api/ingredient-waste/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/api/ingredient-waste/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = req.body?.userId ?? req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const result = await pool.query(
      "DELETE FROM ingredient_waste_events WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Waste event not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in DELETE /api/ingredient-waste/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/dashboard-waste?userId=...
 * Returns waste totals, biggest drivers of waste emissions, and purchase-vs-waste snapshot for the Dashboard.
 */
app.get("/api/dashboard-waste", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId required" });

    let purchases = [];
    let wasteEvents = [];
    try {
      const purchaseResult = await pool.query(
        "SELECT id, user_id, ingredient_id, quantity_grams, total_cost_cad, purchase_date, created_at FROM ingredient_purchases WHERE user_id = $1",
        [userId]
      );
      purchases = (purchaseResult.rows || []).map((r) => ({
        ...r,
        total_cost_cad: r.total_cost_cad != null ? Number(r.total_cost_cad) : 0,
      }));
    } catch {
      // table may not exist yet
    }
    try {
      const wasteResult = await pool.query(
        "SELECT id, user_id, ingredient_id, purchase_id, quantity_grams, waste_date, created_at FROM ingredient_waste_events WHERE user_id = $1",
        [userId]
      );
      wasteEvents = wasteResult.rows;
    } catch {
      // table may not exist yet
    }

    let ingredientsMap = {};
    try {
      const ingResult = await pool.query(
        "SELECT id, name, COALESCE(emissions_kg_co2e_per_kg, emissions_per_kg_co2e) AS emission_factor FROM ingredients"
      );
      ingResult.rows.forEach((r) => {
        ingredientsMap[r.id] = { name: r.name, emissionFactor: Number(r.emission_factor) || 0 };
      });
    } catch {
      // If ingredients table/column missing, use empty map; names/emissions will be 0
    }

    const byIngredient = {};
    purchases.forEach((p) => {
      const id = p.ingredient_id;
      if (!byIngredient[id]) {
        byIngredient[id] = { ingredient_id: id, purchaseKg: 0, wasteKg: 0, totalCostCad: 0 };
      }
      byIngredient[id].purchaseKg += (Number(p.quantity_grams) || 0) / 1000;
      byIngredient[id].totalCostCad += Number(p.total_cost_cad) || 0;
    });
    wasteEvents.forEach((w) => {
      const id = w.ingredient_id;
      if (!byIngredient[id]) {
        byIngredient[id] = { ingredient_id: id, purchaseKg: 0, wasteKg: 0, totalCostCad: 0 };
      }
      byIngredient[id].wasteKg += (Number(w.quantity_grams) || 0) / 1000;
    });

    let totalWasteKg = 0;
    let totalWasteEmissionsKgCo2e = 0;
    const biggestDriversOfWasteEmissions = [];
    const purchaseVsWasteSnapshot = [];

    Object.entries(byIngredient).forEach(([ingId, agg]) => {
      const info = ingredientsMap[Number(ingId)] || { name: `Ingredient #${ingId}`, emissionFactor: 0 };
      const wasteKg = agg.wasteKg || 0;
      const purchaseKg = agg.purchaseKg || 0;
      const totalCost = agg.totalCostCad || 0;
      const factor = info.emissionFactor || 0;
      const emissionsKgCo2e = wasteKg * factor;
      totalWasteKg += wasteKg;
      totalWasteEmissionsKgCo2e += emissionsKgCo2e;
      if (wasteKg > 0) {
        biggestDriversOfWasteEmissions.push({
          ingredient_id: Number(ingId),
          ingredient_name: info.name,
          waste_kg: Math.round(wasteKg * 100) / 100,
          emissions_kg_co2e: Math.round(emissionsKgCo2e * 100) / 100,
        });
      }
      if (purchaseKg > 0 || wasteKg > 0) {
        const wasteRatePct = purchaseKg > 0 ? (wasteKg / purchaseKg) * 100 : (wasteKg > 0 ? 100 : 0);
        const wastedCost = purchaseKg > 0 ? (wasteKg / purchaseKg) * totalCost : 0;
        purchaseVsWasteSnapshot.push({
          ingredient_id: Number(ingId),
          ingredient_name: info.name,
          waste_rate_pct: Math.round(wasteRatePct * 10) / 10,
          wasted_cost_cad: Math.round(wastedCost * 100) / 100,
          purchase_kg: Math.round(purchaseKg * 100) / 100,
          waste_kg: Math.round(wasteKg * 100) / 100,
        });
      }
    });

    biggestDriversOfWasteEmissions.sort((a, b) => b.emissions_kg_co2e - a.emissions_kg_co2e);
    purchaseVsWasteSnapshot.sort((a, b) => b.waste_rate_pct - a.waste_rate_pct);

    return res.json({
      totalWasteKg: Math.round(totalWasteKg * 100) / 100,
      totalWasteEmissionsKgCo2e: Math.round(totalWasteEmissionsKgCo2e * 100) / 100,
      biggestDriversOfWasteEmissions,
      purchaseVsWasteSnapshot,
    });
  } catch (err) {
    console.error("Error in /api/dashboard-waste:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Risk factor scoring (Sprint 2) ----------
/**
 * Compute risk score (0–100) and prioritized action items from menu + facility data.
 * Higher score = higher risk (more to improve).
 */
function computeRiskFactor(context) {
  const { items, facilityProfile, wasteDashboard } = context;
  const actions = [];
  let score = 0;
  const maxScore = 100;

  // No menu or empty menu
  const itemCount = items?.length || 0;
  if (itemCount === 0) {
    score += 25;
    actions.push({
      priority: 1,
      title: "Add menu items",
      description: "Add your dishes so we can estimate emissions and identify high-impact items.",
    });
  }

  // Total menu emissions
  const totalEmissions = (items || []).reduce(
    (sum, i) => sum + (Number(i.estimated_emissions_kg_co2e) || 0),
    0
  );
  const highImpactItems = (items || []).filter(
    (i) => Number(i.estimated_emissions_kg_co2e) >= 5
  );
  if (highImpactItems.length > 0) {
    score += Math.min(25, highImpactItems.length * 5);
    actions.push({
      priority: 2,
      title: "Reduce high-impact dishes",
      description: `${highImpactItems.length} dish(es) have high emissions (≥5 kg CO2e). Consider lower-carbon alternatives or smaller portions.`,
    });
  }

  // No facility profile (onboarding not done)
  if (!facilityProfile) {
    score += 30;
    actions.push({
      priority: 3,
      title: "Complete facility onboarding",
      description: "Tell us about energy, waste, and delivery so we can estimate your full carbon footprint.",
    });
  } else {
    // Facility has high waste % if provided
    const wastePct = facilityProfile.food_waste_percent ? Number(facilityProfile.food_waste_percent) : null;
    if (wastePct != null && wastePct > 15) {
      score += 15;
      actions.push({
        priority: 4,
        title: "Reduce food waste",
        description: `Estimated food waste (${wastePct}%) is high. Track waste events and target top ingredients to reduce.`,
      });
    }
  }

  // Logged waste data: high waste emissions or high waste rate contributes to risk
  if (wasteDashboard) {
    const totalWasteEmissions = wasteDashboard.totalWasteEmissionsKgCo2e ?? 0;
    const totalWasteKg = wasteDashboard.totalWasteKg ?? 0;
    const drivers = wasteDashboard.biggestDriversOfWasteEmissions || [];
    const snapshot = wasteDashboard.purchaseVsWasteSnapshot || [];

    if (totalWasteEmissions > 50 || totalWasteKg > 20) {
      score += 15;
      const topNames = drivers.slice(0, 3).map((d) => d.ingredient_name).join(", ");
      actions.push({
        priority: 6,
        title: "Reduce waste emissions",
        description: topNames
          ? `Logged waste generates ${totalWasteEmissions.toFixed(0)} kg CO2e. Biggest drivers: ${topNames}. Target these ingredients to cut both waste and emissions.`
          : `Logged waste generates ${totalWasteEmissions.toFixed(0)} kg CO2e. Track which ingredients drive most waste and target them first.`,
      });
    } else if (totalWasteEmissions > 10 || totalWasteKg > 5) {
      score += 8;
      if (drivers.length > 0) {
        const top = drivers[0];
        actions.push({
          priority: 6,
          title: "Reduce waste from top driver",
          description: `${top.ingredient_name} generates ${Number(top.emissions_kg_co2e).toFixed(1)} kg CO2e from waste. Reduce waste for this ingredient or consider lower-carbon alternatives.`,
        });
      }
    }

    const highWasteRate = snapshot.filter((s) => s.waste_rate_pct >= 40);
    if (highWasteRate.length > 0) {
      score += Math.min(10, highWasteRate.length * 4);
      const names = highWasteRate.slice(0, 3).map((s) => `${s.ingredient_name} (${s.waste_rate_pct}%)`).join(", ");
      actions.push({
        priority: 7,
        title: "Improve purchase efficiency",
        description: `High waste rate on: ${names}. Improve ordering, storage, or portions to reduce waste and cost.`,
      });
    }
  }

  // No emissions data on menu
  const itemsWithEmissions = (items || []).filter(
    (i) => i.estimated_emissions_kg_co2e != null && Number(i.estimated_emissions_kg_co2e) > 0
  );
  if (itemCount > 0 && itemsWithEmissions.length === 0) {
    score += 20;
    actions.push({
      priority: 5,
      title: "Add emissions to menu items",
      description: "Map ingredients to your dishes so we can calculate per-dish emissions and suggest climate-friendly options.",
    });
  }

  score = Math.min(maxScore, score);
  const level = score >= 60 ? "high" : score >= 30 ? "medium" : "low";

  const highImpactDishNames = highImpactItems.map((i) => i.name);
  const sortedByEmissions = [...(items || [])].sort(
    (a, b) => (Number(b.estimated_emissions_kg_co2e) || 0) - (Number(a.estimated_emissions_kg_co2e) || 0)
  );
  const lowestImpact = sortedByEmissions.filter(
    (i) => i.estimated_emissions_kg_co2e != null && Number(i.estimated_emissions_kg_co2e) >= 0
  ).pop();

  return {
    score,
    level,
    totalMenuEmissionsKgCo2e: totalEmissions,
    highImpactDishCount: highImpactItems.length,
    highImpactDishNames,
    lowestImpactDishName: lowestImpact?.name ?? null,
    menuItemCount: itemCount,
    actions: actions
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 7),
    dashboard: {
      foodWastePercent: facilityProfile?.food_waste_percent ?? null,
      energyType: facilityProfile?.energy_type || null,
      renewables: facilityProfile?.renewables || null,
      hasFacilityProfile: !!facilityProfile,
    },
  };
}

/**
 * GET /api/risk-factor?userId=...
 * Returns risk score, level, and prioritized action items for the manager.
 */
app.get("/api/risk-factor", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const context = await getCarbonInsightsContext(userId);
    if (!context.user) {
      return res.status(404).json({ error: "User not found" });
    }

    const lastUpdatedResult = await pool.query(
      `
      SELECT GREATEST(
        COALESCE(
          (SELECT MAX(fp.created_at)::timestamptz
           FROM facility_profiles fp
           WHERE fp.user_id = $1),
          '-infinity'::timestamptz
        ),
        COALESCE(
          (SELECT MAX(ip.created_at)
           FROM ingredient_purchases ip
           WHERE ip.user_id = $1),
          '-infinity'::timestamptz
        ),
        COALESCE(
          (SELECT MAX(iw.created_at)
           FROM ingredient_waste_events iw
           WHERE iw.user_id = $1),
          '-infinity'::timestamptz
        ),
        COALESCE(
          (SELECT MAX(mi.created_at)
           FROM menu_items mi
           JOIN menus m ON m.id = mi.menu_id
           WHERE m.user_id = $1),
          '-infinity'::timestamptz
        ),
        COALESCE(
          (SELECT MAX(m.created_at)
           FROM menus m
           WHERE m.user_id = $1),
          '-infinity'::timestamptz
        )
      ) AS last_updated
      `,
      [userId]
    );

    const risk = computeRiskFactor(context);
    if (context.wasteDashboard) {
      risk.totalWasteKg = context.wasteDashboard.totalWasteKg;
      risk.totalWasteEmissionsKgCo2e = context.wasteDashboard.totalWasteEmissionsKgCo2e;
      risk.biggestDriversOfWasteEmissions = context.wasteDashboard.biggestDriversOfWasteEmissions || [];
      risk.purchaseVsWasteSnapshot = context.wasteDashboard.purchaseVsWasteSnapshot || [];
    }

    risk.lastUpdated =
      lastUpdatedResult.rows[0]?.last_updated &&
      lastUpdatedResult.rows[0].last_updated !== "-infinity"
        ? lastUpdatedResult.rows[0].last_updated
        : null;

    return res.json(risk);
  } catch (err) {
    console.error("Error in /api/risk-factor:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- AI Carbon Insights ----------
/**
 * Load all context needed for the AI carbon advisor: user, menu, menu items, facility profile.
 */
async function getCarbonInsightsContext(userId) {
  const [userResult, menuResult, profileResult] = await Promise.all([
    pool.query(
      "SELECT id, email, company_name FROM users WHERE id = $1",
      [userId]
    ),
    pool.query(
      `SELECT m.id, m.name FROM menus m WHERE m.user_id = $1 AND m.is_active = TRUE LIMIT 1`,
      [userId]
    ),
    pool.query(
      "SELECT * FROM facility_profiles WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
      [userId]
    ),
  ]);

  const user = userResult.rows[0] || null;
  const menu = menuResult.rows[0] || null;
  let items = [];
  if (menu) {
const itemsResult = await pool.query(
      `SELECT id, "name", category, price_cents, estimated_emissions_kg_co2e
       FROM menu_items WHERE menu_id = $1 AND is_active = TRUE ORDER BY estimated_emissions_kg_co2e DESC NULLS LAST`,
      [menu.id]
    );
    items = itemsResult.rows;
  }
  const facilityProfile = profileResult.rows[0] || null;

  // Waste dashboard data (purchases and waste from DB) for insights
  let purchases = [];
  let wasteEvents = [];
  try {
    const purchaseResult = await pool.query(
      "SELECT id, user_id, ingredient_id, quantity_grams, total_cost_cad, purchase_date FROM ingredient_purchases WHERE user_id = $1",
      [userId]
    );
    purchases = (purchaseResult.rows || []).map((r) => ({
      ...r,
      total_cost_cad: r.total_cost_cad != null ? Number(r.total_cost_cad) : 0,
    }));
  } catch {
    // ignore
  }
  try {
    const wasteResult = await pool.query(
"SELECT id, user_id, ingredient_id, purchase_id, quantity_grams, waste_date, created_at FROM ingredient_waste_events WHERE user_id = $1",
      [userId]
    );
    wasteEvents = wasteResult.rows;
  } catch {
    // table may not exist yet
  }
    let ingredientsMap = {};
  try {
    const ingResult = await pool.query(
      "SELECT id, name, COALESCE(emissions_kg_co2e_per_kg, emissions_per_kg_co2e) AS emission_factor FROM ingredients"
    );
    ingResult.rows.forEach((r) => {
      ingredientsMap[r.id] = { name: r.name, emissionFactor: Number(r.emission_factor) || 0 };
    });
  } catch {
    // ignore
  }
  const byIngredient = {};
  purchases.forEach((p) => {
    const id = p.ingredient_id;
    if (!byIngredient[id]) byIngredient[id] = { purchaseKg: 0, wasteKg: 0, totalCostCad: 0 };
    byIngredient[id].purchaseKg += (Number(p.quantity_grams) || 0) / 1000;
    byIngredient[id].totalCostCad += Number(p.total_cost_cad) || 0;
  });
  wasteEvents.forEach((w) => {
    const id = w.ingredient_id;
    if (!byIngredient[id]) byIngredient[id] = { purchaseKg: 0, wasteKg: 0, totalCostCad: 0 };
    byIngredient[id].wasteKg += (Number(w.quantity_grams) || 0) / 1000;
  });
  const wasteDashboard = {
    totalWasteKg: 0,
    totalWasteEmissionsKgCo2e: 0,
    biggestDriversOfWasteEmissions: [],
    purchaseVsWasteSnapshot: [],
  };
  Object.entries(byIngredient).forEach(([ingId, agg]) => {
    const info = ingredientsMap[Number(ingId)] || { name: `Ingredient #${ingId}`, emissionFactor: 0 };
    const wasteKg = agg.wasteKg || 0;
    const purchaseKg = agg.purchaseKg || 0;
    const totalCost = agg.totalCostCad || 0;
    const factor = info.emissionFactor || 0;
    const emissionsKgCo2e = wasteKg * factor;
    wasteDashboard.totalWasteKg += wasteKg;
    wasteDashboard.totalWasteEmissionsKgCo2e += emissionsKgCo2e;
    if (wasteKg > 0) {
      wasteDashboard.biggestDriversOfWasteEmissions.push({
        ingredient_name: info.name,
        waste_kg: Math.round(wasteKg * 100) / 100,
        emissions_kg_co2e: Math.round(emissionsKgCo2e * 100) / 100,
      });
    }
    if (purchaseKg > 0 || wasteKg > 0) {
      const wasteRatePct = purchaseKg > 0 ? (wasteKg / purchaseKg) * 100 : (wasteKg > 0 ? 100 : 0);
      const wastedCost = purchaseKg > 0 ? (wasteKg / purchaseKg) * totalCost : 0;
      wasteDashboard.purchaseVsWasteSnapshot.push({
        ingredient_name: info.name,
        waste_rate_pct: Math.round(wasteRatePct * 10) / 10,
        wasted_cost_cad: Math.round(wastedCost * 100) / 100,
      });
    }
  });
  wasteDashboard.biggestDriversOfWasteEmissions.sort((a, b) => b.emissions_kg_co2e - a.emissions_kg_co2e);
  wasteDashboard.purchaseVsWasteSnapshot.sort((a, b) => b.waste_rate_pct - a.waste_rate_pct);
  wasteDashboard.totalWasteKg = Math.round(wasteDashboard.totalWasteKg * 100) / 100;
  wasteDashboard.totalWasteEmissionsKgCo2e = Math.round(wasteDashboard.totalWasteEmissionsKgCo2e * 100) / 100;

  return { user, menu, items, facilityProfile, wasteDashboard };
}

/**
 * Build a plain-text summary of the restaurant's data for the AI prompt.
 */
function buildContextSummary(context) {
  const { user, menu, items, facilityProfile } = context;
  const lines = [];

  lines.push(`Restaurant: ${user?.company_name || "Unknown"}`);

  if (menu && items.length > 0) {
    lines.push("\nMenu items and estimated emissions (kg CO2e per dish):");
    const totalMenuEmissions = items.reduce(
      (sum, i) => sum + (Number(i.estimated_emissions_kg_co2e) || 0),
      0
    );
    items.forEach((i) => {
      const em = i.estimated_emissions_kg_co2e != null ? Number(i.estimated_emissions_kg_co2e).toFixed(2) : "—";
      lines.push(`  - ${i.name} (${i.category || "—"}): ${em} kg CO2e`);
    });
    lines.push(`  Total menu emissions: ${totalMenuEmissions.toFixed(2)} kg CO2e`);
  } else {
    lines.push("\nNo menu items or emissions data yet.");
  }

  if (facilityProfile) {
    lines.push("\nFacility / operations (onboarding):");
    lines.push(`  Energy: ${facilityProfile.energy_type || "—"}, usage: ${facilityProfile.electricity_usage || "—"}`);
    lines.push(`  Efficient appliances: ${(facilityProfile.efficient_appliances || []).join(", ") || "—"}`);
    lines.push(`  Renewables: ${facilityProfile.renewables || "—"}`);
    lines.push(`  Food waste handling: ${facilityProfile.food_waste_handling || "—"}, est. % wasted: ${facilityProfile.food_waste_percent || "—"}`);
    lines.push(`  Recycling: ${facilityProfile.recycling || "—"}`);
    lines.push(`  Water tracking: ${facilityProfile.water_tracking || "—"}, efficient: ${facilityProfile.water_efficient || "—"}`);
    lines.push(`  Sourcing: ${facilityProfile.sourcing || "—"}, delivery frequency: ${facilityProfile.delivery_frequency || "—"}`);
    lines.push(`  Packaging: ${facilityProfile.packaging_type || "—"}, reusable program: ${facilityProfile.reusable_program || "—"}`);
    lines.push(`  Vehicles: ${facilityProfile.vehicles || "—"}, weekly km: ${facilityProfile.weekly_km || "—"}`);
  } else {
    lines.push("\nNo facility profile (onboarding) completed yet.");
  }

  const wasteDashboard = context.wasteDashboard;
  if (wasteDashboard && (wasteDashboard.totalWasteKg > 0 || wasteDashboard.biggestDriversOfWasteEmissions?.length > 0)) {
    lines.push("\nLogged waste data (from Waste page):");
    lines.push(`  Total waste: ${wasteDashboard.totalWasteKg} kg, total waste emissions: ${wasteDashboard.totalWasteEmissionsKgCo2e} kg CO2e`);
    if (wasteDashboard.biggestDriversOfWasteEmissions?.length > 0) {
      lines.push("  Biggest drivers of waste emissions (ingredient, waste kg, emissions kg CO2e):");
      wasteDashboard.biggestDriversOfWasteEmissions.slice(0, 10).forEach((d) => {
        lines.push(`    - ${d.ingredient_name}: ${d.waste_kg} kg waste → ${d.emissions_kg_co2e} kg CO2e`);
      });
    }
    if (wasteDashboard.purchaseVsWasteSnapshot?.length > 0) {
      lines.push("  Purchase vs waste (waste rate %, wasted cost $):");
      wasteDashboard.purchaseVsWasteSnapshot.slice(0, 10).forEach((s) => {
        lines.push(`    - ${s.ingredient_name}: ${s.waste_rate_pct}% waste rate, $${s.wasted_cost_cad} wasted cost`);
      });
    }
  }

  return lines.join("\n");
}

/**
 * Call OpenAI to get carbon footprint assessment and improvement suggestions.
 * Requires OPENAI_API_KEY in env. Returns null if no key or request fails.
 */
async function getAICarbonInsights(contextSummary) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const systemPrompt = `You are an expert sustainability advisor for restaurants. You analyze their carbon footprint and operations data and give clear, actionable advice. Be concise and specific. Use metric units (kg CO2e).`;

  const userPrompt = `Based on the following restaurant data (menu + onboarding/facility + logged waste), provide:
1. **Current carbon footprint** – A short paragraph summarizing their situation. Use their actual dish names, emissions numbers (kg CO2e), and their onboarding answers: energy type, renewables, food waste %, delivery frequency, packaging, recycling, water, sourcing, vehicles, weekly km. If they have logged waste data (total waste kg, biggest drivers of waste emissions, purchase vs waste by ingredient), include that—e.g. "You've logged X kg waste generating Y kg CO2e; top drivers are [ingredients]."
2. **Improvement suggestions** – A numbered list of 5–7 specific, actionable steps. Use their onboarding data AND their logged waste data when present: if they have high waste emissions from specific ingredients, suggest reducing waste for those ingredients or swapping to lower-carbon alternatives; if purchase-vs-waste shows high waste rates, suggest portion control or storage/ordering changes. Also consider: energy/renewables, delivery frequency, packaging, recycling, vehicles. Tie every suggestion to their actual menu, facility, or waste data—no generic advice.

Restaurant data (menu + facility onboarding + logged waste):
${contextSummary}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI API error:", response.status, errText);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    return content || null;
  } catch (err) {
    console.error("Error calling OpenAI:", err);
    return null;
  }
}

/**
 * GET /api/ai/carbon-insights?userId=...
 * Returns current footprint summary and AI-generated suggestions (if OPENAI_API_KEY is set).
 */
app.get("/api/ai/carbon-insights", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const context = await getCarbonInsightsContext(userId);
    if (!context.user) {
      return res.status(404).json({ error: "User not found" });
    }

    const contextSummary = buildContextSummary(context);
    const aiResponse = await getAICarbonInsights(contextSummary);

    if (aiResponse) {
      return res.json({
        ok: true,
        source: "ai",
        content: aiResponse,
        contextSummary: contextSummary,
      });
    }

    // No API key or AI failed: return summary + suggestions built from their actual data
    const { items, facilityProfile } = context;
    const totalEmissions = (context.items || []).reduce(
      (sum, i) => sum + (Number(i.estimated_emissions_kg_co2e) || 0),
      0
    );
    const highImpact = (items || [])
      .filter((i) => Number(i.estimated_emissions_kg_co2e) >= 5)
      .slice(0, 5);
    const sortedByEmissions = [...(items || [])].sort(
      (a, b) => (Number(b.estimated_emissions_kg_co2e) || 0) - (Number(a.estimated_emissions_kg_co2e) || 0)
    );
    const lowestImpact = sortedByEmissions.filter(
      (i) => i.estimated_emissions_kg_co2e != null && Number(i.estimated_emissions_kg_co2e) >= 0
    ).pop();

    let currentFootprint = `Your menu has ${items?.length || 0} items with a total estimated emissions of ${totalEmissions.toFixed(2)} kg CO2e.`;
    if (highImpact.length > 0) {
      currentFootprint += ` Highest-impact dishes: ${highImpact.map((i) => i.name).join(", ")}.`;
    }
    if (!facilityProfile) {
      currentFootprint += " Complete onboarding to get facility-level insights.";
    }

    const suggestions = [];
    if (highImpact.length > 0) {
      suggestions.push(
        `Your highest-emission dishes (${highImpact.map((i) => i.name).join(", ")}) drive most of your menu footprint. Consider smaller portions, plant-based swaps, or promoting lower-carbon options.`
      );
    }
    if (items?.length > 0 && lowestImpact) {
      suggestions.push(
        `Promote "${lowestImpact.name}" as a climate-friendly option—it has the lowest emissions on your menu.`
      );
    }
    if (!facilityProfile) {
      suggestions.push(
        "Complete facility onboarding (energy, waste %, delivery) so we can estimate your full carbon footprint and give tailored advice."
      );
    } else {
      const fp = facilityProfile;
      if (fp.food_waste_percent != null && Number(fp.food_waste_percent) > 15) {
        suggestions.push(
          `Your estimated food waste (${fp.food_waste_percent}%) is high. Track waste by ingredient and target the top items to reduce both cost and emissions.`
        );
      }
      const wasteDashboard = context.wasteDashboard;
      if (wasteDashboard?.totalWasteKg > 0) {
        currentFootprint += ` Logged waste: ${wasteDashboard.totalWasteKg} kg (${wasteDashboard.totalWasteEmissionsKgCo2e} kg CO2e from waste).`;
        if (wasteDashboard.biggestDriversOfWasteEmissions?.length > 0) {
          const top = wasteDashboard.biggestDriversOfWasteEmissions[0];
          suggestions.push(
            `Your biggest driver of waste emissions is ${top.ingredient_name} (${top.waste_kg} kg waste → ${top.emissions_kg_co2e} kg CO2e). Reduce waste for this ingredient or consider lower-carbon alternatives.`
          );
        }
        if (wasteDashboard.purchaseVsWasteSnapshot?.length > 0) {
          const highRate = wasteDashboard.purchaseVsWasteSnapshot.find((s) => s.waste_rate_pct > 30);
          if (highRate) {
            suggestions.push(
              `${highRate.ingredient_name} has a ${highRate.waste_rate_pct}% waste rate ($${highRate.wasted_cost_cad} wasted). Improve ordering, storage, or portions to cut waste and cost.`
            );
          }
        }
      }
      if (!fp.renewables || String(fp.renewables).toLowerCase().includes("none") || String(fp.renewables).toLowerCase().includes("no ")) {
        suggestions.push(
          `You indicated ${fp.energy_type || "standard"} energy with no renewables. Consider switching to green energy or adding solar/wind to cut facility emissions.`
        );
      }
      if (fp.delivery_frequency && String(fp.delivery_frequency).toLowerCase().includes("daily")) {
        suggestions.push(
          "With daily deliveries, consolidating to fewer trips per week can reduce transport emissions and cost."
        );
      }
      if (fp.packaging_type && (String(fp.packaging_type).toLowerCase().includes("single") || String(fp.packaging_type).toLowerCase().includes("disposable")) && !fp.reusable_program) {
        suggestions.push(
          "You're using single-use/disposable packaging with no reusable program. Introducing reusables for dine-in (e.g. plates, cups) can cut packaging waste and emissions."
        );
      }
      if (fp.recycling && (String(fp.recycling).toLowerCase().includes("none") || String(fp.recycling).toLowerCase().includes("no "))) {
        suggestions.push(
          "You reported no or minimal recycling. Adding recycling for cardboard, plastics, and organics can reduce waste sent to landfill."
        );
      }
      if (fp.water_tracking && String(fp.water_tracking).toLowerCase().includes("no")) {
        suggestions.push(
          "You're not tracking water use. Tracking usage and installing efficient fixtures can reduce water and energy (hot water)."
        );
      }
      if (fp.vehicles && fp.weekly_km && Number(fp.weekly_km) > 50) {
        suggestions.push(
          `With ${fp.vehicles} and ~${fp.weekly_km} km/week, consider route optimization or switching to electric/low-emission vehicles to cut transport emissions.`
        );
      }
      if (fp.sourcing && (String(fp.sourcing).toLowerCase().includes("conventional") || String(fp.sourcing).toLowerCase().includes("mixed"))) {
        suggestions.push(
          "You source conventional or mixed. Prioritizing local or sustainable suppliers for key ingredients can lower your supply-chain footprint."
        );
      }
    }
    const wasteDashboardStandalone = context.wasteDashboard;
    if (wasteDashboardStandalone?.totalWasteKg > 0 && !facilityProfile) {
      currentFootprint += ` Logged waste: ${wasteDashboardStandalone.totalWasteKg} kg (${wasteDashboardStandalone.totalWasteEmissionsKgCo2e} kg CO2e from waste).`;
      if (wasteDashboardStandalone.biggestDriversOfWasteEmissions?.length > 0) {
        const top = wasteDashboardStandalone.biggestDriversOfWasteEmissions[0];
        suggestions.push(
          `Your biggest driver of waste emissions is ${top.ingredient_name} (${top.waste_kg} kg waste → ${top.emissions_kg_co2e} kg CO2e). Reduce waste for this ingredient or consider lower-carbon alternatives.`
        );
      }
    }
    if (items?.length > 0) {
      const noEmissions = items.filter((i) => !i.estimated_emissions_kg_co2e || Number(i.estimated_emissions_kg_co2e) === 0);
      if (noEmissions.length > 0) {
        suggestions.push(
          `${noEmissions.length} dish(es) (e.g. ${noEmissions.slice(0, 2).map((i) => i.name).join(", ")}) have no emissions data yet. Add ingredient mapping to get accurate per-dish impact.`
        );
      }
    }
    if (suggestions.length === 0) {
      suggestions.push("Keep logging menu and waste data—we'll refine your insights as you add more.");
    }

    return res.json({
      ok: true,
      source: "fallback",
      content: null,
      currentFootprint,
      suggestions,
      contextSummary: contextSummary,
    });
  } catch (err) {
    console.error("Error in /api/ai/carbon-insights:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
