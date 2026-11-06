import type { Db } from "./db.js";
import { categories, products } from "./seed-data.js";

/**
 * Idempotente: pode rodar várias vezes e restaura os valores de demonstração, sem duplicar.
 * Não toca nos vetores; se o conteúdo mudar, o hash acusa a diferença na próxima indexação.
 */
export async function seedDatabase(db: Db): Promise<void> {
  for (const category of categories) {
    await db.query(
      `INSERT INTO categories (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [category.id, category.name],
    );
  }
  for (const product of products) {
    await db.query(
      `INSERT INTO products (id, category_id, name, description, specs, price_cents, stock_quantity, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         category_id = EXCLUDED.category_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         specs = EXCLUDED.specs,
         price_cents = EXCLUDED.price_cents,
         stock_quantity = EXCLUDED.stock_quantity,
         active = EXCLUDED.active,
         updated_at = now()`,
      [
        product.id,
        product.categoryId,
        product.name,
        product.description,
        JSON.stringify(product.specs),
        product.priceCents,
        product.stockQuantity,
        product.active,
      ],
    );
  }
}
