<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="docs/assets/readme/hero.zh-CN.svg" width="100%" alt="Pappra：Agent 的会话会结束，任务不会。图中是两个会话之间的交接，并嵌入了一段真实的 pappra resume 输出：目标、上下文状态，以及交给下一个会话的下一步；其余输出行已省略。">
</p>

**编码 Agent 的会话会结束，任务不会。Pappra 把目标、已经做过的决定和下一步保存成你项目里的
普通文件，下一个会话——不论用哪个 Agent——都能接着把这件事做下去。**

## 什么是 Pappra？

你已经在 `CLAUDE.md` 或 `AGENTS.md` 里给编码 Agent 写下了长期指令：怎么构建、怎么测试、遵循什么
风格。这些文件说明的是“怎么干活”，而不是“活干到哪一步了”。后者只存在于对话里，所以当会话太长、
你换了工具、或者隔天再回来的时候，新的会话只能从零开始。

Pappra 把当前任务的状态——目标、已经做过的决定、试过什么、卡在哪里、下一步做什么——保存成你项目
文件夹里的文件。你选用的任何 Agent 都能读到它们，这些信息也不会随聊天记录一起消失。

- **在任何 Agent 里接着做。** 一个会话保存的检查点，下一个会话都能读，不论它跑在哪个 Agent 里。
- **项目知识。** 把 Agent 该读的文档登记进来，下一次会话能自己找到，不必让你再贴一遍。
- **代码导航。** 查找代码时不必把整个仓库都交给 Agent。即使不安装额外工具，文本与结构搜索也能用。
- **协调多个 Agent。** 用可见、可追溯的工作流把一项任务拆给多个 Agent，并能把进行中的协调者角色交接给新的
  Claude Code 或 Codex 会话，而不丢失进度。
- **接入你的 Agent。** 通过 Pappra 的技能和钩子，Claude Code、Codex 和 Pi 可以读取检查点，而保存检查点
  是在你要求时才由技能执行。

按需取用即可。

## 看看效果

检查点是关于一项任务的备忘文件：任务是什么、怎样算完成、停在了哪里。新会话运行
`pappra resume demo`，拿到的是任务状态，而不是旧的对话记录：

```text
Task: demo
Checkpoint: checkpoints/0001-d523d72a-4553-4579-883d-93409c9df53e.json@1
Execution allowed: no
Context: complete
Code drift: unchanged
Verification: current
Objective: Try Pappra
Blocked: live_writer_unverified: P07 cannot establish live writer/stop ownership from a stored session string; execution remains blocked.
Blocked: unknown_writer: Checkpoint author session is unknown; execution is blocked.
Next: Write the first test
```

新会话由此得到目标、无法自行开工的原因，以及下一步，因此不必翻旧聊天就能继续。
`Execution allowed: no` 是有意为之：恢复只交接上下文，从不授予权限。具体跑什么由你和 Agent 决定。
命令的退出码是 `0`，还可能把只读诊断信息打印到 stderr。

## 快速开始

你需要 [Node.js](https://nodejs.org/) 24 或更高版本，以及 Git。别的都不需要：不需要 Agent，不需要
模型账号，也不需要任何额外服务。

**1. 在一个练习文件夹里完成 Pappra 的配置。** 在一个空文件夹里不带任何参数运行它。在终端里，这就是
全部的配置过程：它会问工作区名称、要包含哪些仓库、要登记哪些文档，而大多数问题都有默认值，按回车
接受即可。随后它打印将要写入的计划，在你确认一次之后应用，并逐项提供可选的后续步骤，每一步都可以
跳过：准备代码索引、登记它找到的文档、接入你的编码 Agent（Claude Code、Codex、Pi，包括 MCP 登记）、
运行健康检查。Pappra 需要一个至少有一次提交的仓库，所以练习文件夹里要先做一次空提交。

```sh
mkdir pappra-demo && cd pappra-demo
git init
git commit --allow-empty -m init
npx @phyzess/pappra@beta
```

现在你有了一个 `.pappra/` 目录。`.pappra/workspace.json` 是共享的，应当提交到 Git；
`.pappra/local/` 是私有的，会自动忽略自身，永远不会进入 Git。如果你每天都用 Pappra，就安装一次，
这样下面的步骤就能直接写 `pappra`：`npm install -g @phyzess/pappra@beta`。

<details>
<summary>脚本与 CI</summary>

显式标志绝不会提问：`init --yes` 只打印计划，`--apply` 才会写入。

```sh
npx @phyzess/pappra@beta init --yes
npx @phyzess/pappra@beta init --yes --apply
npx @phyzess/pappra@beta doctor
```

</details>

**2. 接入你的 Agent（可选）。** `pappra host install --host claude`（或 `codex`、`pi`）会把 Pappra
的技能和生命周期钩子加进那个 Agent，让它知道该在什么时候、以什么方式保存检查点。它会请你确认一次，
然后打印已经写入的文件。Pappra 绝不会替你回答 Agent 自己的信任提示，这一步由你在 Agent 里确认。
MCP 是另一项同样可选的步骤：`pappra host mcp install --host claude --apply` 会登记 `pappra mcp`，
它的工具大多是只读的，会写入的工具需要受信任的服务器启动策略。

```sh
pappra host install --host claude
```

**3. 把任务存成检查点，再恢复它。** 接好 Agent 之后，在你收工的时候让它保存一个检查点。你也可以在
练习文件夹里自己运行这两条命令：

```sh
pappra checkpoint --task demo --objective 'Try Pappra' \
  --acceptance 'A new session can pick it up' --next-action 'Write the first test'
pappra resume demo
```

第一条命令会在 `.pappra/local/tasks/demo/checkpoints/` 下写入一个检查点。第二条命令打印新会话看到的
内容，也就是上面那段输出。

## 工作原理

<p align="center">
  <img src="docs/assets/readme/how-it-works.zh-CN.svg" width="100%" alt="生命周期：会话 A 正常工作，然后把检查点写入 .pappra/local/；会话 B 在任意 Agent 中恢复它；随后你和 Agent 一起决定要运行什么。Pappra 只报告状态，绝不会自行开始工作。">
</p>

你和 Agent 像平常一样在一个会话里工作。当你收工时，让 Agent 把检查点写入 `.pappra/local/`，也就是
项目文件夹中私有的那部分：目标、已经做过的决定、试过什么、卡在哪里、下一步做什么。新的会话不论是哪个
Agent，都用 `pappra resume` 读这个文件，或者在任务用 `pappra task pin <id> --auto-resume` 固定之后，
由 Pappra 的钩子把它送达。没有任何东西会自动开始：你和 Agent 一起读这份交接，然后决定要运行什么。

## 接下来看什么

| 我想要…                                 | 看这篇                                                    |
| --------------------------------------- | --------------------------------------------------------- |
| 运行每条命令、查看每个标志              | [运维参考](docs/operations.md)                            |
| 接入 Claude Code、Codex 或 Pi（含钩子） | [快速开始](docs/quickstart.zh-CN.md)                      |
| 让 Agent 通过 MCP 使用 Pappra           | [Agent 原生用法](docs/agent-native.md)                    |
| 接管已有的多仓库工作区                  | [快速开始](docs/quickstart.zh-CN.md)                      |
| 把工作区搬到另一台机器                  | [可移植性](docs/portability.md)                           |
| 协调多个 Agent 完成同一项任务           | [协作工作流](docs/collaboration-workflow.md)              |
| 把协调者交接给新的会话                  | [协调者连续性](docs/cross-host-coordinator-continuity.md) |
| 启动由 Pappra 拥有的受管 Pi 会话        | [受管的 Pi 会话](docs/managed-pi.md)                      |
| 查看支持的版本与限制                    | [支持范围与限制](docs/support.md)                         |
| 基于 API 开发                           | [API 边界](docs/api.md)                                   |
| 参与 Pappra 本身的开发                  | [开发](docs/development.md)                               |

## 常见问题

**Pappra 会启动我的 Agent 或调用模型吗？** 不会。它只读写你项目里的文件；调用模型的只有你的 Agent，
而启动它的是你。

**Pappra 会替我确认 Agent 的信任提示吗？** 不会。接入 Agent 只是加上 Pappra 的技能和钩子，
Claude Code、Codex 或 Pi 里的首次确认由你完成。

**它和 `CLAUDE.md` 或 Agent 记忆有什么区别？** 那些文件保存的是长期指令，每次会话读到的内容都一样。
检查点记录的是一项任务的当前状态，包括做过的决定和下一步；它在你让 Agent 保存时写入（Agent 会运行
`pappra checkpoint`，技能里就是这么教的），或者由你自己运行这条命令写入。钩子只把已保存的检查点交给
下一个会话，不会自动保存任何东西。

**哪些内容会提交，哪些只留在这台机器上？** `.pappra/workspace.json` 应当提交。`.pappra/local/` 保存
检查点和本机设置；它会忽略自身，不会进入 Git。Pappra 本身的副本在你的用户数据目录里，所以清理
`npx` 缓存也不会弄坏它。

**试用它需要代码图或者 Agent 吗？** 不需要。有 Node.js 和 Git 就够了；没有 Agent 也能保存和恢复
检查点，没有配置代码图引擎时，代码导航会回退到文本搜索。

**为什么恢复结果里的“允许执行”是 no？** 因为交接上下文不等于授权执行。`Execution allowed: no` 是正常
结果；接下来做什么，由你和 Agent 决定。

## 状态

Pappra 是 beta 软件（`0.1.0-beta.23`），以 `@phyzess/pappra` 发布，使用 `beta` dist-tag。请固定到
`beta` 或某个确切版本，因为预发布版本绝不会被重新发布。哪些是受支持的、测试没有证明什么，见
[支持范围与限制](docs/support.md)。

## 许可证

Pappra 采用 MIT 许可证。见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
