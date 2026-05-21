import { runHarness } from "./src";

type CliOptions = {
  mission: string;
  debug: boolean;
  step: boolean;
  debugMaxChars?: number;
  maxTurns?: number;
  model?: string;
};

const options = parseArgsOrExit(process.argv.slice(2));
const mission = options.mission;

if (!mission) {
  console.error('Usage: bun run index.ts [--debug] [--step] "ta mission"');
  console.error(
    'Exemple: bun run index.ts "Calcule 37*42 avec run_js puis sauvegarde le résultat dans une note"',
  );
  console.error(
    'Debug: bun run index.ts --debug --step "Calcule 37*42 avec run_js"',
  );
  process.exit(1);
}

const finalAnswer = await runHarness(mission, {
  debug: options.debug,
  step: options.step,
  debugMaxChars: options.debugMaxChars,
  maxTurns: options.maxTurns,
  model: options.model,
});

console.log("\nRéponse finale");
console.log("─".repeat(14));
console.log(finalAnswer);

function parseArgs(argv: string[]): CliOptions {
  const missionParts: string[] = [];
  let debug = false;
  let step = false;
  let debugMaxChars: number | undefined;
  let maxTurns: number | undefined;
  let model: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    switch (arg) {
      case "--":
        break;
      case "--debug":
        debug = true;
        break;
      case "--step":
        debug = true;
        step = true;
        break;
      case "--debug-full":
        debug = true;
        debugMaxChars = Infinity;
        break;
      case "--max-turns":
        maxTurns = readNumberFlag(argv, ++index, "--max-turns");
        break;
      case "--model":
        model = readStringFlag(argv, ++index, "--model");
        break;
      default:
        if (arg?.startsWith("--")) {
          throw new Error(`Option inconnue: ${arg}`);
        }
        if (arg) missionParts.push(arg);
    }
  }

  return {
    mission: missionParts.join(" ").trim(),
    debug,
    step,
    debugMaxChars,
    maxTurns,
    model,
  };
}

function parseArgsOrExit(argv: string[]): CliOptions {
  try {
    return parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

function readStringFlag(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Valeur manquante pour ${flag}`);
  }
  return value;
}

function readNumberFlag(
  argv: string[],
  index: number,
  flag: string,
): number {
  const value = Number(readStringFlag(argv, index, flag));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Valeur invalide pour ${flag}`);
  }
  return value;
}
