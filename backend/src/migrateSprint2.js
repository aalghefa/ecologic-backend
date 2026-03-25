/**
 * Sprint 2 schema migrations:
 * - users: add role ('owner' | 'staff'), invited_by_user_id (for staff)
 * - ingredients: new table + expanded emissions dataset
 * Run after initDb: npm run migrate
 */
import pool from "./db.js";

async function migrate() {
  const client = await pool.connect();
  try {
    // 1. Users: add role and optional link for staff
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner'
    `);
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by_user_id INTEGER REFERENCES users(id)
    `);
    console.log("Users: role, invited_by_user_id added or already exist");

    // 2. Ingredients table (id, name, category, emissions_per_kg_co2e)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ingredients (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        emissions_per_kg_co2e NUMERIC(10, 4) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Add missing columns if table existed from an older schema
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ingredients' AND column_name = 'category') THEN
          ALTER TABLE ingredients ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ingredients' AND column_name = 'emissions_per_kg_co2e') THEN
          ALTER TABLE ingredients ADD COLUMN emissions_per_kg_co2e NUMERIC(10, 4) NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ingredients' AND column_name = 'emissions_kg_co2e_per_kg') THEN
          ALTER TABLE ingredients ADD COLUMN emissions_kg_co2e_per_kg NUMERIC(10, 4);
          UPDATE ingredients SET emissions_kg_co2e_per_kg = COALESCE(emissions_kg_co2e_per_kg, emissions_per_kg_co2e);
        END IF;
      END $$
    `);
    console.log("Ingredients table created or already exists");

    // 2a. Seed ingredients if empty (do this before menu_item_ingredients so we have data even if that step fails)
    const countResult = await client.query(
      "SELECT COUNT(*) AS n FROM ingredients"
    );
    const count = Number(countResult.rows[0]?.n) ?? 0;
    if (count === 0) {
      const ingredients = [
        { name: "Beef (conventional)", category: "meat", emissions: 27.0 },
        { name: "Lamb", category: "meat", emissions: 39.2 },
        { name: "Pork", category: "meat", emissions: 12.1 },
        { name: "Chicken", category: "meat", emissions: 6.9 },
        { name: "Turkey", category: "meat", emissions: 10.9 },
        { name: "Fish (farmed)", category: "seafood", emissions: 5.0 },
        { name: "Shrimp (farmed)", category: "seafood", emissions: 12.0 },
        { name: "Salmon", category: "seafood", emissions: 11.9 },
        { name: "Tuna", category: "seafood", emissions: 6.1 },
        { name: "Cod", category: "seafood", emissions: 3.9 },
        { name: "Milk (dairy)", category: "dairy", emissions: 3.2 },
        { name: "Cheese (hard)", category: "dairy", emissions: 21.2 },
        { name: "Butter", category: "dairy", emissions: 12.1 },
        { name: "Cream", category: "dairy", emissions: 7.4 },
        { name: "Yogurt", category: "dairy", emissions: 3.2 },
        { name: "Eggs", category: "dairy", emissions: 4.8 },
        { name: "Rice (white)", category: "grains", emissions: 4.0 },
        { name: "Wheat flour", category: "grains", emissions: 1.0 },
        { name: "Bread", category: "grains", emissions: 1.4 },
        { name: "Pasta", category: "grains", emissions: 1.5 },
        { name: "Quinoa", category: "grains", emissions: 2.1 },
        { name: "Oats", category: "grains", emissions: 2.3 },
        { name: "Potatoes", category: "vegetables", emissions: 0.3 },
        { name: "Tomatoes", category: "vegetables", emissions: 1.4 },
        { name: "Onions", category: "vegetables", emissions: 0.4 },
        { name: "Carrots", category: "vegetables", emissions: 0.4 },
        { name: "Broccoli", category: "vegetables", emissions: 0.4 },
        { name: "Lettuce", category: "vegetables", emissions: 0.4 },
        { name: "Spinach", category: "vegetables", emissions: 0.3 },
        { name: "Bell peppers", category: "vegetables", emissions: 0.5 },
        { name: "Cucumber", category: "vegetables", emissions: 0.3 },
        { name: "Garlic", category: "vegetables", emissions: 0.6 },
        { name: "Mushrooms", category: "vegetables", emissions: 0.3 },
        { name: "Avocado", category: "vegetables", emissions: 0.9 },
        { name: "Apples", category: "fruits", emissions: 0.4 },
        { name: "Bananas", category: "fruits", emissions: 0.7 },
        { name: "Oranges", category: "fruits", emissions: 0.5 },
        { name: "Lemons", category: "fruits", emissions: 0.5 },
        { name: "Strawberries", category: "fruits", emissions: 0.4 },
        { name: "Grapes", category: "fruits", emissions: 0.6 },
        { name: "Blueberries", category: "fruits", emissions: 0.5 },
        { name: "Olive oil", category: "oils", emissions: 6.3 },
        { name: "Sunflower oil", category: "oils", emissions: 3.5 },
        { name: "Soybean oil", category: "oils", emissions: 6.0 },
        { name: "Sugar", category: "pantry", emissions: 0.6 },
        { name: "Chocolate", category: "pantry", emissions: 19.0 },
        { name: "Coffee", category: "pantry", emissions: 16.5 },
        { name: "Tea", category: "pantry", emissions: 5.0 },
        { name: "Almonds", category: "nuts", emissions: 2.3 },
        { name: "Peanuts", category: "nuts", emissions: 2.9 },
        { name: "Lentils", category: "legumes", emissions: 0.9 },
        { name: "Chickpeas", category: "legumes", emissions: 0.7 },
        { name: "Black beans", category: "legumes", emissions: 0.9 },
        { name: "Tofu", category: "legumes", emissions: 3.2 },
        { name: "Tempeh", category: "legumes", emissions: 2.0 },
      ];
      for (const i of ingredients) {
        await client.query(
          `INSERT INTO ingredients (name, category, emissions_per_kg_co2e, emissions_kg_co2e_per_kg)
           VALUES ($1, $2, $3, $3)`,
          [i.name, i.category, i.emissions]
        );
      }
      console.log(`Seeded ${ingredients.length} ingredients`);
    } else {
      console.log(`Ingredients table already has ${count} rows, skipping seed`);
    }

    // 2b. Menu item ingredients (link dishes to ingredients for emissions)
    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_item_ingredients (
        id SERIAL PRIMARY KEY,
        menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
        ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
        quantity_grams NUMERIC(12, 2) NOT NULL,
        unit TEXT NOT NULL DEFAULT 'g',
        UNIQUE(menu_item_id, ingredient_id)
      )
    `);
    // Add quantity_grams / unit if table existed with different columns
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'menu_item_ingredients' AND column_name = 'quantity_grams') THEN
          ALTER TABLE menu_item_ingredients ADD COLUMN quantity_grams NUMERIC(12, 2) NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'menu_item_ingredients' AND column_name = 'unit') THEN
          ALTER TABLE menu_item_ingredients ADD COLUMN unit TEXT NOT NULL DEFAULT 'g';
        END IF;
      END $$
    `);
    console.log("menu_item_ingredients table created or already exists");

    // 2c. Ingredient purchases (Waste page – id, user_id, ingredient_id, purchase_date, quantity_grams, total_cost_cad, created_at only)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ingredient_purchases (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
        quantity_grams NUMERIC(12, 2) NOT NULL DEFAULT 0,
        total_cost_cad NUMERIC(12, 2),
        purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE ingredient_purchases DROP COLUMN IF EXISTS supplier_name`);
    await client.query(`ALTER TABLE ingredient_purchases DROP COLUMN IF EXISTS invoice_number`);
    await client.query(`ALTER TABLE ingredient_purchases DROP COLUMN IF EXISTS notes`);
    console.log("ingredient_purchases table created or already exists");

    // 2d. Ingredient waste events (Waste page – persisted; no waste_stage or waste_reason)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ingredient_waste_events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
        purchase_id INTEGER,
        quantity_grams NUMERIC(12, 2) NOT NULL DEFAULT 0,
        waste_date DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      ALTER TABLE ingredient_waste_events DROP COLUMN IF EXISTS waste_stage
    `);
    await client.query(`
      ALTER TABLE ingredient_waste_events DROP COLUMN IF EXISTS waste_reason
    `);
    console.log("ingredient_waste_events table created or already exists");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
