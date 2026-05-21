import { resolve, relative, basename } from "node:path";

const MAX_FILE_CHARS = 5000;

export const readFileDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Lit un fichier texte situé sous le répertoire courant de la harness. Refuse les chemins qui sortent du cwd et les fichiers cachés (commençant par '.').",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Chemin relatif au cwd de la harness. Exemples: 'README.md', 'src/app/harness.ts', 'notes/rapport.md'.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
} as const;

export async function readFile(path: string): Promise<string> {
  const safePath = resolveSafePath(path);

  const file = Bun.file(safePath);
  if (!(await file.exists())) {
    return `Erreur: fichier introuvable (${path}).`;
  }

  let content: string;
  try {
    content = await file.text();
  } catch {
    return `Erreur: fichier non lisible en texte (${path}). Binaire ?`;
  }

  const truncated = content.length > MAX_FILE_CHARS;
  const body = truncated ? content.slice(0, MAX_FILE_CHARS) : content;
  const suffix = truncated
    ? `\n… (${content.length - MAX_FILE_CHARS} caractères tronqués sur ${content.length})`
    : "";

  return `${body}${suffix}`;
}

function resolveSafePath(input: string): string {
  if (input.trim() === "") {
    throw new Error("Chemin vide");
  }

  const cwd = process.cwd();
  const absolute = resolve(cwd, input);
  const rel = relative(cwd, absolute);

  if (rel.startsWith("..") || rel === "") {
    throw new Error(`Chemin hors du cwd refusé: ${input}`);
  }

  if (basename(absolute).startsWith(".")) {
    throw new Error(`Fichier caché refusé: ${input}`);
  }

  return absolute;
}
