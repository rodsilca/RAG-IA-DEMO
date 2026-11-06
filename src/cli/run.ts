import { UserError } from "../config.js";
import { describeDbError } from "../db.js";

export function describeError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  return describeDbError(error) ?? `Erro inesperado: ${error instanceof Error ? error.message : String(error)}`;
}

/** Ponto de entrada dos comandos: erro vira mensagem clara e código de saída 1, sem stack trace. */
export async function runCli(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(`Erro: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
