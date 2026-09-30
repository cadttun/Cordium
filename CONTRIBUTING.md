# 贡献指南

## 开发环境

- Node.js ≥ 20（CI 覆盖 20 / 22 / 24）
- 零运行时依赖；`npm install` 只建立两个 workspace 的链接

```bash
npm test               # 两包全部测试
npm run test:coverage  # 测试 + 覆盖率
npm run pack           # 打包到 dist/（不入库）
```

静态检查（CI 同款，需在 bash / Git Bash 下运行）：

```bash
npx --yes oxlint@1.86.0 --deny-warnings --import-plugin -D import/no-cycle packages/*/src
```

## Git hooks（可选，启用一次长期有效）

本仓用 **Git 2.54+ 自带的配置化 hooks**，不装 Husky / pre-commit / Lefthook 一类的第三方管理工具：

```bash
git config include.path ../.githooks/gitconfig   # 启用
git hook list pre-push                            # 查看（应输出 tests）
git config --unset include.path                   # 停用
```

启用后：`pre-push` 跑全部测试（含边界门禁：内核不得出现具体服务名、依赖方向单向）。lint 与打包检查由 CI 负责。钩子定义见 [.githooks/gitconfig](.githooks/gitconfig)。

> Git 不会让仓库自带的配置自动执行命令 —— 那等于让克隆者远程执行任意代码。所以这一步必须手动开启，是 git 的有意设计。
> 门禁的**权威判定**始终是 CI；本地钩子只是把反馈提前，不能替代 CI。

## ⚠️ 双仓结构

本项目有两个仓：**开发仓**（日常提交发生在这里，历史含大量内部信息——产品名、称呼、评审叙事等；因此它不设 remote、不对外推送——配了 remote，一次手滑 `git push` 就会把内部历史全部推出去，而 git 历史是**无法真正撤回**的）与**发布仓**（你在 GitHub 上看到的这个：单条提交、无内部历史，由发布管线从开发仓的已提交内容同步生成）。

两仓 `.git` 没有共同祖先，这是有意设计，不要试图「合并」两段历史。

## 边界（改代码前先读）

判断一段代码该不该进 cordium，只问一句：**它是在说明或执行「插件机制」的规则，还是只关心某个具体应用怎么做？** 后者不进。

三条硬边界：

1. `packages/kernel/src` 只能 import 本目录内的模块或 `node:` 内置模块（`boundary.test.mjs`）。
2. 源码与测试（含注释）不得出现具体应用的产品名、业务词或具体服务名 `service.<名>`（服务名由 `neutrality.test.mjs` 检查，其余靠评审）。
3. 内核里不得出现产品装配清单，例如「某产品默认装哪些插件」的列表（`boundary.test.mjs`）。

依赖方向单向：`@cordium/plugins` → `@cordium/kernel`；跨包只经包名与 `exports` 列出的入口引用，`@cordium/kernel/internal` 只供 `packages/plugins/src` 使用。

## 公开接口

- 公开导出、宿主方法、`ctx` 成员、错误码表都由测试钉死（`public-surface.test.mjs`、`host.test.mjs`、`error-model.test.mjs`）。增删改名是有意的 API 变更，要同时改这些清单，并写进 `CHANGELOG.md`。
- 插件可见的接口有破坏性变化时，升 `KERNEL_API_VERSION` 的主版本（它与包版本相互独立）。
- 两个包版本同步发布（lockstep）。
- 发版：两个 `package.json` 的版本改好、`CHANGELOG.md` 把 `[Unreleased]` 改成版本段 → 打标签 `vX.Y.Z` 推送 → 在 GitHub 上发布 Release。`release` workflow 会校验包版本与标签一致、跑测试，再把两个 `.tgz` 与 `SHA256SUMS` 附到 Release 上。
- 删除过的接口及原因记录在 [design/removed-apis.md](design/removed-apis.md)，加回之前先读。

## 代码约定

- 抛错一律 `new CordiumError(ErrorCode.X, message, { cause, pluginId })`，源码中不得出现裸 `new Error(`（有测试守护）。
- 换行 LF、缩进 2 空格、UTF-8（见 `.gitattributes` / `.editorconfig`）。
- 不引入格式化工具链；lint 只用上面那条锁定版本的 oxlint 命令，`src` 保持零告警。升级 oxlint 版本是一次有意的改动：改 CI 里的版本号，本地先跑一遍。

## 测试约定

- 每个修复都配一条能判别它的测试：撤掉修复，对应用例必须变红。
- 按被测主题命名测试文件（`service-access`、`lifecycle-gates` …）。`regression-sweep` 是跨主题的回归合集。
- 测试只用中立夹具（`test/fixtures/`），不依赖任何具体应用的代码或契约表。
- 按错误码断言（`fixtures/errors.mjs` 的 `hasCode`），不按报文文字断言。
