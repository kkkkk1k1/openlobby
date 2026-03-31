---
name: release
description: 发布新版本。升级版本号、生成 CHANGELOG、构建、测试、tag、push、创建 GitHub Release，输出发布通知文本。
---

# Release 发布技能

执行完整的版本发布流程。

## 触发

`/release <version>` 或 `/release patch|minor|major`

- `patch` / `minor` / `major` — 从当前版本自动 bump
- `0.3.0` — 直接指定版本号

## 完整流程

严格按顺序执行以下步骤。每一步失败则停止并报告。

### 1. 确定新版本号

- 读取 `packages/cli/package.json` 获取当前版本
- 如果参数是 `patch`/`minor`/`major`，自动计算新版本号
- 如果参数是具体版本号（如 `0.3.0`），直接使用
- 向用户确认：`即将发布 v<version>，确认？`
- 用户确认后继续

### 2. 更新版本号

更新以下文件中的 `version` 字段：

- `packages/cli/package.json`
- `packages/core/package.json`
- `packages/server/package.json`
- `packages/web/package.json`

注意：`packages/channel-telegram/package.json` 有独立版本号，**不更新**。

同时更新 `packages/cli/src/bin.ts` 中硬编码的版本号（搜索 `console.log('x.x.x')` 行）。

### 3. 生成 CHANGELOG 条目

- 运行 `git log --oneline v<previous-version>..HEAD` 获取自上次 tag 以来的所有 commit
  - 如果没有上一个 tag，使用 `git log --oneline` 获取所有 commit
- 按 commit message 前缀分类：
  - `feat` → **Features**
  - `fix` → **Bug Fixes**
  - `docs` → **Documentation**
  - `chore` / `refactor` / 其他 → **Other Changes**
- 生成格式化的 CHANGELOG 条目，追加到 `CHANGELOG.md` 顶部（如果文件不存在则创建）

格式：
```markdown
# Changelog

## v0.3.0 (2026-03-29)

### Features
- Add QuestionCard for AskUserQuestion tool (#commit-short)
- Make MCP API port configurable (#commit-short)

### Bug Fixes
- ...

### Documentation
- ...

### Other Changes
- ...
```

### 4. 构建

```bash
pnpm -r build
```

构建失败则停止发布。

### 5. 测试

```bash
pnpm test
```

测试失败则停止发布（如果没有测试脚本则跳过）。

### 6. 提交

```bash
git add -A
git commit -m "release: v<version>"
```

### 7. 创建 Tag

```bash
git tag v<version>
```

### 8. 推送

```bash
git push --follow-tags
```

这会触发 CI 执行 npm publish。

### 9. 创建 GitHub Release

使用 `gh` CLI 创建 GitHub Release：

```bash
gh release create v<version> --title "v<version>" --notes "<CHANGELOG 条目内容>"
```

### 10. 输出发布通知

生成一段适合转发到 IM 群组的发布通知文本，直接输出给用户：

```
🚀 OpenLobby v<version> 已发布

<本次更新要点，2-5 条，从 CHANGELOG 中提炼>

📦 安装/更新: npx openlobby@latest
🔗 Release: <GitHub Release URL>
```

## 注意事项

- 发布前确保工作区干净（无未提交的更改）
- 如果工作区有未提交的更改，先提示用户处理
- `channel-telegram` 包有独立版本周期，不跟随主版本
- npm publish 由 CI Action 自动完成，技能不执行 publish
