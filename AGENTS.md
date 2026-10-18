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

## 踩过的坑

- **schemastery 会给缺省的数组/字典补 `[]`/`{}`**。`servers` 覆盖里的 `args`/`env`/`headers` 必须用 `z.any().required(false)`，否则只写 `command` 的覆盖会把共享配置文件里的 `args`/`env` 覆盖成空，服务器启动后行为异常（chrono 报缺子命令、uvx 打印帮助后退出）。校验放在 `lib/config.js`。
- **profile patch 同 id 会整段替换 bundle config**，不会深合并。写覆盖要把字段写全。
- DSH 从桌面快捷方式启动时 PATH 可能没有 `%USERPROFILE%\.local\bin`，裸命令名会连不上；用 `servers.<name>.command` 给绝对路径。
- 连接失败要把服务器 stderr 尾巴带出来，否则 MCP SDK 只给一个 `Connection closed`。`manager.js` 已用 `stderr: 'pipe'` 收集最后 4 KB。
- 每次加载会把解析后的服务器清单写到 `%TEMP%\dsh-mcp-gateway-resolved.json`（env 只留键名），排查配置解析用。

## 测试

- `npm run test:unit`：纯函数/配置合并/缓存/搜索格式，不依赖外部服务器，CI 跑这个。
- `npm test`：配置解析（真实 Pi 文件 + schemastery 归一化）、搜索/缓存（真实工具清单）。
- `npm run test:smoke`：管理器对真实服务器的 list/call/idle 测试。
- `npm run test:integration`：真实 cordis + 真实 dsh-tools 注册表 + 真实 MCP 服务器，验证工具面只有一个 `mcp`、status/connect/search/describe/call/错误路径。

改连接层后先跑 smoke；改排序/格式后跑 test；改插件接线后跑 integration。改配置解析后务必通过 `Config(...)` 归一化再断言，直接传裸对象会绕过 schema 掩盖上面第一个坑。

## 发行

`RELEASING.md` 是完整流程。要点：

- `npm run verify:release` 校验 manifest、`dsh.bundle.patch`、插入行、模块语法；`prepack` 自动跑。
- CI（`.github/workflows/ci.yml`）跑 `npm ci` → verify → unit → `npm pack --dry-run`。
- 推 `v*` tag 触发 `.github/workflows/release.yml`：校验 tag 与版本一致、unit、pack、有 `NPM_TOKEN` 时 `npm publish`、创建 GitHub Release 附 tarball。
- 不要改 `files`：tarball 只应包含 `lib/`、`cordis.patch.yml`、README、LICENSE。

## 没做的部分

MCP resources、prompts、elicitation、OAuth、语义搜索、审批粒度。做之前先看 README 的「限制」。
