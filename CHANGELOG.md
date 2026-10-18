# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-18

### 新增

- `mcp({ action: "reload" })`：改完服务器清单原地重载 —— 重新读文件、重建服务器列表、重注册 `mcp` 工具、后台发现新服务器。清单写坏时直接报错，旧列表继续工作，不需要重启 DSH。
- 服务器清单默认路径改为 `$DSH_HOME/mcp.json`；`configFile` 变成可选，仍支持 `~`，也可以指向 Pi / Claude / Cursor 的配置。

### 变更

- bundle 的 `cordis.patch.yml` 不再写死 Pi 的 `mcp-adapter.json` 路径。
- 测试和文档同步：默认读 `$DSH_HOME/mcp.json`；集成测试覆盖 reload 换清单和坏文件回退。

## [0.1.0] - 2026-10-18

### 新增

- 单一 `mcp` 代理工具：`search` / `describe` / `call` / `connect` / `action`，替代把每个 MCP 工具都注册成原生工具。
- 磁盘元数据缓存（按 transport 配置哈希失效），搜索和描述不需要启动服务器。
- 服务器懒连接、空闲 10 分钟关闭、断线单次重连。
- 兼容 Pi 的 `mcp-adapter.json`（`mcpServers`、`disabled`、`description`、`searchKeywords`、`requestTimeoutMs`），支持 `includeServers`/`excludeServers` 和逐服务器覆盖。
- 搜索结果带紧凑参数形状；重名工具按 `server/tool` 展示；中文关键词可用。
- 输出上限：`describe` 超过 20 KB、工具结果超过 50 KB / 2000 行时截断并落盘。
- 图片结果通过 DSH attachments 投影（模型声明支持图片时）。
- 连接失败信息附带服务器 stderr 末尾。
- 测试：配置解析、搜索/缓存、真实服务器 smoke、真实 cordis/dsh-tools 集成测试。
