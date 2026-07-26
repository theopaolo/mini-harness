import { expect, test } from "bun:test";

import { executeTool, isToolName, toolDefinitions } from "./index";

test("isToolName accepte chaque outil déclaré et rejette le reste", () => {
  for (const definition of toolDefinitions) {
    expect(isToolName(definition.function.name)).toBe(true);
  }

  expect(isToolName("save_note")).toBe(false);
  expect(isToolName("")).toBe(false);
});

test("un outil inconnu renvoie une erreur nommant l'outil demandé", async () => {
  const result = await executeTool({
    id: "call_1",
    name: "search_web",
    input: {},
  });

  // Le nom demandé doit apparaître tel quel: ne pas le déguiser en run_js.
  expect(result).toContain("search_web");
  expect(result).toContain("outil inconnu");
  expect(result).toContain("run_js");
});

test("des arguments illisibles remontent une erreur explicite", async () => {
  const result = await executeTool({
    id: "call_2",
    name: "run_js",
    input: {},
    argumentsError: "arguments illisibles, JSON invalide (reçu: {code:)",
  });

  expect(result).toContain("run_js");
  expect(result).toContain("JSON invalide");
});

test("un argument manquant est signalé sans faire crasher la harness", async () => {
  const result = await executeTool({
    id: "call_3",
    name: "run_js",
    input: {},
  });

  expect(result).toContain("code");
  expect(result.startsWith("Erreur run_js:")).toBe(true);
});

test("run_js exécute du code déterministe", async () => {
  const result = await executeTool({
    id: "call_4",
    name: "run_js",
    input: { code: "37 * 42" },
  });

  expect(result.trim()).toBe("1554");
});

test("run_js refuse les opérations interdites", async () => {
  const result = await executeTool({
    id: "call_5",
    name: "run_js",
    input: { code: "await fetch('https://example.com')" },
  });

  expect(result).toContain("refusé");
  expect(result).toContain("network fetch");
});
