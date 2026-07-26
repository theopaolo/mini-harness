import { expect, test } from "bun:test";

import { pickCheapModel } from "./cheapModel";
import type { OpenRouterModelInfo } from "./llm";

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

const CHEAP = "0.00000001";
const DEAR = "0.00001";

test("pickCheapModel prend le modèle le moins cher, pas le mieux classé", () => {
  const models = [priced("vendor/cher", DEAR), priced("vendor/pas-cher", CHEAP)];

  // "vendor/cher" est le premier candidat du routeur, donc l'ancien choix.
  expect(pickCheapModel(models, ["vendor/cher"])).toBe("vendor/pas-cher");
});

test("les appels auxiliaires n'exigent pas le support des outils", () => {
  // La détection passe par callTextModel: un modèle sans `tools` reste éligible,
  // et c'est ce qui donne accès aux modèles les moins chers.
  const models = [priced("vendor/sans-outils", CHEAP)];

  expect(pickCheapModel(models, [])).toBe("vendor/sans-outils");
});

test("les variantes :free sont écartées malgré leur coût nul", () => {
  const models = [priced("vendor/x:free", "0"), priced("vendor/payant", DEAR)];

  expect(pickCheapModel(models, [])).toBe("vendor/payant");
});

test("un tarif illisible ou nul ne peut pas gagner par défaut", () => {
  const models = [
    priced("vendor/inconnu", "n/a"),
    priced("vendor/zero", "0"),
    priced("vendor/reel", DEAR),
  ];

  expect(pickCheapModel(models, [])).toBe("vendor/reel");
});

test("à prix égal, le choix est stable", () => {
  const models = [priced("vendor/b", CHEAP), priced("vendor/a", CHEAP)];

  expect(pickCheapModel(models, [])).toBe("vendor/a");
  expect(pickCheapModel([...models].reverse(), [])).toBe("vendor/a");
});

test("sans liste de modèles, on retombe sur le candidat du routeur", () => {
  // C'est le cas du modèle forcé: la détection réutilise ce modèle.
  expect(pickCheapModel([], ["vendor/force"])).toBe("vendor/force");
  expect(pickCheapModel([], [])).toBeNull();
});

test("HARNESS_CHEAP_MODEL a le dernier mot", () => {
  const previous = Bun.env.HARNESS_CHEAP_MODEL;
  Bun.env.HARNESS_CHEAP_MODEL = "vendor/impose";
  try {
    expect(pickCheapModel([priced("vendor/pas-cher", CHEAP)], [])).toBe(
      "vendor/impose",
    );
  } finally {
    if (previous === undefined) delete Bun.env.HARNESS_CHEAP_MODEL;
    else Bun.env.HARNESS_CHEAP_MODEL = previous;
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
  expect(pickCheapModel(models, [])).toBe("vendor/entree-modeste");
});

