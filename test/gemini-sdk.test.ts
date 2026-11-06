import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { GoogleGenAI, Type } from "@google/genai";
import { UserError } from "../src/config.js";
import { createGeminiClient } from "../src/gemini.js";

// Exercita o SDK real contra um servidor HTTP local: valida o que é enviado e como a resposta
// é lida. NÃO comprova que os modelos existem nem a qualidade deles, o que exige a API real.

interface Captured {
  url: string;
  apiKey: string | undefined;
  body: any;
}

const TEST_KEY = "chave-de-teste-nao-real";
let captured: Captured[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });
}

const server = createServer(async (request, response) => {
  captured.push({
    url: request.url ?? "",
    apiKey: request.headers["x-goog-api-key"] as string | undefined,
    body: JSON.parse((await readBody(request)) || "{}"),
  });
  response.writeHead(reply.status, { "content-type": "application/json" });
  response.end(JSON.stringify(reply.body));
});

let genai: GoogleGenAI;
const config = {
  geminiApiKey: TEST_KEY,
  generationModel: "modelo-geracao",
  embeddingModel: "gemini-embedding-2",
  embeddingDimensions: 3,
};

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  genai = new GoogleGenAI({
    apiKey: TEST_KEY,
    httpOptions: { baseUrl: `http://127.0.0.1:${port}`, retryOptions: { attempts: 1 } },
  });
});

after(() => {
  server.close();
});

function reset(status: number, body: unknown) {
  captured = [];
  reply = { status, body };
}

const embeddingReply = { embeddings: [{ values: [0.1, 0.2, 0.3] }], embedding: { values: [0.1, 0.2, 0.3] } };

test("SDK real: embedding de consulta usa prefixo de tarefa e dimensão configurada", async () => {
  reset(200, embeddingReply);
  const vector = await createGeminiClient(config, genai).embedQuery("placa com wi-fi");
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  const request = captured[0]!;
  assert.match(request.url, /gemini-embedding-2/);
  assert.equal(request.apiKey, TEST_KEY);
  const body = JSON.stringify(request.body);
  assert.ok(body.includes("task: search result | query: placa com wi-fi"), body);
  assert.ok(body.includes('"outputDimensionality":3'), body);
  assert.ok(!body.includes("taskType"), "gemini-embedding-2 não aceita taskType");
});

test("SDK real: embedding de documento usa o formato title/text", async () => {
  reset(200, embeddingReply);
  await createGeminiClient(config, genai).embedDocument("Placa A", "conteúdo");
  assert.ok(JSON.stringify(captured[0]!.body).includes("title: Placa A | text: conteúdo"));
});

test("SDK real: gemini-embedding-001 usa taskType em vez de prefixo", async () => {
  reset(200, embeddingReply);
  await createGeminiClient({ ...config, embeddingModel: "gemini-embedding-001" }, genai).embedQuery("placa");
  const body = JSON.stringify(captured[0]!.body);
  assert.ok(body.includes("RETRIEVAL_QUERY"), body);
  assert.ok(!body.includes("task: search result"), body);
});

test("SDK real: dimensão divergente orienta a recriar a indexação", async () => {
  reset(200, { embeddings: [{ values: [0.1] }], embedding: { values: [0.1] } });
  await assert.rejects(createGeminiClient(config, genai).embedQuery("x"), /npm run index:rebuild/);
});

const generationRequest = {
  system: "regras do sistema",
  prompt: "pergunta",
  schema: { type: Type.OBJECT, properties: { ok: { type: Type.BOOLEAN } }, required: ["ok"] },
};

test("SDK real: geração envia instrução de sistema e schema, e interpreta o JSON", async () => {
  reset(200, { candidates: [{ content: { role: "model", parts: [{ text: '{"ok":true}' }] } }] });
  const output = await createGeminiClient(config, genai).generateJson(generationRequest);
  assert.deepEqual(output, { ok: true });
  const request = captured[0]!;
  assert.match(request.url, /modelo-geracao:generateContent/);
  assert.equal(request.body.systemInstruction.parts[0].text, "regras do sistema");
  assert.equal(request.body.generationConfig.responseMimeType, "application/json");
  assert.equal(request.body.generationConfig.responseSchema.type, "OBJECT");
});

test("SDK real: resposta que não é JSON falha sem recomendar nada", async () => {
  reset(200, { candidates: [{ content: { role: "model", parts: [{ text: "texto solto" }] } }] });
  await assert.rejects(createGeminiClient(config, genai).generateJson(generationRequest), /Nenhum produto foi recomendado/);
});

const errors: [string, number, unknown, RegExp][] = [
  ["chave inválida", 400, { error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" } }, /GEMINI_API_KEY/],
  ["sem permissão", 403, { error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } }, /GEMINI_API_KEY/],
  ["modelo inexistente", 404, { error: { code: 404, message: "not found", status: "NOT_FOUND" } }, /GENERATION_MODEL/],
  ["limite de uso", 429, { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }, /429/],
  ["serviço fora do ar", 503, { error: { code: 503, message: "down", status: "UNAVAILABLE" } }, /indisponível/],
];

for (const [name, status, body, expected] of errors) {
  test(`SDK real: erro de ${name} vira mensagem clara`, async () => {
    reset(status, body);
    await assert.rejects(createGeminiClient(config, genai).embedQuery("x"), (error: Error) => {
      assert.ok(error instanceof UserError);
      assert.match(error.message, expected);
      assert.ok(!error.message.includes(TEST_KEY), "a chave não pode aparecer");
      return true;
    });
  });
}

test("SDK real: chave mencionada em mensagem de erro é removida", async () => {
  reset(400, { error: { code: 400, message: `request invalid for ${TEST_KEY}`, status: "INVALID_ARGUMENT" } });
  await assert.rejects(createGeminiClient(config, genai).embedQuery("x"), (error: Error) => {
    assert.ok(!error.message.includes(TEST_KEY));
    assert.ok(error.message.includes("[REDACTED]"));
    return true;
  });
});

test("SDK real: falha de rede vira mensagem clara", async () => {
  const offline = new GoogleGenAI({
    apiKey: TEST_KEY,
    httpOptions: { baseUrl: "http://127.0.0.1:1", retryOptions: { attempts: 1 } },
  });
  await assert.rejects(createGeminiClient(config, offline).embedQuery("x"), /Verifique sua conexão/);
});
