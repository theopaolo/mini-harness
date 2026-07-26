import { fetchUrl, fetchUrlDefinition } from "./fetchUrl";
import {
  memoryAppend,
  memoryAppendDefinition,
  memoryRead,
  memoryReadDefinition,
  memoryRewrite,
  memoryRewriteDefinition,
} from "./memory";
import { readFile, readFileDefinition } from "./readFile";
import { runJs, runJsDefinition } from "./runJs";
import { writeDocument, writeDocumentDefinition } from "./writeDocument";

export const toolDefinitions = [
  fetchUrlDefinition,
  readFileDefinition,
  runJsDefinition,
  writeDocumentDefinition,
  memoryReadDefinition,
  memoryAppendDefinition,
  memoryRewriteDefinition,
] as const;

// Dérivé de toolDefinitions: ajouter un outil au tableau suffit, le type et la
// validation runtime suivent. Le switch de executeTool devient alors incomplet,
// et tsc le signale.
export type ToolName = (typeof toolDefinitions)[number]["function"]["name"];

const TOOL_NAMES: ReadonlySet<string> = new Set(
  toolDefinitions.map((definition) => definition.function.name),
);

export function isToolName(value: string): value is ToolName {
  return TOOL_NAMES.has(value);
}

export type ToolCall = {
  id: string;
  /** Nom brut demandé par le modèle. Validé par executeTool, pas avant. */
  name: string;
  input: Record<string, unknown>;
  /** Renseigné quand `arguments` n'était pas du JSON exploitable. */
  argumentsError?: string;
};

export async function executeTool(call: ToolCall): Promise<string> {
  if (!isToolName(call.name)) {
    return `Erreur: outil inconnu "${call.name}". Outils disponibles: ${[...TOOL_NAMES].join(", ")}.`;
  }

  if (call.argumentsError) {
    return `Erreur ${call.name}: ${call.argumentsError}`;
  }

  try {
    switch (call.name) {
      case "fetch_url":
        return await fetchUrl(readString(call.input, "url"));
      case "read_file":
        return await readFile(readString(call.input, "path"));
      case "run_js":
        return await runJs(readString(call.input, "code"));
      case "write_document":
        return await writeDocument(
          readString(call.input, "filename"),
          readString(call.input, "content"),
        );
      case "memory_read":
        return await memoryRead();
      case "memory_append":
        return await memoryAppend(readString(call.input, "content"));
      case "memory_rewrite":
        return await memoryRewrite(readString(call.input, "content"));
    }
  } catch (error) {
    return `Erreur ${call.name}: ${errorMessage(error)}`;
  }
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`argument "${key}" manquant ou invalide`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
