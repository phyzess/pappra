<p align="center">
  <a href="quickstart.md">English</a> · <strong>简体中文</strong>
</p>

# Pappra 快速开始

这份指南带你一步步从零开始，得到一套能用的 Pappra 配置，不需要任何前置知识。如果你想先了解整体
图景，可以先读 [README](../README.zh-CN.md)。

**Pappra 做什么：** 它把 AI 编码 Agent 做到哪一步了（目标、决策、下一步）保存成你项目里的普通文件，
这样新开一段对话或换一个 Agent，也能接着干。

跟着本页操作，你**不需要**编码 Agent、模型账号、私有仓库或任何额外服务。你只需要：

- [Node.js](https://nodejs.org/) 24 或更高版本。用 `node --version` 检查。
- Git，这样 Pappra 才能识别你的仓库。

## 第 1 步：在练习文件夹里配置 Pappra

先建一个空文件夹，免得动到真实的东西。`npx` 会下载并运行 Pappra，不需要安装；`@beta` 是这个软件包
发布所用的发布通道。

```sh
mkdir pappra-demo && cd pappra-demo
git init
```

现在不带任何参数运行 Pappra。在终端里，这会启动引导式配置：`init` 向导、一份将要写入的计划预览，
以及一次确认。回答“是”，它就会应用这份计划。

```sh
npx @phyzess/pappra@beta
```

工作区建好之后，它会逐项提供可选的后续步骤，每一步都可以跳过：

- 为工作区里的仓库准备代码索引；
- 登记它发现的知识文档；
- 接入你的编码 Agent——Claude Code、Codex 或 Pi——包括 MCP 登记；
- 运行健康检查。

Pappra 不会替你回答宿主自己的信任提示：Claude Code、Codex 或 Pi 是否可以加载 Pappra 的钩子或
MCP 服务，需要你在那个 Agent 里自己决定。

刚才发生了什么：

- 出现了一个 `.pappra/` 目录。`.pappra/workspace.json` 是共享设置，应当提交到 Git。
  `.pappra/local/` 只属于这台电脑，并且会自动忽略自身，所以不会进入 Git。
- 配置过程还在你的用户数据目录里安装了一份 Pappra 的副本，并记录在 `.pappra/local/machine.json`
  中。这样即使 `npx` 清理了缓存，这套配置也能继续工作。如果你不想要这份副本，可以改用显式写法并
  带上 `--no-runtime`：`npx @phyzess/pappra@beta init --no-runtime`，再加上 `--yes --apply`
  就会真正写入。
- 引导式健康检查会打印一行汇总和所有错误；`pappra doctor` 随时可以把同一批检查逐条打印出来：
  出现几条 `[WARNING]`、`[UNKNOWN]` 或 `[PARTIAL]`，对应的是你还没有配置的东西（宿主、代码图），
  这很正常，`[ERROR]` 才是需要修的。

### 脚本与 CI

显式写法从不提问，所以脚本和 CI 任务应当使用它：

```sh
npx @phyzess/pappra@beta init --yes
npx @phyzess/pappra@beta init --yes --apply
npx @phyzess/pappra@beta doctor
```

`--yes` 的意思是“根据这个文件夹里能发现的东西选择合理的默认值，不要问我问题”。第一条命令只打印
计划，不写入任何内容，所以随时可以放心运行；第二条才会应用它，之后由 `doctor` 检查一切是否就位。

### 命令以数字退出时

| 退出码 | 含义                           |
| ------ | ------------------------------ |
| `0`    | 你要求的工作已经完成           |
| `1`    | 发生冲突，或者要求的工作未完成 |
| `2`    | 输入无效，比如标志拼错了       |
| `3`    | 环境不可用                     |

`doctor` 在希望你查看某些东西时也会以 `1` 退出。请阅读它的汇总行。

## 第 2 步：保存检查点并读回来

**检查点**是关于一项任务的存档笔记，**恢复**则把它读回来。恢复只负责报告，绝不会启动任何工作。

```sh
npx @phyzess/pappra@beta checkpoint --task demo --objective 'Try Pappra' \
  --acceptance 'Resume stays advisory' \
  --author-session demo --native-session demo \
  --context-completeness complete --json
npx @phyzess/pappra@beta resume demo --session demo
```

你应该会看到 `Execution allowed: no` 和几行 `Blocked:`。**这是正确的结果，不是错误。** 恢复包是
建议性的：能读到检查点，并不意味着 Agent 获准开始工作。这个演示用的检查点也没有任何决策和下一步，
所以 Pappra 如实地告诉你上下文不完整，而不是假装没问题。命令依然以 `0` 退出；只有验证已过期时才会
以非零状态退出。在机器可读的（`--json`）输出里，同样的信息表现为 `executionAllowed:false` 加上
非空的 `blockingReasons`。

这就是 Pappra 的核心。下面的内容都是可选的。

## 第 3 步（可选）：安装一次

如果你每天都用 Pappra，就安装它，这样命令就只是 `pappra`：

```sh
npm install -g @phyzess/pappra@beta
```

使用 mise 或其他版本管理器时，请用 `npm install -g --prefix "$HOME/.local"`，这样命令就不会绑定在
某一个 Node 版本的 shim 上。`npx` 的写法依然有效，并且无需安装就能固定版本。

## 进阶内容

从这里开始的一切都是可选的，需要时再看。浏览一下标题，跳到符合你情况的部分即可。

## 重新配置、管理运行时副本，以及 `init` 的其他细节

`init --print-choices` 会把推导出的选择打印成一份文档，并且不写入任何内容；如果想改用文件，使用
`--config`：

```sh
npx @phyzess/pappra@beta init --print-choices        # 打印推导出的文档，不写入任何内容
npx @phyzess/pappra@beta init --config ./minimal-choices.json --apply --json
```

本仓库里的 `examples/minimal-choices.json` 是一份完整的选择文件，适用于无宿主、无代码图、单目录的
工作区。`--yes` 和 `--print-choices` 从不提示，所以可以在 CI 中使用。不带选择的 `init --json`
依然以非零状态退出，但会返回发现的候选项和建议的 `pappra/init-choices/1` 文档；只有在没有选择的
TTY 中才会打开向导。

`init --apply` 会安装一份所执行软件包的持久运行时副本，并把它绑定到 `machine.json`，这正是 npx/dlx
引导在缓存被清理后仍能继续工作的原因。传入 `--no-runtime` 可以把这一步留到以后（结果是 `ok:true`、
`status:"external-actions-pending"`，退出码 `0`；请查看 `pendingExternalActions`，不要把它当成配置
损坏）。这份副本可以直接管理：

```sh
npx @phyzess/pappra@beta runtime install --apply --json   # 默认 --from self
npx @phyzess/pappra@beta runtime status --json            # 只读的被动状态
npx @phyzess/pappra@beta runtime verify --json            # 内容与冒烟验证
npx @phyzess/pappra@beta runtime remove --apply --json    # 拒绝移除仍被引用的运行时；--force 只接受未知引用
```

已有的有效 `.pappra/workspace.json` 绝不会被悄悄重写。`--reconfigure` 是显式的选择加入：它会根据
当前的选择重写该文件，并保留工作区标识、`extensions`、`continuity`、带有检出绑定的自定义校验条目，
以及已有的本地机器设置；旧文件会备份到 `.pappra/local/backups` 下。各种标志组合的行为是有意不同的：

| 调用                                         | 效果                                     |
| -------------------------------------------- | ---------------------------------------- |
| 单独的 `init`                                | 复用有效的配置，只规划缺失的本地状态     |
| `init --yes --reconfigure --apply`           | 保留当前已有的选择，而不是从发现结果重新推导 |
| `init --config <file> --reconfigure --apply` | 应用你显式提供的修改                     |
| TTY 中的 `init --reconfigure`                | 打开以当前选择为初始值的编辑器           |
| `init --print-choices --reconfigure`         | 打印当前的选择，并且不写入任何内容       |

成功应用后还会报告建议性的 `nextActions`：选定了代码引擎时是 `pappra code prepare --repo <id>
--apply`，以及用 `pappra docs scan --apply` 登记发现结果中已列在已配置知识来源下的文档。

## 让你的 Agent 调用 Pappra（MCP）

MCP 是让 Agent 调用工具的一种标准方式。`pappra mcp` 会为当前工作区启动一个 stdio MCP 服务。只读
工具涵盖工作区状态、恢复、文档、代码查询和运行时状态。具备写入能力的工具需要受信任的服务器启动
策略；仅靠一个 `apply` 参数永远不会获得授权。`pappra host mcp install --host claude|pi --apply`
会把它登记到 `.mcp.json` / `.pi/mcp.json`；Codex 使用 `codex mcp add pappra -- pappra mcp`。

`pappra task pin <id> --auto-resume` 会让生命周期钩子为该任务注入一个有界的恢复包。完整的工具和
授权模型见 [Agent 原生用法](agent-native.md)（英文）。

## 设置新的工作区或新的机器

想用一条命令代替好几个步骤？`pappra onboard` 会规划或应用整套配置：工作区配置、持久运行时，以及
（加上 `--apply-host` 时）为已显式准入的、被观察到的宿主版本接入宿主。在终端里，不带任何标志的
`pappra onboard` 在没有工作区时会运行引导式配置；已有工作区时则运行可选的后续步骤（代码索引、文档、
编码 Agent、健康检查），不显示菜单。下面的标志依然有效，可供脚本使用。

```sh
pappra onboard --dry-run --json            # 只读：范围、文件、宿主版本
pappra onboard --yes --json                # init + 运行时，打印宿主步骤
pappra onboard --yes --apply-host --json   # 同时写入已验证的宿主集成
```

它从不批准宿主信任。onboard 会使用并重新检查检测到的版本，包括[支持矩阵](support.md)中每一个
显式准入的版本。未列出的版本会被跳过；请安装受支持的版本，或手动使用检查点/恢复。把工作区复制到
另一台机器，见[可移植性](portability.md)（英文）；`.pappra/local/` 是机器本地的，不能复制。

## 接管已有的多仓库工作区

工作区根目录下往往有许多检出目录，外加第三方依赖和工作树。`init --yes` 会推导出发现的每一个检出
目录，这通常过宽；请改用显式选择：

```sh
cd /path/to/workspace
PAPPRA="npx @phyzess/pappra@beta"

# 1. 盘点推导出的形态，不写入任何内容（即使 .pappra 还不存在也能用）。
$PAPPRA init --print-choices --json

# 2. 保留那份文档，然后收窄它：
#    - repositories：只给你正在修改的检出目录写权限
#    - excludes：node_modules、dist、coverage、第三方依赖、工作树、临时克隆
#    - knowledge.sources：根目录规则文件，加上你真正在维护的笔记目录
#    - validation：几条真实的 lint/test 命令，而不是每个包一条
$PAPPRA init --config .pappra-choices.json --apply --json
$PAPPRA doctor --json
$PAPPRA docs scan --apply --json
$PAPPRA code prepare --repo <active-repo> --apply --json

# 之后的修改，或运行时升级：
$PAPPRA init --config .pappra-choices.json --reconfigure --apply --json
```

说明：

- 排除项在第一次应用之后才生效；之后的 `--print-choices` 或 `--reconfigure` 只会看到已配置的
  仓库加上根目录，而不是整棵目录树。
- 代码登记信息保存在 `<workspace>/.pappra/local/code/<repo>.json`；检出目录内部不会创建
  `.pappra` 目录，因此外层的发现仍能正常解析。
- `doctor` 会观察私有默认根目录、项目目录和 `$CODEX_HOME` 中的宿主清单，但用 `pi install` 安装的
  Pi 包没有这样的清单：请用真实会话来检查它。
- 工作区根目录不必是 Git 仓库；没有 Git 时检查点也能工作。

## 开发 Pappra 本身（开发检出目录）

只有在你要修改 Pappra 自身的源码时才需要。

检出目录和目标工作区是不同的目录。在检出目录里构建一次，然后在目标工作区里用绝对路径调用
`dist/cli/main.js`。

```sh
cd /absolute/path/to/pappra
pnpm install --frozen-lockfile
pnpm build
export CHECKOUT="$PWD"
export PAPPRA_CLI="$CHECKOUT/dist/cli/main.js"

mkdir -p <empty-dir> && cd <empty-dir>
cp "$CHECKOUT/examples/minimal-choices.json" ./minimal-choices.json
node "$PAPPRA_CLI" init --config ./minimal-choices.json --json
node "$PAPPRA_CLI" init --config ./minimal-choices.json --apply --json
node "$PAPPRA_CLI" doctor --json
```

Node.js 24+ 和 pnpm 12.3.4 是受支持的开发基线。

收敛的应用以 `0` 退出。使用 `--no-runtime` 时，结果是 `ok:true`，并带有
`status:"external-actions-pending"`、`initComplete:false`，退出码为 `0`；请查看
`pendingExternalActions`，不要把它当成配置损坏。`doctor` 会报告由此产生的运行时状况；
`pappra runtime verify` 则执行主动检查。

## 检查点与恢复的 JSON 形式

流程与第 2 步相同，是适合脚本使用、面向开发检出目录的变体。

目标成为 Git 工作树、并且所需的工作区标识可用之后，创建并读取一个建议性检查点：

```sh
node "$PAPPRA_CLI" checkpoint --task demo --objective 'Try Pappra' \
  --acceptance 'Resume stays advisory' \
  --author-session demo --native-session demo \
  --context-completeness complete --json
node "$PAPPRA_CLI" resume demo --session demo --json
```

恢复包是建议性的。请检查 `executionAllowed`；能读到检查点并不意味着获准开始工作。
`executionAllowed:false` 并附带非空的 `blockingReasons`，是一个成功的建议性结果（退出码 `0`），
不是命令失败；验证已过期时才会以非零状态退出。

## 代码图、宿主钩子与协作

以上流程并不依赖这些内容，并且 init 不会为它们生成任何示例文件。

- 代码图的状态/准备/查询需要选定一个外部代码图引擎；没有它时，仍可使用有界的文本/结构回退。
- 宿主的检测/规划/安装需要所选宿主的 CLI 和支持。安装的钩子是复制到宿主根目录中的、无依赖的包；
  Claude Code 使用 `${CLAUDE_PROJECT_DIR}` 占位符，因此检出目录被移动或 npx 缓存被清理都不会
  破坏它。

  Codex 只会从其用户配置目录加载生命周期钩子，所以要用
  `pappra host install --host codex --scope user --apply` 来接入，并在 Codex 中批准一次该钩子；
  项目里的 `.codex/hooks.json` 和插件包在那里不会被加载。

  `pappra host bundle --host <name> --out <dir> --marketplace` 会导出一个 Claude Code 和 Codex
  都接受的本地插件市场（`.claude-plugin/marketplace.json` 加一个 `pappra/` 插件目录）；不带
  `--marketplace` 时则导出插件目录本身。Pi 直接安装该目录。已观察到的插件钩子支持因宿主版本而异；
  见[宿主插件验证](host-plugin-validation.md)（英文）。由于每个宿主仍然需要各自的注册步骤，
  `host install --mode plugin` 保持失败即关闭，并打印确切的命令。
- 协作需要显式指定控制器：

  ```sh
  node "$PAPPRA_CLI" collab run --prepared prepared.json \
    --capabilities card.json --controller fixture
  ```

  先运行 `prepare`；`run` 需要已准备好的任务和一张新的能力卡。`fixture` 是确定性的、不使用模型的。
  `pi-rpc` 会启动一个真实的、由其拥有的 Pi RPC 会话；见 [Pi RPC 协作](pi-rpc.md)（英文）。

协作和受管 Pi 的软件包 API 是实验性的，只通过两个入口提供：`@phyzess/pappra/experimental` 和
`@phyzess/pappra/experimental/pi`。beta 版的映射很精简，去掉了早先按功能划分的路径
（`pappra/collab/*`、`pappra/hosts/pi-*`、`pappra/collaboration`）；它们会以
`ERR_PACKAGE_PATH_NOT_EXPORTED` 失败，并且没有兼容垫片，见 [API 边界](api.md)（英文）。打破锁只能
通过 CLI 操作（`pappra collab recovery lock-break`）；没有任何库导出授予这一能力。
