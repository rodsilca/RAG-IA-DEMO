import assert from "node:assert/strict";
import { after, test } from "node:test";
import type pg from "pg";
import {
  applySchema,
  assertEmbeddingColumn,
  createPool,
  getActiveProductsByIds,
  getCatalogStatus,
  resetEmbeddings,
  searchProducts,
} from "../src/db.js";
import type { AiClient } from "../src/gemini.js";
import { findProductsToIndex, indexProducts } from "../src/indexer.js";
import { answerTurn, createSession, type ModelAnswer } from "../src/rag.js";
import { seedDatabase } from "../src/seed.js";
import { products as seedProducts } from "../src/seed-data.js";

// Integração com o PostgreSQL + pgvector reais do Docker Compose. Cada teste roda em uma
// transação desfeita ao final; nada persiste no banco da demonstração.
//
// FAKE SOMENTE DE TESTE: os vetores abaixo são contagens de palavras e as respostas do modelo são
// roteirizadas. Eles exercitam SQL, filtros e orquestração. Não medem a qualidade real do RAG.

const DIMENSIONS = 768;
const MODEL = "fake-test-model";
const pool = createPool({ databaseUrl: "postgres://rag_demo:rag_demo_local@127.0.0.1:5544/makerswap_rag_demo" });

after(async () => {
  await pool.end();
});

function fakeVector(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 7;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % DIMENSIONS;
    vector[hash]! += 1;
  }
  return vector;
}

function fakeAi(generated: unknown[] = []): AiClient & { embedCalls: string[]; prompts: string[] } {
  const queue = [...generated];
  const embedCalls: string[] = [];
  const prompts: string[] = [];
  return {
    embedCalls,
    prompts,
    embedDocument: async (title, text) => {
      embedCalls.push(title);
      return fakeVector(text);
    },
    embedQuery: async (text) => fakeVector(text),
    generateJson: async ({ prompt }) => {
      prompts.push(prompt);
      if (queue.length === 0) throw new Error("o modelo fake recebeu uma chamada não prevista");
      return queue.shift();
    },
  };
}

/** Banco preparado dentro de uma transação que sempre termina em ROLLBACK. */
async function inRollback(run: (db: pg.PoolClient) => Promise<void>, { indexed = true } = {}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applySchema(client, DIMENSIONS);
    await seedDatabase(client);
    await client.query("UPDATE products SET embedding = NULL, embedding_model = NULL, content_hash = NULL");
    if (indexed) await indexProducts(client, fakeAi(), MODEL);
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const deps = (db: pg.PoolClient, ai: AiClient) => ({
  db,
  ai,
  config: { embeddingModel: MODEL, minSimilarity: 0.05, topK: 8, outOfStockK: 3, historyMaxTurns: 6 },
});

const search = (db: pg.PoolClient, query: string, inStock: boolean, filters = {}) =>
  searchProducts(db, { embedding: fakeVector(query), embeddingModel: MODEL, inStock, filters, limit: 50 });

const analysis = (overrides: object = {}) => ({
  intent: "product_search",
  searchQuery: "placa com wi-fi para automação",
  maxPriceBRL: null,
  minPriceBRL: null,
  cheaperThanPrevious: false,
  category: null,
  referencedProductIds: [],
  clarificationQuestion: null,
  ...overrides,
});

const recommend = (...productIds: string[]): ModelAnswer => ({
  outcome: "recommend",
  message: "Estas opções atendem.",
  recommendations: productIds.map((productId) => ({ productId, reason: "Tem Wi-Fi.", relevantSpecs: ["Wi-Fi"] })),
  outOfStock: [],
});

test("schema: extensão, coluna vetorial e checagem de dimensão", async () => {
  await inRollback(async (db) => {
    const { rows } = await db.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    assert.equal(rows.length, 1);
    await assertEmbeddingColumn(db, DIMENSIONS);
    await assert.rejects(assertEmbeddingColumn(db, 1536), /npm run index:rebuild/);
  });
});

test("schema: restrições recusam preço e estoque negativos", async () => {
  await inRollback(async (db) => {
    await db.query("SAVEPOINT s");
    await assert.rejects(db.query("UPDATE products SET price_cents = -1 WHERE id = 'esp-01s'"), /check/i);
    await db.query("ROLLBACK TO s");
    await assert.rejects(db.query("UPDATE products SET stock_quantity = -1 WHERE id = 'esp-01s'"), /check/i);
  });
});

test("seed: idempotente e restaura os valores de demonstração", async () => {
  await inRollback(async (db) => {
    const count = async () => (await db.query("SELECT count(*)::int AS n FROM products")).rows[0].n as number;
    const before = await count();
    await seedDatabase(db);
    assert.equal(await count(), before);
    await db.query("UPDATE products SET stock_quantity = 0");
    await seedDatabase(db);
    const { rows } = await db.query("SELECT stock_quantity FROM products WHERE id = 'esp-01s'");
    assert.equal(rows[0].stock_quantity, 75);
  });
});

test("seed: cobre as categorias e os estados exigidos", () => {
  assert.ok(seedProducts.length >= 13 && seedProducts.length <= 18);
  assert.equal(new Set(seedProducts.map((product) => product.categoryId)).size, 5);
  assert.ok(seedProducts.some((product) => product.stockQuantity === 0));
  assert.ok(seedProducts.some((product) => !product.active));
  assert.ok(seedProducts.some((product) => product.specs["Wi-Fi"] === "Não possui"));
  assert.equal(new Set(seedProducts.map((product) => product.id)).size, seedProducts.length);
});

test("indexação: só gera embedding do que mudou", async () => {
  await inRollback(
    async (db) => {
      const ai = fakeAi();
      const first = await indexProducts(db, ai, MODEL);
      assert.equal(first.indexed, seedProducts.length);
      assert.equal(ai.embedCalls.length, seedProducts.length);

      const second = await indexProducts(db, ai, MODEL);
      assert.deepEqual(second, { total: seedProducts.length, indexed: 0, skipped: seedProducts.length });

      await db.query("UPDATE products SET price_cents = 1, stock_quantity = 0, active = FALSE WHERE id = 'esp-01s'");
      assert.equal((await indexProducts(db, ai, MODEL)).indexed, 0, "preço, estoque e status não reindexam");

      await db.query("UPDATE products SET description = 'Texto novo' WHERE id = 'esp-01s'");
      ai.embedCalls.length = 0;
      assert.equal((await indexProducts(db, ai, MODEL)).indexed, 1);
      assert.equal(ai.embedCalls[0], "Módulo Wi-Fi ESP-01S (ESP8266)");

      assert.equal((await indexProducts(db, ai, "outro-modelo")).indexed, seedProducts.length, "trocar de modelo reindexa tudo");
    },
    { indexed: false },
  );
});

test("indexação: recriar a coluna muda a dimensão e pede nova indexação", async () => {
  await inRollback(async (db) => {
    await resetEmbeddings(db, 1536);
    await assertEmbeddingColumn(db, 1536);
    const { pending } = await findProductsToIndex(db, MODEL);
    assert.equal(pending.length, seedProducts.length);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM products");
    assert.equal(rows[0].n, seedProducts.length, "o catálogo não pode ser afetado");
  });
});

test("busca: inativo nunca aparece; com e sem estoque ficam separados", async () => {
  await inRollback(async (db) => {
    const available = await search(db, "placa wi-fi", true);
    const unavailable = await search(db, "placa wi-fi", false);
    const availableIds = available.map((product) => product.id);
    const unavailableIds = unavailable.map((product) => product.id);

    for (const ids of [availableIds, unavailableIds]) assert.ok(!ids.includes("esp32-s2-mini"));
    assert.ok(availableIds.includes("nodemcu-esp8266"));
    assert.ok(!availableIds.includes("esp32-cam"));
    assert.deepEqual(unavailableIds.sort(), ["esp32-cam", "sensor-co2-mhz19c"]);
    assert.ok(available.every((product) => product.stockQuantity > 0));
    assert.ok(available.every((product, index) => index === 0 || available[index - 1]!.similarity >= product.similarity));
  });
});

test("busca: filtros estruturados e parâmetros contra injeção", async () => {
  await inRollback(async (db) => {
    const capped = await search(db, "placa", true, { maxPriceCents: 3290 });
    assert.ok(capped.length > 0 && capped.every((product) => product.priceCents <= 3290));
    assert.ok(capped.some((product) => product.priceCents === 3290), "o limite é inclusivo");

    const cheaper = await search(db, "placa", true, { belowPriceCents: 3290 });
    assert.ok(cheaper.every((product) => product.priceCents < 3290));

    const floor = await search(db, "placa", true, { minPriceCents: 6000 });
    assert.ok(floor.length > 0 && floor.every((product) => product.priceCents >= 6000));

    const category = await search(db, "placa", true, { categoryId: "sensores" });
    assert.ok(category.length > 0 && category.every((product) => product.categoryId === "sensores"));

    assert.deepEqual(await search(db, "placa", true, { categoryId: "x' OR '1'='1" }), []);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM products");
    assert.equal(rows[0].n, seedProducts.length);
  });
});

test("busca: ignora vetores de outro modelo", async () => {
  await inRollback(async (db) => {
    const found = await searchProducts(db, {
      embedding: fakeVector("placa"),
      embeddingModel: "modelo-que-nao-indexou",
      inStock: true,
      filters: {},
      limit: 5,
    });
    assert.deepEqual(found, []);
  });
});

test("fluxo: envia apenas candidatos, com dados atuais do banco", async () => {
  await inRollback(async (db) => {
    await db.query("UPDATE products SET price_cents = 4100 WHERE id = 'nodemcu-esp8266'");
    const ai = fakeAi([analysis(), recommend("nodemcu-esp8266")]);
    const turn = await answerTurn(deps(db, ai), createSession(), "Preciso de uma placa com Wi-Fi para automação.");
    assert.equal(turn.kind, "recommendation");
    assert.equal(turn.recommendations[0]!.product.priceCents, 4100, "o preço vem do banco, sem reindexar");

    const context = ai.prompts[1]!;
    assert.ok(context.includes("R$ 41,00"));
    assert.ok(!context.includes("esp32-s2-mini"), "produto inativo não vai para o modelo");
    assert.ok(!/similarity|similaridade/.test(context), "o score não vai para o modelo");
  });
});

test("fluxo: filtro de preço do modelo é aplicado no banco e impede item caro", async () => {
  await inRollback(async (db) => {
    const ai = fakeAi([analysis({ maxPriceBRL: 50 }), recommend("esp32-devkit-v1", "nodemcu-esp8266")]);
    const turn = await answerTurn(deps(db, ai), createSession(), "Tem alguma por até R$ 50?");
    assert.deepEqual(turn.recommendations.map((item) => item.product.id), ["nodemcu-esp8266"], "o de R$ 59,90 é descartado");
    assert.deepEqual(turn.appliedFilters, ["preço até R$ 50,00"]);
  });
});

test("fluxo: 'mais barata' usa o menor preço atual dos produtos mostrados", async () => {
  await inRollback(async (db) => {
    const ai = fakeAi([
      analysis(),
      recommend("nodemcu-esp8266"),
      analysis({ cheaperThanPrevious: true }),
      recommend("esp-01s", "nodemcu-esp8266"),
    ]);
    const session = createSession();
    await answerTurn(deps(db, ai), session, "Preciso de uma placa com Wi-Fi para automação.");
    const turn = await answerTurn(deps(db, ai), session, "e tem uma mais barata?");
    assert.deepEqual(turn.recommendations.map((item) => item.product.id), ["esp-01s"]);
    assert.deepEqual(turn.appliedFilters, ["preço abaixo de R$ 32,90"]);
    assert.ok(ai.prompts[2]!.includes("Placa NodeMCU"), "o histórico chega à interpretação do seguimento");
  });
});

test("fluxo: comparação relê os produtos mostrados", async () => {
  await inRollback(async (db) => {
    const ai = fakeAi([
      analysis(),
      recommend("nodemcu-esp8266", "esp32-c3-mini"),
      analysis({ intent: "compare", referencedProductIds: ["nodemcu-esp8266", "esp32-c3-mini", "inventado"] }),
      { outcome: "answer", message: "A C3 tem Bluetooth.", recommendations: [], outOfStock: [] },
    ]);
    const session = createSession();
    await answerTurn(deps(db, ai), session, "Preciso de uma placa com Wi-Fi para automação.");
    await db.query("UPDATE products SET stock_quantity = 0 WHERE id = 'esp32-c3-mini'");
    const turn = await answerTurn(deps(db, ai), session, "Qual a diferença entre essas duas?");
    assert.equal(turn.kind, "comparison");
    assert.deepEqual(turn.comparison.map((product) => product.id), ["nodemcu-esp8266", "esp32-c3-mini"]);
    assert.equal(turn.comparison[1]!.stockQuantity, 0, "reflete o estoque atual");
  });
});

test("fluxo: comparação sem produtos anteriores pede esclarecimento", async () => {
  await inRollback(async (db) => {
    const ai = fakeAi([analysis({ intent: "compare" })]);
    const turn = await answerTurn(deps(db, ai), createSession(), "Qual a diferença entre essas duas?");
    assert.equal(turn.kind, "clarify");
    assert.equal(ai.prompts.length, 1, "não gasta chamada de geração");
  });
});

test("fluxo: 'placa Wi-Fi' ambígua pergunta sem consultar o modelo", async () => {
  await inRollback(async (db) => {
    const ai = fakeAi();
    const turn = await answerTurn(deps(db, ai), createSession(), "Preciso de uma placa Wi-Fi.");
    assert.equal(turn.kind, "clarify");
    assert.match(turn.message, /projetos eletrônicos/);
    assert.match(turn.message, /adaptador Wi-Fi/);
    assert.equal(ai.prompts.length, 0);
  });
});

test("fluxo: produto ausente abaixo do piso nem chega ao modelo de resposta", async () => {
  await inRollback(async (db) => {
    const ai = fakeAi([analysis({ searchQuery: "rtx 4090 gpu nvidia gaming" })]);
    const context = deps(db, ai);
    // Os vetores fake podem colidir em uma palavra e somar algo perto de 0,1; 0,3 exige sobreposição real.
    context.config.minSimilarity = 0.3;
    const turn = await answerTurn(context, createSession(), "Preciso de uma RTX 4090");
    assert.equal(turn.kind, "no_match");
    assert.match(turn.message, /Não encontrei uma opção adequada/);
    assert.equal(ai.prompts.length, 1);
  });
});

test("fluxo: acima do piso, a rejeição do modelo prevalece sobre a proximidade", async () => {
  await inRollback(async (db) => {
    const ai = fakeAi([
      analysis({ searchQuery: "placa de vídeo rtx 4090" }),
      { outcome: "no_match", message: "O catálogo não tem placas de vídeo.", recommendations: [], outOfStock: [] },
    ]);
    const turn = await answerTurn(deps(db, ai), createSession(), "Preciso de uma placa de vídeo RTX 4090");
    assert.equal(turn.kind, "no_match");
    assert.deepEqual(turn.recommendations, []);
    assert.equal(ai.prompts.length, 2, "passou pelo piso e foi rejeitado na segunda etapa");
  });
});

test("fluxo: modelo que tenta recomendar inativo ou sem estoque é barrado", async () => {
  await inRollback(async (db) => {
    const ai = fakeAi([analysis(), recommend("esp32-s2-mini", "esp32-cam")]);
    const turn = await answerTurn(deps(db, ai), createSession(), "Preciso de uma placa com Wi-Fi para automação.");
    assert.deepEqual(turn.recommendations, []);
    assert.equal(turn.kind, "no_match");
  });
});

test("fluxo: produto relevante sem estoque é informado como indisponível", async () => {
  await inRollback(async (db) => {
    const ai = fakeAi([
      analysis({ searchQuery: "placa com câmera" }),
      {
        outcome: "no_match",
        message: "Só há opção sem estoque.",
        recommendations: [],
        outOfStock: [{ productId: "esp32-cam", reason: "Tem câmera OV2640." }],
      },
    ]);
    const turn = await answerTurn(deps(db, ai), createSession(), "Preciso de uma placa com câmera");
    assert.equal(turn.kind, "out_of_stock");
    assert.equal(turn.outOfStock[0]!.product.id, "esp32-cam");
    assert.ok(ai.prompts[1]!.includes("sem_estoque"));
  });
});

test("fluxo: sem produtos disponíveis, responde sem chamar a IA", async () => {
  await inRollback(async (db) => {
    await db.query("UPDATE products SET stock_quantity = 0");
    const ai = fakeAi();
    const turn = await answerTurn(deps(db, ai), createSession(), "Preciso de uma placa com Wi-Fi para automação.");
    assert.equal(turn.kind, "no_stock");
    assert.equal(ai.prompts.length, 0);
    assert.deepEqual(await getCatalogStatus(db, MODEL), { available: 0, availableIndexed: 0 });
  });
});

test("fluxo: sem indexação, orienta a rodar o comando", async () => {
  await inRollback(
    async (db) => {
      await assert.rejects(answerTurn(deps(db, fakeAi()), createSession(), "Preciso de um sensor"), /npm run index/);
    },
    { indexed: false },
  );
});

test("fluxo: JSON fora do schema não recomenda nada", async () => {
  await inRollback(async (db) => {
    const invalid = fakeAi([{ intent: "qualquer" }]);
    await assert.rejects(answerTurn(deps(db, invalid), createSession(), "Preciso de um sensor"), /Nenhum produto foi recomendado/);
    const invalidAnswer = fakeAi([analysis(), { outcome: "recommend" }]);
    await assert.rejects(answerTurn(deps(db, invalidAnswer), createSession(), "Preciso de uma placa"), /Nenhum produto foi recomendado/);
  });
});

test("fluxo: histórico curto respeita o limite e não guarda preços", async () => {
  await inRollback(async (db) => {
    const ai = fakeAi([analysis(), recommend("nodemcu-esp8266"), analysis({ intent: "off_topic" }), analysis({ intent: "off_topic" })]);
    const session = createSession();
    const context = deps(db, ai);
    context.config.historyMaxTurns = 2;
    await answerTurn(context, session, "Preciso de uma placa com Wi-Fi para automação.");
    assert.ok(!JSON.stringify(session.history).includes("R$"));
    await answerTurn(context, session, "oi");
    await answerTurn(context, session, "tudo bem?");
    assert.equal(session.history.length, 4);
    assert.equal(session.history[0]!.text, "oi");
  });
});

test("fluxo: erro em um turno não entra no histórico", async () => {
  await inRollback(async (db) => {
    const session = createSession();
    await assert.rejects(answerTurn(deps(db, fakeAi([{ intent: "x" }])), session, "pergunta"));
    assert.deepEqual(session.history, []);
  });
});

test("releitura por ID: mantém a ordem e ignora inativos", async () => {
  await inRollback(async (db) => {
    const products = await getActiveProductsByIds(db, ["esp-01s", "esp32-s2-mini", "nodemcu-esp8266"]);
    assert.deepEqual(products.map((product) => product.id), ["esp-01s", "nodemcu-esp8266"]);
  });
});
