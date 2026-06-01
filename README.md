# Deploy Primitive Function

GitHub Action that deploys a [Primitive Function](https://primitive.dev) to primitive.dev. Idempotent — creates the function on first run, updates it on subsequent runs. Manages custom `function_secrets` in lockstep with the deploy and triggers a re-bind when bindings change.

## Quick start

```yaml
- uses: actions/checkout@v4
- run: pnpm install --frozen-lockfile && pnpm build
- uses: primitivedotdev/deploy-function@v1
  with:
    api-key: ${{ secrets.PRIMITIVE_API_KEY }}
    name: my-function
    code-path: dist/handler.js
    source-map-path: dist/handler.js.map
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | yes | — | Org-scoped Primitive API key. Pass via `${{ secrets.* }}` — masked in logs. |
| `api-base-url` | no | `https://api.primitive.dev/v1` | API base URL. Override only if deploying against a non-production environment. |
| `name` | yes | — | Function name. `/^[a-z0-9_-]{1,64}$/`. Idempotent within the org. |
| `code-path` | one of | — | Path to a pre-built ESM bundle (e.g. `dist/handler.js`). Mutually exclusive with `files-path`. |
| `source-map-path` | no | — | Source map for the `code-path` bundle. Surfaces readable stack traces in the dashboard. |
| `files-path` | one of | — | Path to a source directory for **managed build**. The Action walks the tree, applies ignore patterns, and the platform builds server-side. Directory must contain a `package.json` at its root. Requires the `functions_managed_build` entitlement on the org. Mutually exclusive with `code-path`. |
| `ignore` | no | — | Newline-delimited basename patterns to skip when walking `files-path`. Layered on top of the [default ignore list](#default-ignore-list). |
| `secrets` | no | `{}` | JSON object of custom function secrets to upsert. Values are masked. |
| `redeploy-on-secret-change` | no | `true` | Re-bind the runtime after upserting secrets. |
| `expected-org-id` | no | — | Safety guard: aborts if the API key's org differs from this UUID. Strongly recommended in production workflows. |

Exactly one of `code-path` and `files-path` must be set.

### Default ignore list

`node_modules`, `.git`, `.github`, `dist`, `build`, `.next`, `.turbo`, `.vercel`, `coverage`, `.DS_Store`, `.env`, `.env.local`, `.env.*` (covers `.env.production`, `.env.staging`, etc).

Add to it via the `ignore` input — basenames anywhere in the tree, exact match or simple glob (`*.log`, `*.test.ts`). `#` comments and blank lines allowed.

## Outputs

| Output | Description |
|---|---|
| `function-id` | UUID of the created or updated function. |
| `deploy-status` | `deployed`, `pending`, or `failed`. |
| `created` | `true` on initial create, `false` on update. |

## Examples

### Minimal — pre-built bundle

```yaml
- uses: primitivedotdev/deploy-function@v1
  with:
    api-key: ${{ secrets.PRIMITIVE_API_KEY }}
    name: my-function
    code-path: dist/handler.js
```

### With custom secrets and an org-id guard

```yaml
- uses: primitivedotdev/deploy-function@v1
  with:
    api-key: ${{ secrets.PRIMITIVE_API_KEY }}
    expected-org-id: ${{ vars.PRIMITIVE_ORG_ID }}
    name: my-function
    code-path: dist/handler.js
    secrets: |
      {
        "OPENAI_API_KEY": "${{ secrets.OPENAI_API_KEY }}",
        "FEATURE_FLAG": "on"
      }
```

The action upserts each secret via `POST /v1/functions/{id}/secrets`, then calls `POST /v1/functions/{id}/redeploy` so the new bindings are live in the runtime. Set `redeploy-on-secret-change: false` to skip the redeploy step (only the secret rows are touched).

### Managed build (`files-path`)

Skip the build step and hand the platform your source. The platform bundles server-side, applying the same Workers-for-Platforms compatibility flags as the dashboard's managed-build path.

```yaml
- uses: actions/checkout@v4
- uses: primitivedotdev/deploy-function@v1
  with:
    api-key: ${{ secrets.PRIMITIVE_API_KEY }}
    name: my-function
    files-path: ./function-source
    ignore: |
      # local-only assets the platform doesn't need
      fixtures
      *.test.ts
      *.spec.ts
```

`function-source/` must contain a `package.json` at its root (dependencies may be empty).

### Using outputs

```yaml
- id: deploy
  uses: primitivedotdev/deploy-function@v1
  with:
    api-key: ${{ secrets.PRIMITIVE_API_KEY }}
    name: my-function
    code-path: dist/handler.js
- run: echo "Deployed function-id=${{ steps.deploy.outputs.function-id }} (created=${{ steps.deploy.outputs.created }})"
```

## Security

- The `api-key` input is automatically masked. Pass it as a GitHub secret (`${{ secrets.* }}`) — never hard-code.
- Every value passed via `secrets` is also masked.
- Use `expected-org-id` in production workflows. It calls `GET /v1/whoami` before any write and aborts if the API key's org doesn't match.

## Versioning

- Floating major tag `v1` always tracks the latest 1.x.
- Pin a specific minor/patch (`v1.2.0`) for reproducible deploys.
- Breaking changes bump the major; `v1` stays alive for a deprecation window.

## Source

This action is authored in [primitivedotdev/primitive-mono-repo](https://github.com/primitivedotdev/primitive-mono-repo) under `tools/actions/deploy-function/` and mirrored here on release tags. See [RELEASING.md](./RELEASING.md) for the release process.

## License

MIT — see [LICENSE](./LICENSE).
