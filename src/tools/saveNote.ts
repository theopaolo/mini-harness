import { mkdir } from "node:fs/promises";

const NOTE_PATH = "notes/rapport.md";

export const saveNoteDefinition = {
  type: "function",
  function: {
    name: "save_note",
    description:
      "Ajoute du contenu Markdown dans notes/rapport.md, la mémoire persistante de l'agent.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Contenu Markdown à ajouter dans notes/rapport.md.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
} as const;

export async function saveNote(content: string): Promise<string> {
  await mkdir("notes", { recursive: true });

  const file = Bun.file(NOTE_PATH);
  const previous = (await file.exists()) ? await file.text() : "";
  const separator = previous.trim().length > 0 ? "\n\n---\n\n" : "";
  const next = `${previous}${separator}${content.trim()}\n`;

  await Bun.write(NOTE_PATH, next);
  return `Note sauvegardée dans ${NOTE_PATH} (${content.length} caractères).`;
}
