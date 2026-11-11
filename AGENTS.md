<!--VITE PLUS START-->

## Vite+ Guidelines

This project uses Vite+ to manage development tools. Always use `vp` (or `vpr` shorthand for `vp run`) to run commands:

- `vpr <script>` (or `vp run <script>`): Run scripts from `package.json`
- `vp install`: Install dependencies
- `vp update`: Update dependencies
- `vp check`: Run linter, typecheck, format checks
- `vp fmt`: Run formatter
- `vp lint`: Run linter

<!--VITE PLUS END-->

# Agent Operations & Maintenance Guide

## 1. Architecture Overview

`vp-actions` provides shared, modular GitHub Actions and Reusable Workflows for Vite+ applications.

| Layer                  | Path                              | Responsibility                                                                                   |
| :--------------------- | :-------------------------------- | :----------------------------------------------------------------------------------------------- |
| **Composite Actions**  | `actions/setup-vp-env/`           | Installs Node.js with Vite+, installs dependencies, and manages the Vite Task Cache              |
| **Composite Actions**  | `actions/setup-playwright/`       | Installs Playwright Chromium binaries and Linux OS dependencies                                  |
| **Reusable Workflows** | `.github/workflows/vp-web-ci.yml` | Standard three-tier verification gate with cross-platform matrix support (`platform-compat`)     |
| **Automation Scripts** | `scripts/`                        | Release calculation (`release.ts`) and action metadata integrity validation (`test-metadata.ts`) |
| **Modular Rules**      | `.agents/rules/`                  | Domain-specific rules for Git delivery and Action maintenance triggered via file globbing        |

---

## 2. Git Delivery Protocol & AI Rejection Invariant

- **AI Direct Commits Globally Prohibited**:
  - The local environment enforces SSH commit signing (e.g. 1Password) and Git pre-commit verification that rejects direct commits by AI agents.
  - Agents must NEVER execute `git commit` or `git push`.
  - Mandatory delivery workflow:
    1. Apply code changes and verify TypeScript types, linting, and action metadata: `vpr agent:verify:gate`.
    2. Format modified files: `vpr format`.
    3. Stage changes using defensive explicit paths: `git add <files>`.
    4. Output the exact `git commit -m "type(scope): concise imperative description"` command in English following Conventional Commits for manual execution by the user.

---

## 3. Agent Verification Commands

Agents modifying workflows or scripts must execute the following commands prior to staging changes:

```bash
# Tier 1: Inner-loop verification (TypeScript typecheck + vp lint + actionlint + format check)
vpr agent:verify:inner

# Tier 2: Full verification gate (inner verification + metadata test)
vpr agent:verify:gate

# Individual verification tools
vpr typecheck          # TypeScript compiler diagnostics (tsc -b --pretty false)
vp lint                # Oxlint type-aware linting
vpr lint:ci            # GitHub Actions syntax validation (actionlint)
vpr format             # Format all documents, workflows, and TypeScript files

# Test release calculation in simulation mode
vpx ./scripts/release.ts --dry-run --bump=auto
```

---

## 4. Release Pipeline & Invariants

This repository operates on a single source of truth (SSOT) automated release model executed exclusively on GitHub Actions:

1. **Conventional Commits Release Trigger**:
   - Commits containing `BREAKING CHANGE:` or `feat!:` / `fix!:` trigger a major version bump (`v3.0.0`, updating `v3`).
   - Commits prefixed with `feat:` trigger a minor version bump (e.g. `v2.1.0`, updating `v2`).
   - Commits prefixed with `fix:` or `perf:` trigger a patch version bump (e.g. `v2.0.1`, updating `v2`).
   - Commits prefixed with `chore:`, `docs:`, `ci:`, or `test:` do not trigger a release.
2. **Local Tagging Prohibition & CI SSOT**:
   - Creating or pushing version tags manually from local environments is strictly prohibited. Version calculation, git tagging, and GitHub Releases are executed exclusively by `.github/workflows/release.yml`, triggered automatically via `workflow_run` only after the `CI` workflow (`.github/workflows/test-actions.yml`) succeeds on `main`.
   - Local environments synchronize tags using `git fetch origin --tags --force` (required because the floating major tag `v2` is force-updated on each release). Workspace `.vscode/settings.json` enables `git.replaceTagsWhenPull` and disables `git.followTagsWhenSync` so editor Sync/Pull replaces conflicting floating tags without prompts.
3. **Major Floating Tag Invariant**:
   - Consumer applications pin to the major floating tag (e.g. `uses: Florencea/vp-actions/actions/setup-vp-env@v2`).
   - The release script automatically advances the major floating tag (`v2`) to point to the latest semantic release tag.
4. **Runner Version Pinning & Platform Compatibility**:
   - Workflows must strictly use pinned runner versions: `gatekeeper` uses `ubuntu-24.04`, and `platform-compat` uses `windows-2025` and `macos-26`. Floating `*-latest` runner labels are strictly prohibited across all workflows.
   - `platform-compat` (`windows-2025`, `macos-26`) must initialize Playwright via `actions/setup-playwright` whenever browser or unit tests require browser binaries.
5. **Node.js Engine Exact Invariant**:
   - `package.json` pins `engines.node` to exact `"26.13.0"` matching all `vp-*` ecosystem projects.

---

## 5. Modular Domain Rules (`.agents/rules/`)

- **Git Delivery**: [`.agents/rules/git-delivery.md`](./.agents/rules/git-delivery.md) (Standard git delivery and conventional commit format)
- **Actions & Workflows**: [`.agents/rules/actions.md`](./.agents/rules/actions.md) (Triggers on `actions/**`, `.github/workflows/**`)
