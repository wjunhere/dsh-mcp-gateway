# AGENTS.md

给后续接手这个插件的人（或 agent）。使用者文档看 README.md。

## 这个项目是什么

DSH 插件：把 MCP 工具面收成一个 `mcp` 代理工具，工具元数据落盘缓存，服务器按需启动、空闲关闭。
依赖 DSH 0.2.1-rc.2 的 `ctx.tools.register`、`systemPrompt`、`attachments`/`llm`（图片结果时）。

## 代码结构

- `lib/index.js`：cordis 插件入口（`apply`/`Config`），`mcp` 工具定义、各模式分发、图片投影、启动时后台发现。
- `lib/manager.js`：MCP 连接管理（懒连接、空闲关闭、单次重连、超时）。不依赖 cordis，可单独测。
- `lib/search.js`：词法排序（权重/覆盖率门限/关键词）、compact shape、describe、分页、拼错建议。
- `lib/cache.js`：元数据缓存（atomic write、config hash）。
- `lib/config.js`：读 Pi 的 `mcp-adapter.json`，合并 include/exclude/overrides。

## 关键约束

1. `mcp` 工具的描述必须是配置文件（服务器名列表）的纯函数。任何实时状态（连接数、工具数）放进 `mcp({ action: "status" })` 的返回值，否则每次重注册都会击穿 KV 缓存前缀。
2. 缓存条目按 transport 身份（command/args/env/cwd/url/headers）哈希失效；配置改了必须重新发现。
3. 后台发现完成后调用 `manager.disconnect(name)`，避免启动时把所有服务器进程都留着。
4. 结果文本就是模型看到的内容，保持简短；完整 schema 只在 `describe` 返回。

## 测试

- `npm test`：搜索/缓存的真实数据测试（连真实 archivum、picgo-uploader）。
- `npm run test:smoke`：管理器对真实服务器的 list/call/idle 测试。
- `npm run test:integration`：真实 cordis + 真实 dsh-tools 注册表 + 真实 MCP 服务器，验证工具面只有一个 `mcp`、status/connect/search/describe/call/错误路径。

改连接层后先跑 smoke；改排序/格式后跑 test；改插件接线后跑 integration。

## 没做的部分

MCP resources、prompts、elicitation、OAuth、语义搜索、审批粒度。做之前先看 README 的「限制」。
