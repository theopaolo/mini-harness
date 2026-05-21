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

export type ToolName =
  | "fetch_url"
  | "read_file"
  | "run_js"
  | "write_document"
  | "memory_read"
  | "memory_append"
  | "memory_rewrite";

export type ToolCall = {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
};

export const toolDefinitions = [
  fetchUrlDefinition,
  readFileDefinition,
  runJsDefinition,
  writeDocumentDefinition,
  memoryReadDefinition,
  memoryAppendDefinition,
  memoryRewriteDefinition,
] as const;

export async function executeTool(call: ToolCall): Promise<string> {
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
