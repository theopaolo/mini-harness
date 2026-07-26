import { expect, test } from "bun:test";

import type { OpenRouterModelInfo } from "./llm";
import {
  buildSystemPrompt,
  loadSkillCatalog,
  normalizeChoice,
  pickDetectionModel,
  type Skill,
} from "./skills";

function priced(
  id: string,
  prompt: string,
  completion = prompt,
): OpenRouterModelInfo {
  return {
    id,
    name: id,
    canonicalSlug: null,
    contextLength: 128_000,
    supportedParameters: [],
    pricing: { prompt, completion },
  };
}

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

const CHEAP = "0.00000001";
const DEAR = "0.00001";

test("le routeur de skills prend le modèle le moins cher, pas le mieux classé", () => {
  const models = [priced("vendor/cher", DEAR), priced("vendor/pas-cher", CHEAP)];

  // "vendor/cher" est le premier candidat du routeur, donc l'ancien choix.
  expect(pickDetectionModel(models, ["vendor/cher"])).toBe("vendor/pas-cher");
});

test("le routeur de skills n'a pas besoin du support des outils", () => {
  // La détection passe par callTextModel: un modèle sans `tools` reste éligible,
  // et c'est ce qui donne accès aux modèles les moins chers.
  const models = [priced("vendor/sans-outils", CHEAP)];

  expect(pickDetectionModel(models, [])).toBe("vendor/sans-outils");
});

test("les variantes :free sont écartées malgré leur coût nul", () => {
  const models = [priced("vendor/x:free", "0"), priced("vendor/payant", DEAR)];

  expect(pickDetectionModel(models, [])).toBe("vendor/payant");
});

test("un tarif illisible ou nul ne peut pas gagner par défaut", () => {
  const models = [
    priced("vendor/inconnu", "n/a"),
    priced("vendor/zero", "0"),
    priced("vendor/reel", DEAR),
  ];

  expect(pickDetectionModel(models, [])).toBe("vendor/reel");
});

test("à prix égal, le choix est stable", () => {
  const models = [priced("vendor/b", CHEAP), priced("vendor/a", CHEAP)];

  expect(pickDetectionModel(models, [])).toBe("vendor/a");
  expect(pickDetectionModel([...models].reverse(), [])).toBe("vendor/a");
});

test("sans liste de modèles, on retombe sur le candidat du routeur", () => {
  // C'est le cas du modèle forcé: la détection réutilise ce modèle.
  expect(pickDetectionModel([], ["vendor/force"])).toBe("vendor/force");
  expect(pickDetectionModel([], [])).toBeNull();
});

test("HARNESS_SKILL_DETECT_MODEL a le dernier mot", () => {
  const previous = Bun.env.HARNESS_SKILL_DETECT_MODEL;
  Bun.env.HARNESS_SKILL_DETECT_MODEL = "vendor/impose";
  try {
    expect(pickDetectionModel([priced("vendor/pas-cher", CHEAP)], [])).toBe(
      "vendor/impose",
    );
  } finally {
    if (previous === undefined) delete Bun.env.HARNESS_SKILL_DETECT_MODEL;
    else Bun.env.HARNESS_SKILL_DETECT_MODEL = previous;
  }
});

test("le prix de sortie compte aussi, malgré les 5 tokens produits", () => {
  const models = [
    // 0.0000001 × 700 + 0.001 × 5 = 0.00507
    priced("vendor/sortie-exorbitante", "0.0000001", "0.001"),
    // 0.000001 × 700 + 0.0000001 × 5 = 0.0007005
    priced("vendor/entree-modeste", "0.000001", "0.0000001"),
  ];

  // Un prompt bon marché ne rachète pas une complétion absurde: si seul le prix
  // d'entrée était regardé, "sortie-exorbitante" gagnerait.
  expect(pickDetectionModel(models, [])).toBe("vendor/entree-modeste");
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
