import { mkdir } from "node:fs/promises";

import { listBenchmarks, type BenchmarkSnapshot } from "../llm";
import type { ModelBenchmarkRow } from "../llm";

const CACHE_PATH = "model-bench/openrouter-benchmarks.json";
const DEFAULT_TTL_HOURS = 24;

export type BenchmarkIndex = {
  /** Scores par slug OpenRouter, prêts à joindre sur canonicalSlug puis id. */
  bySlug: Map<string, ModelBenchmarkRow>;
  asOf: string | null;
  /** D'où viennent les scores: utile à afficher, la fraîcheur change le routage. */
  origin: "réseau" | "cache" | "absent";
  note: string | null;
};

type CacheFile = BenchmarkSnapshot & { fetchedAt: string };

export const EMPTY_BENCHMARK_INDEX: BenchmarkIndex = {
  bySlug: new Map(),
  asOf: null,
  origin: "absent",
  note: null,
};

/**
 * Charge les scores publics avec un cache disque.
 *
 * L'ordre importe: cache frais → réseau → cache périmé → rien. Le dernier cran
 * garantit qu'une mission reste lançable hors ligne, et que le routage ne dépende
 * pas d'une requête qui peut échouer.
 */
export async function loadBenchmarkIndex(options?: {
  ttlHours?: number;
  refresh?: boolean;
}): Promise<BenchmarkIndex> {
  const ttlHours = options?.ttlHours ?? readTtlFromEnv() ?? DEFAULT_TTL_HOURS;
  const cached = await readCache();

  if (!options?.refresh && cached && ageInHours(cached.fetchedAt) < ttlHours) {
    return toIndex(cached, "cache", null);
  }

  try {
    const snapshot = await listBenchmarks();
    await writeCache(snapshot);
    return toIndex(snapshot, "réseau", null);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (cached) {
      return toIndex(
        cached,
        "cache",
        `réseau indisponible (${reason}), cache périmé conservé`,
      );
    }
    return { ...EMPTY_BENCHMARK_INDEX, note: `scores indisponibles (${reason})` };
  }
}

function toIndex(
  snapshot: BenchmarkSnapshot,
  origin: BenchmarkIndex["origin"],
  note: string | null,
): BenchmarkIndex {
  const bySlug = new Map<string, ModelBenchmarkRow>();
  for (const row of snapshot.rows) bySlug.set(row.modelPermaslug, row);
  return { bySlug, asOf: snapshot.asOf, origin, note };
}

async function readCache(): Promise<CacheFile | null> {
  const file = Bun.file(CACHE_PATH);
  if (!(await file.exists())) return null;

  try {
    const data = (await file.json()) as Partial<CacheFile>;
    if (!Array.isArray(data.rows) || typeof data.fetchedAt !== "string") {
      return null;
    }
    return { rows: data.rows, asOf: data.asOf ?? null, fetchedAt: data.fetchedAt };
  } catch {
    // Un cache corrompu ne doit pas casser une mission: on le traite comme absent.
    return null;
  }
}

async function writeCache(snapshot: BenchmarkSnapshot): Promise<void> {
  const payload: CacheFile = { ...snapshot, fetchedAt: new Date().toISOString() };
  await mkdir("model-bench", { recursive: true });
  await Bun.write(CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function ageInHours(isoDate: string): number {
  const fetchedAt = Date.parse(isoDate);
  if (Number.isNaN(fetchedAt)) return Number.POSITIVE_INFINITY;
  return (Date.now() - fetchedAt) / 3_600_000;
}

function readTtlFromEnv(): number | null {
  const raw = Bun.env.HARNESS_BENCHMARK_TTL_HOURS;
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Joint un modèle à ses scores publics: slug daté d'abord, `id` en secours. */
export function findModelScores(
  index: BenchmarkIndex,
  model: { id: string; canonicalSlug: string | null },
): ModelBenchmarkRow | undefined {
  if (model.canonicalSlug) {
    const bySlug = index.bySlug.get(model.canonicalSlug);
    if (bySlug) return bySlug;
  }
  return index.bySlug.get(model.id);
}
