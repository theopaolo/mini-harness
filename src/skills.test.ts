import { expect, test } from "bun:test";

import {
  buildSystemPrompt,
  loadSkillCatalog,
  normalizeChoice,
  type Skill,
} from "./skills";


function skill(name: string): Skill {
  return {
    name,
    description: `description de ${name}`,
    body: `corps de ${name}`,
    charCount: `corps de ${name}`.length,
    path: `skills/${name}/SKILL.md`,
  };
}

test("le catalogue charge tous les skills du dossier skills/", async () => {
  const catalog = await loadSkillCatalog();
  const names = catalog.map((entry) => entry.name);

  expect(names).toEqual(["code-review", "data-analysis", "redaction", "tech-report"]);
});

test("chaque skill chargé a un nom, une description et un corps non vides", async () => {
  const catalog = await loadSkillCatalog();

  for (const entry of catalog) {
    expect(entry.name).not.toBe("");
    expect(entry.description).not.toBe("");
    expect(entry.body).not.toBe("");
    expect(entry.charCount).toBe(entry.body.length);
  }
});

test("une description repliée sur plusieurs lignes est recollée entièrement", async () => {
  const catalog = await loadSkillCatalog();
  const redaction = catalog.find((entry) => entry.name === "redaction");

  expect(redaction).toBeDefined();
  // Le guillemet fermant doit avoir été retiré, pas laissé au milieu.
  expect(redaction?.description).not.toContain('"');
  expect(redaction?.description.endsWith(".")).toBe(true);
});

const catalog = [skill("code-review"), skill("data-analysis"), skill("c++")];

test("normalizeChoice accepte une réponse propre", () => {
  expect(normalizeChoice("code-review", catalog)).toBe("code-review");
  expect(normalizeChoice("  Code-Review\n", catalog)).toBe("code-review");
});

test("normalizeChoice retrouve le nom dans une phrase", () => {
  expect(normalizeChoice("Je choisis code-review.", catalog)).toBe("code-review");
  expect(normalizeChoice("Skill: data-analysis", catalog)).toBe("data-analysis");
});

test("normalizeChoice reconnaît le refus", () => {
  expect(normalizeChoice("none", catalog)).toBe("none");
  expect(normalizeChoice("aucun skill ne correspond, none", catalog)).toBe("none");
});

test("normalizeChoice rend null quand rien ne correspond", () => {
  expect(normalizeChoice("peut-être un autre truc", catalog)).toBeNull();
});

test("normalizeChoice ne matche pas un nom collé à d'autres caractères", () => {
  expect(normalizeChoice("code-reviewer", catalog)).toBeNull();
  expect(normalizeChoice("xxcode-review", catalog)).toBeNull();
});

test("normalizeChoice gère un nom contenant des métacaractères regex", () => {
  // Un `new RegExp` non échappé lèverait ici "nothing to repeat".
  expect(normalizeChoice("c++", catalog)).toBe("c++");
  expect(normalizeChoice("je prends c++ pour ça", catalog)).toBe("c++");
});

test("buildSystemPrompt renvoie le prompt de base sans skill", () => {
  expect(buildSystemPrompt("BASE", null)).toBe("BASE");
});

test("buildSystemPrompt injecte le corps du skill après le prompt de base", () => {
  const prompt = buildSystemPrompt("BASE", skill("code-review"));

  expect(prompt.startsWith("BASE")).toBe(true);
  expect(prompt).toContain("Skill actif : code-review");
  expect(prompt).toContain("corps de code-review");
});
