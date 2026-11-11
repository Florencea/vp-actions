# Agent Operations & Maintenance Guide

## Architecture Overview

`vp-actions` provides shared, modular GitHub Actions and Reusable Workflows for Vite+ applications.

1. **Tier 1: Composite Actions (Infrastructure)**
   - `actions/setup-vp-env`: Installs Node.js with Vite+, installs dependencies, and manages the Vite Task Cache.
   - `actions/setup-playwright`: Restores Playwright browser binaries from cache, installs missing binaries, and configures OS dependencies.
2. **Tier 2: Reusable Workflows (Standards Gate)**
   - `.github/workflows/vp-web-ci.yml`: Standard three-tier verification gate (`agent:verify:inner` -> `agent:test:unit` -> `vp build` -> `agent:test:e2e`) with cross-platform matrix support (`platform-compat`).

---

## Agent Verification Commands

Agents modifying workflows or scripts must execute the following commands prior to committing:

```bash
# Tier 1: Inner-loop verification (workflow syntax & formatting check)
vpr agent:verify:inner

# Tier 2: Full verification gate (actionlint + metadata validation)
vpr agent:verify:gate

# Format all documents, workflows, and TypeScript scripts
vpr format

# Test release calculation in simulation mode
vpx ./scripts/release.ts --dry-run --bump=auto
```

---

## Release Pipeline & Invariants

This repository operates on a direct, automated release model without GitHub Release PRs:

1. **Conventional Commits Release Trigger**:
   - Commits containing `BREAKING CHANGE:` or `feat!:` / `fix!:` trigger a major version bump (`v2.0.0`, updating `v2`).
   - Commits prefixed with `feat:` trigger a minor version bump (`v1.1.0`, updating `v1`).
   - Commits prefixed with `fix:` or `perf:` trigger a patch version bump (`v1.0.1`, updating `v1`).
   - Commits prefixed with `chore:`, `docs:`, `ci:`, or `test:` do not trigger a release.
2. **Major Floating Tag Invariant**:
   - Consumer applications pin to the major floating tag (e.g. `uses: Florencea/vp-actions/actions/setup-vp-env@v1`).
   - The release script automatically advances the major floating tag (`v1`) to point to the latest semantic release tag.
3. **Platform Compatibility Invariant**:
   - `platform-compat` (`windows-latest`, `macos-latest`) must initialize Playwright via `actions/setup-playwright` whenever browser or unit tests require browser binaries.
   - In `actions/setup-playwright`, version outputs must strip `\r` for Windows runner safety.
