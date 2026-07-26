import { expect, test } from "bun:test";

import type { ModelBenchmarkRow, OpenRouterModelInfo } from "../llm";
import type { BenchmarkRow } from "./types";
import {
  codeAffinityBonus,
  parseBenchmarkMarkdown,
  qualityFor,
  taskAffinityBonus,
} from "./modelRouter";

function scores(partial: Partial<ModelBenchmarkRow> = {}): ModelBenchmarkRow {
  return {
    modelPermaslug: "vendor/modele-20260101",
    displayName: "Modèle",
    intelligenceIndex: 50,
    codingIndex: 60,
    agenticIndex: 40,
    ...partial,
  };
}

const CURATED: BenchmarkRow = {
  task: "Génération de code",
  label: "modele",
  latencyMs: 1000,
  costEur: 0.0001,
  qualityScore: 5,
};

function model(id: string): OpenRouterModelInfo {
  return {
    id,
    name: id,
    canonicalSlug: `${id}-20260101`,
    contextLength: 128_000,
    supportedParameters: ["tools"],
    pricing: { prompt: "0", completion: "0" },
  };
}

const SIMPLE = "corrige ce bug";
const COMPLEX = "refactor complexe de l'architecture en profondeur";

test("un modèle coder reçoit un bonus code unique", () => {
  expect(codeAffinityBonus(model("qwen/qwen3-coder-next"), SIMPLE)).toBe(8);
  expect(codeAffinityBonus(model("qwen/qwen3-coder-next"), COMPLEX)).toBe(8);
});

test("un deepseek coder ne cumule pas les deux signaux code", () => {
  // Avant: isCoderModel(+8) et le bonus deepseek(+4) s'additionnaient à 12.
  expect(codeAffinityBonus(model("deepseek/deepseek-coder"), COMPLEX)).toBe(8);
});

test("un deepseek généraliste garde un bonus fournisseur plus faible", () => {
  expect(codeAffinityBonus(model("deepseek/deepseek-v4-pro"), SIMPLE)).toBe(4);
  expect(codeAffinityBonus(model("deepseek/deepseek-v4-pro"), COMPLEX)).toBe(6);
});

test("un modèle sans affinité code ne reçoit rien", () => {
  expect(codeAffinityBonus(model("openai/gpt-4o"), COMPLEX)).toBe(0);
});

test("aucun bonus code ne dépasse celui d'un modèle coder dédié", () => {
  const ids = [
    "qwen/qwen3-coder-next",
    "deepseek/deepseek-coder",
    "deepseek/deepseek-v4-pro",
    "openai/gpt-4o",
  ];

  for (const id of ids) {
    for (const text of [SIMPLE, COMPLEX]) {
      expect(codeAffinityBonus(model(id), text)).toBeLessThanOrEqual(8);
    }
  }
});

test("benchmark.md l'emporte sur les scores publics quand la ligne existe", () => {
  // La mesure faite à la main sur cette harness est plus pertinente qu'un index
  // générique: elle ne doit pas être écrasée.
  expect(qualityFor("code", CURATED, scores({ codingIndex: 20 }))).toBe(5);
});

test("les scores publics remplacent le défaut de 3 quand benchmark.md est muet", () => {
  expect(qualityFor("code", undefined, scores({ codingIndex: 80 }))).toBe(4);
  expect(qualityFor("code", undefined, scores({ codingIndex: 40 }))).toBe(2);
});

test("sans benchmark.md ni score public, la qualité reste le défaut", () => {
  expect(qualityFor("code", undefined, undefined)).toBe(3);
  expect(qualityFor("code", undefined, scores({ codingIndex: null }))).toBe(3);
});

test("chaque type de tâche lit l'index qui la concerne", () => {
  const s = scores({ codingIndex: 100, agenticIndex: 60, intelligenceIndex: 20 });

  expect(qualityFor("code", undefined, s)).toBe(5);
  expect(qualityFor("tool", undefined, s)).toBe(3);
  expect(qualityFor("research", undefined, s)).toBe(3);
  expect(qualityFor("reasoning", undefined, s)).toBe(1);
  expect(qualityFor("general", undefined, s)).toBe(1);
});

test("le bonus d'affinité suit l'index public quand il existe", () => {
  const strong = taskAffinityBonus("code", model("vendor/x"), SIMPLE, scores({ codingIndex: 80 }));
  const weak = taskAffinityBonus("code", model("vendor/y"), SIMPLE, scores({ codingIndex: 20 }));

  expect(strong).toBe(8);
  expect(weak).toBe(2);
  expect(strong).toBeGreaterThan(weak);
});

test("un modèle classé faible en code ne profite plus de son nom", () => {
  // C'est tout l'intérêt: "coder" dans le nom ne vaut plus rien face à un index.
  const named = taskAffinityBonus(
    "code",
    model("vendor/super-coder"),
    SIMPLE,
    scores({ codingIndex: 15 }),
  );

  expect(named).toBeCloseTo(1.5, 5);
});

test("les heuristiques de nom servent de secours pour un modèle non classé", () => {
  expect(taskAffinityBonus("code", model("vendor/super-coder"), SIMPLE, undefined)).toBe(8);
  expect(taskAffinityBonus("code", model("vendor/inconnu"), SIMPLE, undefined)).toBe(0);
});

test("le raisonnement complexe conserve la prime de capacité reasoning", () => {
  const withReasoning: OpenRouterModelInfo = {
    ...model("vendor/x"),
    supportedParameters: ["tools", "reasoning"],
  };

  const scored = taskAffinityBonus("reasoning", withReasoning, COMPLEX, scores({ intelligenceIndex: 50 }));
  const plain = taskAffinityBonus("reasoning", model("vendor/x"), COMPLEX, scores({ intelligenceIndex: 50 }));

  expect(scored).toBe(13);
  expect(plain).toBe(5);
});

const VALID = `## Tâche : Génération de code

| Modèle | Latence | In | Out | Coût | Score |
| --- | --- | --- | --- | --- | --- |
| qwen3-coder-next | 1200ms | 100 | 200 | €0.0004 | ★★★★★ |
`;

test("parseBenchmarkMarkdown lit une ligne bien formée", () => {
  const rows = parseBenchmarkMarkdown(VALID);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({
    task: "Génération de code",
    label: "qwen3-coder-next",
    latencyMs: 1200,
    costEur: 0.0004,
    qualityScore: 5,
  });
});

test("parseBenchmarkMarkdown ignore une latence illisible plutôt que produire NaN", () => {
  // Un NaN ici contaminerait le score et rendrait le tri des modèles arbitraire.
  const rows = parseBenchmarkMarkdown(VALID.replace("1200ms", "n/a"));

  expect(rows).toHaveLength(0);
});

test("parseBenchmarkMarkdown ignore un coût illisible", () => {
  const rows = parseBenchmarkMarkdown(VALID.replace("€0.0004", "gratuit"));

  expect(rows).toHaveLength(0);
});

test("parseBenchmarkMarkdown ne renvoie aucune ligne pour une tâche inconnue", () => {
  const rows = parseBenchmarkMarkdown(
    VALID.replace("Génération de code", "Tâche inventée"),
  );

  expect(rows).toHaveLength(0);
});

test("les lignes du benchmark du dépôt sont toutes numériquement valides", async () => {
  const markdown = await Bun.file("model-bench/benchmark.md").text();
  const rows = parseBenchmarkMarkdown(markdown);

  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(Number.isFinite(row.latencyMs)).toBe(true);
    expect(Number.isFinite(row.costEur)).toBe(true);
    expect(row.qualityScore).toBeGreaterThanOrEqual(0);
  }
});
