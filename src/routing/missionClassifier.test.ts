import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  classifyMission,
  classifyMissionByKeywords,
  normalizeTaskKind,
  TASK_KINDS,
} from "./missionClassifier";

test("normalizeTaskKind accepte une réponse propre", () => {
  expect(normalizeTaskKind("code")).toBe("code");
  expect(normalizeTaskKind("  Research\n")).toBe("research");
});

test("normalizeTaskKind retrouve la catégorie dans une phrase", () => {
  expect(normalizeTaskKind("Je classe ça en code.")).toBe("code");
  expect(normalizeTaskKind("Catégorie : reasoning")).toBe("reasoning");
});

test("normalizeTaskKind refuse ce qui n'est pas une catégorie", () => {
  expect(normalizeTaskKind("aucune idée")).toBeNull();
  expect(normalizeTaskKind("")).toBeNull();
});

test("normalizeTaskKind ne matche pas une catégorie collée à d'autres lettres", () => {
  expect(normalizeTaskKind("codebase")).toBeNull();
  expect(normalizeTaskKind("xxtool")).toBeNull();
});

test("chaque catégorie déclarée est reconnaissable", () => {
  for (const kind of TASK_KINDS) {
    expect(normalizeTaskKind(kind)).toBe(kind);
  }
});

test("la liste de mots-clés reste utilisable comme secours", () => {
  expect(classifyMissionByKeywords("Résume https://bun.sh/docs")).toBe("research");
  expect(classifyMissionByKeywords("Calcule 37*42")).toBe("tool");
  expect(classifyMissionByKeywords("Refactor cette fonction TypeScript")).toBe("code");
  expect(classifyMissionByKeywords("Démontre que l'algo termine")).toBe("reasoning");
  expect(classifyMissionByKeywords("Bonjour")).toBe("general");
});

test("la faiblesse connue de la liste de mots-clés est documentée par un test", () => {
  // Le cas observé en vrai: aucun mot-clé « code » dans la phrase, donc `general`.
  // C'est précisément pour ça que le modèle est passé devant.
  expect(
    classifyMissionByKeywords(
      "Analyse le dossier src/ et trouve les problèmes de sécurité",
    ),
  ).toBe("general");
});

test("une URL court-circuite le modèle et donne research", async () => {
  // Mesuré: le modèle répond `summary` sur « Résume https://… », ce qui est vrai
  // sur le fond mais fait router sans les bonus de fetch. La règle est
  // déterministe, donc appliquée avant l'appel — et sans appel du tout.
  const result = await classifyMission("Résume https://bun.sh/docs", null);

  expect(result.kind).toBe("research");
  expect(result.source).toBe("règle URL");
});

test("la règle URL s'applique même avec un modèle disponible", async () => {
  const result = await classifyMission(
    "Résume http://example.com/page",
    "vendor/modele-inexistant",
  );

  expect(result.kind).toBe("research");
  expect(result.source).toBe("règle URL");
});

test("une mission sans URL n'active pas la règle", async () => {
  const result = await classifyMission("Calcule 37*42", null);

  expect(result.source).not.toBe("règle URL");
});

test("sans modèle, la classification retombe sur les mots-clés", async () => {
  const result = await classifyMission("Calcule 37*42", null);

  expect(result.kind).toBe("tool");
  expect(result.source).toBe("mots-clés");
  expect(result.note).toBe("aucun modèle disponible");
});

let previousKey: string | undefined;

beforeEach(() => {
  previousKey = Bun.env.OPEN_ROUTER_API;
});

afterEach(() => {
  if (previousKey === undefined) delete Bun.env.OPEN_ROUTER_API;
  else Bun.env.OPEN_ROUTER_API = previousKey;
});

test("un échec d'appel retombe sur les mots-clés en disant pourquoi", async () => {
  Bun.env.OPEN_ROUTER_API = "sk-or-v1-invalide";

  const result = await classifyMission(
    "Refactor cette fonction TypeScript",
    "vendor/modele",
  );

  // Router avec un mauvais type de tâche vaut mieux que ne pas router du tout.
  expect(result.kind).toBe("code");
  expect(result.source).toBe("mots-clés");
  expect(result.note).toContain("classification en échec");
});
