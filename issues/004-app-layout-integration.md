---
type: AFK
estimate: 1d
effort: small
status: in_review
blocked_by: ["002", "003"]
needs_llm: false
needs_vision: false
needs_pdf: false
needs_docker: false
test_files:
  - packages/web/src/__tests__/App.test.tsx
---

# #004 — App.tsx 布局重构 + 集成

## Parent

`docs/mobile-adaptation-phase-1-prd.md` — PRD: Mobile Adaptation Phase 1

## 背景

这是 Phase 1 的核心集成点。将 #001-#003 的所有产出（CSS、store、MobileDrawer、MobileNav、Sidebar 适配）在 App.tsx 中连接为完整的响应式布局。同时附带 TerminalView "Copy last command" button 和 3 个对话框的移动端安全尺寸。

## What to build

### App.tsx 布局重构

**当前结构:**
```tsx
<div className="h-screen flex bg-surface text-on-surface">
  <Sidebar />
  <main className="flex-1 flex flex-col min-w-0">
    <RoomHeader />
    {/* MessageList / Terminal / Input / empty state */}
  </main>
</div>
```

**新结构（单 DOM 树 + CSS 断点切换）:**

```tsx
<div className="h-screen h-dvh flex flex-col md:flex-row bg-surface text-on-surface">
  {/* 桌面端 sidebar — CSS 隐藏移动端 */}
  <div className="hidden md:flex md:w-72 shrink-0">
    <Sidebar />
  </div>

  {/* 移动端 drawer — 仅 open 时 mount Sidebar children */}
  <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
    <Sidebar onSessionSelect={() => setDrawerOpen(false)} />
  </MobileDrawer>

  {/* 单内容树 */}
  <main className="flex-1 flex flex-col min-w-0 pb-[calc(var(--mobile-nav-height)+env(safe-area-inset-bottom,0px))] md:pb-0">
    {/* 移动端顶栏 — 桌面端隐藏 */}
    <div className="md:hidden flex items-center px-3 py-2 border-b border-outline bg-surface-secondary">
      <button onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={drawerOpen}
              aria-controls="mobile-drawer"
              className="w-11 h-11 flex items-center justify-center rounded-lg tap-target">
        {/* hamburger SVG icon */}
      </button>
      <h1 className="text-sm font-bold ml-3">OpenLobby</h1>
    </div>
    <RoomHeader />
    {/* MessageList / Terminal / Input — 单份，不重复 */}
    {/* 移动端空状态: "Tap the menu or Sessions tab to choose a conversation" */}
  </main>

  <MobileNav />

  {/* 对话框 — 从 Sidebar 移到这里，共享给 Sidebar toolbar + MobileNav */}
  {showAgentsPanel && <AgentsPanel onClose={() => setShowAgentsPanel(false)} />}
  {showChannelPanel && <ChannelManagePanel onClose={() => setShowChannelPanel(false)} />}
  {showSettingsDialog && <GlobalSettingsDialog onClose={() => setShowSettingsDialog(false)} />}
  {showUpdateDialog && <UpdateDialog onClose={() => setShowUpdateDialog(false)} />}
  {showDiscoverDialog && <DiscoverDialog onClose={() => setShowDiscoverDialog(false)} />}
</div>
```

**关键实现细节:**
- **Hamburger**: App 层顶栏内，独立于 RoomHeader（RoomHeader 无 session 时 return null）
- **matchMedia**: `useEffect` 中监听 `(min-width: 768px)`，断点穿越时自动 `setDrawerOpen(false)`
- **移动端空状态**: session 列表为空 + drawer 未打开时显示移动端引导提示
- **useCallback**: `setDrawerOpen(false)` 包装为 `useCallback(() => setDrawerOpen(false), [])` 传给 MobileDrawer
- **移动端 main padding**: `pb-[calc(var(--mobile-nav-height)+env(safe-area-inset-bottom,0px))] md:pb-0`

### TerminalView.tsx — Copy last command 按钮

在 `packages/web/src/components/TerminalView.tsx` 中新增一个按钮：
- 移动端可见（`md:hidden`）
- 点击复制最后一条终端命令到剪贴板
- 极小改动，不影响任何现有功能

### 3 个对话框 — 移动端安全尺寸

AgentPanel、ChannelManagePanel、GlobalSettingsDialog 各加 mobile guard class:
```
max-h-[80dvh] overflow-y-auto w-[calc(100vw-32px)] md:w-96 mx-4 md:mx-0
```
保证 iPhone SE (568px 高度) 上内容可滚动。

## Acceptance Criteria

- [ ] AC1: 桌面端（>=768px）— Sidebar 280px 常驻，无 MobileNav，无 hamburger，所有功能与改动前完全一致
- [ ] AC2: 移动端（<768px）— Sidebar 隐藏，hamburger 顶栏可见，MobileNav 底部固定可见
- [ ] AC3: 点击 hamburger → drawer 滑入（200ms），backdrop 可见，session 列表可用
- [ ] AC4: 点击 drawer 中 session → drawer 关闭 + session 激活
- [ ] AC5: 从 <768px 缩放至 >=768px → matchMedia 触发 drawer 自动关闭，sidebar 显示
- [ ] AC6: 移动端首次加载（无 session，drawer 关闭）→ 显示 "Tap the menu or Sessions tab to choose a conversation"
- [ ] AC7: 5 个对话框从 App.tsx 渲染，Sidebar toolbar 和 MobileNav tab 均能触发
- [ ] AC8: TerminalView Copy 按钮：移动端可见、桌面端隐藏，点击复制最后命令到剪贴板
- [ ] AC9: AgentsPanel / ChannelManagePanel / GlobalSettingsDialog 在 568px 高度 viewport 上：内容可滚动，按钮可触达
- [ ] AC10: CSS `h-dvh` 双值回退已实现（`h-screen h-dvh` cascade），在支持 dvh 的浏览器上高度正确
- [ ] AC11: `pnpm build` 成功，`pnpm test` 全部通过

## 前置准备

- [x] #001 完成 — CSS + i18n + store
- [x] #002 完成 — MobileDrawer.tsx + MobileNav.tsx
- [x] #003 完成 — Sidebar.tsx 适配

## 代码目录

- 实现: `packages/web/src/App.tsx`（修改）, `packages/web/src/components/TerminalView.tsx`（修改）, `packages/web/src/components/AgentsPanel.tsx`（修改）, `packages/web/src/components/ChannelManagePanel.tsx`（修改）, `packages/web/src/components/GlobalSettingsDialog.tsx`（修改）
- 测试: `packages/web/src/__tests__/App.test.tsx`（新建/追加）

## Scope

**In:**
- App.tsx 单 DOM 树布局重构
- matchMedia resize handler
- 移动端顶栏 + hamburger
- 移动端空状态
- 对话框 JSX 从 Sidebar 提升至 App.tsx
- TerminalView Copy last command button
- 3 个对话框移动端安全尺寸 class

**Out:**
- RoomHeader 任何修改（Phase 2）
- MessageBubble / MessageInput / MessageList 修改（Phase 2）
- 其余 5 个对话框的完整移动端适配（Phase 2）
- 键盘处理 / visualViewport API（Phase 3）

## 架构约束

| # | 约束 | 来源 |
|---|------|------|
| R1 | 不修改 packages/core, packages/server, packages/cli | PRD §1.2 |
| R2 | 零新依赖 | PRD §Bundle |
| R3 | 单 DOM 树，不重复 MessageList/MessageInput/TerminalView | 决策 D1 |
| R4 | CSS 变更包裹在注释块内 | 决策 D29 |
| R5 | z-index: Nav 40 < Drawer 45 < Modals 50 | 决策 D17 |
| D10 | h-screen + h-dvh 双值回退 | 决策 D10 |
| D18 | --mobile-nav-height CSS 变量 + safe-area calc | 决策 D18 |
| D22 | prefers-reduced-motion 支持 | 决策 D22 |

## 测试策略

- **App 单元测试**: matchMedia handler (mock window.matchMedia), drawer auto-close on breakpoint, mobile empty state rendering, dialog JSX rendering from store state
- **手动验证**: 5 个 viewport (320x568, 375x667, 390x844, 430x932, 768x1024) 功能正常；桌面端 1920x1080 全功能零回归；横屏 568x320 无 crash
- **视觉回归**: 截图对比 5 viewports

## 风险

- matchMedia listener 可能引起 resize 循环 — useCallback + useEffect cleanup 可验证，仅处理 >=768px 单一边界
- 上游合并冲突风险高 — App.tsx 布局重构是 Phase 1 修改量最大的文件
- 缓解: CSS 变更在注释块内；所有新增代码在独立组件（MobileDrawer, MobileNav）；原始 exports 不变
- 对话框从 Sidebar 提升至 App 可能遗漏某处调用 — AC7（5 个对话框双入口验证）覆盖
- 回退: `git revert` 对应 commit，可安全回退（单文件为主）

## 依赖表格

| SDK/工具 | 版本 | 参考 |
|----------|------|------|
| React | 19.x | useEffect, useCallback, matchMedia |
| Tailwind CSS | >=3.4 | h-dvh, md: modifiers, calc() |
| Zustand | 5.x | 现有 store |
| navigator.clipboard | Web API | writeText() |

## Issue 质量自检（对照宪法 14 项）

- [x] 1. estimate ≤1d — 1d（核心集成点，最厚一条） ✅
- [x] 2. type AFK — 纯代码，无人机交互 ✅
- [x] 3. AC 可测量 — 11 条 AC 全部可自动化或可观测 ✅
- [x] 4. 代码目录已指定 — 5 个修改文件精确路径 ✅
- [x] 5. 前置准备完整 — #001 #002 #003 ✅
- [x] 6. mock/E2E 策略明确 — 单元测试 + 手动 5 viewport 验证 ✅
- [x] 7. SDK 用法可参考 — 依赖表格已记录 ✅
- [x] 8. 验收无主观 — 全部可量化（宽度、可见性、行为触发） ✅
- [x] 9. blocked_by 已设 — blocked_by: ["002", "003"] ✅
- [x] 10. 架构约束已引用 — R1-R5, D10, D18, D22 ✅
- [x] 11. AC 覆盖集成层 — 所有组件端到端连接验证 ✅
- [x] 12. Scope 边界清晰 — In/Out 已列 ✅
- [x] 13. needs_* 已声明 — needs_llm: false ✅
- [x] 14. test_files 已指定 — App.test.tsx ✅
