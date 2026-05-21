import { fetchUrl, fetchUrlDefinition } from "./fetchUrl";
import { runJs, runJsDefinition } from "./runJs";
import { saveNote, saveNoteDefinition } from "./saveNote";

export type ToolName = "fetch_url" | "run_js" | "save_note";

export type ToolCall = {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
};

export const toolDefinitions = [
  fetchUrlDefinition,
  runJsDefinition,
  saveNoteDefinition,
] as const;

export async function executeTool(call: ToolCall): Promise<string> {
  try {
    switch (call.name) {
      case "fetch_url":
        return await fetchUrl(readString(call.input, "url"));
      case "run_js":
        return await runJs(readString(call.input, "code"));
      case "save_note":
        return await saveNote(readString(call.input, "content"));
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
