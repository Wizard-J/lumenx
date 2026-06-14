---
description: LumenX 个人 fork 发布流程 - 安全提交、敏感数据扫描、推送到个人 GitHub 仓库
---

# LumenX 个人 Fork 发布流程

此 workflow 整合了从本地开发到个人 GitHub fork 的发布流程，包含安全检查和规范约束。

## 核心规则

- **允许直接推送 `main` 分支** — 本仓库是个人 fork，用户要求发布/同步时可直接推送 main
- **推送前必须执行敏感数据扫描**
- **Commit Message 遵循 Conventional Commits** (`feat:` / `fix:` / `docs:` / `refactor:` / `chore:`)
- **GitHub remote 优先使用 `github`**，仓库地址：`git@github.com:Wizard-J/lumenx.git`
- **提交作者使用** `Wizard-J <79328210@qq.com>`
- **PR 是可选流程**；除非用户明确要求，否则不要创建 PR

## 阶段一：提交前检查

### 1. 确认分支

```bash
git branch --show-current
```

如果用户要求发布到主分支，确保当前工作位于 `main`。如果用户明确要求实验分支或 PR，再使用 `feature/*`、`fix/*`、`docs/*` 分支。

```bash
git checkout main
```

### 2. 敏感数据扫描

逐项执行，**任何一项命中都必须修复后才能继续**：

**搜索硬编码密钥（40+ 字符字符串）:**
```bash
git grep -E "['\"][a-zA-Z0-9_-]{40,}['\"]" -- ':(exclude)*.lock' ':(exclude)node_modules'
```

**搜索内部域名:**
```bash
git grep -i "alibaba-inc.com"
```

**搜索 API Key 模式:**
```bash
git grep -iE "(sk-|AKID|access_key|password|pwd|token|bearer)" -- ':(exclude)*.lock' ':(exclude)*.example' ':(exclude)node_modules'
```

**检查敏感文件是否被追踪:**
```bash
git ls-files | grep -E "\.env$|secret|credential|\.key$|\.pem$" | grep -v "\.example"
```

### 3. 检查 .gitignore 完整性

```bash
grep -E "^\.env|^\.agent|^CLAUDE\.md|^output/" .gitignore
```

确保至少包含：`.env`、`.agent/`、`CLAUDE.md`、`output/`

## 阶段二：代码质量（可选但推荐）

**Python 代码格式化:**
```bash
black --check src/
flake8 src/
```

**前端 Lint:**
```bash
cd frontend && npm run lint
```

## 阶段三：提交与推送

### 1. 暂存文件

```bash
git add <specific-files>
```

**不要使用 `git add .`**，逐一确认文件。

### 2. 提交

```bash
git commit -m "feat: your descriptive commit message"
```

提交前确认作者身份符合项目约定：

```bash
git log -1 --format='%an <%ae>'
```

期望作者：

- `Wizard-J <79328210@qq.com>`

Commit 类型：
- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `style:` 代码格式（不影响逻辑）
- `refactor:` 重构
- `test:` 测试
- `chore:` 构建/工具/依赖

### 3. 推送到 GitHub

```bash
git push github main
```

如果用户明确要求推送非主分支：

```
git push -u github <branch-name>
```

## 阶段四：推送后验证

- 访问 https://github.com/Wizard-J/lumenx 确认内容正确
- 检查 README 格式渲染
- 确认无敏感信息泄露

## 紧急情况：撤销敏感信息

**未 push:**
```bash
git reset --soft HEAD~1
```

**已 push:**
需要使用 BFG Repo-Cleaner 清理历史并 force push。联系团队协助。
