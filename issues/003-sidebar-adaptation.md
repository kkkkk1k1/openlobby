---
type: AFK
estimate: 0.5d
effort: small
status: in_review
pr: ["https://github.com/kkkkk1k1/openlobby/pull/17"]
blocked_by: ["001"]
needs_llm: false
needs_vision: false
needs_pdf: false
needs_docker: false
test_files:
  - packages/web/src/components/__tests__/Sidebar.test.tsx
---

# #003 — Sidebar 适配（响应式 + dialog state 迁移）

## Parent

`docs/mobile-adaptation-phase-1-prd.md` — PRD: Mobile Adaptation Phase 1

## 背景

当前 Sidebar 硬编码 `w-72`（280px），对话框状态（showAgentsPanel、showChannelPanel、showSettingsDialog、showUpdateDialog）使用本地 `useState`。移动端需要响应式宽度 + 两个入口（Sidebar toolbar + MobileNav）共享对话框状态，因此 state 必须提升到 Zustand store（已在 #001 完成）。

## What to build

修改 `packages/web/src/components/Sidebar.tsx`，6 项改动：

**1. 响应式宽度**
- `w-72` → `w-full md:w-72`（移动端全宽 drawer，桌面端固定 280px）

**2. onSessionSelect prop**
- 新增可选 prop: `onSessionSelect?: (sessionId: string) => void`
- 点击 session card 选择 session 后回调 — 移动端 drawer 借此关闭

**3. 对话框 state → store**
- 删除 4 个本地 `useState`：
  - `showAgentsPanel` → `useLobbyStore(s => s.showAgentsPanel)`
  - `showChannelPanel` → `useLobbyStore(s => s.showChannelPanel)`
  - `showSettingsDialog` → `useLobbyStore(s => s.showSettingsDialog)`
  - `showUpdateDialog` → `useLobbyStore(s => s.showUpdateDialog)`
- 删除 setter 本地调用，改用 store setter
- 对话框 JSX 元素从 Sidebar 移到 App.tsx（将由 #004 实现）

**4. SessionCard CSS group-hover**
- 删除 JS `isHovered` state + `onMouseEnter`/`onMouseLeave` handler
- 卡片添加 `className="group"`
- 操作按钮: `md:invisible md:w-0 md:group-hover:visible md:group-hover:w-auto overflow-hidden`
- 已 pin 项: pin icon 始终 `opacity-100`（不受 group-hover 影响）

**5. showUpdateDialog → store**
- `showUpdateDialog` 已包含在 #3 的 state 迁移中
- UpdateDialog JSX 也需移到 App.tsx（#004 负责）

**6. showDiscoverDialog → App.tsx 预准备**
- `showDiscoverDialog` 已在 store，JSX 目前仍在 Sidebar
- 本 issue 中保持 JSX 位置不变（#004 统一移动）
- 仅确保 store 字段正常读写

## Acceptance Criteria

- [ ] AC1: 桌面端（>=768px）Sidebar 宽度 280px，所有功能不变
- [ ] AC2: 移动端（<768px）Sidebar 宽度 `w-full`（占满 drawer panel）
- [ ] AC3: 传入 `onSessionSelect` prop → 点击 session card 时回调被触发
- [ ] AC4: 4 个对话框状态从 store 读写，Sidebar 内无本地 useState
- [ ] AC5: SessionCard pin/rename 按钮：桌面端默认隐藏、hover 显示；已 pin 项 pin icon 始终可见
- [ ] AC6: 移动端 SessionCard 的 pin/rename 按钮始终可见（无 hover 依赖）
- [ ] AC7: 现有桌面功能零回归（session 创建/选择/删除、LM、发现导入、主题/语言切换）
- [ ] AC8: `pnpm build` 成功，`pnpm test` 全部通过

## 前置准备

- [x] #001 完成 — store 字段已就位，CSS 类可用

## 代码目录

- 实现: `packages/web/src/components/Sidebar.tsx`（修改）
- 测试: `packages/web/src/components/__tests__/Sidebar.test.tsx`（新建/追加）

## Scope

**In:**
- Sidebar.tsx 的响应式宽度
- onSessionSelect prop 新增
- 4 个对话框 state 迁移至 store
- SessionCard group-hover 替换 JS hover
- 已 pin 项的指示器始终可见

**Out:**
- 对话框 JSX 移动至 App.tsx（#004）
- Sidebar 以外的任何组件
- SessionCard long-press 菜单（Phase 3）

## 架构约束

| # | 约束 | 来源 |
|---|------|------|
| R1 | 不修改 packages/core, packages/server, packages/cli | PRD §Architecture |
| R2 | 零新依赖 | PRD §Bundle |
| D6 | CSS group-hover + pinned exception，非 JS hover | 决策 D6 |
| D5 | 对话框状态 → Zustand store | 决策 D5 |

## 测试策略

- **Sidebar 单元测试**: responsive width class check, onSessionSelect callback invocation, store state read/write for dialog visibility, SessionCard: group-hover classes, pinned-item always-visible, no JS hover state residual
- **手动验证**: 桌面端 Sidebar 全功能无回归

## 风险

- 桌面回归风险中 — Sidebar 是核心组件，dialog state 迁移涉及多个交互路径
- 缓解: AC7（零回归）覆盖所有桌面功能；AC8（build+test 全绿）为硬门禁
- group-hover 在旧版 Safari 上可能有兼容问题 — 已在主流移动/桌面浏览器验证
- 回退: `git revert` 对应 commit，无数据迁移

## 依赖表格

| SDK/工具 | 版本 | 参考 |
|----------|------|------|
| React | 19.x | 现有项目 |
| Zustand | 5.x (immer) | 现有 store 模式 |
| Tailwind CSS | >=3.4 | group-hover, md: modifiers |

## Issue 质量自检（对照宪法 14 项）

- [x] 1. estimate ≤1d — 0.5d ✅
- [x] 2. type AFK — 纯代码，无人机交互 ✅
- [x] 3. AC 可测量 — 8 条 AC 全部可自动化/可观测 ✅
- [x] 4. 代码目录已指定 — Sidebar.tsx 精确路径 ✅
- [x] 5. 前置准备完整 — 仅需 #001 ✅
- [x] 6. mock/E2E 策略明确 — 单元测试覆盖所有行为 ✅
- [x] 7. SDK 用法可参考 — 依赖表格已记录 ✅
- [x] 8. 验收无主观 — 全部可量化（宽度、class、store 值） ✅
- [x] 9. blocked_by 已设 — blocked_by: ["001"] ✅
- [x] 10. 架构约束已引用 — R1, R2, D6, D5 ✅
- [x] 11. AC 覆盖集成层 — store 读写集成、桌面零回归验证 ✅
- [x] 12. Scope 边界清晰 — In/Out 已列 ✅
- [x] 13. needs_* 已声明 — needs_llm: false ✅
- [x] 14. test_files 已指定 — Sidebar.test.tsx ✅
