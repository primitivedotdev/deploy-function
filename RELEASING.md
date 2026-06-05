# Releasing `deploy-function`

This Action is authored in [`primitivedotdev/primitive-mono-repo`](https://github.com/primitivedotdev/primitive-mono-repo) under `tools/actions/deploy-function/` and **mirrored on tag** to the public repo [`primitivedotdev/deploy-function`](https://github.com/primitivedotdev/deploy-function). External consumers pin a floating major (`@v1`) or an immutable patch (`@v1.2.3`) from the public repo.

The mirror is **one-way**: every release wipes the public tree and force-replaces it with the contents of `tools/actions/deploy-function/`. No PRs are accepted against the public repo.

Publishing is handled by the **generalized** [`mirror-action.yml`](../../../.github/workflows/mirror-action.yml) workflow, shared by every action under `tools/actions/`. There is no per-action mirror workflow. The workflow is a **thin tag-triggered caller** — it does only auth setup (OIDC + the App installation token); the mirror logic (parse the tag, assert the action exists + is reachable from `main`, create the public repo on first publish, mirror the subtree, move the tags) lives in the typed, unit-tested deploy-engine (`pnpm --filter @primitivedotdev/deploy-engine deploy-worker mirror-action`), the same engine every other deploy in this repo routes through.

> **`dist/` parity is CI-enforced.** Because the published action runs the committed `dist/index.js`, the `actions` job in [`ci.yml`](../../../.github/workflows/ci.yml) **blocks** PRs on `typecheck` + `test:run` + `lint:dist` (the `check-dist.mjs` parity guard) for every action. A stale `dist/` can no longer merge — rebuild with `pnpm --filter @primitivedotdev/deploy-function-action build` and commit.

## One-time setup

The generalized mirror **creates `primitivedotdev/deploy-function` on first publish** if it doesn't exist (it needs the `primitive-ci` App to have org `Administration: write`; if the App lacks that, the create step prints a `gh repo create …` command to run once by hand). The App is installed at the **org level with `repository_selection: "all"`**, so a freshly created repo is covered automatically — no per-repo install step. The App credential is read at run time from AWS Secrets Manager (`staging/github-ci-app`) via the existing OIDC role; no GitHub Actions secret to manage.

> **Marketplace:** the mirror pushes git tags only — listing the action on the GitHub Marketplace is a separate one-time manual step (publish a release from the public repo's UI and accept the Marketplace agreement).

## Cutting a release

1. **Confirm the change is on `main`** — the mirror workflow asserts the tag commit is reachable from `origin/main` and refuses to publish otherwise.
2. **Pick a version** following semver (`vX.Y.Z`). Breaking changes bump the major.
3. **Tag locally and push**:

   ```bash
   git checkout main
   git pull --ff-only
   git tag deploy-function-action-v1.2.3
   git push origin deploy-function-action-v1.2.3
   ```

4. **Watch the mirror run**:

   ```bash
   gh run watch \
     "$(gh run list --workflow mirror-action.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

5. **Confirm the public repo updated**:

   ```bash
   # The mirror only pushes git tags (not GitHub Releases), so verify
   # against the tag list directly.
   gh api repos/primitivedotdev/deploy-function/tags --jq '.[].name'
   curl -fsSL https://raw.githubusercontent.com/primitivedotdev/deploy-function/v1/action.yml | head -20
   ```

## How `vMAJOR` works

The mirror always force-pushes a floating major tag (`v1`) pointing at the latest `v1.x.y`. Consumers who pin `@v1` get the newest patch automatically. Consumers who pin `@v1.2.3` get exactly that immutable version.

When you ship `v2.0.0`, the workflow creates `v2` (new floating major) without touching `v1` — so existing `@v1` consumers stay on the v1 line until they explicitly upgrade.

## Rollback

If a release breaks consumers in production:

1. Tag the **previous** good commit with a new patch version that supersedes the broken one (don't try to "delete" the broken tag; consumers may have already pinned it):

   ```bash
   git tag deploy-function-action-v1.2.4 <previous-good-sha>
   git push origin deploy-function-action-v1.2.4
   ```

   The mirror will rebuild the public repo from that commit and move `v1` to point at `v1.2.4`.

2. If the breakage is in the bundled `dist/`, you can also just **revert + re-tag** on the monorepo, since `dist/` regenerates from `src/` on every build (the `check-dist.mjs` CI guard ensures parity).
