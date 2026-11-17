# Architecture decisions

记录会影响多个模块、公共契约或长期成本的取舍。

本文件由 62 个提交（2026-11-05 至 2026-11-17）的正文回填，保留当时的讨论上下文、
被否掉的方案与后续反转。证据列使用短 commit 哈希；同一决策可能由多个提交支撑。

## 格式

### YYYY-MM-DD — 决策标题

- Context: 要解决的问题、约束和已排除方案。
- Decision: 采用的边界、协议或机制。
- Consequences: 正向收益、维护成本和迁移/回滚方式。
- 证据：commit…
- Status: accepted | superseded by <link>

---

### 2026-11-05 — 产品形态：只读诊断 CLI + 三类日志入口 + 轻量知识库

- Context: 目标是 Java / Spring Boot / Spring Cloud 故障诊断。候选形态包括 Web 平台、
  多 Agent、常驻服务；讨论后排除，理由是单人维护成本与只读安全边界难以保证。
- Decision: 单机 CLI；日志入口为提示词粘贴、显式 `@` 本地附件、经堡垒机远程查询三种；
  源码限制在单个本地仓库；故障经验以人工确认的版本化 Markdown 保存。
- Consequences: 全部能力本地可验证、无服务端组件；代价是不支持跨服务串联、
  不做数据库/监控/进程诊断，日志与源码读取必须有界。
- 证据：3e14d7c（PRD V1）、de25208（知识库纳入 V1）、f070e81（三种日志入口）
- Status: accepted

### 2026-11-06 — 技术方向：Node.js + TypeScript + Pi SDK 单进程

- Context: 历史试作包含 Python 导出器、`PI_MODELS_JSON` 与仓库本地配置，均被用户否定；
  讨论过是否保留 Python 工具链。
- Decision: 单个 Node 进程，TypeScript 为唯一应用语言；Expect 作为已有外部登录适配例外；
  模型使用 Pi 原生 `models.json`，不经过导出工具；锁定 Pi SDK 1.5.0、typebox 1.3.27、
  TypeScript 7.0.2；ESM、tsc、`node:test`，不引入 zod、tsx、node-pty 与测试框架。
- Consequences: 依赖面小、分发为单个 tarball；Pi 的集成契约被写进 Spec 并有契约测试守护。
  Python 链路删除后只保留在 Git 历史中，不再作为验收基线。
- 证据：6d59aa0（TECH_SPEC 1.0）、16dc326（凭证迁移）、87c097e（工具链与 SDK 契约测试）
- Status: accepted

### 2026-11-06 — 模块化单体 + 七个扩展端口 + 单向依赖

- Context: 用户要求预留扩展点，同时明确不提前拆微服务、不引入后台进程。
- Decision: 依赖方向固定为 `ports ← core ← app/composition ← cli/适配器`，由唯一组装根接线；
  定义 Interaction、LogSource、Repository、AgentRuntime、SessionStore、KnowledgeStore、
  ReportRenderer 七个端口；所有模型可调用工具只能在组装根显式注册；核心不得导入 Pi。
- Consequences: 依赖方向由 `tests/unit/architecture.test.ts` 静态导入图强制；
  端口只降低替换成本，不自动获得同等安全保证，新适配器必须复用统一权限/脱敏/预算链路。
- 证据：94ed863、c871d1a
- Status: accepted

### 2026-11-06 — 分发与安装：GitHub Release tarball，不发 npm registry

- Context: 讨论过 npm publish、Homebrew、源码安装；前两者需要额外账号与供应链维护。
- Decision: 包名 `finch`、命令名 `finch`，通过 GitHub Release 的
  `finch-<version>.tgz` 分发，同时上传固定名 `finch.tgz` 供
  `releases/latest/download/finch.tgz` 使用；安装必须带 `--ignore-scripts`。
- Consequences: README 不随版本变动；SHA256SUMS 覆盖两类产物。
  代价是安装命令较长，且需在发布流程中额外维护固定名资产。
- 证据：8298653（包名与分发方式）、567d689（latest 稳定链接）、f9790f5（完整性校验）
- Status: accepted

### 2026-11-06 — 配置归属与来源：用户目录为唯一位置，能推导的项不进配置

- Context: 配置位置在一天内经历三次反转：`.env` 先在用户目录，c1c4525 迁到项目目录
  （认为连接信息属于具体项目），a6bd2fd 又全部迁回用户目录（连接信息属于个人环境、
  跨项目共享）。同时讨论过 `settings.json` 是否必要。
- Decision:
  1. `.env`、`models.json` 固定放在 `~/.config/finch/`（目录 0700、文件 0600），
     不搜索仓库或 `~/.pi/` 的其他配置。
  2. `settings.json` 在 abd9580 中删除：`models.json` 已描述候选模型，
     当前选择改为运行时决定，不落盘。
  3. `REPO_ROOT`、`SERVICE_ID` 改为启动目录 + `git rev-parse --show-toplevel` 推导，
     `.env` 中的遗留旧值一律不采用。
  4. 工具路径（`EXPECT_PATH`、`OATH_TOOL`）只从进程环境变量读取，不写入配置文件；
     `TARGET_HOST` 被移除，残留键仅作废弃提示。
- Consequences: 配置项大幅减少，换机器与换项目无需改配置；代价是无法按项目保存
  不同连接参数，且所有读取方（运行时、doctor、向导）必须共用同一入口。
- 证据：c1c4525、224a4e9、a6bd2fd、abd9580
- Status: accepted（c1c4525 的“项目目录 .env”方案已被 a6bd2fd 取代）

### 2026-11-06 — 模型选择：唯一候选自动采用，多候选显式指定，禁止静默回退

- Context: 讨论过用配置文件保存“当前模型”，但该状态与可用模型列表重复，
  且会话内切换不应污染磁盘。
- Decision: 只有一个候选时自动采用并在界面如实标注；多个候选时要求
  `--model <provider>/<modelId>`，绝不静默挑第一个；显式指定的模型不存在时直接报错，
  不回退到唯一候选；模型 ID 按第一个斜杠切分，兼容 `group/md-default` 这类含斜杠的值。
  `/model` 与 `/effort` 仅对本次会话生效。
- Consequences: 用户写下的选择不会被替换；代价是多候选环境下必须显式传参。
- 证据：abd9580、96a0b89
- Status: accepted

### 2026-11-06 — 交互形态：行式 CLI、approve 关键字、审计账本

- Context: 讨论过 rich 分屏、全屏 TUI 与系统弹窗。主要动作是粘贴大段日志和阅读证据，
  全屏会破坏终端回滚与复制、干扰多行粘贴，并使测试依赖终端模拟器。
- Decision: 行式 CLI + 单行状态行；危险操作要求输入完整 `approve`（大小写敏感、单独成行、
  粘贴内容不生效）；所有工具操作写入同一会话审计账本，`/audit` 默认最近 10 条，
  不提供导出；界面措辞使用“授权范围”而非“权限”。
- Consequences: 自动化测试不依赖终端模拟器；代价是无法做复杂富交互。
  该决策在 2026-11-07 被 Pi InteractiveMode 取代了输入层实现，但 approve 与审计规则保留。
- 证据：b76d380
- Status: superseded by 2026-11-07 — 交互界面改用 Pi 自带 InteractiveMode（业务规则保留）

### 2026-11-06 — 远程查询：固定命令白名单 + 结构化查询 + 目标机网段限制

- Context: 讨论过让模型生成 shell 命令，或在服务器上执行任意命令；两者都会突破只读边界。
  用户提供真实日志样本，确认存在 `.gz` 轮转，并同意加入 `sed` 区间读取与 `awk` 时间过滤。
- Decision: 命令只来自代码内审核过的固定模板；模型只能提交 fileRef、queryRef、时间窗、
  方向与数量，不能提交命令名、选项或路径；目标机只允许 `22.50.0.0/16` 与 `10.80.0.0/16`
  内的 IPv4 字面量，每次连接都必须确认并核对身份；拒绝递归、`-f`、`tail -f`、
  `-exec`、`xargs`、`sh -c`、`eval`、命令替换与重定向。
- Consequences: 远程能力受模板覆盖范围限制；新增查询必须先补模板与测试。
  目标机网段限制在 2026-11-09 的 `/remote` 改造中继续保留。
- 证据：9ca46a4、e46e509
- Status: accepted（目标解析方式已被 49087b5 取代，网段与确认规则保留）

### 2026-11-06 — 日志记录模型：整条记录为证据单位，最后一个 ERROR 为锚点

- Context: 用户提供真实日志样本并纠正关键规则：执行遇错会中止，因此应以时间线最后一个
  ERROR/FATAL 为终止锚点，而不是第一个错误；早期 WARN 与被 catch 后继续执行的异常
  不是根因。
- Decision: 记录头固定 8 段加消息；记录边界以行首时间戳判定，Java 异常续行归属上一条记录；
  以整条记录为证据单位，截断只允许发生在记录之间；级别按第 7 段判定而非整行关键词；
  先建立时间线，再定位最后一个错误，级联错误向前回溯触发点但不强行关联。
- Consequences: 证据更完整、可排序；代价是单条超限时只能标记 `truncated="record"`，
  不能部分返回。
- 证据：65dc7b7、9ca46a4
- Status: accepted

### 2026-11-06 — 源码定位边界：同仓库多模块可查，外部依赖止于调用点

- Context: 用户追问“项目 A 依赖 B、B 依赖 C，异常由 B 或 C 抛出时是否继续深挖”。
  无限深挖会拉取其他仓库并虚构依赖内部实现。
- Decision: 同一构建内的多模块可继续检索；外部 jar、其他仓库与私有制品只分析本仓库的
  调用点、参数、异常处理与配置，不读取依赖源码、不拉取仓库、不切换分支、不按类名反推；
  第三层根因无法证明时标为待核实并给出核实请求；构建声明的依赖版本不等于线上版本。
- Consequences: 结论可证明、可复核；代价是部分根因只能停在“调用点 + 待核实”。
- 证据：c871d1a
- Status: accepted

### 2026-11-06 — 系统依赖与 doctor：npm 不装系统二进制，检查分层

- Context: 用户询问 npm 安装是否会带上 Expect 与 oathtool。答案是否定的，且不应通过
  postinstall 自动安装或打包 GPLv3 二进制。
- Decision: Node 必需、Git 推荐、Expect 与 oathtool 仅远程需要；禁止
  postinstall/preinstall 执行 brew、下载二进制或编译；可执行文件默认从 PATH 解析，
  显式路径必须是绝对路径、普通文件、当前用户可执行，校验失败不回退；
  doctor 分基础/本地诊断/远程/可选四组，远程缺失不阻断本地诊断，退出码 0/3 分层。
- Consequences: `--ignore-scripts` 可验证，安装无提权；代价是远程功能需要用户自行装依赖。
- 证据：f4823ec、e75e71e
- Status: accepted

### 2026-11-06 — 会话恢复：三个入口共用同一实现，授权与预算不恢复

- Context: 用户询问是否存在 `/resume` 或 `finch -c`；讨论过恢复时是否自动重放工具调用、
  是否恢复远程授权。自动重放会复用旧授权，突破按次审批。
- Decision: `finch -c`、`finch -r <id>`、`--sessions` 与 `/resume` 共用
  `restoreSafeSnapshot`；`-c` 直接恢复最近活跃会话、不追加确认；恢复脱敏对话、证据、
  结论与预算消耗记录，但不恢复远程 grant、本地附件授权、原始 traceId、密钥与占位符映射；
  恢复后第一次远程操作必须重新连接并重新审批；并发用锁文件，损坏时不覆盖原文件。
- Consequences: 恢复安全、可预测；代价是每次恢复后需要重新指定附件与远程目标。
- 证据：40c2cf0
- Status: accepted

### 2026-11-07 — 交互界面改用 Pi 自带 InteractiveMode，删除自研输入组件

- Context: 自研输入界面连续三次提交（9971538、ea75fe6、5d7f0bc）修复按键解析、
  多行粘贴、光标定位与历史回溯，每次修复都引入新的边界缺陷。
- Decision: 直接使用 Pi 的 `InteractiveMode`，输入编辑、历史、补全、滚动、主题与快捷键
  全部交给框架；资源加载只启用本产品扩展，关闭技能、提示模板、主题与项目上下文文件；
  系统提示词固定；删除 `src/cli/ui.ts` 与 `src/cli/repl.ts` 共 1363 行。
- Consequences: 维护面大幅缩小；代价是交互行为受 SDK 约束，只能用官方钩子扩展。
  用 `user_bash` 钩子继续拦截 `!`/`!!`，只读工具白名单保持不变。
- 证据：16477d7、9971538、ea75fe6、5d7f0bc
- Status: accepted

### 2026-11-07 — 删除未接线的编排层，职责迁移到扩展钩子

- Context: 审查发现 `core/diagnosis.ts`、`agent/turn-runner.ts` 的整套编排已被 Pi 会话循环
  取代，但同时 `budget.start()`、`parseUserInput`、`appendEvent`、`AuditLedger` 等
  写完后从未被调用，功能真实不可达。
- Decision: 删除重复编排层，预算、审计、引用校验、附件登记全部改由扩展生命周期钩子驱动；
  新增 `tests/integration/assembly.test.ts`，跑真实 `compose()` 断言工具白名单、
  扩展触发与会话落盘。
- Consequences: 代码路径唯一、可测；代价是任何新能力都必须在组装根接线，并有集成测试证据。
- 证据：1044abe、7134e95、ef0d965
- Status: accepted

### 2026-11-07 — 发布触发：PR 标题驱动自动发版 → 手动 tag 触发

- Context: 第一版按 Spec 4.1.1 实现 PR 标题驱动（BREAKING/feat/fix 判定级别）+
  master 发布镜像，全程只用 `GITHUB_TOKEN`。随后评估单人仓库没有跨仓库签名与
  密钥隔离需求，自动发版反而让发布节奏与版本语义难以控制。
- Decision: 79f8b90 的分支模型（develop 集成、master 发布镜像、`v<version>` tag 为权威标识）
  保留；触发方式改为人工推送 `v<version>` tag，CI 不再响应 PR 合入、不判定级别、
  不回写 develop。发布前校验 tag 形态、tag 提交在 `origin/develop` 上、版本三处一致；
  先建 draft Release 并校验资产名齐全，再判定 Latest；补发幂等，已推送 tag 永不移动。
- Consequences: 发布是显式动作、可审计；代价是版本号与 tag 需要人工回写。
- 证据：79f8b90（初版）、f9790f5（取代）
- Status: superseded by f9790f5（手动 tag 触发）

### 2026-11-09 — 远程查询入口：/trace traceId → /remote 自然语言 + 计划确认门禁

- Context: `/trace` 以 traceId 为入口，但用户实际诉求是“查某个现象”，traceId 只是搜索线索；
  同时旧流程在确认后即建立授权，缺少对查询目的与范围的审批。
- Decision: `/remote <目标IP> <自然语言诉求>` 登记内存态待确认请求，再由模型先做语义分析；
  `remote_query_plan` 工具是唯一授权入口，宿主展示目标、诉求、目的、关键词、枚举范围与配额，
  确认后才登录并建立 grant；拒绝、无 UI、登录失败都清空 pending；一次请求只允许提交一次计划。
  删除 `/trace`、`parseTraceCommand`、target-resolver、recent-targets 与默认/最近目标推断。
- Consequences: 授权与真实诉求绑定、按次生效；代价是入口从确定参数变为自然语言，
  需要模型先分析，且时间窗查询仍未实现。
- 证据：49087b5、4ea39c1
- Status: accepted（取代 e46e509/6ec728a 的 traceId 入口）

### 2026-11-09 — 远程桥接协议：Expect SSH PTY + DONE 终态 + fileRef + 配额

- Context: 旧链路无法区分“grep 未命中（退出码 1）”与“命令失败（退出码 ≥2）”；
  模型若能看到远端绝对路径，会扩大信息暴露面；远端脚本被改坏时宿主不能跟着失控。
- Decision: 复用 Expect 内部 SSH PTY，不引入原生 PTY 依赖；固定 LIST/SEARCH/READ 操作，
  每条命令用请求 nonce 生成双标记；新增 DONE 终态帧携带 status/exit/matched/truncated/
  bytes/lines，解析失败按协议错乱处理；`READY` 一次性探测能力，未探测到的能力视为不支持；
  模型只提交 fileRef，路径由宿主解析；`RemoteSession` 设置结果字节与行数上限；
  每次尝试（含失败与重试）都消耗配额；授权结束后迟到的结果丢弃。
- Consequences: 远端行为可验证、可限额；代价是协议与脚本需同步演进，且真实环境联调
  仍是启用前提。
- 证据：4ea39c1、e75e71e、49087b5
- Status: accepted

### 2026-11-11 — 更新检查与升级：显式 update 子命令 + footer 限期提示

- Context: 升级只能手工复制 README 命令；`ctx.ui.notify` 会把文本永久追加进聊天区，
  不会超时消失；`ctx.ui.confirm` 默认聚焦 Yes，误按回车会写全局目录。
- Decision: `finch update` 查版本 → 查可写性 → 确认 → 安装 → 回读校验；非 TTY 且无 `--yes`
  直接拒绝；失败非零退出并打印手工命令。交互式启动时后台检查新版本，用 footer 的
  `setStatus` 提示 15 秒；24 小时 TTL 缓存，拒绝后持久化 skipped，
  `FINCH_NO_UPDATE_CHECK=1` 彻底关闭；裸键监听必须同时满足“提示存续、输入框为空、
  模型空闲”才消费按键；不可逆操作使用 `ui.select` 且取消置首。
- Consequences: 升级路径可验证且不打扰；代价是多一个缓存文件与按键监听生命周期管理。
- 证据：00f058c、ab11dc7
- Status: accepted

### 2026-11-17 — 配置模板单一事实来源：init 运行时读取 templates/

- Context: `init` 内联 `ENV_TEMPLATE` / `MODELS_TEMPLATE`，与 `templates/` 下的模板逐渐分叉：
  `.env` 缺 `JUMP_HOST`/`JUMP_PORT`，`models.json` 少示例 provider，用户拿到的配置与
  仓库模板互相矛盾。
- Decision: `init` 直接读取包内 `templates/env.example` 与 `templates/models.example.json`
  原样写入，模板成为唯一事实来源；模板缺失时返回具体路径并失败，不静默生成空配置；
  新增“init 产物与 templates/ 逐字一致”回归测试，并用 `npm pack --dry-run` 确认模板在
  发布产物内。
- Consequences: 模板只维护一份；代价是运行时依赖发布包必须包含 `templates/`，
  已在 `package.json` 的 `files` 中固定。
- 证据：c0ba7d6
- Status: accepted
