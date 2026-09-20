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
  const skillFilePattern = `${SKILLS_DIR}/*/SKILL.md`;
  const skillFileMatcher = new Bun.Glob(skillFilePattern);
  const skillFilePaths: string[] = [];

  for await (const skillFilePath of skillFileMatcher.scan(".")) {
    skillFilePaths.push(skillFilePath);
  }

  const parsedSkills = await Promise.all(
    skillFilePaths.map(async (skillFilePath) => {
      const skillFile = Bun.file(skillFilePath);
      const skillFileContent = await skillFile.text();

      return parseSkillFile(skillFileContent, skillFilePath);
    }),
  );

  const validSkills = parsedSkills.filter(
    (skill): skill is Skill => skill !== null,
  );

  validSkills.sort((firstSkill, secondSkill) =>
    firstSkill.name.localeCompare(secondSkill.name),
  );

  return validSkills;
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

  const canDetectSkill = detectionModel !== null && catalog.length > 0;
  if (!canDetectSkill) {
    console.log("Skill chargé : aucun skill détecté");
    return null;
  }

  // Le modèle est affiché: c'est volontairement le moins cher du compte, pas celui
  // qui exécute la mission, et ça doit se voir.
  console.log(`Routeur skill : ${detectionModel}`);

  const availableSkills = catalog
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");

  const routerInstructions =
    "Tu es un routeur de skills. Tu reçois une mission utilisateur et une liste de skills disponibles. " +
    "Tu réponds par UN SEUL mot : le nom exact du skill le plus pertinent, ou 'none' si aucun ne correspond. " +
    "Pas de phrase, pas de ponctuation, pas d'explication.";

  const routingRequest =
    `Skills disponibles :\n${availableSkills}\n\n` +
    `Mission :\n${mission}\n\n` +
    "Réponds avec un seul mot.";

  const messages: ChatMessage[] = [
    { role: "system", content: routerInstructions },
    { role: "user", content: routingRequest },
  ];

  try {
    const modelResponse = await withTimeout(
      callTextModel(messages, detectionModel),
      AUX_TIMEOUT_MS,
      `détection skill ${detectionModel}`,
    );

    if (Bun.env.HARNESS_SKILL_DEBUG) {
      console.log(
        `[skill-debug] modèle=${detectionModel} brut="${modelResponse.content}"`,
      );
    }

    const normalizedChoice = normalizeChoice(modelResponse.content, catalog);
    if (!normalizedChoice || normalizedChoice === "none") {
      console.log("Skill chargé : aucun skill détecté");
      return null;
    }

    const selectedSkill =
      catalog.find((skill) => skill.name.toLowerCase() === normalizedChoice) ??
      null;

    if (!selectedSkill) {
      console.log("Skill chargé : aucun skill détecté");
      return null;
    }

    console.log(
      `Skill chargé : ${selectedSkill.name} (${selectedSkill.charCount} chars injectés)`,
    );
    return selectedSkill;
  } catch (error) {
    // Ne pas confondre "aucun skill ne correspond" et "la détection a échoué":
    // un 401 ou un timeout doit être visible sans HARNESS_SKILL_DEBUG.
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`Skill chargé : aucun (détection en échec — ${reason})`);
    return null;
  }
}

/** Exporté pour les tests: c'est la partie fragile de la détection. */
export function normalizeChoice(
  rawModelResponse: string,
  catalog: Skill[],
): string | null {
  const normalizedResponse = rawModelResponse.trim().toLowerCase();

  const exactSkillMatch = catalog.find(
    (skill) => skill.name.toLowerCase() === normalizedResponse,
  );

  if (exactSkillMatch) {
    return exactSkillMatch.name.toLowerCase();
  }

  // Le modèle ajoute parfois une phrase autour du nom. On cherche donc chaque nom
  // comme mot entier, en échappant les métacaractères: un skill nommé "c++" ou
  // "node.js" produirait sinon un motif invalide ou trop permissif.
  for (const skill of catalog) {
    const normalizedSkillName = skill.name.toLowerCase();
    const escapedSkillName = escapeRegExp(normalizedSkillName);
    const skillNamePattern = new RegExp(
      `(?:^|[^a-z0-9])${escapedSkillName}(?![a-z0-9])`,
    );

    const responseContainsSkillName = skillNamePattern.test(normalizedResponse);
    if (responseContainsSkillName) {
      return normalizedSkillName;
    }
  }

  const modelSelectedNoSkill = normalizedResponse.includes("none");
  if (modelSelectedNoSkill) {
    return "none";
  }

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
