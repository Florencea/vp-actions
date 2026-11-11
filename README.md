# vp-actions

Shared, modular GitHub Actions and Reusable Workflows tailored for Vite+ (`vp`) web applications and tools adhering to the `node-project-architecture` standards.

## Architecture

This repository provides a two-tier CI architecture:

1. **Tier 1: Composite Actions (Infrastructure)**
   - `actions/setup-vp-env`: Installs Node.js with Vite+, installs dependencies, and manages the Vite Task Cache (`node_modules/.vite/task-cache`).
   - `actions/setup-playwright`: Restores Playwright browser binaries from cache, installs missing browsers (`chromium`), and installs system dependencies on Linux.
2. **Tier 2: Reusable Workflows (Standards Gate)**
   - `.github/workflows/vp-web-ci.yml`: Standard three-tier verification gate (`agent:verify:inner` -> `agent:test:unit` -> `vp build` -> `agent:test:e2e`), with support for pre-test hooks and cross-platform matrix testing.

---

## Usage

### 1. Standard Web & Fullstack Applications (Reusable Workflow)

For web applications following standard `package.json` scripts (`agent:verify:inner`, `check:deadcode`, `agent:test:unit`, `vp build`, `agent:test:e2e`):

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}

permissions:
  contents: read

jobs:
  ci:
    name: Gatekeeper
    uses: Florencea/vp-actions/.github/workflows/vp-web-ci.yml@v1
    with:
      # Optional: Command executed before test phases (e.g. database seed)
      pre-test-command: vp run db:seed
      # Optional: Custom build command (default: vp build)
      build-command: vp build
      # Optional: Toggle E2E browser tests (default: true)
      enable-e2e: true
      # Optional: Toggle platform compatibility testing on Windows and macOS (default: false)
      enable-platform-compat: true
```

#### Reusable Workflow Inputs

| Input                    | Type      | Default      | Description                                                                |
| :----------------------- | :-------- | :----------- | :------------------------------------------------------------------------- |
| `pre-test-command`       | `string`  | `""`         | Hook executed immediately before linting and testing (e.g. database setup) |
| `build-command`          | `string`  | `"vp build"` | Production build command                                                   |
| `enable-e2e`             | `boolean` | `true`       | Whether to run Playwright E2E browser tests                                |
| `enable-platform-compat` | `boolean` | `false`      | Runs a secondary matrix job on `windows-2025` and `macos-26`               |

---

### 2. Specialized Workflows (Composite Actions)

For applications requiring customized runner environments, virtual framebuffers (e.g. `xvfb-run`), or platform packaging (e.g. Electron):

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  gatekeeper:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7

      - name: Setup Vite+ Environment
        uses: Florencea/vp-actions/actions/setup-vp-env@v1
        with:
          checkout: "false"

      - name: Setup Playwright Browsers
        uses: Florencea/vp-actions/actions/setup-playwright@v1

      - name: Verification
        run: vp run agent:verify:inner

      - name: Dead Code Check
        run: vp run check:deadcode

      - name: Unit Tests
        run: vp run agent:test:unit

      - name: Specialized Build
        run: vp run build:all

      - name: Headless GUI Tests
        run: xvfb-run --auto-servernum vp run agent:test:e2e
```

#### `actions/setup-vp-env` Inputs

| Input               | Type     | Default          | Description                            |
| :------------------ | :------- | :--------------- | :------------------------------------- |
| `checkout`          | `string` | `"true"`         | Runs `actions/checkout@v7` if true     |
| `node-version-file` | `string` | `"package.json"` | Path to file containing engine version |
| `install-command`   | `string` | `"vp install"`   | Package installation command           |

#### `actions/setup-playwright` Inputs

| Input           | Type     | Default               | Description                                          |
| :-------------- | :------- | :-------------------- | :--------------------------------------------------- |
| `browser`       | `string` | `"chromium"`          | Browser family to install system dependencies for    |
| `install-deps`  | `string` | `"true"`              | Whether to install Linux system dependencies via apt |
| `setup-command` | `string` | `"vp run test:setup"` | Script executed when browser binary cache misses     |

---

## Versioning & Release Strategy

Workflows and actions adhere to Semantic Versioning with automated pipeline execution:

- **Major Floating Tags (`@v1`)**: Consumer workflows pin to `@v1` to automatically receive non-breaking improvements, runtime patches, and security updates.
- **Specific Release Tags (`@v1.2.0`)**: Used for strict pinning when determinism across minor modifications is desired.

### Automated Release Pipeline

The repository operates on a single source of truth (SSOT) automated release workflow (`.github/workflows/release.yml`) executed exclusively on GitHub Actions:

1. **CI-Gated Continuous Release on `main`**:
   - Pushes to the `main` branch first execute the `CI` workflow (`.github/workflows/test-actions.yml`).
   - Only when `CI` completes with `success` does `.github/workflows/release.yml` trigger via `workflow_run` to evaluate Conventional Commits since the latest release tag.
   - `fix:` / `perf:` triggers a patch release (`v1.2.1`).
   - `feat:` triggers a minor release (`v1.3.0`).
   - `BREAKING CHANGE:` or `feat!:` triggers a major release (`v2.0.0`).
   - The release job automatically updates the corresponding major floating tag (`v1`) to point to the newly published commit.
2. **Manual Tagging Prohibition & Local Sync**:
   - Creating or pushing version tags manually from local workstations is strictly prohibited to prevent version skew.
   - Run `git fetch origin --tags` locally to synchronize newly published tags.
3. **Manual Workflow Dispatch**:
   - Trigger the `Release` workflow from the GitHub Actions tab or CLI.
   - Choose `bump`: `auto`, `patch`, `minor`, or `major`.
   - Enable `dry_run: true` to simulate release calculation without modifying git tags.
4. **Local Dry-Run Simulation**:

```bash
# Dry-run release evaluation in local simulation mode
vpx ./scripts/release.ts --dry-run --bump=auto
```
