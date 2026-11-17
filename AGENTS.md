# AGENTS.md — Node.js + TypeScript CLI 经验与进化

## 项目

Finch 是面向 Java / Spring Boot 的**只读**故障诊断 CLI，技术栈为 Node.js + TypeScript（ESM、npm、tsc、node:test）。Agent 修改代码前必须读 `LESSONS.md` 与 `docs/code-standards.md`。

## 命令（按仓库实际改，必须可复制）

- 构建：`npm run build`
- 局部验证：`npm run typecheck`
- 相关测试：`npm run build && node --test dist/tests/unit/redactor.test.js`（替换为实际模块测试路径）
- 全量测试：`npm test`
- 本地启动：`npm run dev`（交互诊断需 TTY；子命令见 `finch --help`）
- 格式与静态检查：`npm run typecheck`（仓库未配置独立 formatter/linter，不擅自引入）

包管理只使用 npm，锁文件为 `npm-shrinkwrap.json`，Node 版本以 `package.json` 的 `engines` 为准；禁止混用包管理器或擅自升级 lockfile 格式。

## 工作方式

- 先用一句话复述目标；需求不清就问，不猜业务规则。
- 做最小改动；不顺手重构无关模块。
- 优先在现有模块边界内修改，不跨层乱调。
- 完成时在 commit 或 PR 写明跑了哪些命令、所在 commit、手测场景和未验证部分。

## 错题本触发

完成业务修复或 PR 前，按 `.claude/loops/lessons-capture.md` 检查：
- Bug 修复、返工、审查打回、契约变更、临时绕过和环境差异是触发点。
- 命中已有规则就追加日期和证据；未命中才新建一句话规则。
- 同一规则在 3 个不同日期命中时，PR 完成前提议晋升到硬规则。

## 技术栈约定

- 运行时与语言：Node.js ≥ 22.19.0，`"type": "module"`；TypeScript strict 全开（含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）；相对导入必须带 `.js` 后缀。
- 依赖方向：`src/core/` 只依赖 `src/ports/` 定义的端口；具体适配器只在 `src/app/composition.ts` 组装根注入，禁止核心模块直接 import 适配器或 CLI 层。
- 只读边界：不得写业务仓库、服务器、数据库或服务配置；仅允许写 `~/.config/finch/` 配置、脱敏会话和经人工确认的知识。
- 外部进程与远程：`expect`、`oathtool` 与 SSH 交互必须走 `src/remote/` 既有封装；超时、退出码、stderr 必须进入错误路径，禁止拼接 shell 字符串。
- 安全与脱敏：业务内容外发、展示或落盘前必须经 `src/security/redactor.ts`；密钥只从 `~/.config/finch/.env` 和 `models.json` 读取，不进入日志、错误信息或测试快照。
- 输出契约：结果走 stdout，错误与诊断走 stderr；退出码遵循 `0 成功 / 2 用法错误 / 3 不可用`；未实现的命令必须明确失败，不得静默成功。
- 上限与截断：文件、行数、远程输出达到上限时必须如实标记截断或未覆盖，禁止静默丢弃后报告“未找到/完整扫描”。
- 验证：行为变更必须有能在旧实现上失败的 `node:test` 测试；外部进程、模型网关和堡垒机使用测试替身，架构依赖由 `tests/unit/architecture.test.ts` 守护。

## 禁区

- Never：提交真实密码、AK/SK、私钥、本地产物和无意义的 lock 噪声。
- Do：密钥只从 `~/.config/finch/.env` / `models.json` 读取，文档只写变量名。
- Never：在未说明的情况下操作生产数据或执行不可逆操作。
- Do：数据结构变更先设计迁移和回滚，再扩展代码。
- Never：把校验、鉴权或只读边界只放在模型提示词、工具描述或系统提示里。
- Do：宿主在工具执行前完成 schema、路径、权限与预算校验。
- Never：吞掉读取、解析、子进程或请求失败，让异常表现为空状态或成功。
- Do：失败进入明确错误处理路径，保留可定位日志并返回既有退出码。
- Never：远程登录或查询执行写命令，或复用上一次授权。
- Do：每次远程查询单独审批，授权不跨会话恢复。

## 测试最低要求

- 修 bug 至少补一条在旧代码上会失败的测试。
- 涉及 CLI 入口、退出码、远程协议或权限时，优先使用 `tests/unit`、`tests/integration` 现有风格。
- 涉及外部进程（expect/oathtool/SSH）、模型网关或文件系统时使用测试替身与临时目录，不访问真实外网、真实服务器或真实凭证。
- 测试命名和目录结构跟随目标模块现状；架构依赖由 `tests/unit/architecture.test.ts` 守护。

## 路由

- 近期失败与返工规则：`LESSONS.md`
- 已晋升硬规则：`docs/code-standards.md`
- 架构取舍：`docs/decisions.md`
- 模块差异：`<module>/AGENTS.md` 或 `docs/subsystems/<name>.md`
