# Pappra quick start

Pappra is a workspace-local manager. It does not require a private repository,
a running host, a model provider or a code-graph service.

## 1. Build

```sh
pnpm install --frozen-lockfile
pnpm build
```

Node.js 24+ and pnpm 12.3.4 are the supported development baseline.

## 2. Create a workspace

Run `pappra init` from the intended workspace root. A plan is read-only; apply
writes only Pappra-owned configuration and prompts for missing choices when
interactive.

```sh
pappra init --json
pappra init --config init-choices.json --apply --json
pappra doctor --json
```

The apply result distinguishes written files from `external-actions-pending`.
Those actions are optional integrations; they are not performed by init.

## 3. Use continuity

```sh
pappra checkpoint --task example --objective 'Ship the change' \
  --author-session dev-session --native-session dev-session \
  --context-completeness complete --json
pappra resume example --session dev-session --json
```

A resume packet is advisory. Check `executionAllowed` and the verification
fields; a readable checkpoint does not grant permission to start work.

## 4. Use optional code intelligence

Select `codegraph` in workspace configuration only if the external engine is
installed. With the graph unselected, bounded text/structure queries remain
available.

```sh
pappra code status --repo app --json
pappra code prepare --repo app --plan --json
pappra code query --repo app --kind text --query 'entrypoint' --json
```

No global index is created by status or doctor.

## 5. Optional host and collaboration surfaces

Host integration is explicit:

```sh
pappra host detect --json
pappra host plan pi --json
```

Collaboration requires an explicit controller:

```sh
pappra collab run --prepared prepared.json --capabilities card.json \
  --controller fixture
```

`fixture` is deterministic and no-model. `pi-rpc` is an optional adapter that
uses an existing Pi RPC setup; it is not a default and is not required by core
Pappra commands.
