# 发行说明

面向维护者。用户安装方式见 README。

## 版本与发布

```sh
# 1. 选版本（只改 package.json 和锁文件，不建 tag）
npm version patch --no-git-tag-version   # 或 minor / major

# 2. 更新 CHANGELOG.md，提交
git commit -am "release: v$(node -p "require('./package.json').version")"

# 3. 打 tag 并推送，GitHub Actions 会完成剩下的
git tag "v$(node -p "require('./package.json').version")"
git push --follow-tags
```

`release.yml` 在 tag 推送后执行：

1. `scripts/verify-release.mjs <tag>`：manifest、bundle patch、模块语法、tag 与版本一致；
2. `npm run test:unit`（不依赖外部 MCP 服务器）；
3. `npm pack` 生成 `dsh-mcp-gateway-<version>.tgz`；
4. 若仓库配置了 `NPM_TOKEN` secret，`npm publish --access public --provenance`；
5. 创建 GitHub Release 并附上 tarball。

## npm 发布凭据

在 GitHub 仓库 Settings → Secrets and variables → Actions 添加 `NPM_TOKEN`（npm 的 Automation token）。没有这个 secret 时工作流**跳过 npm 发布**，仍然产出 GitHub Release 和 tarball。

本地手动发布：

```sh
npm login          # 已登录可跳过
npm pack           # 先看内容，prepack 会跑校验
npm publish --access public
```

## 发布前检查

```sh
npm run verify:release
npm run test:unit
npm pack --dry-run     # 确认只有 lib/、cordis.patch.yml、README、LICENSE
```

真实服务器的测试（`npm test`、`npm run test:smoke`、`npm run test:integration`）依赖本机 MCP 服务器，不进 CI；改连接层或搜索逻辑时本地跑。

## 用户安装来源

| 来源 | `plugin_manager install_bundle` 的 target |
|---|---|
| npm | `dsh-mcp-gateway` 或 `dsh-mcp-gateway@0.1.0` |
| GitHub | `git+https://github.com/wjunhere/dsh-mcp-gateway.git` |
| Release tarball | `https://github.com/wjunhere/dsh-mcp-gateway/releases/download/v0.1.0/dsh-mcp-gateway-0.1.0.tgz` |
| 本地目录 | `B:\path\to\dsh-mcp-gateway` |

装完后按 README 禁用原来的 `@deepseek-ai/dsh-mcp-client` 行，再确认 `mcp({ action: "status" })`。
