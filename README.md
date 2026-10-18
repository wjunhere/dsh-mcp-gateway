# dsh-mcp-gateway

给 DSH 一个 `mcp` 代理工具：MCP 工具不再全部塞进上下文，模型按需搜索、查看、调用。

## 为什么

MCP 服务器一多，工具定义会吃掉整个上下文窗口。一份 19 个启用服务器的 Pi 配置（`%USERPROFILE%\.pi\agent\mcp-adapter.json`）实测 **488 个工具、schema 总量约 4.1 MB**。DSH 默认把每个工具都注册成原生工具，每次请求都带上它们，1M 窗口直接被塞满。

这个插件只向模型注册 **1 个** `mcp` 工具，工具清单放在磁盘缓存里，按需检索、按需连接。

| | DSH 默认（逐个注册） | 本插件 |
|---|---|---|
| 模型每次请求看到的 MCP 定义 | 488 个工具，约 4.1 MB（≈100 万 token） | 1 个工具，2.6 KB（≈660 token） |
| 服务器进程 | 启动时全部连上，常驻 | 用到才连，空闲 10 分钟关闭 |
| 服务器连不上 | 启动变慢，工具直接消失 | 记入缓存状态，不影响其它服务器 |

搜索延迟实测：488 个工具上 27–80 ms。

## 安装

前提：DSH 0.2.1-rc.2，Node 依赖已装（`npm install`）。

1. 用插件管理器安装这个目录：

   ```
   plugin_manager install_bundle  target = <本仓库目录>
   ```

   或者手动在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里加：

   ```json
   "dependencies": { "dsh-mcp-gateway": "file:<本仓库目录>" },
   "dsh": { "profile": { "bundles": [ "...", "dsh-mcp-gateway" ] } }
   ```

   然后在 profile 目录执行 `pnpm install`。

2. **禁用原来的 MCP 行**。否则每个服务器会同时以原生工具和网关两种方式加载。编辑
   `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，给所有
   `name: '@deepseek-ai/dsh-mcp-client'` 的行加 `disabled: true`：

   ```yaml
   - id: mcp-matlab
     name: '@deepseek-ai/dsh-mcp-client'
     disabled: true
     config: { ... }
   ```

3. 重启 DSH。首次启动会在后台发现没缓存的服务器（并发 2，每个 60 秒超时），期间
   `mcp({ action: "status" })` 能看到进度。

## 配置

插件的配置在 `cordis.patch.yml` 的 `mcp-gateway` 行里（安装时会自动写入）：

```yaml
- id: mcp-gateway
  name: 'dsh-mcp-gateway'
  config:
    configFile: '~/.pi/agent/mcp-adapter.json'
    discoverOnStart: background
    discoverConcurrency: 2
    idleTimeoutMs: 600000
    toolCallTimeoutMs: 60000
    maxSearchResults: 12
    # includeServers: [picgo-uploader, matlab, mineru-mcp, archivum]
    # excludeServers: [rea-wsl]
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `configFile` | 必填 | 服务器清单，和 Pi 共用同一个 JSON |
| `cacheFile` | 清单同目录下 `.dsh-mcp-gateway-cache.json` | 工具元数据缓存 |
| `discoverOnStart` | `background` | 启动时后台发现；`off` 则只按需发现 |
| `discoverConcurrency` | `2` | 同时发现几个服务器 |
| `connectTimeoutMs` | `60000` | 连接/列工具的超时 |
| `idleTimeoutMs` | `600000` | 空闲多久关闭连接 |
| `toolCallTimeoutMs` | `60000` | 单次调用默认超时；服务器可用 `requestTimeoutMs` 覆盖 |
| `maxSearchResults` | `12` | 搜索默认返回条数 |
| `includeServers` / `excludeServers` | 空 | 只加载/排除指定服务器 |
| `servers` | 空 | 按服务器覆盖 `disabled`、`description`、`requestTimeoutMs` |

Pi 配置里的 `searchKeywords`、`description`、`disabled`、`requestTimeoutMs`、`lifecycle` 都会被读取；`directTools` 忽略。

## 模型怎么用

```text
mcp({ search: "book download" })              → 搜索，返回名字、简述、参数形状
mcp({ describe: "download_book" })            → 完整描述和 input schema
mcp({ tool: "download_book", args: { ... } }) → 调用
mcp({ connect: "archivum" })                  → 发现/刷新一个服务器
mcp({ action: "status" })                     → 各服务器状态、工具数、发现时间
mcp({ action: "discover" })                   → 发现所有缺元数据的服务器
mcp({ action: "instructions", server: "x" })  → 服务器的使用说明
```

同一个工具名出现在多个服务器上时，搜索结果会显示成 `server/tool`，例如
`rea/inspect_android_class`（`rea` 和 `rea-wsl` 的工具名完全重复）。

## 限制

- **不接管 MCP resources**：DSH 的 `list_mcp_resources` 等 3 个工具由 `dsh-mcp-client` 提供，禁用那些行之后它们会消失。
- **审批看不到内层工具**：所有调用在审批/历史里都显示为 `mcp`，参数里有工具名和 server。`danger-full-access` 下没影响。
- **图片结果**走 DSH 的 attachments（仅当前模型声明支持图片时），还没在 GUI 里实测。
- **命令要在 DSH 的 PATH 里**：`uvx`、`zotero-mcp`、`chrono` 这三个本次发现失败，就是 DSH 进程 PATH 里找不到。改成绝对路径或补 PATH。
- **超大 schema**：`describe` 超过 20 KB 会截断并把全文写到临时文件；工具结果超过 50 KB / 2000 行同理。
- 没做：MCP prompts、elicitation、OAuth、语义搜索、`directTools` 式激活。

## 排错

- `mcp({ action: "status" })`：看每个服务器的状态、工具数、失败原因。
- 缓存文件：`%USERPROFILE%\.pi\agent\.dsh-mcp-gateway-cache.json`。删掉它会在下次启动时全量重新发现。
- 服务器命令跑不起来时，日志里是 `mcp server "<name>": connect failed: ...`。
- 发现太慢：先在 Pi 里确认服务器可用，或临时把 `includeServers` 缩到常用的几个。

## 开发

见 [AGENTS.md](AGENTS.md)。测试：

```sh
npm test                  # 搜索/缓存（真实 archivum、picgo 工具清单）
npm run test:smoke        # 连接管理（真实服务器 list/call/空闲关闭）
npm run test:integration  # 真实 cordis + 真实 dsh-tools 注册表 + 真实 MCP 服务器
```
