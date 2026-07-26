import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryAppend, memoryRead, memoryRewrite } from "./memory";

// memory.ts écrit sous `notes/` relatif au cwd: on isole chaque test dans un
// dossier temporaire pour ne pas toucher la mémoire du dépôt.
let previousCwd: string;
let workdir: string;

beforeEach(async () => {
  previousCwd = process.cwd();
  workdir = await mkdtemp(join(tmpdir(), "titi-memory-"));
  process.chdir(workdir);
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(workdir, { recursive: true, force: true });
});

test("une mémoire absente est signalée comme vide", async () => {
  expect(await memoryRead()).toBe("(mémoire vide)");
});

test("memory_append accumule les notes dans l'ordre", async () => {
  await memoryAppend("première note");
  await memoryAppend("deuxième note");

  const memory = await memoryRead();
  expect(memory).toContain("première note");
  expect(memory).toContain("deuxième note");
  expect(memory.indexOf("première")).toBeLessThan(memory.indexOf("deuxième"));
});

test("des appends parallèles ne se perdent pas", async () => {
  // Le harness exécute les tool calls d'un même tour via Promise.all. Sans
  // sérialisation, ces appends liraient tous le même contenu initial et un seul
  // survivrait.
  const notes = Array.from({ length: 12 }, (_, i) => `note-${i}`);
  await Promise.all(notes.map((note) => memoryAppend(note)));

  const memory = await memoryRead();
  for (const note of notes) {
    expect(memory).toContain(note);
  }
});

test("memory_rewrite remplace tout le contenu", async () => {
  await memoryAppend("à jeter");
  await memoryRewrite("version propre");

  const memory = await memoryRead();
  expect(memory).not.toContain("à jeter");
  expect(memory.trim()).toBe("version propre");
});
