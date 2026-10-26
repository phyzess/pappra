<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="docs/assets/readme/hero.zh-CN.svg" width="100%" alt="Pappra，面向编码 Agent 的工作区管理器：Agent 的工作应当放在工作区自己拥有的文件里，而不是某一段聊天记录中。图中是 pappra resume 的真实输出摘录：验证状态是最新的、不允许执行，并列出了阻塞原因。">
</p>

**Pappra 把 AI 编码 Agent 做到哪一步了，保存成你项目里的普通文件，这样换一个 Agent 也能接着干。**

## 为什么需要 Pappra？

你让编码 Agent（Claude Code、Codex、Pi……）去做一件大事。做到一半，对话太长了，或者你换了工具，
或者隔天再回来，新的会话什么都不知道：目标是什么、已经做过哪些决定、下一步该做什么，全都困在
那一段聊天记录里。

Pappra 把这些信息从聊天里搬出来，放进你项目文件夹里的文件中。你选用的任何 Agent 都可以读到同样
的文件。试用它不需要 Agent、模型账号或任何额外服务，有 Node.js 就够了。

## 会遇到的几个词

| 词               | 在这里的意思                                                         |
| ---------------- | -------------------------------------------------------------------- |
| **工作区**       | Pappra 管理的项目文件夹。它的文件放在里面的 `.pappra/` 目录中。      |
| **Agent / 宿主** | AI 编码工具（Claude Code、Codex、Pi）。Pappra 把这类工具称为“宿主”。 |
| **检查点**       | 关于一项任务的存档笔记：目标、怎样算完成、下一步该做什么。           |
| **恢复**         | 把检查点读回来。它只负责报告状态，不会启动任何工作。                 |
| **知识**         | 你选择登记的项目文档，方便 Agent 找到。                              |
| **代码导航**     | 一种有界的代码查找方式。不装额外工具也能用，以后也可以接入代码图。   |

## 5 分钟上手

你需要 [Node.js](https://nodejs.org/) 24 或更高版本，以及 Git。先检查一下版本：

```sh
# 应当输出 v24 或更高版本
node --version
```

**1. 新建一个练习文件夹，然后在里面启动 Pappra。** 在终端里不带任何参数运行 Pappra，配置就
全部完成了：它读取这个文件夹、问几个问题、打印将要写入的计划，并在你确认一次之后应用它。之后它会
逐项提供可选的后续步骤——准备代码索引、登记知识文档、接入你的编码 Agent（Claude Code、Codex、Pi，
包括 MCP 登记）以及运行健康检查——每一步都可以跳过。

```sh
mkdir pappra-demo && cd pappra-demo
git init
npx @phyzess/pappra@beta
```

现在你有了一个 `.pappra/` 目录。`.pappra/workspace.json` 是共享的，应当提交到 Git；
`.pappra/local/` 是私有的，并且会自动忽略自身，所以不会进入 Git。配置过程还会在你的用户数据目录里
放一份 Pappra 的副本，这样清理 `npx` 缓存也不会弄坏这套配置。你随时可以用 `pappra doctor`
重新运行这项只读检查：出现几条 `[WARNING]` 或 `[UNKNOWN]`，对应的是你还没有配置的东西，比如宿主，
这很正常；`[ERROR]` 才是需要修的。

脚本和 CI 请改用显式标志，它们绝不会提问：

```sh
npx @phyzess/pappra@beta init --yes
npx @phyzess/pappra@beta init --yes --apply
npx @phyzess/pappra@beta doctor
```

`init --yes` 只打印计划，不写入任何内容；加上 `--apply` 才会写入。

**2. 保存一个检查点，再把它读回来。**

```sh
npx @phyzess/pappra@beta checkpoint --task demo --objective 'Try Pappra' \
  --acceptance 'Resume stays advisory' \
  --author-session demo --native-session demo \
  --context-completeness complete --json
npx @phyzess/pappra@beta resume demo --session demo
```

本页顶部的输出就是最后一条命令的摘录。

**3. 看懂结果。** 你应该会看到 `Execution allowed: no` 和几行 `Blocked:`。这是正确的结果，
不是错误。恢复只报告任务的状态，绝不会授权 Agent 开始工作；而这个演示用的检查点还没有任何决策
和下一步，所以 Pappra 如实地告诉你上下文不完整。命令的退出码是 `0`；只有验证已过期时才会以非零
状态退出。

这就是核心思想的全部。下面的内容都是可选的。

## 工作原理

<p align="center">
  <img src="docs/assets/readme/how-it-works.zh-CN.svg" width="100%" alt="可选的宿主（Claude Code、Codex、Pi）通过钩子、MCP 服务或命令行调用 Pappra。Pappra 读写你工作区中的两处位置：.pappra/workspace.json，它是共享并提交的；以及 .pappra/local/，它是私有的，并且会自动忽略自身。恢复只报告状态，绝不授予执行权限。">
</p>

Agent 通过钩子、MCP 服务或命令行与 Pappra 交互。Pappra 读写工作区里的两处位置：
`.pappra/workspace.json`（共享，提交）和 `.pappra/local/`（私有，自动忽略自身）。代码引擎的登记信息
保存在 `.pappra/local/code` 下，绝不放进你的检出目录里。

## 你能得到什么

- **工作区配置：** `.pappra/workspace.json`，以及 `.pappra/local/machine.json`，后者保存只适用于
  这台电脑的设置。
- **知识：** 一份 Agent 应当了解的文档清单。登记永远是先预览、再应用；每份文档单独一个文件，
  所以两个人同时登记也不会冲突。
- **连续性：** 私有的检查点，以及 Agent 可以读取的恢复报告。
- **代码导航：** 针对你选定的仓库，提供状态、准备和查找。没有安装代码图时，纯文本与结构搜索
  依然可用。
- **集成（均为可选）：** Agent 钩子、基于 MCP 的 Agent 工具，以及 Agent 之间的协作。

## 下一步

按需选择，没有一项是必需的。

- **安装一次：** `npx` 每次运行都会下载 Pappra。如果你每天都用，就安装它，这样命令就只是 `pappra`：

  ```sh
  npm install -g @phyzess/pappra@beta
  ```

- **让你的 Agent 用上它：** `pappra mcp` 通过 stdio 给 Agent 提供几个安全的工具。Claude Code 或 Pi
  用下面的命令注册，Codex 使用 `codex mcp add`。会写入的工具需要受信任的服务器启动策略，而不是
  Agent 自己传入的标志。见[Agent 原生用法](docs/agent-native.md)（英文）。

  ```sh
  pappra host mcp install --host claude --apply
  ```

- **钩子：** `pappra host install` 会加入 Pappra 自己的钩子条目，而不会接管你的配置。
  `pappra task pin <id> --auto-resume` 让钩子把一个有界的恢复包交给 Agent。见
  [宿主插件验证](docs/host-plugin-validation.md)（英文）。
- **受管会话：** `pappra session` 会启动一个由 Pappra 拥有的、可见的 Pi 终端会话。见
  [受管的 Pi 会话](docs/managed-pi-session.md)（英文）。
- **协作：** `pappra collab workflow` 协调多个 Agent 共同完成一项任务。角色不授予任何权限，
  报告不等于验收，通知也不等于执行。见[工作流契约](docs/collaboration-workflow.md)和
  [有界协作](skills/pappra/references/collaboration.md)（均为英文）。
- **再次回到工作区：** 在工作区里不带参数运行 `pappra`，会显示当前状态和一个简短菜单：恢复任务、
  准备代码索引、扫描文档、接入编码 Agent、健康检查、重新配置、退出。

| 能力                                    | 前提                                    | 默认状态                         |
| --------------------------------------- | --------------------------------------- | -------------------------------- |
| 工作区、init、doctor、检查点/恢复、知识 | 只需 Node.js；识别仓库需要 Git          | 核心，始终可用                   |
| 代码图的状态/准备/查询                  | 可选的外部代码图引擎                    | 除非选用否则关闭；文本回退仍可用 |
| 宿主钩子                                | 你显式选定 Pi、Codex 或 Claude Code     | 不会自动安装                     |
| 协作控制器                              | 显式的 `--controller <fixture\|pi-rpc>` | 没有隐式控制器                   |

这里提到某个宿主或协议，只表示 Pappra 可以与之集成。上面的核心流程不需要其中任何一个。

## 文档

除“快速开始”外，以下文档目前只有英文版。

- [快速开始](docs/quickstart.zh-CN.md)（有中文版）和[运维参考](docs/operations.md)，后者讲解 `init` 如何规划与应用、
  运行时副本如何管理，以及如何修复被中断的状态
- [API 边界](docs/api.md)和[Agent 原生用法](docs/agent-native.md)
- [支持范围与限制](docs/support.md)、[可移植性](docs/portability.md)和
  [分发](docs/distribution-plan.md)
- [开发](docs/development.md)，适用于在本仓库内工作（`pnpm check`）

## 状态与限制

Pappra 是开发阶段的软件（`0.1.0-beta.22`），以 `@phyzess/pappra` 发布，使用 `beta` dist-tag。
请固定到 `beta` 或某个确切版本，因为预发布版本绝不会被重新发布。版本通过 GitHub Actions 以
npm 可信发布（OIDC）的方式发布；这里不保存任何 npm 令牌。

自动化测试使用的是合成的工作区、测试夹具和本地进程。它们并不能证明真实模型的行为、每个宿主在
每个平台上都能工作、代码图引擎是否完整、Windows/Linux 的一致性，或生产环境的性能。列为受支持的
宿主版本只是一种“观察到的声明”，并不证明你的安装一定能加载或运行它。

评审状态，包括每一条被跟踪的发现及其状态，见[评审收尾](docs/review-closeout.md)（英文）。冷启动
用例实际展示了什么，见[冷启动验收](docs/cold-start-acceptance.md)（英文）。

## 许可证

Pappra 采用 MIT 许可证。见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
