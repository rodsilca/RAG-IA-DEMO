import { ApiError, GoogleGenAI, type Schema } from "@google/genai";
import { UserError, type Config } from "./config.js";

/** Tudo o que o RAG precisa da IA. Os testes substituem esta interface por um fake explícito. */
export interface AiClient {
  embedDocument(title: string, text: string): Promise<number[]>;
  embedQuery(text: string): Promise<number[]>;
  generateJson(request: { system: string; prompt: string; schema: Schema }): Promise<unknown>;
}

type AiConfig = Pick<Config, "geminiApiKey" | "generationModel" | "embeddingModel" | "embeddingDimensions">;

export function createGeminiClient(config: AiConfig, genai?: Pick<GoogleGenAI, "models">): AiClient {
  const client = genai ?? new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { timeout: 60_000 } });
  // gemini-embedding-2 recebe a tarefa como prefixo no texto; os anteriores usam taskType.
  const usesPrefixes = config.embeddingModel.startsWith("gemini-embedding-2");

  async function embed(contents: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[]> {
    // Uma chamada por texto: no gemini-embedding-2, várias entradas na mesma requisição
    // podem ser agregadas em um único vetor. O catálogo é pequeno, então o custo é irrelevante.
    const response = await withFriendlyErrors(config, () =>
      client.models.embedContent({
        model: config.embeddingModel,
        contents,
        config: {
          outputDimensionality: config.embeddingDimensions,
          ...(usesPrefixes ? {} : { taskType }),
        },
      }),
    );
    const values = response.embeddings?.[0]?.values;
    if (!values || values.length !== config.embeddingDimensions) {
      throw new UserError(
        `O modelo ${config.embeddingModel} retornou ${values?.length ?? 0} dimensões, mas EMBEDDING_DIMENSIONS=` +
          `${config.embeddingDimensions}. Ajuste o .env e rode: npm run index:rebuild`,
      );
    }
    return values;
  }

  return {
    embedDocument: (title, text) =>
      embed(usesPrefixes ? `title: ${title} | text: ${text}` : text, "RETRIEVAL_DOCUMENT"),
    embedQuery: (text) => embed(usesPrefixes ? `task: search result | query: ${text}` : text, "RETRIEVAL_QUERY"),
    async generateJson({ system, prompt, schema }) {
      const response = await withFriendlyErrors(config, () =>
        client.models.generateContent({
          model: config.generationModel,
          contents: prompt,
          config: {
            systemInstruction: system,
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        }),
      );
      try {
        return JSON.parse(response.text ?? "");
      } catch {
        throw new UserError("A IA não retornou uma resposta estruturada válida. Nenhum produto foi recomendado; tente novamente.");
      }
    },
  };
}

async function withFriendlyErrors<T>(config: AiConfig, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new UserError(describeGeminiError(error, config));
  }
}

export function describeGeminiError(error: unknown, config: AiConfig): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Nada que contenha a chave chega ao terminal, mesmo que o SDK a inclua na mensagem.
  const detail = config.geminiApiKey ? raw.replaceAll(config.geminiApiKey, "[REDACTED]") : raw;

  if (error instanceof ApiError) {
    if (/API_KEY_INVALID|API key/i.test(detail) || error.status === 401 || error.status === 403) {
      return "O Gemini recusou as credenciais. Verifique se GEMINI_API_KEY está correta e ativa.";
    }
    if (error.status === 404) {
      return `Modelo não encontrado no Gemini. Verifique GENERATION_MODEL ("${config.generationModel}") e EMBEDDING_MODEL ("${config.embeddingModel}").`;
    }
    if (error.status === 429) return "Limite de uso do Gemini atingido (HTTP 429). Aguarde um pouco e tente novamente.";
    if (error.status >= 500) return `O Gemini está indisponível no momento (HTTP ${error.status}). Tente novamente.`;
    return `O Gemini rejeitou a requisição (HTTP ${error.status}): ${detail}`;
  }
  return `Não foi possível falar com o Gemini. Verifique sua conexão com a internet. Detalhe: ${detail}`;
}
