import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMPTY_BENCHMARK_INDEX,
  findModelScores,
  loadBenchmarkIndex,
} from "./benchmarkSource";
import type { ModelBenchmarkRow } from "../llm";

const CACHE_PATH = "model-bench/openrouter-benchmarks.json";

function row(permaslug: string, coding: number): ModelBenchmarkRow {
  return {
    modelPermaslug: permaslug,
    displayName: permaslug,
    intelligenceIndex: 50,
    codingIndex: coding,
    agenticIndex: 40,
  };
}

// loadBenchmarkIndex écrit sous model-bench/ relatif au cwd.
let previousCwd: string;
let workdir: string;
let previousKey: string | undefined;

beforeEach(async () => {
  previousCwd = process.cwd();
  previousKey = Bun.env.OPEN_ROUTER_API;
  workdir = await mkdtemp(join(tmpdir(), "titi-bench-"));
  process.chdir(workdir);
});

afterEach(async () => {
  process.chdir(previousCwd);
  if (previousKey === undefined) delete Bun.env.OPEN_ROUTER_API;
  else Bun.env.OPEN_ROUTER_API = previousKey;
  await rm(workdir, { recursive: true, force: true });
});

async function seedCache(fetchedAt: string): Promise<void> {
  await mkdir("model-bench", { recursive: true });
  await Bun.write(
    CACHE_PATH,
    JSON.stringify({
      rows: [row("anthropic/claude-opus-5-20260723", 78)],
      asOf: "2026-07-25T00:00:00.000Z",
      fetchedAt,
    }),
  );
}

test("la jointure privilégie le slug daté", () => {
  const index = {
    ...EMPTY_BENCHMARK_INDEX,
    bySlug: new Map([
      ["anthropic/claude-opus-5-20260723", row("slug", 78)],
      ["anthropic/claude-opus-5", row("id", 10)],
    ]),
  };

  const found = findModelScores(index, {
    id: "anthropic/claude-opus-5",
    canonicalSlug: "anthropic/claude-opus-5-20260723",
  });

  expect(found?.codingIndex).toBe(78);
});

test("la jointure retombe sur l'id quand le slug ne matche pas", () => {
  const index = {
    ...EMPTY_BENCHMARK_INDEX,
    bySlug: new Map([["mistralai/mistral-small", row("id", 33)]]),
  };

  const found = findModelScores(index, {
    id: "mistralai/mistral-small",
    canonicalSlug: "mistralai/mistral-small-2506",
  });

  expect(found?.codingIndex).toBe(33);
});

test("un modèle non classé ne renvoie rien", () => {
  expect(
    findModelScores(EMPTY_BENCHMARK_INDEX, {
      id: "inconnu/modele",
      canonicalSlug: null,
    }),
  ).toBeUndefined();
});

test("un cache frais est utilisé sans appel réseau", async () => {
  await seedCache(new Date().toISOString());
  // Clé invalide: si le réseau était sollicité, on basculerait sur une note d'erreur.
  Bun.env.OPEN_ROUTER_API = "sk-or-v1-invalide";

  const index = await loadBenchmarkIndex({ ttlHours: 24 });

  expect(index.origin).toBe("cache");
  expect(index.note).toBeNull();
  expect(index.bySlug.size).toBe(1);
});

test("un cache périmé est conservé quand le réseau échoue", async () => {
  const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
  await seedCache(old);
  Bun.env.OPEN_ROUTER_API = "sk-or-v1-invalide";

  const index = await loadBenchmarkIndex({ ttlHours: 1 });

  // Mieux vaut router sur des scores d'avant-hier que sur rien du tout.
  expect(index.origin).toBe("cache");
  expect(index.note).toContain("réseau indisponible");
  expect(index.bySlug.size).toBe(1);
});

test("sans cache ni réseau, l'index est vide mais explique pourquoi", async () => {
  Bun.env.OPEN_ROUTER_API = "sk-or-v1-invalide";

  const index = await loadBenchmarkIndex({ ttlHours: 0 });

  expect(index.origin).toBe("absent");
  expect(index.bySlug.size).toBe(0);
  expect(index.note).toContain("scores indisponibles");
});

test("un cache corrompu est traité comme absent", async () => {
  await mkdir("model-bench", { recursive: true });
  await Bun.write(CACHE_PATH, "{ pas du json");
  Bun.env.OPEN_ROUTER_API = "sk-or-v1-invalide";

  const index = await loadBenchmarkIndex({ ttlHours: 24 });

  expect(index.origin).toBe("absent");
  expect(index.note).toContain("scores indisponibles");
});
