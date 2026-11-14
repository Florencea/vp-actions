# vp-actions

Shared, modular GitHub Actions and Reusable Workflows tailored for Vite+ (`vp`) web applications and tools adhering to the `node-project-architecture` standards.

## Architecture

This repository provides a two-tier CI architecture:

1. **Tier 1: Composite Actions (Infrastructure)**
   - `actions/setup-vp-env`: Installs Node.js with Vite+, installs dependencies, and manages the Vite Task Cache (`node_modules/.vite/task-cache`).
   - `actions/setup-playwright`: Installs Playwright Chromium and Linux system dependencies.
2. **Tier 2: Reusable Workflows (Standards Gate)**
   - `.github/workflows/vp-web-ci.yml`: Standard three-tier verification gate (`agent:verify:inner` -> `agent:test:unit` -> `vp build` -> `agent:test:e2e`) on `ubuntu-24.04`.
   - `.github/workflows/vp-electron-ci.yml`: Standard Electron verification gate (`ubuntu-24.04`) and OS-specific packaging matrix (`macos-26`, `windows-2025`).

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
    uses: Florencea/vp-actions/.github/workflows/vp-web-ci.yml@v3.0.0
    with:
      # Optional: Command executed before test phases (e.g. database seed)
      pre-test-command: vp run db:seed
      # Optional: Custom build command (default: vp build)
      build-command: vp build
      # Optional: Toggle E2E browser tests (default: true)
      enable-e2e: true
```

#### `vp-web-ci.yml` Inputs

| Input              | Type      | Default      | Description                                                                |
| :----------------- | :-------- | :----------- | :------------------------------------------------------------------------- |
| `pre-test-command` | `string`  | `""`         | Hook executed immediately before linting and testing (e.g. database setup) |
| `build-command`    | `string`  | `"vp build"` | Production build command                                                   |
| `enable-e2e`       | `boolean` | `true`       | Whether to run Playwright E2E browser tests                                |

---

### 2. Electron Applications (Reusable Workflow)

For Electron applications requiring Linux E2E smoke testing (`xvfb-run`) and OS-specific packaging verification across Linux (`ubuntu-24.04`), macOS (`macos-26`), and Windows (`windows-2025`), following standard `package.json` scripts (`agent:verify:inner`, `check:deadcode`, `agent:test:unit`, `build:all`, `app:pack`, `agent:test:e2e`, `app:linux`, `app:mac`, `app:win`):

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
    name: Gatekeeper & Package
    uses: Florencea/vp-actions/.github/workflows/vp-electron-ci.yml@v3.0.0
```

#### `vp-electron-ci.yml` Inputs

| Input               | Type      | Default              | Description                                                               |
| :------------------ | :-------- | :------------------- | :------------------------------------------------------------------------ |
| `pre-test-command`  | `string`  | `""`                 | Hook executed immediately before linting and testing                      |
| `build-command`     | `string`  | `"vp run build:all"` | Production build command for Electron main, preload, and renderer         |
| `enable-playwright` | `boolean` | `true`               | Whether to install Playwright Chromium browsers                           |
| `enable-e2e`        | `boolean` | `true`               | Whether to pack unpacked app and run `xvfb-run` E2E smoke tests           |
| `enable-package`    | `boolean` | `true`               | Whether to test OS-specific packaging (`app:linux`, `app:mac`, `app:win`) |

---

### 3. Specialized Workflows (Composite Actions)

For Electron applications requiring Linux E2E smoke testing (`xvfb-run`) and OS-specific packaging verification across Linux (`ubuntu-24.04`), macOS (`macos-26`), and Windows (`windows-2025`), following standard `package.json` scripts (`agent:verify:inner`, `check:deadcode`, `agent:test:unit`, `build:all`, `app:pack`, `agent:test:e2e`, `app:linux`, `app:mac`, `app:win`):

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
    name: Gatekeeper & Package
    uses: Florencea/vp-actions/.github/workflows/vp-electron-ci.yml@v3.0.0
```

#### `vp-electron-ci.yml` Inputs

| Input               | Type      | Default              | Description                                                               |
| :------------------ | :-------- | :------------------- | :------------------------------------------------------------------------ |
| `pre-test-command`  | `string`  | `""`                 | Hook executed immediately before linting and testing                      |
| `build-command`     | `string`  | `"vp run build:all"` | Production build command for Electron main, preload, and renderer         |
| `enable-playwright` | `boolean` | `true`               | Whether to install Playwright Chromium browsers                           |
| `enable-e2e`        | `boolean` | `true`               | Whether to pack unpacked app and run `xvfb-run` E2E smoke tests           |
| `enable-package`    | `boolean` | `true`               | Whether to test OS-specific packaging (`app:linux`, `app:mac`, `app:win`) |

---

### 3. Specialized Workflows (Composite Actions)

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
        uses: Florencea/vp-actions/actions/setup-vp-env@v2
        with:
          checkout: "false"

      - name: Setup Playwright Browsers
        uses: Florencea/vp-actions/actions/setup-playwright@v2

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

#### `actions/setup-playwright` Behavior

Takes no inputs. Installs Playwright Chromium directly (`vp exec playwright install --with-deps chromium` on Linux; `vp exec playwright install chromium` on macOS and Windows) without browser caching.

---

## Versioning & Release Strategy

Workflows and actions adhere to Semantic Versioning with automated pipeline execution:

- **Major Floating Tags (`@v2`)**: Consumer workflows pin to `@v2` to automatically receive non-breaking improvements, runtime patches, and security updates. Existing consumers pinned to `@v1` remain unaffected until upgrading to `@v2`.
- **Specific Release Tags (`@v2.0.0`)**: Used for strict pinning when determinism across minor modifications is desired.

### Automated Release Pipeline

The repository operates on a single source of truth (SSOT) automated release workflow (`.github/workflows/release.yml`) executed exclusively on GitHub Actions:

1. **CI-Gated Continuous Release on `main`**:
   - Pushes to the `main` branch first execute the `CI` workflow (`.github/workflows/test-actions.yml`).
   - Only when `CI` completes with `success` does `.github/workflows/release.yml` trigger via `workflow_run` to evaluate Conventional Commits since the latest release tag.
   - `fix:` / `perf:` triggers a patch release (`v2.0.1`).
   - `feat:` triggers a minor release (`v2.1.0`).
   - `BREAKING CHANGE:` or `feat!:` triggers a major release (`v3.0.0`).
   - The release job automatically updates the corresponding major floating tag (`v2`) to point to the newly published commit.
2. **Manual Tagging Prohibition & Local Sync**:
   - Creating or pushing version tags manually from local workstations is strictly prohibited to prevent version skew.
   - Run `git fetch origin --tags --force` locally to synchronize newly published and force-updated floating tags (`v2`). Workspace `.vscode/settings.json` configures `git.replaceTagsWhenPull` so editor Source Control Sync/Pull updates floating tags without conflict prompts.
3. **Manual Workflow Dispatch**:
   - Trigger the `Release` workflow from the GitHub Actions tab or CLI.
   - Choose `bump`: `auto`, `patch`, `minor`, or `major`.
   - Enable `dry_run: true` to simulate release calculation without modifying git tags.
4. **Local Dry-Run Simulation**:

```bash
# Dry-run release evaluation in local simulation mode
vpx ./scripts/release.ts --dry-run --bump=auto
```
