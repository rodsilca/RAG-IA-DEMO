-- Schema idempotente, aplicado por `npm run db:init`.
-- {{EMBEDDING_DIMENSIONS}} é substituído pelo valor validado de EMBEDDING_DIMENSIONS.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS categories (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS products (
  id               TEXT PRIMARY KEY,
  category_id      TEXT NOT NULL REFERENCES categories (id),
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  specs            JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(specs) = 'object'),
  price_cents      INTEGER NOT NULL CHECK (price_cents >= 0),
  stock_quantity   INTEGER NOT NULL CHECK (stock_quantity >= 0),
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  embedding        VECTOR({{EMBEDDING_DIMENSIONS}}),
  embedding_model  TEXT,
  content_hash     TEXT,
  indexed_at       TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_category_idx ON products (category_id);

-- Sem índice ANN (HNSW/IVFFlat) de propósito: com um catálogo pequeno, a varredura
-- sequencial com `<=>` é exata e combina sem surpresas com os filtros do WHERE.
