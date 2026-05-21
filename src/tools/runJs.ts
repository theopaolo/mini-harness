const JS_TIMEOUT_MS = 5000;
const MAX_TOOL_RESULT_CHARS = 8000;

const FORBIDDEN_PATTERNS = [
  { label: "filesystem Bun", pattern: /\bBun\.(write|file|spawn|spawnSync)\b/ },
  { label: "network fetch", pattern: /\bfetch\s*\(/ },
  { label: "environment variables", pattern: /\bprocess\.env\b/ },
  { label: "dynamic import", pattern: /\bimport\s*\(/ },
  { label: "static import", pattern: /\bimport\s+[\w*{]/ },
  { label: "commonjs require", pattern: /\brequire\s*\(/ },
  { label: "eval", pattern: /\beval\s*\(/ },
  { label: "Function constructor", pattern: /\bnew\s+Function\b/ },
  { label: "node filesystem module", pattern: /node:fs|fs\/promises/ },
  { label: "child process module", pattern: /node:child_process|child_process/ },
] as const;

export const runJsDefinition = {
  type: "function",
  function: {
    name: "run_js",
    description:
      "Exécute un snippet JavaScript avec Bun et retourne le résultat. Refuse les opérations réseau, fichier, process et import.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "Code JavaScript à exécuter avec `bun --print`. Exemple: `const xs=[1,2,3]; xs.reduce((a,b)=>a+b,0)`.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
} as const;

export async function runJs(code: string): Promise<string> {
  assertSafeCode(code);

  const proc = Bun.spawn(["bun", "--print", code], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), JS_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  if (exitCode !== 0) {
    return truncate(`Erreur Bun ${exitCode}: ${stderr.trim()}`, 2000);
  }

  return truncate(stdout.trim() || "(aucune sortie)", MAX_TOOL_RESULT_CHARS);
}

function assertSafeCode(code: string): void {
  for (const forbidden of FORBIDDEN_PATTERNS) {
    if (forbidden.pattern.test(code)) {
      throw new Error(`Code refusé: opération interdite (${forbidden.label})`);
    }
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}
