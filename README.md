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
  有界读取并标记截断）、`/remote` 自然语言远程查询。
- **只读工具**：`source_search` / `source_read` / `local_log_search` / `local_log_read`，
  含文件名与行号，返回前先脱敏并登记为证据编号。
- **远程日志查询**：`/remote <目标IP> <自然语言诉求>`。模型先做语义分析并用
  `remote_query_plan` 提交查询计划（目的、关键词、枚举范围、关注点），宿主弹窗
  确认后才登录目标机、核对远端主机名与账户；之后可用
  `remote_log_list` / `remote_log_search` / `remote_log_read` 按
  「枚举 → 搜索 → 读取」执行。计划被拒绝则终止，不建立任何连接；
  `/remote-close` 结束授权并断开连接。配额由 `.env` 的 `MAX_QUERY_COUNT`、
  `MAX_FILES`、`MAX_RESULT_LINES`、`MAX_RESULT_BYTES` 控制。
  搜索是 `grep` 字面量匹配，关键词仅限 ASCII；时间窗过滤尚未实现。
- **交互界面**：直接用 Pi 的终端界面（输入编辑、历史、补全、滚动与快捷键）。
  底部显示工作目录、Git 分支、模型与思考等级、token 用量与费用。
- **会话与知识**：`-c` / `-r` / `--sessions` 恢复会话；
  `/knowledge` 列表、检索、保存与失效标记。
- **`/audit`** 记录每次工具操作的非敏感摘要（操作、目标、参数摘要、
  结果与授权编号，默认展示最近 10 条，不提供导出），本地与远程操作共用同一账本。

尚未启用：远程查询的时间窗过滤（`--since` / `--until`）与查询取消宽限期；
超时仍按“终止状态未知”弃用连接。

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
  https://github.com/hayeslin-ai/finch/releases/latest/download/finch.tgz
```

上面的地址永远指向最新版，不需要随版本修改；升级时重新执行同一条命令即可
（npm 会覆盖旧版本；不做静默自动更新）。需要固定版本时，改用 Release 页面上
该版本的 `download/v<version>/finch-<version>.tgz` 地址。

npm 不会安装 Expect 与 oathtool；缺少它们只影响远程功能，本地诊断不受影响。
两者默认从 `PATH` 查找（`EXPECT_PATH` / `OATH_TOOL` 可覆盖）；Expect 登录脚本由 `finch init`、`finch doctor --remote` 或 `/remote` 自动生成到 `~/.config/finch/`，无需手工放置。

## 发版

发版由人工推送 `v<version>` tag 触发；CI 不判定版本、不回写仓库、不创建 tag。
版本号按语义化版本选取：`fix` / `perf` → 修订号，`feat` → 次版本号，
破坏性变更（`BREAKING CHANGE:` 或类型后的 `!`）→ 主版本号。

1. 在 `develop` 上写入版本（三处文件必须同提交）：

   ```bash
   npm run build
   node dist/scripts/release/cli.js apply --version 0.1.1
   git commit -am "chore(release): v0.1.1"
   git push origin develop
   ```

2. 打附注 tag 并推送：

   ```bash
   git tag -a v0.1.1 -m "finch v0.1.1"
   git push origin v0.1.1
   ```

tag 推送后 CI 依次执行：校验 tag 在 `develop` 上且版本一致 → 类型检查与测试 →
构建 `finch-<version>.tgz` 与 `SHA256SUMS` → 隔离安装冒烟 → 创建 draft Release 并
校验资产 → 发布（仅最高版本拿 Latest）→ 快进 `master` → Ubuntu/macOS 从公开链接
重新安装验证。

补发与修复（tag 已推送但 Release 缺失或不完整）：

```bash
gh workflow run release -f tag=v0.1.1
```

Release 已完整时该命令只做校验并成功返回；缺资产时从 tag 重建补齐；
已推送的 tag 永不移动或删除。

## 配置

```text
~/.config/finch/.env         连接参数与凭证（0600，人工编辑）
~/.config/finch/models.json  Pi 原生模型配置（0600）
```

只有一个模型时自动采用；有多个时用 `--model <provider>/<modelId>` 指定，
或启动后用 `/model` 切换（仅本次会话）。`/effort` 可切换思考等级。

可用命令：`/knowledge`（故障经验）、`/remote`（远程只读查询）、
`/remote-close`（结束远程授权）、`/audit`（最近的工具操作摘要）、`/model`、`/effort`。

模板见 `templates/`。真实配置不得提交到仓库。
