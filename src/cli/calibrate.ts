import { assertAiConfigured, loadConfig } from "../config.js";
import { assertEmbeddingColumn, createPool, getCatalogStatus, searchProducts, type ScoredProduct } from "../db.js";
import { createGeminiClient } from "../gemini.js";
import { runCli } from "./run.js";

// Mede os scores reais do modelo configurado para escolher RELEVANCE_MIN_SIMILARITY.
// `expected` vazio: não há produto adequado no catálogo.
const QUESTIONS: { query: string; expected: string[] }[] = [
  { query: "placa de desenvolvimento com Wi-Fi para automação", expected: ["esp32-devkit-v1", "nodemcu-esp8266", "esp32-c3-mini"] },
  { query: "placa com Wi-Fi barata para projeto eletrônico", expected: ["nodemcu-esp8266", "esp-01s", "esp32-c3-mini"] },
  { query: "placa ESP32 com câmera para monitoramento", expected: ["esp32-cam"] },
  { query: "placa sem Wi-Fi com lógica de 5 V para aprender eletrônica", expected: ["arduino-uno-r3", "arduino-nano"] },
  { query: "sensor de temperatura e umidade", expected: ["sensor-dht22", "sensor-bme280"] },
  { query: "sensor de CO2 para qualidade do ar", expected: ["sensor-co2-mhz19c"] },
  { query: "motor de passo para impressora 3D", expected: ["motor-nema17"] },
  { query: "driver para dois motores DC em um robô", expected: ["driver-l298n"] },
  { query: "fonte de 12 V para fita de LED", expected: ["fonte-12v-5a"] },
  { query: "placa de vídeo RTX 4090 para jogos", expected: [] },
  { query: "adaptador Wi-Fi USB para notebook", expected: [] },
  { query: "notebook para programar", expected: [] },
  { query: "smartphone com 5G", expected: [] },
  { query: "tênis de corrida", expected: [] },
];

await runCli(async () => {
  const config = loadConfig();
  assertAiConfigured(config);
  const pool = createPool(config);
  try {
    await assertEmbeddingColumn(pool, config.embeddingDimensions);
    const status = await getCatalogStatus(pool, config.embeddingModel);
    if (status.availableIndexed === 0) {
      console.error("Nenhum produto disponível indexado. Rode: npm run seed e npm run index");
      process.exitCode = 1;
      return;
    }

    const ai = createGeminiClient(config);
    const positives: number[] = [];
    const negatives: number[] = [];

    console.log(`Modelo: ${config.embeddingModel}. Score é similaridade de cosseno, não probabilidade de acerto.\n`);
    for (const { query, expected } of QUESTIONS) {
      const embedding = await ai.embedQuery(query);
      const search = { embedding, embeddingModel: config.embeddingModel, filters: {}, limit: 5 };
      const top: ScoredProduct[] = [
        ...(await searchProducts(pool, { ...search, inStock: true })),
        ...(await searchProducts(pool, { ...search, inStock: false })),
      ].sort((a, b) => b.similarity - a.similarity);

      if (expected.length === 0) {
        negatives.push(top[0]?.similarity ?? -1);
      } else {
        // O piso não pode cortar nenhum produto esperado: vale o pior deles entre os recuperados.
        const scores = top.filter((product) => expected.includes(product.id)).map((product) => product.similarity);
        positives.push(scores.length > 0 ? Math.min(...scores) : -1);
      }

      const label = expected.length === 0 ? "sem produto adequado" : `esperado: ${expected.join(", ")}`;
      console.log(`"${query}" (${label})`);
      for (const product of top.slice(0, 3)) console.log(`  ${product.similarity.toFixed(4)}  ${product.id}`);
    }

    const lowestPositive = Math.min(...positives);
    const highestNegative = Math.max(...negatives);
    console.log(`\nMenor score entre produtos esperados: ${lowestPositive.toFixed(4)}`);
    console.log(`Maior score em perguntas sem produto adequado: ${highestNegative.toFixed(4)}`);
    console.log(`Piso atual (RELEVANCE_MIN_SIMILARITY): ${config.minSimilarity}`);

    if (lowestPositive > highestNegative) {
      const suggestion = ((lowestPositive + highestNegative) / 2).toFixed(2);
      console.log(`\nAs faixas não se sobrepõem. Sugestão de piso: ${suggestion}.`);
    } else {
      const suggestion = (lowestPositive - 0.02).toFixed(2);
      console.log(
        `\nAs faixas se sobrepõem: o score sozinho não separa os casos. Use um piso abaixo dos esperados (ex.: ${suggestion}), ` +
          "para não perder produtos bons, e deixe a verificação de evidência rejeitar os demais.",
      );
    }
    if (lowestPositive < config.minSimilarity) {
      console.log("Atenção: o piso atual corta produtos esperados. Reduza RELEVANCE_MIN_SIMILARITY.");
    }
  } finally {
    await pool.end();
  }
});
