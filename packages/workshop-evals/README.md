# Workshop agent evals

These evals run the production Workshop agent, execute the Gadget it creates, and verify the result
through the Gadget's real RPC.

The package uses the workerd and Cap'n Web helpers from `@gadgets/integration-tests`. `vitest-evals`
owns transcript normalization, scoring, reports, traces, and CI result reduction.

## Run locally

Use an existing AI Gateway configuration:

```sh
export CF_AI_GATEWAY=...
export CF_AI_GATEWAY_ACCOUNT_ID=...
export CF_AI_GATEWAY_API_TOKEN=...
pnpm evals
```

A Wrangler OAuth token can call Workers AI directly for local development:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
pnpm evals
```

Optional controls:

```sh
export WORKSHOP_EVAL_MODELS='@cf/zai-org/glm-5.2,@cf/moonshotai/kimi-k2.7-code'
export WORKSHOP_EVAL_TRIALS=3
```

The defaults are both models and one trial.

## Run against a preview

Provide the preview router URL and an Access application JWT for the user that runs the scenarios:

```sh
export WORKSHOP_EVAL_TARGET='https://pr123-branch-router.example.workers.dev'
export CF_ACCESS_TOKEN=...
pnpm evals
```

The preview supplies its own model catalog and Workers AI binding. The runner does not need separate
model credentials in this mode. The same task prompts and verifiers run locally and on the preview.

## Inspect results

The run writes `.wrangler/evals/results.json` in this package. Open the report UI with:

```sh
pnpm evals:ui
```

The report includes behavioral scores, transcripts, tool calls and errors, timings, usage, and target
metadata.

## CI

The **Workshop evals** workflow is manual-only. Start it with `workflow_dispatch` and choose the model
list and trial count. It uses existing repository AI Gateway credentials, native Vitest sharding, and
the official `getsentry/vitest-evals` action to publish one combined report.

## Add a scenario

1. Add `tasks/<name>.task.ts` with a prompt and RPC verifier.
2. Add `evals/<name>.eval.ts` that imports the task and calls `defineTaskEval(task)`.

A verifier should check user-visible behavior and stable RPC contracts. It should not require a
particular implementation technique. Multi-turn tasks should re-check earlier behavior after each
extension.
