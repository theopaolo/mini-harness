# Benchmark LLM — 2026-05-20

> **Scope:** OpenRouter only

## How to read this report

| Column        | Description                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------- |
| Latence       | End-to-end response time (includes network + generation). Lower is faster.                         |
| Tokens in     | Prompt tokens sent to the model.                                                                   |
| Tokens out    | Completion tokens generated.                                                                       |
| Coût          | Estimated cost in EUR for this single call (prompt + completion pricing). `€0.00` = free or local. |
| Score qualité | How correct/well-formed the response is (see scoring below).                                       |

### Scoring method per task

| Task                 | Method                                 | What gets 5★                                                           |
| -------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Résumé de texte      | Heuristic (word count)                 | Response between 20–70 words                                           |
| Génération de code   | Ground truth — code is executed by Bun | `runningAverage([1,2,3,4])` returns `[1,1.5,2,2.5]` exactly            |
| Raisonnement logique | Ground truth — checks correct answers  | Response contains both **120 km** and **2 hours** (the exact solution) |

### Winners

- **Meilleure qualité** — highest score; latency breaks ties (faster = better).
- **Meilleur rapport qualité/coût** — best score-per-euro among paid models. Free/local models are excluded from this ranking since their ratio is infinite.

> ⚠️ When multiple models tie on score, quality differences are invisible here — a judge model would be needed to rank them further.

## Tâche : Résumé de texte

| Modèle               | Latence | Tokens in | Tokens out | Coût     | Score qualité |
| -------------------- | ------- | --------- | ---------- | -------- | ------------- |
| kimi-latest          | 1990ms  | 158       | 803        | €0.00268 | ★★★★★         |
| pareto-code          | 950ms   | 154       | 456        | €0.00    | ★★★★★         |
| kimi-k2.6            | 2845ms  | 158       | 430        | €0.00149 | ★★★★★         |
| qwen-2.5-7b-instruct | 1985ms  | 192       | 80         | €0.00001 | ★★★★★         |
| deepseek-v4-pro      | 4417ms  | 154       | 286        | €0.00112 | ★★★☆☆         |
| qwen3-coder-next     | 2052ms  | 171       | 140        | €0.00012 | ★★★☆☆         |

**Meilleure qualité :** pareto-code
**Meilleur rapport qualité/coût :** qwen-2.5-7b-instruct

## Tâche : Génération de code

| Modèle               | Latence | Tokens in | Tokens out | Coût     | Score qualité |
| -------------------- | ------- | --------- | ---------- | -------- | ------------- |
| kimi-latest          | 2356ms  | 49        | 707        | €0.00230 | ★★★★★         |
| deepseek-v4-pro      | 1807ms  | 45        | 344        | €0.00114 | ★★★★★         |
| pareto-code          | 2676ms  | 45        | 237        | €0.00    | ★★★★★         |
| kimi-k2.6            | 2553ms  | 49        | 686        | €0.00224 | ★★★★★         |
| qwen3-coder-next     | 1987ms  | 48        | 85         | €0.00007 | ★★★★★         |
| qwen-2.5-7b-instruct | 1985ms  | 69        | 73         | €9.26e-6 | ★★★★★         |

**Meilleure qualité :** deepseek-v4-pro
**Meilleur rapport qualité/coût :** qwen-2.5-7b-instruct

## Tâche : Raisonnement logique

| Modèle               | Latence | Tokens in | Tokens out | Coût     | Score qualité |
| -------------------- | ------- | --------- | ---------- | -------- | ------------- |
| kimi-latest          | 1000ms  | 60        | 705        | €0.00230 | ★★★★★         |
| deepseek-v4-pro      | 1841ms  | 56        | 760        | €0.00245 | ★★★★★         |
| pareto-code          | 3431ms  | 56        | 733        | €0.00    | ★★★★★         |
| kimi-k2.6            | 2510ms  | 60        | 1085       | €0.00352 | ★★★★★         |
| qwen3-coder-next     | 2224ms  | 64        | 504        | €0.00038 | ★★★★★         |
| qwen-2.5-7b-instruct | 3035ms  | 64        | 432        | €0.00004 | ★★★★★         |

**Meilleure qualité :** kimi-latest
**Meilleur rapport qualité/coût :** qwen-2.5-7b-instruct

## Modèles bloqués par guardrails (10)

`claude-haiku-latest`, `gpt-mini-latest`, `gemini-pro-latest`, `gemini-flash-latest`, `claude-sonnet-latest`, `gpt-latest`, `claude-opus-latest`, `free`, `bodybuilder`, `auto`
