# Git Delivery Protocol & Conventional Commit Standards

## 1. Non-Interactive Commit Prohibition

- AI agents must NEVER execute `git commit` or `git push` directly in this repository.
- The environment requires interactive SSH key signing (1Password SSH agent). Non-interactive subshell commits fail or hang.

---

## 2. Mandatory Delivery Pipeline

Whenever modifications or new files are introduced, the agent must strictly execute the following steps:

1. **Verification**: Run `vpr agent:verify:gate` to verify TypeScript types, Oxlint rules, actionlint, and metadata tests.
2. **Formatting**: Run `vpr format` to format modified files using `oxfmt`.
3. **Staging**: Execute explicit file staging: `git add <file1> <file2> ...`. Never use unvetted `git add .` or wildcards that could capture untracked temporary files.
4. **Command Output**: Provide the exact `git commit -m "type(scope): concise imperative description"` command formatted according to Conventional Commits for the user to execute manually in their terminal.

---

## 3. Conventional Commits Rules & Automated Release Impact

Commits to `main` trigger automated releases via `scripts/release.ts`:

- `feat:` or `feat(scope):`: Triggers minor release bump (`v1.x.0`).
- `fix:` or `perf:`: Triggers patch release bump (`v1.0.x`).
- `feat!:` or `BREAKING CHANGE:`: Triggers major release bump (`v2.0.0`).
- `chore:`, `docs:`, `ci:`, `test:`, `refactor:`: Do NOT trigger a release bump.
