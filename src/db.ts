import { readFile } from "node:fs/promises";
import pg from "pg";
import { UserError, type Config } from "./config.js";

/** Pool ou client em transação: permite demonstrar estados do banco com ROLLBACK. */
export interface Db {
  query: pg.Pool["query"];
}

export interface Product {
  id: string;
  name: string;
  categoryId: string;
  category: string;
  description: string;
  specs: Record<string, unknown>;
  priceCents: number;
  stockQuantity: number;
  active: boolean;
}

export interface ScoredProduct extends Product {
  /** Similaridade de cosseno. Serve só para ordenar e cortar; não é probabilidade de acerto. */
  similarity: number;
}

/** Restrições já validadas. Sempre vão como parâmetros, nunca como texto SQL. */
export interface SearchFilters {
  maxPriceCents?: number;
  /** Preço estritamente menor, usado em "tem uma mais barata?". */
  belowPriceCents?: number;
  minPriceCents?: number;
  categoryId?: string;
}

const PRODUCT_COLUMNS = `
  p.id,
  p.name,
  p.category_id AS "categoryId",
  c.name AS category,
  p.description,
  p.specs,
  p.price_cents AS "priceCents",
  p.stock_quantity AS "stockQuantity",
  p.active`;

export function createPool(config: Pick<Config, "databaseUrl">): pg.Pool {
  const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5_000 });
  // Conexão ociosa perdida (ex.: container parado) não deve derrubar o processo.
  pool.on("error", () => {});
  return pool;
}

export function describeDbError(error: unknown): string | null {
  const { code } = error as { code?: string };
  const message = error instanceof Error ? error.message : "";
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "57P01" ||
    code === "57P03" ||
    /connection terminated|timeout expired/i.test(message)
  ) {
    return "Não foi possível conectar ao PostgreSQL. Suba o banco com: npm run db:up";
  }
  if (code === "28P01" || code === "3D000") {
    return "O PostgreSQL recusou as credenciais ou o banco. Confira DATABASE_URL com o .env.example.";
  }
  if (code === "42P01" || code === "42703") return "O schema não foi criado ou está incompleto. Rode: npm run db:init";
  return null;
}

/** Aplica o schema. Só cria o que falta; não apaga nem altera dados existentes. */
export async function applySchema(db: Db, dimensions: number): Promise<void> {
  const template = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  await db.query(template.replaceAll("{{EMBEDDING_DIMENSIONS}}", String(dimensions)));
}

/** Confirma que a coluna vetorial tem a dimensão configurada. */
export async function assertEmbeddingColumn(db: Db, dimensions: number): Promise<void> {
  const { rows } = await db.query<{ dimensions: number }>(
    `SELECT atttypmod AS dimensions FROM pg_attribute
     WHERE attrelid = to_regclass('public.products') AND attname = 'embedding' AND NOT attisdropped`,
  );
  const column = rows[0];
  if (!column) throw new UserError("O schema não foi criado. Rode: npm run db:init");
  if (column.dimensions !== dimensions) {
    throw new UserError(
      `A coluna products.embedding tem ${column.dimensions} dimensões, mas EMBEDDING_DIMENSIONS=${dimensions}. ` +
        "Para recriar a indexação, rode: npm run index:rebuild",
    );
  }
}

/**
 * Descarta os vetores atuais e recria a coluna com a nova dimensão. Só é chamada por
 * `npm run index:rebuild`. Vetores são dados derivados; o catálogo não é afetado.
 */
export async function resetEmbeddings(db: Db, dimensions: number): Promise<void> {
  // Vários comandos sem parâmetros rodam numa única transação implícita: ou tudo, ou nada.
  await db.query(`
    ALTER TABLE products DROP COLUMN embedding;
    ALTER TABLE products ADD COLUMN embedding VECTOR(${dimensions});
    UPDATE products SET embedding_model = NULL, content_hash = NULL, indexed_at = NULL;
  `);
}

export interface CatalogStatus {
  /** Ativos e com estoque. */
  available: number;
  /** Ativos e com estoque, com vetor do modelo configurado. */
  availableIndexed: number;
}

export async function getCatalogStatus(db: Db, embeddingModel: string): Promise<CatalogStatus> {
  const { rows } = await db.query<CatalogStatus>(
    `SELECT
       count(*) FILTER (WHERE active AND stock_quantity > 0)::int AS available,
       count(*) FILTER (WHERE active AND stock_quantity > 0 AND embedding IS NOT NULL AND embedding_model = $1)::int
         AS "availableIndexed"
     FROM products`,
    [embeddingModel],
  );
  return rows[0]!;
}

/**
 * Busca por similaridade com os dados atuais do banco. Produtos inativos nunca são
 * retornados. Com `inStock`, separa candidatos disponíveis de relevantes sem estoque.
 */
export async function searchProducts(
  db: Db,
  params: {
    embedding: number[];
    embeddingModel: string;
    inStock: boolean;
    filters: SearchFilters;
    limit: number;
  },
): Promise<ScoredProduct[]> {
  const { rows } = await db.query<ScoredProduct>(
    `SELECT ${PRODUCT_COLUMNS}, 1 - (p.embedding <=> $1::vector) AS similarity
     FROM products p
     JOIN categories c ON c.id = p.category_id
     WHERE p.active
       AND p.embedding IS NOT NULL
       AND p.embedding_model = $2
       AND (p.stock_quantity > 0) = $3
       AND ($4::int IS NULL OR p.price_cents <= $4)
       AND ($5::int IS NULL OR p.price_cents < $5)
       AND ($6::int IS NULL OR p.price_cents >= $6)
       AND ($7::text IS NULL OR p.category_id = $7)
     ORDER BY p.embedding <=> $1::vector, p.id
     LIMIT $8`,
    [
      JSON.stringify(params.embedding),
      params.embeddingModel,
      params.inStock,
      params.filters.maxPriceCents ?? null,
      params.filters.belowPriceCents ?? null,
      params.filters.minPriceCents ?? null,
      params.filters.categoryId ?? null,
      params.limit,
    ],
  );
  return rows;
}

/** Releitura pelos IDs mostrados antes: preço, estoque e status sempre vêm atualizados. */
export async function getActiveProductsByIds(db: Db, ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<Product>(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     JOIN categories c ON c.id = p.category_id
     WHERE p.active AND p.id = ANY($1::text[])`,
    [ids],
  );
  return ids.flatMap((id) => rows.find((row) => row.id === id) ?? []);
}

export async function listCategories(db: Db): Promise<{ id: string; name: string }[]> {
  const { rows } = await db.query<{ id: string; name: string }>("SELECT id, name FROM categories ORDER BY id");
  return rows;
}
