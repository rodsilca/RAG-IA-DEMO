import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import type { AiClient } from "./gemini.js";

interface IndexableProduct {
  id: string;
  name: string;
  category: string;
  description: string;
  specs: Record<string, unknown>;
}

interface IndexRow extends IndexableProduct {
  embedding_model: string | null;
  content_hash: string | null;
  has_embedding: boolean;
}

/**
 * Texto enviado ao modelo de embeddings. Preço, estoque e status ficam de fora de propósito:
 * mudam com frequência e são lidos do banco a cada consulta, sem exigir nova indexação.
 */
export function buildDocument(product: Omit<IndexableProduct, "id">): string {
  const specs = Object.entries(product.specs)
    .sort(([a], [b]) => a.localeCompare(b, "pt-BR"))
    .map(([key, value]) => `- ${key}: ${String(value)}`)
    .join("\n");
  return [
    `Nome: ${product.name}`,
    `Categoria: ${product.category}`,
    `Descrição: ${product.description}`,
    `Especificações técnicas:\n${specs}`,
  ].join("\n");
}

export function hashDocument(document: string): string {
  return createHash("sha256").update(document).digest("hex");
}

/** Produtos sem vetor, com vetor de outro modelo ou com conteúdo alterado desde a indexação. */
export async function findProductsToIndex(db: Db, embeddingModel: string) {
  const { rows } = await db.query<IndexRow>(
    `SELECT p.id, p.name, c.name AS category, p.description, p.specs,
            p.embedding_model, p.content_hash, p.embedding IS NOT NULL AS has_embedding
     FROM products p
     JOIN categories c ON c.id = p.category_id
     ORDER BY p.id`,
  );
  const pending = rows.flatMap((row) => {
    const document = buildDocument(row);
    const contentHash = hashDocument(document);
    const upToDate = row.has_embedding && row.embedding_model === embeddingModel && row.content_hash === contentHash;
    return upToDate ? [] : [{ id: row.id, name: row.name, document, contentHash }];
  });
  return { total: rows.length, pending };
}

/**
 * Indexa também produtos inativos ou sem estoque: a disponibilidade é filtrada na consulta,
 * então reativar um produto não exige novo embedding. Grava produto a produto, de modo que
 * uma falha no meio não perde o que já foi feito e a próxima execução continua de onde parou.
 */
export async function indexProducts(
  db: Db,
  ai: Pick<AiClient, "embedDocument">,
  embeddingModel: string,
  log: (message: string) => void = () => {},
) {
  const { total, pending } = await findProductsToIndex(db, embeddingModel);
  for (const [position, product] of pending.entries()) {
    const embedding = await ai.embedDocument(product.name, product.document);
    await db.query(
      `UPDATE products
       SET embedding = $2::vector, embedding_model = $3, content_hash = $4, indexed_at = now()
       WHERE id = $1`,
      [product.id, JSON.stringify(embedding), embeddingModel, product.contentHash],
    );
    log(`  [${position + 1}/${pending.length}] ${product.id}`);
  }
  return { total, indexed: pending.length, skipped: total - pending.length };
}
