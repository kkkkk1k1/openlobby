---
type: AFK
estimate: 0.75d
effort: small
status: in_review
blocked_by: ["001"]
needs_llm: false
needs_vision: false
needs_pdf: false
needs_docker: false
pr: ["https://github.com/kkkkk1k1/openlobby/pull/15"]
test_files:
  - packages/web/src/components/__tests__/MobileDrawer.test.tsx
  - packages/web/src/components/__tests__/MobileNav.test.tsx
---

# #002 — MobileDrawer + MobileNav 组件

## Parent

`docs/mobile-adaptation-phase-1-prd.md` — PRD: Mobile Adaptation Phase 1

## 背景

移动端需要两个新 UI 组件：侧滑抽屉（替换桌面 sidebar 在移动端的呈现）和底部标签导航栏。两者都是新建文件，共享 lobby-store 字段（来自 #001），可并行实现和测试。

## What to build

### MobileDrawer (`packages/web/src/components/MobileDrawer.tsx`)

Deep module — 固定定位的 overlay drawer，Props: `{ open: boolean, onClose: () => void, children: ReactNode }`

行为清单：
- **外壳常驻**: `fixed inset-0 z-45`，`pointer-events-none`（关闭时） / `pointer-events-auto`（打开时）
- **Backdrop**: `absolute inset-0 bg-black/50 z-0`，transition `opacity duration-200`，点击触发 `onClose`
- **Panel**: `absolute top-0 left-0 h-full w-[85vw] max-w-[320px] z-10 bg-surface-secondary border-r border-outline`，transition `-translate-x-full` ↔ `translate-x-0 duration-200`
- **stopPropagation**: Panel 上 `onClick={e => e.stopPropagation()}`
- **Escape key**: `useEffect` keydown listener → Escape 触发 `onClose`
- **Scroll lock**: 打开时 `document.body.style.overflow = 'hidden'`，关闭/卸载时恢复
- **条件挂载 children**: 仅 `open=true` 时 mount children（节省 DOM），外壳始终挂载（动画平滑）
- **ARIA**: Panel: `role="dialog" aria-modal="true" aria-label="Session navigation"`
- **ErrorBoundary**: children 用 React ErrorBoundary 包裹，fallback 显示 "Something went wrong loading the sidebar." + retry button
- **React.memo**: 组件用 `React.memo` 包裹，`onClose` 由父组件 `useCallback` 稳定化

### MobileNav (`packages/web/src/components/MobileNav.tsx`)

Shallow module — 底部固定标签栏，3 tabs，从 store 读取并调用 setter：

- **定位**: `fixed bottom-0 inset-x-0 z-40 md:hidden`
- **安全区**: `pb-safe`（`env(safe-area-inset-bottom)`）
- **3 个标签**:
  - 💬 Sessions → `setDrawerOpen(true)`
  - 🤖 Agents → `setShowAgentsPanel(true)`
  - 📡 Channels → `setShowChannelPanel(true)`
- **激活态**: 从 `drawerOpen` / `showAgentsPanel` / `showChannelPanel` 派生 — 无独立 `activeMobileTab` 状态
- **Badge**: Agents tab 显示 session count badge（复用 store 已有数据）
- **i18n**: tab 文本使用 `nav.sessions` / `nav.agents` / `nav.channels` key
- **高度**: `h-[var(--mobile-nav-height)]`

## Acceptance Criteria

- [ ] AC1: `open=true` — panel 可见（`translate-x-0`），backdrop `opacity-100`，body `overflow: hidden`，`aria-modal="true"`
- [ ] AC2: `open=false` — panel 不可见（`-translate-x-full`），backdrop `opacity-0`，`pointer-events-none`，children 未挂载
- [ ] AC3: 点击 backdrop → `onClose` 被调用
- [ ] AC4: 按 Escape → `onClose` 被调用
- [ ] AC5: 点击 panel 内部 → `onClose` 不被调用（stopPropagation）
- [ ] AC6: Sidebar 抛出异常 → ErrorBoundary 捕获，fallback UI 显示，App 不崩溃
- [ ] AC7: MobileNav 渲染 3 个按钮，文本分别为 Sessions / Agents / Channels（中英文切换正确）
- [ ] AC8: 点击 Sessions → `setDrawerOpen(true)` 被调用；点击 Agents → `setShowAgentsPanel(true)` 被调用；点击 Channels → `setShowChannelPanel(true)` 被调用
- [ ] AC9: 桌面端（>=768px）→ MobileNav 不可见（md:hidden）
- [ ] AC10: `prefers-reduced-motion: reduce` → drawer transition 时长 0ms

## 前置准备

- [x] #001 完成 — CSS 类、i18n key、store 字段已就位
- [ ] 安装测试依赖: `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`（如尚未安装）

## 代码目录

- 实现: `packages/web/src/components/MobileDrawer.tsx`（新建）, `packages/web/src/components/MobileNav.tsx`（新建）
- 测试: `packages/web/src/components/__tests__/MobileDrawer.test.tsx`（新建）, `packages/web/src/components/__tests__/MobileNav.test.tsx`（新建）

## Scope

**In:**
- MobileDrawer.tsx 完整实现（含 ErrorBoundary、React.memo）
- MobileNav.tsx 完整实现
- 两个组件的单元测试

**Out:**
- Swipe-to-open gesture（Phase 3）
- Long-press 菜单（Phase 3）
- Settings tab（不需要，低频功能留在 drawer 侧边栏）

## 架构约束

| # | 约束 | 来源 |
|---|------|------|
| R1 | 不修改 packages/core, packages/server, packages/cli | PRD §1.2 |
| R2 | 零新 npm 依赖 | PRD §Bundle |
| R3 | 单 DOM 树 — 不重复 MessageList/MessageInput/TerminalView | 决策 D1 |
| R5 | z-index: Nav z-40, Drawer z-45, Modals z-50 | 决策 D17 |
| D9 | Drawer 外壳始终挂载，children 条件挂载 | 决策 D9 |
| D31 | React.memo + useCallback on MobileDrawer | 决策 D31 |

## 测试策略

- **MobileDrawer 单元测试**: mount with open=true/false, simulate backdrop click, simulate Escape key, verify stopPropagation, verify scroll lock apply/remove, verify ARIA attributes, verify children not mounted when closed, ErrorBoundary fallback on children throw
- **MobileNav 单元测试**: verify 3 buttons rendered, verify each button triggers correct store setter, verify hidden on desktop (mock matchMedia), verify active state derivation

## 风险

- focus trap 实现可能中断现有键盘导航 — 仅在 drawer open 时激活，关闭时恢复焦点至 hamburger
- React.memo 可能导致 stale children — onClose 通过 useCallback 稳定化，children (Sidebar) 由 store 驱动重渲染
- 双 Sidebar 实例状态分歧风险低 — drawer 与桌面 sidebar 通过 matchMedia 互斥
- 回退: `git revert` 对应 commit，纯新文件无破坏性影响

## 依赖表格

| SDK/工具 | 版本 | 参考 |
|----------|------|------|
| React | 19.x | 现有项目 |
| Zustand | 5.x (immer) | 现有 store 模式 |
| @testing-library/react | latest | 组件测试 |

## Issue 质量自检（对照宪法 14 项）

- [x] 1. estimate ≤1d — 0.75d ✅
- [x] 2. type AFK — 纯代码，无人机交互 ✅
- [x] 3. AC 可测量 — 10 条 AC 全部可自动化断言（mount + simulate + verify） ✅
- [x] 4. 代码目录已指定 — 4 个精确文件路径 ✅
- [x] 5. 前置准备完整 — 仅需确认 #001 完成 + 测试依赖 ✅
- [x] 6. mock/E2E 策略明确 — 单元测试覆盖所有行为 ✅
- [x] 7. SDK 用法可参考 — 依赖表格已记录 ✅
- [x] 8. 验收无主观 — 全部可量化和自动化 ✅
- [x] 9. blocked_by 已设 — blocked_by: ["001"] ✅
- [x] 10. 架构约束已引用 — R3, R5, D9, D31 ✅
- [x] 11. AC 覆盖集成层 — 与 store 的 setter 调用验证集成 ✅
- [x] 12. Scope 边界清晰 — In/Out 已列 ✅
- [x] 13. needs_* 已声明 — needs_llm: false ✅
- [x] 14. test_files 已指定 — 2 个测试文件 ✅
