import { mkdir } from "node:fs/promises";

const DOCUMENTS_DIR = "documents";
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export const writeDocumentDefinition = {
  type: "function",
  function: {
    name: "write_document",
    description:
      "Écris un document Markdown final dans documents/. Le harness ajoute automatiquement un timestamp au nom (ex: 'rapport.md' devient 'rapport_2026-05-21T143000.md'), donc deux appels n'écrasent jamais l'un l'autre. À utiliser pour produire un livrable (rapport, synthèse, doc) demandé par l'utilisateur. Un seul appel, contenu complet et autonome.",
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description:
            "Nom de fichier de base, sans dossier (ex: 'rapport.md'). Doit finir en .md. Pas de '/', pas de '..'. Ne mets pas de timestamp toi-même — il est ajouté automatiquement.",
        },
        content: {
          type: "string",
          description: "Contenu Markdown complet du document.",
        },
      },
      required: ["filename", "content"],
      additionalProperties: false,
    },
  },
} as const;

export async function writeDocument(
  filename: string,
  content: string,
): Promise<string> {
  if (!FILENAME_PATTERN.test(filename)) {
    throw new Error(
      `nom de fichier invalide "${filename}" (doit matcher [A-Za-z0-9._-]+\\.md, sans dossier)`,
    );
  }

  await mkdir(DOCUMENTS_DIR, { recursive: true });
  const path = `${DOCUMENTS_DIR}/${timestampedName(filename)}`;
  await Bun.write(path, content.endsWith("\n") ? content : `${content}\n`);
  return `Document écrit dans ${path} (${content.length} caractères).`;
}

function timestampedName(filename: string): string {
  const base = filename.slice(0, -".md".length);
  return `${base}_${timestamp()}.md`;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
