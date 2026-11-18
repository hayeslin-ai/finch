# Lessons from work events

本仓库代码常由 coding agent 编写与修改。
按事件触发记录：Bug 修复、返工、PR 打回、契约变更、临时绕过和环境差异。
完成关口必须先查重：命中已有规则就追加日期；未命中才新建条目。

每条格式：
**<一句话规则>**
- 证据：issue/commit、后果
- 修复：commit（可选）
- Done right: 正例（可选）
- Seen N× (YYYY-MM-DD, …)

同一条在 3 个不同日期出现，移入 `docs/code-standards.md`。

<!-- recent-hits: 2026-11-17 -->

## 历史覆盖（62 个提交，2026-11-05 至 2026-11-17）

- 类型分布：feat 22、docs 18、fix 11、chore 6、refactor 4、test 1。
- 高频改动面：`tasks/todo.md` 28、`README.md` 21、`docs/TECH_SPEC.md` 20、`docs/PRD.md` 19、`src/cli/main.ts` 16、`src/cli/repl.ts` 9、`src/app/composition.ts` 9、`.github/workflows/release.yml` 9。
- 返工集中面：发布流程 7 个 fix、配置与 init 6 个 fix/refactor、接线与生效 4 个、远程授权 2 个。
- 以下规则均由真实提交回填，证据以 commit 哈希定位；同一提交可支撑多条规则。

## A. 接线与生效

**新增能力必须在唯一组装根接线，并由经过真实 compose() 的集成测试断言副作用；类型检查与单元测试全绿不代表功能可达。**
- 证据：ef0d965 中 `budget.start()` 全仓库零调用，`DIAGNOSIS_TIMEOUT_MS` 这条安全边界从未生效；1044abe 中 `parseUserInput`、`appendEvent`、`AuditLedger`、`config.limits` 四处写完但零调用，附件、会话记录、审计与限额全部不可达；7134e95 因此新增 `tests/integration/assembly.test.ts`。
- Done right: 集成测试断言模型可调用工具白名单、扩展钩子真实触发、会话事件真实落盘，而不是只测单个模块。
- Seen 3× (2026-11-07)

**删除或替换模块后必须全仓搜索残留引用、配置键与测试，旧路径不得继续被读取。**
- 证据：16477d7 删除自研 UI 后 `repl.ts` 中的预算启动逻辑一并消失（ef0d965 修复）；a6bd2fd 迁移模型键后 `composition` 仍读旧位置（96a0b89 修复）；49087b5 删除 `/trace` 时同步删除 target-resolver、recent-targets 与对应测试。
- Done right: 删除模块的同一提交内用 `grep`/测试证明无残留调用。
- Seen 3× (2026-11-07, 2026-11-09)

## B. 配置与资源

**每个配置项只能有一个存放位置和一个读取入口；迁移配置键必须同一提交内搜索全部读取方、doctor 与测试。**
- 证据：c1c4525 与 a6bd2fd 在两天内把 `.env` 从用户目录迁到项目目录又迁回；a6bd2fd 把模型选择移入 `settings.json` 后 `composition` 仍读 `.env`（96a0b89 修复）；74d774a 中 doctor 从 `config.values` 读工具路径、运行时却从 `process.env` 读，导致探测恒为 skipped；c0ba7d6 中 init 内联模板与 `templates/` 逐渐分叉。
- Done right: 运行时与 doctor 共用同一个 `readRemoteTools()` / `loadConfig()`；配置迁移时清理旧键、旧检查与旧测试。
- Seen 7× (2026-11-07, 2026-11-17)

**运行时资源（模板、登录脚本）只保留一份事实来源，从 templates/ 或 assets/ 原样读取，并用 npm pack --dry-run 验证发布产物包含。**
- 证据：c0ba7d6 内联 `ENV_TEMPLATE`/`MODELS_TEMPLATE` 缺少 `JUMP_HOST`/`JUMP_PORT`，用户拿到的配置与仓库模板矛盾；52931be 清理失效的 `.gitignore` 规则与模板注释；e75e71e 登录脚本随包生成而非另存副本。
- Done right: 新增“init 产物与 templates/ 逐字一致”回归测试，并检查 pack 清单。
- Seen 3× (2026-11-07, 2026-11-08, 2026-11-17)

**能推导的配置不要要求用户填写；遗留旧值必须忽略，并在模板与文档中说明推导规则。**
- 证据：224a4e9 把 `REPO_ROOT`/`SERVICE_ID` 改为启动目录与 Git 根推导，明确不采用 `.env` 旧值；a6bd2fd 移除 `TARGET_HOST`，残留键只作废弃提示；`assets/login_agent.exp` 曾把 `OATH_TOOL` 当必填，而 `~/.config/finch/.env` 不含该键（doctor 与向导都把它当 PATH 可选覆盖），手工联调必失败。
- 修复：`OATH_TOOL` 缺失时回退到 PATH 中的 `oathtool`；finch 注入的绝对路径仍优先。
- Seen 3× (2026-11-07, 2026-11-18)

**随包分发到配置目录的脚本必须按安装布局定位自己的配置，手工联调路径不能只按仓库布局假设。**
- 证据：`assets/login_agent.exp` 的 `load_dotenv` 只读 `[file dirname [info script]]/../.env`；安装后脚本位于 `~/.config/finch/`，真实 `.env` 在同目录，上级是 `~/.config/`，手工运行必报“缺少必需配置：JUMP_HOST”。
- 修复：同目录 `.env` 优先，仅 `assets/` 布局回退上级目录；已存在的环境变量优先，finch 注入的配置不被文件覆盖。
- Seen 1× (2026-11-18)

## C. 上限、错误与资源边界

**达到任何上限（文件数、行数、字节、远程配额）必须如实返回 truncated/skipped 计数；禁止静默丢弃后报告“未找到/完整扫描”。**
- 证据：ef0d965 中 `collectFiles` 达 `maxFiles` 返回 true，16 个命中文件、上限 4 时仍报“已扫描 4 个、无截断”；74d774a 中正常区间读取被无条件标记 `truncated=tail`，且区间读取缺少扫描预算；4ea39c1 远程会话增加结果上限并如实上报。
- Done right: 上限触发时返回精确未覆盖数量；正常读完与被迫截断分开判定。
- Seen 3× (2026-11-07, 2026-11-09)

**读取外部文件、日志或知识条目必须流式按需读取并设扫描预算，禁止整文件载入后再切片。**
- 证据：74d774a 的 `readSourceRange` 改为 `createReadStream + readline`；`readLocalRange` 前置行计入扫描上限；`searchKnowledge` 只预读 4 KiB 文件头，避免为过滤载入全文。
- Seen 1× (2026-11-07)

**只捕获预期异常类型；程序缺陷必须上抛，不得被宽泛 catch 伪装成参数错误、空结果或成功。**
- 证据：ef0d965 的 `error instanceof QueryValidationError || error instanceof Error` 让前一个分支成为死代码；74d774a 的 spawn 未监听 error 事件，缺少外部程序时整个 CLI 崩溃；4ea39c1 区分 grep 退出码 1（未命中）与 ≥2（命令失败），缺终态不当作成功。
- Done right: 子进程 error、stdin EPIPE、stdout/stderr 流错误分别处理；未知异常继续上抛。
- Seen 3× (2026-11-07, 2026-11-09)

**命令退出码为 0 不等于结果正确；安装、写盘、发布必须回读产物验证。**
- 证据：00f058c 安装后回读 `package.json` 的 version，而不是信任 npm 退出码；4ea39c1 的 DONE 帧携带真实 exit/status/matched/truncated；ec503e6 证明下载命令不因某个资产缺失而失败。
- Seen 3× (2026-11-09, 2026-11-11)

**会话或进程结束必须释放预算、监听与脱敏映射，并等待异步落盘；取消是不可复活终态。**
- 证据：ef0d965 把 `cancelled` 定为终态并在 `dispose` 调 `budget.cancel()`；1044abe 的 `dispose` 等待 recorder 写完最后事件；ab11dc7 的按键监听在提示结束或触发后立即解绑。
- Seen 3× (2026-11-07, 2026-11-11)

## D. 测试与验收

**测试必须与运行机器无关：显式注入临时 HOME、固定 git 身份、从源码常量取版本、使用绝对路径；不得依赖开发机配置。**
- 证据：55bc784 的集成测试继承开发机 HOME，本地绿、CI 红；288ec9b 本地全局 git 身份掩盖了 CI 上 `level=none` 的 tag 失败；f9790f5 的安装测试硬编码 0.1.0；93ddc13 相对 tgz 路径被 npm 当作 GitHub 简写。
- Done right: `mkdtemp` 注入 HOME 并在 `after` 清理；CI 独立配置身份；测试从 `src/version.ts` 导入 `VERSION`；脚本使用 `$GITHUB_WORKSPACE` 绝对路径。
- Seen 4× (2026-11-07, 2026-11-09)

**修 bug 的测试必须在旧实现上失败；“写完没接线”“读错配置来源”这类缺陷只能由经过组装根的集成测试兜住。**
- 证据：7134e95 新增 assembly 测试；55bc784 用空 HOME 复现错误结论；74d774a 用不存在的可执行文件验证 error 监听；c0ba7d6 用逐字比对验证 init 产物。
- Seen 4× (2026-11-07, 2026-11-17)

**测试夹具必须使用合成数据；真实 traceId、主机名、手机号、邮箱、内网地址一律替换。**
- 证据：49087b5 将真实 traceId、目标主机、公司/服务/任务标识替换为示例值，私网地址改为 RFC 5737 文档地址。
- Seen 1× (2026-11-09)

**审查报告与缺陷报告的结论必须先复现再修；误报要记录，不照单全收。**
- 证据：ef0d965 经复现确认 C-2（JWT 缺 g 标志）与 C-4（查询中 close 挂起）为误报，明确不改；52931be 按发版审查结论逐项修复。
- Seen 2× (2026-11-07, 2026-11-08)

## E. 交互与授权边界

**用户显式输入不得被静默替换或扩大：指定模型不存在时直接报错，多候选不自动选择，内部注入文本不解析 @ 附件。**
- 证据：abd9580 规定显式模型不存在时不回退到唯一候选，并兼容含斜杠的模型 ID；a6bd2fd 与 6ec728a 在多候选目标时只返回候选、不擅自选择；49087b5 对 `event.source === 'extension'` 只脱敏、不解析 `@`、不注入附件授权。
- Seen 4× (2026-11-07, 2026-11-09)

**多步交互命令必须在开始前校验前置条件，并复用同一条输入流，避免提前返回后用户输入被主循环误读。**
- 证据：96a0b89 的 `/knowledge save` 在无诊断结论时立即返回，后续输入被当成诊断内容；6ec728a 统一复用同一条 readline，消除第二套输入流导致的命令与数据错位。
- Seen 2× (2026-11-07)

**不可逆或修改全局状态的操作默认项必须是取消；非 TTY 且无 --yes 必须拒绝。**
- 证据：ab11dc7 中 `ctx.ui.confirm` 默认聚焦 Yes，“按 u 再回车”会直接写全局目录，改用 `ui.select` 且取消置首；裸键监听必须同时满足“提示存续、输入框为空、模型空闲”；00f058c 在非 TTY 且无 `--yes` 时拒绝安装，失败非零退出并打印手工命令。
- Seen 2× (2026-11-11)

**远程查询授权按次生效，不跨会话恢复；最近目标与日志中提取的目标只是建议，不构成授权；每次尝试都消耗配额。**
- 证据：a6bd2fd 明确“最近使用只用于建议”；49087b5 以 `/remote` 计划确认作为唯一授权入口，未确认前不发送任何远程字节；4ea39c1 中失败与重试同样消耗配额，授权结束后迟到的结果被丢弃。
- Seen 3× (2026-11-07, 2026-11-09)

**敏感内容在进入模型、展示、审计与落盘前必须脱敏；审计只记编号与摘要，不记关键词原文、绝对路径或正文；凭证文件权限 0600 且拒绝符号链接。**
- 证据：1044abe 建立入口脱敏与 `message_end` 出口复核；e75e71e 登录脚本 0600、原子写入并拒绝符号链接目标；4ea39c1 审计只记 fileRef、行区间与关键词个数；49087b5 的 `<remote-grant>` 注记不含远端绝对路径。
- Seen 4× (2026-11-07, 2026-11-09)

**只读边界必须在宿主执行点强制，不能只靠系统提示词、工具描述或模型自觉。**
- 证据：16477d7 用 `user_bash` 钩子拦截 `!`/`!!`；4ea39c1 在工具层做路径校验、配额与预算守卫；49087b5 在计划确认前不建立连接。
- Seen 3× (2026-11-07, 2026-11-09)

## F. 发布与文档

**发布流程把所有校验（版本一致、master 可快进、tag 形态）放在任何写操作之前；失败即中止，不留 tag、Release 或半改状态。**
- 证据：a1e4065 把快进校验提前到发布之前，修复“Release 已发布、master 未前移”的假成功；4237919 改用独立资产目录；288ec9b 把 git 身份配置提前到所有写 git 对象的步骤之前；52931be 的 apply 先读齐三份文件再统一落盘；f9790f5 固化补发幂等与 tag 不移动规则。
- Done right: 失败运行不产生 tag/Release，补发路径只校验、不重复副作用。
- Seen 5× (2026-11-07, 2026-11-08, 2026-11-09)

**发布产物完整性必须按资产名逐项断言并校验字节一致；不能依赖下载命令退出码或聚合校验和。**
- 证据：ec503e6 中 `gh release download -p` 某个模式无匹配时不失败，旧 `SHA256SUMS` 合法导致 finch.tgz 漏传且 latest 链接 404；567d689 增加固定 `finch.tgz` 并要求与带版本产物逐字节一致；c0ba7d6 用 `npm pack --dry-run` 确认模板在包内。
- Seen 3× (2026-11-09, 2026-11-17)

**发布资产与构建输出必须分离到独立目录；脚本安装与冒烟使用绝对路径。**
- 证据：4237919 中 `gh release upload dist/*` 把编译目录也上传并以 “is a directory” 失败；93ddc13 中 npm 把 `dist/finch-<version>.tgz` 当成 `user/repo` 简写并执行 `git ls-remote` 失败。
- Seen 2× (2026-11-09)

**用户安装命令必须指向稳定 latest 地址，不写死版本号，并用测试反向校验。**
- 证据：567d689 中 README 写死 v0.1.0 地址，v0.2.0 发布后新用户装到旧版；修复后新增 `tests/unit/readme-install.test.ts`，带版本号的下载 URL 会判失败；6b98687 同步更新安装命令与 `npm ci`。
- Seen 2× (2026-11-08, 2026-11-09)

**README/PRD/TECH_SPEC 的能力声明必须与实现同一提交同步；未接线、未验证的能力不得写成已完成。**
- 证据：1044abe 修正 README 中会话恢复、审计、附件等“声称完成但从未生效”的声明；52931be 同步 Spec 步骤与 README 首发前置；edd565f 重写 README 移除内部实现与发版流程。
- Seen 3× (2026-11-07, 2026-11-08, 2026-11-11)

**版本号与构建元数据只有一个来源；--version 的 commit 必须在构建时注入，测试从源码常量取版本，不写字面量。**
- 证据：52931be 把 `BUILD_COMMIT` 改为编译后写入，避免永远报 commit unknown；f9790f5 把安装测试中硬编码的 0.1.0 改为从 `src/version.ts` 导入。
- Seen 2× (2026-11-08, 2026-11-09)

## G. 工具陷阱

**`ctx.ui.confirm` 默认聚焦 Yes，不可逆操作改用 `ui.select` 且取消置首；`ctx.ui.notify` 不会自动消失，短提示用 footer 的 setStatus。**
- 证据：ab11dc7 实测 notify 会把文本永久追加进聊天区，只有 footer `setStatus(key, text)` + `setStatus(key, undefined)` 能定时清除。
- Seen 1× (2026-11-11)

**npm 会把含斜杠的相对 .tgz 路径当作 GitHub user/repo 简写，安装与冒烟必须用绝对路径；gh release download 的 -p 无匹配不报错，必须显式枚举资产名。**
- 证据：93ddc13 与 ec503e6 分别在 v0.2.0 发布中真实触发。
- Seen 2× (2026-11-09)

**交互式登录的“等待输入”只能按提示符形态匹配；`*OTP*`/`*assword*` 这类裸关键字会命中成功横幅与输入回显，把认证成功误判成重新认证。**
- 证据：2026-11-18 真机上报“已发送 MFA 验证码”后立即报“堡垒机重新要求 MFA”；`assets/login_agent.exp` 用 `*OTP*`、`*MFA Code*`、`*assword*` 匹配，成功横幅（“OTP verified / MFA Code accepted”）与回显行都会命中。
- 修复：改为行尾提示符正则（冒号后只能有空白），OTP 被真实拒绝时用新生成的验证码重试一次；`FINCH_LOGIN_DEBUG=1` 输出脱敏屏幕快照供定位厂商文案差异。
- Seen 1× (2026-11-18)

**交互式终端里相邻命令之间必须留间隔，相互独立的值必须用独立标记分行回传；一条 printf 同时取多个值时，任一处被吞或缺失都无法归因。**
- 证据：真机上 `printf '__ID__%s|%s\n' "$(hostname)" "$(id -un)"` 未回传任何标记，只报“远端身份核对失败”，无法判断是命令被吞还是值缺失；拆成 `__HOST__` / `__USER__` 两条命令、各占一行后，同一次登录直接 READY（host/user/dir 全部核对通过）；间隔 0.1–0.15s 即可，真机复测总耗时 2.9s。
- 注意：`set timeout` 是上限而非固定等待，成功路径不会因此变慢，不要用调小 timeout 的方式“提速”。
- Done right: 取值命令带 `||` 回退（`uname -n`、`whoami`），失败信息区分“未取得主机名/未取得账户名”。
- Seen 1× (2026-11-18)

**Expect 的 `timeout` 是全局变量，proc 内必须写 `set ::timeout`；`set timeout` 只创建局部变量，expect 会静默沿用外层值。**
- 证据：`assets/login_agent.exp` 的 `run_marked` 内 `set timeout 30` 未生效，查询沿用身份核对阶段留下的 25 秒，长查询会提前超时并被报成“远端执行状态未知”。
- Seen 1× (2026-11-18)

**finch 以 `TERM=dumb` 启动登录子进程，登录脚本必须补一个可用终端类型；否则堡垒机 TUI 可能不渲染资产菜单。**
- 证据：`src/remote/connector.ts` 的 `buildBridgeSpawnOptions` 固定 `TERM: 'dumb'`，而人工运行的 `docs/login_bastion.exp` 继承正常终端。脚本改为缺失或 dumb 时覆盖为 `xterm`；真机复测仍待用户执行。
- Seen 1× (2026-11-18)

## H. 提交与验证规范

**修复提交必须写明根因、复现路径、回归测试与验证输出；文档、发布、重构分开提交。**
- 证据：11 个 fix 提交均包含根因与验证段（ef0d965、74d774a、55bc784、288ec9b、93ddc13、4237919、a1e4065、567d689、ec503e6、52931be、c0ba7d6）；全仓类型分布 feat 22 / docs 18 / fix 11 / chore 6 / refactor 4 / test 1。
- Done right: 提交正文用“验证”段贴出 `typecheck` 与测试通过数；发布与业务改动不混在同一提交。
- Seen 11× (2026-11-07, 2026-11-08, 2026-11-09, 2026-11-17)

## 晋升候选（已在 3 个及以上不同日期命中）

以下规则建议在下次 PR 完成前晋升到 `docs/code-standards.md`：

1. **退出码与产物验证**：命令成功不能只看退出码，安装/写盘/发布必须回读产物（2026-11-07、2026-11-09、2026-11-11）。
2. **发布前置校验与原子性**：所有校验先于任何写操作，失败不留半成品（2026-11-07、2026-11-08、2026-11-09）。
3. **文档与实现同步**：README/PRD/TECH_SPEC 的能力声明与实现同提交，安装命令不写死版本（2026-11-07、2026-11-08、2026-11-09、2026-11-11）。
4. **提交与验证证据**：修复提交必须包含根因、复现与验证输出（2026-11-07、2026-11-08、2026-11-09、2026-11-17）。
