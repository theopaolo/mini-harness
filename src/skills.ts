import { callTextModel, type ChatMessage } from "./llm";

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
  const skills: Skill[] = [];

  for await (const path of glob.scan(".")) {
    const content = await Bun.file(path).text();
    const parsed = parseSkillFile(content, path);
    if (parsed) skills.push(parsed);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

export async function detectSkill(
  mission: string,
  catalog: Skill[],
  detectionModel: string,
): Promise<Skill | null> {
  if (catalog.length === 0) return null;

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
    const result = await callTextModel(messages, detectionModel);
    if (Bun.env.HARNESS_SKILL_DEBUG) {
      console.log(`[skill-debug] modèle=${detectionModel} brut="${result.content}"`);
    }
    const choice = normalizeChoice(result.content, catalog);
    if (!choice || choice === "none") return null;
    return catalog.find((skill) => skill.name.toLowerCase() === choice) ?? null;
  } catch (error) {
    if (Bun.env.HARNESS_SKILL_DEBUG) {
      console.log(`[skill-debug] erreur détection: ${error}`);
    }
    return null;
  }
}

function normalizeChoice(raw: string, catalog: Skill[]): string | null {
  const lower = raw.toLowerCase();
  for (const skill of catalog) {
    if (lower.includes(skill.name.toLowerCase())) return skill.name.toLowerCase();
  }
  if (lower.includes("none")) return "none";
  return null;
}

export function buildSystemPrompt(base: string, skill: Skill | null): string {
  if (!skill) return base;
  return `${base}\n\n── Skill actif : ${skill.name} ──\n${skill.body}`;
}

export function logSkillDetection(
  mission: string,
  skill: Skill | null,
): void {
  const missionPreview =
    mission.length > 80 ? `${mission.slice(0, 80)}…` : mission;
  console.log("── Détection skill ──────────────────────────────");
  console.log(`Mission analysée : "${missionPreview}"`);
  if (skill) {
    console.log(`Skill chargé : ${skill.name} (${skill.charCount} chars injectés)`);
  } else {
    console.log("Skill chargé : aucun skill détecté");
  }
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
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const prefix = `${field}:`;
    if (!line.startsWith(prefix)) continue;

    let value = line.slice(prefix.length).trim();
    if (value.startsWith('"')) {
      value = value.slice(1);
      while (!value.endsWith('"') && i + 1 < lines.length) {
        i++;
        value += " " + (lines[i] ?? "").trim();
      }
      value = value.replace(/"$/, "");
    }
    return value.trim() || null;
  }
  return null;
}
