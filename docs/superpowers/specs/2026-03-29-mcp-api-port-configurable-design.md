# MCP API 端口可配置

**Date:** 2026-03-29
**Status:** Approved

## Problem

MCP 内部 API 端口硬编码为 3002，用户无法配置，可能与其他服务冲突。

## Design

将 MCP API 端口从固定值 3002 改为可配置，优先级：

1. 用户通过 CLI `--mcp-port` 参数指定
2. 环境变量 `OPENLOBBY_MCP_PORT`
3. 默认值：后端服务端口 + 1

### Changes

#### 1. `packages/server/src/index.ts`

`createServer` 的 options 新增可选 `mcpApiPort` 字段。端口计算逻辑：
```typescript
const mcpApiPort = options.mcpApiPort ?? parseInt(process.env.OPENLOBBY_MCP_PORT ?? '', 10) || (port + 1);
```

#### 2. `packages/cli/src/bin.ts`

新增 `--mcp-port <port>` 命令行参数，透传给 `createServer({ port, mcpApiPort, webRoot })`。

### Unchanged

- `mcp-api.ts` 本身不变（已通过参数接收端口）
- `lobby-manager.ts` 不变（已通过 `mcpApiPort` 参数接收端口）
- `mcp-server.ts` 不变（已通过 `OPENLOBBY_API` 环境变量接收地址）

## Files to Modify

| File | Change |
|------|--------|
| `packages/server/src/index.ts` | `createServer` options 增加 `mcpApiPort`，默认值改为 `port + 1` |
| `packages/cli/src/bin.ts` | 新增 `--mcp-port` 参数 |
