# Finch

只读的 Java / Spring Boot / Spring Cloud 故障诊断 CLI。

## 本地开发

```bash
npm ci               # 按 npm-shrinkwrap.json 安装锁定版本依赖
npm run dev          # 编译并进入交互式诊断
npm run dev -- --help   # 编译并运行 CLI，可追加任意参数
npm run cli -- --version   # 直接运行已编译产物，不重新编译
npm run doctor       # 编译并执行 doctor
npm run init         # 编译并初始化用户配置目录
npm test             # 编译并运行全部测试
npm run clean        # 删除 dist
```

## 状态

已接入真实模型网关并完成端到端验证：模型可自动调用源码检索工具、
生成证据编号并在结论中引用；未编造源码或行号。

可用能力：

- **配置与检查**：`init`、`doctor [--remote]`、`provider` / `jumpserver` 向导。
- **三种日志入口**：提示词直接粘贴、`@本地日志文件`（普通与 `.gz`，
  有界读取并标记截断）、traceId 经 `/trace` 解析目标。
- **只读工具**：`source_search` / `source_read` / `local_log_search` / `local_log_read`，
  含文件名与行号，返回前先脱敏并登记为证据编号。
- **交互界面**：直接用 Pi 的终端界面（输入编辑、历史、补全、滚动与快捷键）。
  底部显示工作目录、Git 分支、模型与思考等级、token 用量与费用。
- **会话与知识**：`-c` / `-r` / `--sessions` 恢复会话；
  `/knowledge` 列表、检索、保存与失效标记。

尚未启用：

- **远程连接**。`/trace` 只做到目标解析、确认与工具环境检查；
  桥接脚本需在真实环境验证目标身份、终端回显与取消语义之后才会建立连接。
  在验证完成前不会连上任何服务器，避免在错误机器上取证。
- **`/audit`** 已记录每次工具操作的非敏感摘要（操作、目标、参数摘要、
  结果与授权编号，默认展示最近 10 条，不提供导出）。远程查询尚未接入，
  因此账本里目前只有本地操作。

## 安全边界

约束由扩展钩子收口，不依赖模型自觉：

- `!` / `!!` 本地 Shell 被永久禁止；模型工具集只含四个只读工具，
  MCP、codemode 与工具检索扩展一律不加载。
- **入口脱敏**：用户输入与工具结果在进入模型上下文之前都经同一个
  会话脱敏器处理，占位符（如 `<SECRET_1>`）在整轮对话中保持一致。
- **出口复核**：模型输出的最终消息会再过一次同一脱敏器（Spec 7.5），
  并在写入会话历史之前替换。流式过程中的字符先于该钩子渲染，
  因此这一层是纵深防御，不是唯一防线。
- **预算是硬边界**：`DIAGNOSIS_TIMEOUT_MS` 由 Agent 循环的起止钩子驱动计时，
  等待用户输入的时间不计入；到期后四个工具一律拒绝执行。
- **上限如实标记**：文件数、命中数、扫描字节数、行数任何一项触发上限，
  结果都会标明未覆盖，不静默丢弃。
- **引用校验**：模型引用了不存在的证据编号会当场提示，编造不会被当成事实。

## 安装

```bash
npm install --global --ignore-scripts \
  https://github.com/hayeslin-ai/finch/releases/download/v0.1.0/finch-0.1.0.tgz
```

升级时把版本号替换为 Release 页面上的新版本；不做静默自动更新。

npm 不会安装 Expect 与 oathtool；缺少它们只影响远程功能，本地诊断不受影响。
两者默认从 `PATH` 查找（`EXPECT_PATH` / `OATH_TOOL` 可覆盖）；Expect 登录脚本由 `finch init`、`finch doctor --remote` 或 `/trace` 自动生成到 `~/.config/finch/`，无需手工放置。

## 发版

版本号由合入 `develop` 的 PR 标题自动决定，不需要手改 `package.json`：

| PR 标题 | 结果 |
| --- | --- |
| `fix: …`、`perf: …` | 修订号 +1（`0.1.0` → `0.1.1`） |
| `feat: …` | 次版本号 +1（`0.1.0` → `0.2.0`） |
| 含 `BREAKING CHANGE:`，或类型后带 `!` | 主版本号 +1（`0.1.0` → `1.0.0`） |
| `chore:`、`docs:`、`test:` 等其余标题 | 不发版，只合入代码 |

合并即发布：校验通过后回写版本、打 `v<version>` tag、快进 `master`、
上传 `finch-<version>.tgz` 到 Release。首发与失败后补发走手动触发
（`level=none` 表示按当前版本原样发版）：

```bash
gh workflow run release -f level=none
```

> **首发前置**：`workflow_dispatch` 只识别默认分支上存在的同名工作流，
> 而 `master` 是默认分支、且只由本工作流推进。首发前必须先把 `develop`
> 推到 `master`（`git push origin develop:master`，需管理员绕过或临时
> 放开 `master` 禁推），否则首次触发会因工作流不在默认分支而返回 404。
> 此后 `master` 只随发版前移。

## 配置

```text
~/.config/finch/.env         连接参数与凭证（0600，人工编辑）
~/.config/finch/models.json  Pi 原生模型配置（0600）
```

只有一个模型时自动采用；有多个时用 `--model <provider>/<modelId>` 指定，
或启动后用 `/model` 切换（仅本次会话）。`/effort` 可切换思考等级。

可用命令：`/knowledge`（故障经验）、`/trace`（远程目标，暂不连接）、
`/audit`（最近的工具操作摘要）、`/model`、`/effort`。

模板见 `templates/`。真实配置不得提交到仓库。
