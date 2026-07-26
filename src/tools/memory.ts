import { mkdir } from "node:fs/promises";

const MEMORY_PATH = "notes/memory.md";

export const memoryReadDefinition = {
  type: "function",
  function: {
    name: "memory_read",
    description:
      "Lis la mémoire de travail (notes/memory.md) où tu accumules tes notes entre les tours. À utiliser quand tu veux relire ce que tu as déjà noté avant de continuer.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
} as const;

export const memoryAppendDefinition = {
  type: "function",
  function: {
    name: "memory_append",
    description:
      "Ajoute une note à la fin de la mémoire (notes/memory.md). Pour accumuler des observations au fil de l'enquête. Garde des notes courtes et factuelles.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Texte Markdown à ajouter en fin de mémoire.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
} as const;

export const memoryRewriteDefinition = {
  type: "function",
  function: {
    name: "memory_rewrite",
    description:
      "Remplace entièrement la mémoire (notes/memory.md). À utiliser pour curer, condenser ou réorganiser : relis avec memory_read, puis ré-écris une version propre. Ne pas utiliser pour produire un livrable — pour ça utilise write_document.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Nouveau contenu Markdown complet de la mémoire.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
} as const;

// Le harness exécute les tool calls d'un même tour en parallèle. memory_append
// fait un lire-modifier-écrire sur un fichier unique: deux appends simultanés
// liraient le même `previous` et l'un écraserait l'autre. On sérialise donc tous
// les accès mémoire dans une file, quel que soit l'ordonnancement de l'appelant.
let memoryQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = memoryQueue.then(operation, operation);
  memoryQueue = result.catch(() => {});
  return result;
}

export function memoryRead(): Promise<string> {
  return serialized(async () => {
    const file = Bun.file(MEMORY_PATH);
    if (!(await file.exists())) return "(mémoire vide)";
    const text = await file.text();
    return text.trim().length === 0 ? "(mémoire vide)" : text;
  });
}

export function memoryAppend(content: string): Promise<string> {
  return serialized(async () => {
    await mkdir("notes", { recursive: true });
    const file = Bun.file(MEMORY_PATH);
    const previous = (await file.exists()) ? await file.text() : "";
    const separator = previous.trim().length > 0 ? "\n\n" : "";
    const next = `${previous}${separator}${content.trim()}\n`;
    await Bun.write(MEMORY_PATH, next);
    return `Note ajoutée à ${MEMORY_PATH} (${content.length} caractères, total ${next.length}).`;
  });
}

export function memoryRewrite(content: string): Promise<string> {
  return serialized(async () => {
    await mkdir("notes", { recursive: true });
    const next = content.endsWith("\n") ? content : `${content}\n`;
    await Bun.write(MEMORY_PATH, next);
    return `Mémoire réécrite dans ${MEMORY_PATH} (${content.length} caractères).`;
  });
}
