---
type: AFK
estimate: 0.75d
effort: small
status: in_review
blocked_by: []
needs_llm: false
needs_vision: false
needs_pdf: false
needs_docker: false
test_files:
  - packages/web/src/stores/__tests__/lobby-store.test.ts
---

# #001 — CSS 基础 + i18n + lobby-store 扩展

## Parent

`docs/mobile-adaptation-phase-1-prd.md`

## 背景

Phase 1 所有组件依赖 CSS 基础设施、i18n 翻译 key、lobby-store 移动端状态字段。本 issue 是 #002-#004 的 blocker。

## What to build

**1. CSS 基础设施** — `packages/web/src/index.css`，用 `/* Mobile adaptation: begin/end */` 包裹：
- `.pb-safe` — safe-area-inset-bottom
- `.h-dvh-fallback` — 100vh/100dvh 双值回退
- `.tap-target` — min 44px (WCAG 2.5.5)
- `:root { --mobile-nav-height: 56px }`
- `.drawer-backdrop/.drawer-panel` — 过渡动画
- `@media (prefers-reduced-motion: reduce)` — 禁用过渡

**2. i18n keys** — 3 个 flat key：`nav.sessions/agents/channels`（en + zh-CN + types.ts）

**3. lobby-store 扩展** — 5 个 boolean 字段 + setters：drawerOpen, showAgentsPanel, showChannelPanel, showSettingsDialog, showUpdateDialog。默认 false。遵循 Zustand immer 模式。

## Acceptance Criteria

- [ ] AC1: index.css 含 mobile adaptation 注释块，内含全部 6 项 CSS 规则
- [ ] AC2: 3 个 i18n key 三文件齐全，pnpm build 无类型错误
- [ ] AC3: lobby-store 5 字段默认 false，setter 正确切换
- [ ] AC4: store 写入不影响现有字段
- [ ] AC5: pnpm build 成功

## 前置准备

- [x] pnpm install
- [ ] 确认 tailwindcss >=3.4（内置 h-dvh）

## 代码目录

- 实现: packages/web/src/index.css, packages/web/src/i18n/en.ts|zh-CN.ts|types.ts, packages/web/src/stores/lobby-store.ts
- 测试: packages/web/src/stores/__tests__/lobby-store.test.ts

## Scope

**In:** index.css mobile block, 3 i18n 文件各 3 行, lobby-store 5 字段+setters
**Out:** 组件文件, Phase 2/3 CSS

## 架构约束

| # | 约束 |
|---|------|
| R1 | 不修改 core/server/cli |
| R2 | 零新依赖 |
| R4 | CSS 注释块包裹 |
| R6 | 不用 useMediaQuery hook — CSS 断点驱动布局 |

## 测试策略

- 单元测试: lobby-store 字段默认值+setter+非侵入
- 手动: pnpm build + 浏览器确认 CSS 变量

## 风险

- CSS 变量冲突低 — `--mobile-*` 前缀
- Store 扩展低 — 默认 false 向后兼容
- 回退: git revert

## 依赖表格

| 工具 | 版本 | 参考 |
|------|------|------|
| Tailwind | >=3.4 | h-dvh built-in |
| Zustand | 5.x | immer pattern |

## Issue 质量自检

- [x] 1. ≤1d (0.75d)
- [x] 2. AFK
- [x] 3. AC 可量化
- [x] 4. 目录已指定
- [x] 5. 前置准备完整
- [x] 6. 测试策略明确
- [x] 7. SDK 参考
- [x] 8. 无主观验收
- [x] 9. blocked_by 已设
- [x] 10. 架构约束已引用
- [x] 11. 集成覆盖(build)
- [x] 12. Scope 边界清晰
- [x] 13. needs_* 已声明
- [x] 14. test_files 已指定
