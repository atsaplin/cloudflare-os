# Agent evaluation

This document defines how we evaluate the Workshop agent. It covers live agent evals and the
integration-test code that they reuse.

## Goal

An eval gives the production agent a natural-language task. The agent runs in a real Workshop and
builds a real Gadget. The verifier then calls that Gadget's RPC and checks the requested behavior.

The score measures what the agent delivered. Tool calls, time, errors, tokens, and cost explain the
result. They do not replace behavioral verification.

## One scenario, two targets

Every portable scenario can run against either target:

- **Local** starts the Workshop, its Durable Objects, and the Worker Loader under local workerd.
- **Preview** connects through a deployed preview router, Cloudflare Access, and the preview's real
  service bindings.

The task prompt and verifier do not contain target-specific code. Preview runs therefore act as
functional end-to-end tests of a deployed user scenario. Local runs provide faster iteration, more
trials, and controlled failure testing.

Some low-level tests remain local because the public API cannot abort an arbitrary Durable Object or
seed invalid internal state. They reuse the same integration-test primitives but are not duplicate
agent scenarios.

## Ownership

`packages/integration-tests` owns the Cloudflare-specific runtime bridge:

- start a multi-Worker workerd instance
- connect to the public Cap'n Web API
- authenticate a fresh local user or an Access preview identity
- drive one chat across multiple turns
- read canonical history and workpieces
- connect to generated Gadget RPCs
- accept the current chat's proposed changes

`vitest-evals` owns generic evaluation infrastructure:

- normalized transcripts, tools, traces, errors, usage, and timings
- scored judges
- local report UI
- GitHub summaries, annotations, gates, and sharded report reduction

`packages/workshop-evals` contains only the thin bridge between those layers and the authored Gadget
scenarios. It does not implement another report format, statistics package, trace viewer, or shard
reducer.

## Tasks and checks

A task contains one or more prompts and a verifier. Later turns share the same workspace and chat.
They must re-check earlier requirements when a new feature could break them.

Checks observe outcomes through stable interfaces. Examples include:

- arithmetic and validation through Gadget RPC
- no overselling under concurrent RPC calls
- stored state surviving a later turn's code changes
- a later turn preserving behavior from an earlier turn
- creation of a real standard Doc rather than a custom imitation

A check must not require one implementation technique when several correct techniques exist.

## Scores and diagnostics

Each trial reports:

- whether every requirement passed
- fraction of requirements passed
- model, target, and trial number
- total task duration
- time spent in each agent turn and verifier
- LLM turns
- tool calls, failed tool calls, and tool failure rate
- agent errors
- provider-reported token and cost metadata when available

All initial task scores come from deterministic code and RPC checks. No LLM judge is used.

A tool error does not fail a task by itself if the agent recovers and delivers the requested
behavior. An exception during a verifier check becomes a failed check. This first version does not
classify platform failures separately from the task score.

Repeated trials are required before comparing models or harnesses. Results must identify the model,
harness commit, target, task version, and trial. A model comparison holds the harness fixed. A
harness comparison holds the model fixed.

## Running evals

`pnpm evals` builds the workspace and runs the suite locally. Set `WORKSHOP_EVAL_TARGET` to an Access
preview URL and provide `CF_ACCESS_TOKEN` to run the same scenarios against that deployment.

The GitHub workflow has only `workflow_dispatch`. It never runs on a pull request, push, merge, or
schedule automatically. The caller selects models and trial count.

The workflow uses existing AI Gateway secrets. A deployed preview uses its own configured Workers AI
binding and model catalog.

## Results

Vitest JSON is the durable interchange format for one run. `vitest-evals` renders it locally and
combines CI shards. A separate experiment service can ingest the normalized rows for long-term model
and harness leaderboards. That service is not part of the Workshop execution bridge.
