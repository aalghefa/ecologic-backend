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
    fileSize: 5 * 1024 * 1024, // 5MB limit – adjust if needed
  },
});
/**
 * SIGNUP
 * - validates required fields
 * - checks if email is already in use
 * - stores the password as-is (plaintext for now)
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

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, company_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, company_name`,
      [email, password, companyName] // plaintext for now (fine for dev)
    );

    const user = result.rows[0];

    // create JWT
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Ensure this user has a "Main menu"
    const menu = await getOrCreateMainMenu(user.id);

    // 🔹 IMPORTANT: include token in response
    res.status(201).json({ user, token, menu });
  } catch (err) {
    console.error("Error in /api/signup:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * LOGIN
 * - expects: email, password
 * - finds user by email
 * - compares supplied password to stored password_hash (plaintext for now)
 */
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email and password are required" });
    }

    const result = await pool.query(
      `SELECT id, email, password_hash, company_name
       FROM users
       WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = result.rows[0];

    if (user.password_hash !== password) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const { password_hash, ...publicUser } = user;

    // 🔹 IMPORTANT: include token here too
    return res.json({ user: publicUser, token });
  } catch (err) {
    console.error("Error in /api/login:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

async function getOrCreateMainMenu(userId) {
  // 1) check for existing active menu
  const existing = await pool.query(
    `SELECT id, user_id, name, description, is_active, created_at
     FROM menus
     WHERE user_id = $1 AND is_active = TRUE
     ORDER BY id
     LIMIT 1`,
    [userId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // 2) create a new main menu
  const inserted = await pool.query(
    `INSERT INTO menus (user_id, name, is_active)
     VALUES ($1, $2, TRUE)
     RETURNING id, user_id, name, description, is_active, created_at`,
    [userId, "Main menu"]
  );

  return inserted.rows[0];
}

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
    const itemsResult = await pool.query(
      `SELECT id, name, category, price_cents, estimated_emissions_kg_co2e, is_active, created_at
       FROM menu_items
       WHERE menu_id = $1 AND is_active = TRUE
       ORDER BY created_at ASC`,
      [menu.id]
    );

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
      `INSERT INTO menu_items (
         menu_id, name, category, price_cents, estimated_emissions_kg_co2e, is_active
       )
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, name, category, price_cents, estimated_emissions_kg_co2e, is_active, created_at`,
      [menu.id, name, category || null, priceCents, emissionsValue]
    );

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
      `INSERT INTO facility_profiles (
        user_id,
        energy_type, electricity_usage, efficient_appliances, renewables,
        food_waste_handling, food_waste_percent, recycling,
        water_tracking, water_efficient,
        sourcing, delivery_frequency,
        packaging_type, reusable_program,
        vehicles, weekly_km
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10,
        $11, $12,
        $13, $14,
        $15, $16
      )
      RETURNING *`,
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

    res.status(201).json({ success: true, profile: result.rows[0] });
  } catch (err) {
    console.error("Error saving facility profile:", err);
    res.status(500).json({ error: "Internal server error" });
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

// Helper: recalc total emissions for a menu item based on its ingredients
async function recalculateMenuItemEmissions(menuItemId) {
  // Sum over all ingredients: (quantity_in_kg * emissions_kg_co2e_per_kg)
  const { rows } = await pool.query(
    `
    SELECT
      SUM(
        -- convert grams to kg when unit = 'g'
        (CASE
          WHEN mii.unit = 'g' THEN mii.quantity / 1000.0
          WHEN mii.unit = 'kg' OR mii.unit IS NULL THEN mii.quantity
          ELSE mii.quantity -- fallback if other units show up
        END) * COALESCE(i.emissions_kg_co2e_per_kg, 0)
      ) AS total_kg_co2e
    FROM menu_item_ingredients mii
    JOIN ingredients i ON i.id = mii.ingredient_id
    WHERE mii.menu_item_id = $1
    `,
    [menuItemId]
  );

  const total = rows[0]?.total_kg_co2e || 0;

  // Store on menu_items so the UI can read it directly
  await pool.query(
    `
    UPDATE menu_items
    SET estimated_emissions_kg_co2e = $2
    WHERE id = $1
    `,
    [menuItemId, total]
  );

  return total;
}
app.get("/api/ingredients", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT id, name, emissions_kg_co2e_per_kg, unit
      FROM ingredients
      ORDER BY name ASC
      `
    );

    res.json({ ingredients: rows });
  } catch (err) {
    console.error("Error in GET /api/ingredients:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/menu/items/:menuItemId/ingredients", async (req, res) => {
  try {
    const menuItemId = req.params.menuItemId;

    const { rows } = await pool.query(
      `
      SELECT
        mii.id,
        mii.menu_item_id,
        mii.ingredient_id,
        mii.quantity,
        mii.unit,
        i.name AS ingredient_name,
        i.emissions_kg_co2e_per_kg
      FROM menu_item_ingredients mii
      JOIN ingredients i ON i.id = mii.ingredient_id
      WHERE mii.menu_item_id = $1
      ORDER BY i.name
      `,
      [menuItemId]
    );

    // You can optionally include the current total emissions
    const total = await recalculateMenuItemEmissions(menuItemId);

    res.json({
      menuItemId: Number(menuItemId),
      ingredients: rows,
      totalEmissionsKgCo2e: total,
    });
  } catch (err) {
    console.error("Error in GET /api/menu/items/:menuItemId/ingredients:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/menu/items/:menuItemId/ingredients", async (req, res) => {
  try {
    const menuItemId = req.params.menuItemId;
    const { ingredientId, quantityGrams } = req.body;

    if (!ingredientId || quantityGrams === undefined || quantityGrams === null) {
      return res
        .status(400)
        .json({ error: "ingredientId and quantityGrams are required." });
    }

    const quantityNum = Number(quantityGrams);
    if (Number.isNaN(quantityNum) || quantityNum <= 0) {
      return res.status(400).json({ error: "quantityGrams must be > 0." });
    }

    // Upsert ingredient for this menu item
    const upsertResult = await pool.query(
      `
      INSERT INTO menu_item_ingredients (menu_item_id, ingredient_id, quantity, unit)
      VALUES ($1, $2, $3, 'g')
      ON CONFLICT (menu_item_id, ingredient_id)
      DO UPDATE SET
        quantity = EXCLUDED.quantity,
        unit     = EXCLUDED.unit
      RETURNING id, menu_item_id, ingredient_id, quantity, unit
      `,
      [menuItemId, ingredientId, quantityNum]
    );

    const ingredientRow = upsertResult.rows[0];

    // Recalculate dish emissions
    const totalEmissions = await recalculateMenuItemEmissions(menuItemId);

    res.status(201).json({
      ingredient: ingredientRow,
      totalEmissionsKgCo2e: totalEmissions,
    });
  } catch (err) {
    console.error("Error in POST /api/menu/items/:menuItemId/ingredients:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete(
  "/api/menu/items/:menuItemId/ingredients/:ingredientId",
  async (req, res) => {
    try {
      const { menuItemId, ingredientId } = req.params;

      const deleteResult = await pool.query(
        `
        DELETE FROM menu_item_ingredients
        WHERE menu_item_id = $1 AND ingredient_id = $2
        RETURNING id
        `,
        [menuItemId, ingredientId]
      );

      if (deleteResult.rows.length === 0) {
        return res.status(404).json({ error: "Ingredient link not found." });
      }

      const totalEmissions = await recalculateMenuItemEmissions(menuItemId);

      res.json({
        success: true,
        totalEmissionsKgCo2e: totalEmissions,
      });
    } catch (err) {
      console.error(
        "Error in DELETE /api/menu/items/:menuItemId/ingredients/:ingredientId:",
        err
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /api/ingredient-purchases?userId=123
app.get("/api/ingredient-purchases", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // optional: ensure user exists
    const userCheck = await pool.query("SELECT id FROM users WHERE id = $1", [
      userId,
    ]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const result = await pool.query(
      `SELECT
         id,
         user_id,
         ingredient_id,
         purchase_date,
         quantity_grams,
         total_cost_cad,
         created_at
       FROM ingredient_purchases
       WHERE user_id = $1
       ORDER BY purchase_date DESC, id DESC`,
      [userId]
    );

    res.json({ purchases: result.rows });
  } catch (err) {
    console.error("Error in GET /api/ingredient-purchases:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
// POST /api/ingredient-purchases
// Body: { userId, ingredientId, quantityGrams, totalCostCad, purchaseDate }
app.post("/api/ingredient-purchases", async (req, res) => {
  try {
    const { userId, ingredientId, quantityGrams, totalCostCad, purchaseDate } =
      req.body;

    if (!userId || !ingredientId || !quantityGrams || !purchaseDate) {
      return res.status(400).json({
        error: "Missing required fields (userId, ingredientId, quantityGrams, purchaseDate)",
      });
    }

    const qty = Number(quantityGrams);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "Invalid quantityGrams value" });
    }

    let cost = null;
    if (totalCostCad !== undefined && totalCostCad !== null && totalCostCad !== "") {
      const parsedCost = Number(totalCostCad);
      if (!Number.isFinite(parsedCost) || parsedCost < 0) {
        return res.status(400).json({ error: "Invalid totalCostCad value" });
      }
      cost = parsedCost;
    }

    // optional: ensure user exists
    const userCheck = await pool.query("SELECT id FROM users WHERE id = $1", [
      userId,
    ]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // optional: ensure ingredient exists
    const ingCheck = await pool.query(
      "SELECT id FROM ingredients WHERE id = $1",
      [ingredientId]
    );
    if (ingCheck.rows.length === 0) {
      return res.status(404).json({ error: "Ingredient not found" });
    }

    const insertResult = await pool.query(
      `INSERT INTO ingredient_purchases
         (user_id, ingredient_id, purchase_date, quantity_grams, total_cost_cad)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, ingredient_id, purchase_date,
                 quantity_grams, total_cost_cad, created_at`,
      [userId, ingredientId, purchaseDate, qty, cost]
    );

    res.status(201).json({ purchase: insertResult.rows[0] });
  } catch (err) {
    console.error("Error in POST /api/ingredient-purchases:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/ingredient-purchases/:id
// Body: { userId, ingredientId, quantityGrams, totalCostCad, purchaseDate }
app.put("/api/ingredient-purchases/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, ingredientId, quantityGrams, totalCostCad, purchaseDate } =
      req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const qty = Number(quantityGrams);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "Invalid quantityGrams value" });
    }

    let cost = null;
    if (totalCostCad !== undefined && totalCostCad !== null && totalCostCad !== "") {
      const parsedCost = Number(totalCostCad);
      if (!Number.isFinite(parsedCost) || parsedCost < 0) {
        return res.status(400).json({ error: "Invalid totalCostCad value" });
      }
      cost = parsedCost;
    }

    // Only update rows owned by this user
    const updateResult = await pool.query(
      `UPDATE ingredient_purchases
         SET ingredient_id = $1,
             purchase_date = $2,
             quantity_grams = $3,
             total_cost_cad = $4
       WHERE id = $5 AND user_id = $6
       RETURNING id, user_id, ingredient_id, purchase_date,
                 quantity_grams, total_cost_cad, created_at`,
      [ingredientId, purchaseDate, qty, cost, id, userId]
    );

    if (updateResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Purchase not found or does not belong to user" });
    }

    res.json({ purchase: updateResult.rows[0] });
  } catch (err) {
    console.error("Error in PUT /api/ingredient-purchases/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/ingredient-purchases/:id
// Body: { userId }
app.delete("/api/ingredient-purchases/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const deleteResult = await pool.query(
      `DELETE FROM ingredient_purchases
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId]
    );

    if (deleteResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Purchase not found or does not belong to user" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error in DELETE /api/ingredient-purchases/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
// GET /api/ingredient-waste?userId=123
app.get("/api/ingredient-waste", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const userCheck = await pool.query("SELECT id FROM users WHERE id = $1", [
      userId,
    ]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const result = await pool.query(
      `SELECT
         id,
         user_id,
         ingredient_id,
         purchase_id,
         waste_date,
         quantity_grams,
         created_at
       FROM ingredient_waste_events
       WHERE user_id = $1
       ORDER BY waste_date DESC, id DESC`,
      [userId]
    );

    res.json({ wasteEvents: result.rows });
  } catch (err) {
    console.error("Error in GET /api/ingredient-waste:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
// POST /api/ingredient-waste
// Body: { userId, ingredientId, purchaseId, quantityGrams, wasteDate }
// POST /api/ingredient-waste
// Body: { userId, ingredientId, purchaseId, quantityGrams, wasteDate, wasteStage? }
app.post("/api/ingredient-waste", async (req, res) => {
  try {
    const {
      userId,
      ingredientId,
      purchaseId,
      quantityGrams,
      wasteDate,
      wasteStage,           // <-- NEW: optional in body
    } = req.body;

    if (!userId || !ingredientId || !quantityGrams || !wasteDate) {
      return res.status(400).json({
        error:
          "Missing required fields (userId, ingredientId, quantityGrams, wasteDate)",
      });
    }

    const qty = Number(quantityGrams);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "Invalid quantityGrams value" });
    }

    // simple default for now; later we can expose this in the UI
    const stage =
      typeof wasteStage === "string" && wasteStage.trim().length > 0
        ? wasteStage.trim()
        : "other";

    const userCheck = await pool.query("SELECT id FROM users WHERE id = $1", [
      userId,
    ]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const ingCheck = await pool.query(
      "SELECT id FROM ingredients WHERE id = $1",
      [ingredientId]
    );
    if (ingCheck.rows.length === 0) {
      return res.status(404).json({ error: "Ingredient not found" });
    }

    // Optional: ensure purchase belongs to the same user
    let purchaseIdValue = null;
    if (purchaseId !== undefined && purchaseId !== null && purchaseId !== "") {
      const pId = Number(purchaseId);
      if (!Number.isFinite(pId) || pId <= 0) {
        return res.status(400).json({ error: "Invalid purchaseId value" });
      }

      const purchaseCheck = await pool.query(
        "SELECT id FROM ingredient_purchases WHERE id = $1 AND user_id = $2",
        [pId, userId]
      );
      if (purchaseCheck.rows.length === 0) {
        return res.status(404).json({
          error: "Purchase not found or does not belong to user",
        });
      }

      purchaseIdValue = pId;
    }

    const insertResult = await pool.query(
      `INSERT INTO ingredient_waste_events
         (user_id, ingredient_id, purchase_id, waste_date, quantity_grams, waste_stage)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, ingredient_id, purchase_id,
                 waste_date, quantity_grams, waste_stage, created_at`,
      [userId, ingredientId, purchaseIdValue, wasteDate, qty, stage]
    );

    res.status(201).json({ wasteEvent: insertResult.rows[0] });
  } catch (err) {
    console.error("Error in POST /api/ingredient-waste:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/ingredient-waste/:id
// Body: { userId, ingredientId, purchaseId, quantityGrams, wasteDate }
app.put("/api/ingredient-waste/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, ingredientId, purchaseId, quantityGrams, wasteDate } =
      req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const qty = Number(quantityGrams);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "Invalid quantityGrams value" });
    }

    let purchaseIdValue = null;
    if (purchaseId !== undefined && purchaseId !== null && purchaseId !== "") {
      const pId = Number(purchaseId);
      if (!Number.isFinite(pId) || pId <= 0) {
        return res.status(400).json({ error: "Invalid purchaseId value" });
      }
      purchaseIdValue = pId;
    }

    const updateResult = await pool.query(
      `UPDATE ingredient_waste_events
         SET ingredient_id = $1,
             purchase_id   = $2,
             waste_date    = $3,
             quantity_grams = $4
       WHERE id = $5 AND user_id = $6
       RETURNING id, user_id, ingredient_id, purchase_id,
                 waste_date, quantity_grams, created_at`,
      [ingredientId, purchaseIdValue, wasteDate, qty, id, userId]
    );

    if (updateResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Waste event not found or does not belong to user" });
    }

    res.json({ wasteEvent: updateResult.rows[0] });
  } catch (err) {
    console.error("Error in PUT /api/ingredient-waste/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
// DELETE /api/ingredient-waste/:id
// Body: { userId }
app.delete("/api/ingredient-waste/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const deleteResult = await pool.query(
      `DELETE FROM ingredient_waste_events
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId]
    );

    if (deleteResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Waste event not found or does not belong to user" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error in DELETE /api/ingredient-waste/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
