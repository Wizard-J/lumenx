---
name: lumenx-git-publish
description: LumenX personal-fork publish workflow for safe commits, sensitive-data scans, and direct pushes to the user's GitHub fork.
---

# LumenX Personal Fork Publish Workflow

Use this workflow when working in this personal fork and the user asks to publish, sync, or push work to GitHub.

## Core Rules

- Direct pushes to `main` are allowed in this personal fork when the user asks to publish or sync work.
- Push to the personal GitHub fork. Prefer the `github` remote when present; `origin` may also point to the same fork.
- Run sensitive-data checks before any push.
- Commit messages must follow Conventional Commits.
- Use `Wizard-J <79328210@qq.com>` as the git commit author for this fork.
- Pull requests are optional. Do not create a PR unless the user explicitly asks for one.

Repository-specific constraints:

- GitHub remote: `github`
- GitHub repository: `git@github.com:Wizard-J/lumenx.git`
- Default branch: `main`

## Step 1: Confirm Branch

Check the current branch:

```bash
git branch --show-current
```

If the branch is not `main` and the user asked to publish to `main`, merge or fast-forward the intended commits onto `main` before pushing. If the user asks for an experiment branch or PR, use a descriptive `feature/`, `fix/`, or `docs/` branch.

```bash
git checkout main
```

## Step 2: Sensitive-Data Checks

Run all of the following checks. Any hit must be reviewed and resolved before continuing.

Search for suspicious hardcoded secrets:

```bash
git grep -E "['\"][a-zA-Z0-9_-]{40,}['\"]" -- ':(exclude)*.lock' ':(exclude)node_modules'
```

Search for internal company domains:

```bash
git grep -i "alibaba-inc.com"
```

Search for credential-like patterns:

```bash
git grep -iE "(sk-|AKID|access_key|password|pwd|token|bearer)" -- ':(exclude)*.lock' ':(exclude)*.example' ':(exclude)node_modules'
```

Search tracked sensitive files:

```bash
git ls-files | grep -E "\.env$|secret|credential|\.key$|\.pem$" | grep -v "\.example"
```

## Step 3: Check .gitignore Coverage

Verify that `.gitignore` contains the expected sensitive and local paths:

```bash
grep -E "^\.env|^\.agent|^CLAUDE\.md|^output/" .gitignore
```

Expected coverage includes:

- `.env`
- `.agent/`
- `CLAUDE.md`
- `output/`

## Step 4: Optional Quality Checks

Run relevant checks when the changed files warrant them.

Backend formatting and lint:

```bash
black --check src/
flake8 src/
```

Frontend lint:

```bash
cd frontend && npm run lint
```

## Step 5: Stage Carefully

Stage only the intended files. Do not use `git add .`.

```bash
git add <specific-files>
```

## Step 6: Commit

Create an English Conventional Commit message:

```bash
git commit -m "feat: your descriptive commit message"
```

Before committing, confirm the author identity matches the project convention:

```bash
git log -1 --format='%an <%ae>'
```

Expected author for this fork:

- `Wizard-J <79328210@qq.com>`

Common prefixes:

- `feat:`
- `fix:`
- `docs:`
- `style:`
- `refactor:`
- `test:`
- `chore:`

## Step 7: Push to GitHub

Push `main` to the personal GitHub fork when the user asks to publish/sync:

```bash
git push github main
```

If working on a non-main branch by explicit request:

```
git push -u github <branch-name>
```

## Step 8: Post-Push Verification

- Confirm the pushed branch is visible on GitHub.
- Check README rendering if docs changed.
- Confirm no sensitive information leaked in the diff.

## Emergency Rollback

If the commit has not been pushed yet:

```bash
git reset --soft HEAD~1
```

If sensitive data was already pushed, stop and escalate to the team for history cleanup.
