import { AUX_TIMEOUT_MS } from "./cheapModel";
import { callTextModel, type ChatMessage } from "./llm";
import { withTimeout } from "./timeout";

const SKILLS_DIR = "skills";

export type Skill = {
  name: string;
  description: string;
  body: string;
  charCount: number;
  path: string;
};

export async function loadSkillCatalog(): Promise<Skill[]> {
  const glob = new Bun.Glob(`${SKILLS_DIR}/*/SKILL.md`);
  const paths: string[] = [];
  for await (const path of glob.scan(".")) paths.push(path);

  const results = await Promise.all(
    paths.map(async (path) => {
      const content = await Bun.file(path).text();
      return parseSkillFile(content, path);
    }),
  );

  return results
    .filter((s): s is Skill => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function detectSkill(
  mission: string,
  catalog: Skill[],
  detectionModel: string | null,
): Promise<Skill | null> {
  const missionPreview =
    mission.length > 80 ? `${mission.slice(0, 80)}…` : mission;
  console.log("── Détection skill ──────────────────────────────");
  console.log(`Mission analysée : "${missionPreview}"`);

  if (!detectionModel || catalog.length === 0) {
    console.log("Skill chargé : aucun skill détecté");
    return null;
  }

  // Le modèle est affiché: c'est volontairement le moins cher du compte, pas celui
  // qui exécute la mission, et ça doit se voir.
  console.log(`Routeur skill : ${detectionModel}`);

  const skillList = catalog
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Tu es un routeur de skills. Tu reçois une mission utilisateur et une liste de skills disponibles. " +
        "Tu réponds par UN SEUL mot : le nom exact du skill le plus pertinent, ou 'none' si aucun ne correspond. " +
        "Pas de phrase, pas de ponctuation, pas d'explication.",
    },
    {
      role: "user",
      content: `Skills disponibles :\n${skillList}\n\nMission :\n${mission}\n\nRéponds avec un seul mot.`,
    },
  ];

  try {
    const result = await withTimeout(
      callTextModel(messages, detectionModel),
      AUX_TIMEOUT_MS,
      `détection skill ${detectionModel}`,
    );
    if (Bun.env.HARNESS_SKILL_DEBUG) {
      console.log(
        `[skill-debug] modèle=${detectionModel} brut="${result.content}"`,
      );
    }
    const choice = normalizeChoice(result.content, catalog);
    const skill =
      !choice || choice === "none"
        ? null
        : (catalog.find((s) => s.name.toLowerCase() === choice) ?? null);
    if (skill) {
      console.log(
        `Skill chargé : ${skill.name} (${skill.charCount} chars injectés)`,
      );
    } else {
      console.log("Skill chargé : aucun skill détecté");
    }
    return skill;
  } catch (error) {
    // Ne pas confondre "aucun skill ne correspond" et "la détection a échoué":
    // un 401 ou un timeout doit être visible sans HARNESS_SKILL_DEBUG.
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`Skill chargé : aucun (détection en échec — ${reason})`);
    return null;
  }
}

/** Exporté pour les tests: c'est la partie fragile de la détection. */
export function normalizeChoice(raw: string, catalog: Skill[]): string | null {
  const lower = raw.trim().toLowerCase();

  const exact = catalog.find((skill) => skill.name.toLowerCase() === lower);
  if (exact) return exact.name.toLowerCase();

  // Le modèle ajoute parfois une phrase autour du nom. On cherche donc le nom
  // comme mot entier, en échappant les métacaractères: un skill nommé "c++" ou
  // "node.js" produirait sinon un motif invalide ou trop permissif.
  for (const skill of catalog) {
    const name = skill.name.toLowerCase();
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(name)}(?![a-z0-9])`);
    if (pattern.test(lower)) return name;
  }

  if (lower.includes("none")) return "none";
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSystemPrompt(base: string, skill: Skill | null): string {
  if (!skill) return base;
  return `${base}\n\n── Skill actif : ${skill.name} ──\n${skill.body}`;
}

function parseSkillFile(content: string, path: string): Skill | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const [, frontmatter, body] = match;
  if (!frontmatter || body === undefined) return null;

  const name = extractField(frontmatter, "name");
  const description = extractField(frontmatter, "description");
  if (!name || !description) return null;

  const trimmedBody = body.trim();
  return {
    name,
    description,
    body: trimmedBody,
    charCount: trimmedBody.length,
    path,
  };
}

function extractField(frontmatter: string, field: string): string | null {
  const prefix = `${field}:`;
  const lines = frontmatter.split("\n");

  const start = lines.findIndex((line) => line.startsWith(prefix));
  if (start === -1) return null;

  let value = lines[start]!.slice(prefix.length).trim();
  if (!value.startsWith('"')) return value || null;

  // Les descriptions sont longues et souvent repliées sur plusieurs lignes.
  // On recolle les lignes suivantes jusqu'au guillemet fermant.
  if (!(value.length > 1 && value.endsWith('"'))) {
    for (let i = start + 1; i < lines.length; i++) {
      value += ` ${lines[i]!.trim()}`;
      if (value.endsWith('"')) break;
    }
  }

  return value.slice(1).replace(/"$/, "").trim() || null;
}
