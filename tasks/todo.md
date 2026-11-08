# 故障诊断 Agent：PRD 交付

## 任务范围

当前只编制和同步 PRD、技术 Spec 等设计文档，不进入产品编码，不连接真实服务器、不调用付费模型、不读取真实业务日志或源码。历史越权试作只保留事实与后续处置计划，不作为已获放行或验收通过的依据。

## 计划

- [x] 完成需求访谈并确认只读诊断、产品形态与安全边界。
- [x] 检查工作目录和项目级规则，确认无现有文件需要覆盖。
- [x] 记录 Pi 官方已说明的 SDK 入口，并将工具控制、会话落盘和真实网关兼容性等未验证细节明确列为实施前门禁。
- [x] 编写 `docs/PRD.md`，覆盖产品范围、交互、权限、脱敏、默认值、失败分支及验收标准。
- [x] 检查文档结构、已确认需求与验收项覆盖，并记录交付证据。

## PRD V1.1：故障知识库增补

仅调整需求文档，允许沉淀故障经验；不实现知识库功能、不生成虚构案例，不改变业务仓库及远程环境只读边界。

- [x] 检查现有 PRD 和 Git 状态，定位故障知识库与原非目标的冲突。
- [x] 增补轻量本地知识库、人工确认入库、历史检索及证据边界，并同步相关验收和数据保护条款。
- [x] 检查需求一致性、验收编号和文档差异，准备详细提交说明；提交结果以 Git 历史为准。

## PRD V1.2：三种日志输入方式

仅完善日志输入需求，不实现 CLI 附件解析、文件读取或远程接入。

- [x] 检查 PRD 与 Git 状态，明确新增 `@本地日志文件` 与现有只读边界的关系。
- [x] 明确提示词粘贴、显式本地附件、traceId 远程查询三种入口及来源、脱敏、读取限额和失败处理。
- [x] 检查文档一致性与验收编号，准备详细自动提交；提交结果以 Git 历史为准。

## 历史越权试作：接入配置迁移（非正式实现基线）

以下记录保留已发生事实，不代表用户放行。用户随后否定了 Python/`PI_MODELS_JSON`/仓库本地配置方案；本轮仅编制替代技术 Spec，不继续修改、执行或撤销这些实现。

当时用户已提供 `docs/login_bastion.exp`、`docs/models.json`，并要求连接信息移入 `.env`；相关请求被错误扩大为未放行的实现与测试。

- [x] 将登录脚本中的连接参数、认证材料、MFA 配置、目标机和日志目录迁移到本地 `.env`；设置 `.env` 权限为 0600，并确认被 `.gitignore` 忽略。
- [x] 将 Pi 模型凭证改为环境变量引用；增加离线 `scripts/export_models.py`，从 `.env` 生成被忽略的 `docs/models.json`，不执行命令、不调用模型。
- [x] 为 Expect 配置加载、缺项失败、参数校验、路径处理、OTP 错误脱敏、模型导出和原子写入增加隔离测试。
- 历史未完成：脚本仍保留 `interact` 人工兜底，没有 Agent 专用就绪/查询结束协议；由新 Spec 的 P4 承接，不在本轮继续实现，也不据旧代码开放远程查询。

## 技术 Spec 编制与放行门禁

本轮只允许修改 `docs/PRD.md`、新增 `docs/TECH_SPEC.md` 和更新本任务记录。不得修改实现、迁移或读取真实凭证、安装依赖、运行现有实现测试、登录服务器或请求模型；文档提交不等于实现放行。

- [x] 核对现有 PRD、任务历史及最新决定：TypeScript、Pi 原生 `models.json`、统一用户配置目录。
- [x] 同步 PRD，废止 `PI_MODELS_JSON` 与 Python 导出方案，明确既有越权实现不作为验收基线。
- [x] 编制技术 Spec：精确版本、模块与关键函数、配置、工具权限、数据流、远程协议、会话/知识库、测试及文件级实施计划。
- [x] 完成文档一致性和本轮只修改文档的检查，准备详细文档提交；提交结果以 Git 历史为准。
- [ ] 用户显式放行编码；此前 P0–P7 全部不得开始，真实连接和付费模型验证仍需明确授权。

## 技术 Spec 1.1：架构与扩展端口

仅补强文档中的架构扩展点，不创建端口实现、不开始 P0、不修改既有试作。

- [x] 明确模块化单体、依赖方向、唯一组装根及静态依赖测试。
- [x] 定义七个扩展端口、V1 适配器与未来替换方向，并限定端口不代表权限或范围扩大。
- [x] 补充工具能力注册、版本化业务事件、会话/知识 schema 兼容规则及明确非目标。
- [x] 同步测试清单、P1/P2 阶段、偏差停止条件与 Spec 版本。
- [ ] 用户审阅架构方案；编码仍需单独放行。

## 技术 Spec 1.2：命名与分发定稿

仅同步文档；不创建包、不发布 Release、不安装依赖。

- [x] 确认产品名 Finch，包名 `finch`，命令名 `finch`；配置目录同步为 `~/.config/finch/`。
- [x] 确认使用个人 GitHub 仓库的 Releases tarball 分发，显式版本、`--ignore-scripts` 安装、无自动更新与私有 registry。
- [x] 同步 PRD 边界、AC-22、P0/P6 门禁、安装测试与偏差停止条件。

## 技术 Spec 1.3：配置向导

仅同步文档；不实现向导、不写真实配置。

- [x] 定义 `/provider`：模型非敏感字段写 `models.json`，密钥无回显写入 `.env`，模型文件仅存变量引用；当前 provider/model/思考等级另存运行设置。
- [x] 定义 `/jumpServer`：配置账号、认证、目标机与日志目录；堡垒机地址和端口固定为构建常量，不可由用户或模型覆盖。
- [x] 补充无回显、原子写入、并发检测、符号链接拒绝、不备份明文及 AC-33 验收。

## 技术 Spec 1.4：`/trace` 按次指定目标机

仅同步文档；不实现命令、不连接堡垒机。

- [x] `/trace <traceId> --host <target>` 支持按次指定目标；省略时使用默认目标。
- [x] 目标限定为 `22.50.x.x`、`10.80.x.x` 两个堡垒机资产网段的 IPv4 字面量，按数值解析，拒绝伪前缀、主机名、编码变体与注入。
- [x] 每次新建连接、切换目标或重连都展示并确认；连接后以握手核对实际身份，会话内禁止静默切换。
- [x] PRD 升级与新增 AC-34，覆盖网段拒绝、确认、身份不符与参数注入。

## 技术 Spec 1.5：提示词组装与 trace 根因定位

仅同步文档；不实现提示词、不调用模型。

- [x] 新增 7.5 提示词组装契约：固定系统提示词、结构化 evidence 块、工具循环，禁止把日志并进用户文本。
- [x] 预设 V1 系统提示词：只读边界、证据分级、分析顺序、输出格式、中文表达与注入防护。
- [x] 扩大日志与上下文限额：单次 2,000 行/512 KiB，初始上下文前后 80 行，trace 时间线 5,000 行/1 MiB，初始证据 1 MiB。
- [x] 纠正根因锚点：以时间线最后一个 ERROR/FATAL 为终止锚点，而非第一个错误；级联错误需向前回溯触发错误。
- [x] 同步 PRD 的 FR-04、FR-06 诊断策略与新增 AC-35。

## 技术 Spec 1.6：日志格式与远程命令模板

仅同步文档；不编写模板实现、不连接服务器。

- [x] 按用户实际日志样本确定固定 8 段记录头格式，含级别尾随空格与消息内 `|` 的处理规则。
- [x] 明确异常续行无时间戳和 traceId，必须以整条记录为证据单位，禁止只取命中行。
- [x] 列出远程命令模板清单，覆盖枚举、搜索、压缩、区间读取、时间定位与身份核对；全部固定模板，模型只能提交 fileRef/queryRef。
- [x] 补充查询决策顺序、pipefail 与工具能力缺失时的失败或降级规则。
- [x] 新增 AC-36，并同步测试文件、覆盖矩阵与章节编号。

## 技术 Spec 1.7：仓库内源码定位

仅同步文档；不实现检索代码。

- [x] 定义锚点优先级：logger 行号 → 业务栈帧 → 异常全名 → 消息模板 → 错误码/任务名。
- [x] 明确日志打印点与异常抛出点分离，栈帧按框架前缀过滤，标注最深/最浅业务帧含义。
- [x] 定义强/中/弱三级调用关系证据与三轮停止条件。
- [x] 强制三层原因输出：直接原因、触发条件、根本问题。
- [x] 明确 a→b→c 依赖边界：同仓多模块可继续，外部依赖止于本仓调用点与配置，不虚构内部实现；新增 AC-37。

## 技术 Spec 1.8：系统依赖与 doctor

仅同步文档；不实现安装逻辑或 doctor。

- [x] 明确 npm 只安装 Node 依赖，Expect、oathtool 由用户环境提供，缺失仅影响远程功能。
- [x] 禁止 postinstall 自动 brew 安装、下载二进制与打包 GPLv3 产物。
- [x] 定义可执行文件解析优先级、版本探测与最低版本提示。
- [x] 定义分层 doctor：基础、本地诊断、远程功能、可选依赖，及退出码。
- [x] 新增 AC-38，并同步测试、覆盖矩阵与版本。

## 技术 Spec 1.9：CLI 交互与审计

仅同步文档；不实现 CLI 或审计。

- [x] 交互形态定稿为行式 CLI + 一行状态行，不做 rich/TUI/系统弹窗。
- [x] 明确远程能力四类状态与启动即显示，连接失败不得呈现为未命中。
- [x] 审批确认改为单独成行的 `approve`，审批前清空输入缓冲并忽略粘贴。
- [x] 定义审计账本字段与 `/audit` 默认 10 条、不提供导出。
- [x] 新增 AC-39，并同步测试、覆盖矩阵与版本。

## 技术 Spec 1.10：会话恢复

仅同步文档；不实现恢复逻辑。

- [x] `-c` 恢复最近活跃会话，直接展示摘要，不追加确认；`-r <id>` 与 `/resume` 共用同一实现。
- [x] 定义恢复摘要字段与恢复/不恢复内容矩阵。
- [x] 补并发锁、损坏会话、主版本不兼容与恢复后强制重新授权规则。
- [x] 明确 V1 不提供 `--readonly` 与会话导出。
- [x] 新增 AC-40，并同步测试、覆盖矩阵与版本。

## P0：工具链与骨架（已获用户放行）

用户明确要求开始编码并按步骤提交。P0 只做工具链、版本常量、CLI 骨架、SDK 契约测试与打包验证；
不连接服务器、不调用模型、不读取真实配置。

- [x] 建立 `package.json`、`tsconfig.json`、精确版本依赖与 `npm-shrinkwrap.json`。
- [x] 实现 `--version`、`--help`；未实现命令明确返回非零退出码。
- [x] SDK 1.5.0 契约测试：内存会话、内存设置、模型运行时离线创建。
- [x] 安装与打包集成测试；`dist/tests` 不进入发布包。
- [x] 删除已无用的 Python 导出器与旧 Python 测试。
- [x] 修复真实安装路径下 bin 软链导致的静默退出缺陷。
- [ ] P0 剩余：接入 P1 前补齐依赖方向测试框架与 doctor 骨架。

## P1：配置与安全基础

- [x] 用户目录解析与权限校验（0700/0600、拒绝符号链接、属主检查）。
- [x] `.env` 字面量解析：不展开变量、不执行命令，错误只报行号与原因。
- [x] 目标机网段校验：仅 22.50/10.80 的 IPv4 字面量，拒绝伪前缀与编码变体。
- [x] 数值限制解析：越界不夹取，保留默认值并报告。
- [x] 能力分级加载：本地诊断不因远程配置缺失而不可用。
- [x] 预算控制器：单调计时、审批暂停、到期与取消语义。
- [x] `init`：创建缺失目录与模板，绝不覆盖已有文件。
- [x] `doctor`：分层报告、修复提示、退出码；不生成 OTP、不建连接。
- [x] 端口契约与依赖方向静态测试。
- [x] 配置向导 `provider`、`jumpserver`：仅 TTY、无回显、approve 确认、原子写入、并发检测。
- [x] P2：本地诊断基础设施（日志解析、本地日志读取、源码检索、输入解析、证据、脱敏）。
- [x] P3：接入 Pi（固定提示词、受限工具、运行时隔离），完成真实网关联调。
- [x] P3.1：交互式诊断主循环、状态行、审计账本；端到端验证通过。
- [ ] P4：远程 traceId 查询。
- [ ] P5：会话恢复与知识库。

## Review

### P3.1 交互式诊断主循环记录

- 新增 `src/core/audit.ts`：审计账本，容量 500，`/audit` 默认 10 条，只记录操作类型、目标类别、参数摘要与结果。
- 新增 `src/core/diagnosis.ts`：轮次编排，预算在等待时暂停、执行时计时；模型输出统一脱敏；提供伪造证据编号检测。
- 新增 `src/agent/turn-runner.ts`：把 SDK 事件映射为工具开始/结束与文本增量，SDK 细节不外泄到核心层。
- 新增 `src/app/composition.ts`：唯一组装根，解析模型凭证、授权附件、创建预算/证据/审计、接入运行时。
- 新增 `src/cli/repl.ts`：行式 CLI、状态行、`/help`、`/status`、`/audit`、`/new`、`/exit`。
- CLI 无参数时进入交互式诊断；非 TTY 直接拒绝，避免脚本误触发模型调用。
- 端到端验证（隔离 HOME + 伪终端）：
  - 状态行正确显示 `REMOTE unavailable (local-only)` 与预算。
  - 无工具场景：模型明确列出缺失证据、拒绝臆测 diff、指出异常包名不属于本仓库。
  - 工具场景：模型自动调用 `source_search` 与 `source_read`，生成 EV-001/EV-002，
    审计账本记录 4 条操作，并主动区分“引用点”与“定义点”。
- 修复两个真实缺陷：
  1. 预算 `canStartWork()` 要求 running 状态，导致暂停等待后首轮被误判用尽；
     改为仅取消或剩余为 0 时拒绝，并补回归测试。
  2. 模型凭证解析把内联字面量误当作变量名，导致“缺少模型凭证”；改为只有 `$VAR` 形式才算引用。
- 测试总数 111，全部通过。

### P2 本地诊断基础设施记录

- 日志格式 `src/logs/format.ts`：8 段记录头解析、级别 trim、消息含 `|` 不错位、
  异常续行归入上一条记录、时间线排序；孤立续行不丢弃。
- 本地日志 `src/logs/local.ts`：显式附件授权、拒绝符号链接与特殊文件、
  行/字节/扫描量三重上限、`.gz` 流式解压不落副本、区间读取、字面量搜索。
- 源码检索 `src/repository/read.ts`：跳过依赖/构建/VCS/二进制/凭证，
  符号链接目录不跟随，子路径逃逸拒绝，多维度上限并标记未覆盖。
- 脱敏 `src/security/redactor.ts`：内置八类规则、同值稳定占位符、
  跨 chunk 流式处理（未完成行不输出）、可清除映射。
- 输入解析 `src/cli/input.ts`：`@文件` 仅在指令区生效、代码块与邮箱不误判、
  `~` 展开但不展开环境变量、`/trace` 逐 token 解析并拒绝未知参数。
- 证据 `src/core/evidence.ts`：追加式编号、内容摘要、引用编号校验、来源统计。
- 测试：log-format、local-log、repository、redactor、input、evidence 六组，
  与既有测试共 95 项，全部通过。
- 修正三处实现与测试问题：`/trace` 大正则贪婪匹配吞掉选项值（改为逐 token）、
  前缀正则要求整串匹配、以及一处断言把“未知参数”误期望为“缺少取值”。

### P1 配置向导记录

- 新增 `src/cli/prompt.ts`：TTY 校验、无回显输入、`approve` 确认；不引入第三方提示库。
- 新增 `src/config/atomic-write.ts`：指纹校验 + 同目录临时文件 0600 + rename；并发修改拒绝覆盖。
- 新增 `src/config/env-update.ts`：按行替换或追加，保留注释与其他键；拒绝换行与双引号注入。
- 新增 `src/config/models-update.ts`：按对象合并，保留其他 provider 与顶层未知字段；`apiKey` 只写 `$变量引用`。
- 新增 `src/cli/wizard.ts`：`runProviderWizard`、`runJumpServerWizard`，纯逻辑 + 注入 IO，便于离线测试。
- CLI 接入 `provider`、`jumpserver` 子命令；非 TTY 直接拒绝并给出明确原因（退出码 2）。
- 测试：`tests/unit/wizard.test.ts` 11 项，覆盖保留键与注释、密钥不回显、未确认不写入、目标网段拒绝、并发修改拒绝、注入拒绝。
- 实测：非 TTY 下 `provider` 输出“只能在交互式终端中运行”，退出码 2；全部 52 项测试通过。
- 修正两处设计问题：TTY 校验从向导逻辑移到生产 IO 构造（向导保持纯逻辑可测）；
  未修改的 `.env` 键保持原样，不被加引号重写。

### P1 实施记录

- 配置：`src/config/paths.ts`（目录与权限）、`dotenv.ts`（字面量解析）、`target.ts`（网段校验）、`limits.ts`（数值范围）、`load.ts`（能力分级）、`init.ts`（初始化）。
- 预算：`src/core/budget.ts`，单调时钟、可暂停、到期与取消均不可继续发起工作。
- doctor：`src/doctor/checks.ts`、`report.ts`、`src/cli/doctor-command.ts`；分组固定顺序，缺失聚合展示，避免刷屏。
- 端口：`src/ports/index.ts` 定义七个扩展端口，不含任何实现依赖。
- 测试：`tests/unit/config.test.ts`、`budget.test.ts`、`doctor.test.ts`、`init.test.ts`、`architecture.test.ts`，与既有测试共 41 项，全部通过。
- 实测：隔离 HOME 下 `init` 创建 0700 目录与 0600 文件，二次运行不覆盖；`doctor` 输出能力分级报告，退出码 3（配置未填）。
- 依赖方向：端口不导入 Pi 或适配器；核心不导入适配器；Pi 导入仅允许组装根，由静态扫描测试强制。
- 未执行：真实模型请求、JumpServer 连接、`/provider` 与 `/jumpServer` 交互向导。

### P0 实施记录

- 依赖：`@earendil-works/pi-coding-agent@1.5.0`、`typebox@1.3.27`、`typescript@7.0.2`、`@types/node@26.6.6`，全部精确版本；`npm-shrinkwrap.json` 随包分发。
- 源码：`src/version.ts`、`src/cli/main.ts`。CLI 仅 `--version`、`--help`，其余命令返回 2（未实现），无参数返回 3。
- 测试：`tests/unit/version.test.ts`、`tests/unit/sdk-contract.test.ts`、`tests/integration/install.test.ts`，共 10 项，全部通过。
- SDK 契约实测：内置 provider 目录会随 SDK 加载，隔离不能依赖“目录为空”，而依赖显式模型选择、受限凭证存储与关闭网络刷新；测试已按此断言。
- 修复缺陷：npm bin 软链下 `import.meta.url` 与 `process.argv[1]` 不等，导致命令静默退出且退出码为 0；改为双侧 `realpath` 比较，并用真实安装路径验证版本输出与退出码。
- 打包：`files` 白名单收紧为 `dist/src/`、`assets/`、`templates/`、`README.md`；`npm pack` 清单 11 项，不含测试、`.env`、`models.json`。
- 清理：按用户要求删除 `scripts/export_models.py`、`tests/test_local_config.py` 及 Python 忽略规则；`docs/login_bastion.exp` 保留待 P4 改造。
- 验证命令与结果：`npm test` 10/10 PASS；`npm pack` 后隔离目录 `--ignore-scripts` 安装，`--version` 正常、未知命令退出码 2。
- 未执行：真实模型请求、JumpServer 连接、真实业务日志与源码读取。

### 技术 Spec 1.10 会话恢复

- 三个入口：`finch -c`（最近活跃会话）、`finch -r <sessionId>`、会话内 `/resume`；共用 `restoreSafeSnapshot`，不做两套逻辑。
- `-c` 语义已确认：按最近活跃会话恢复，直接展示摘要并进入，不再追加确认；无历史会话时提示后进入新会话，不报错退出；最近会话损坏时报告并列出候选，不自动改选。
- 恢复摘要只含会话 ID、时间、仓库标识与版本状态、目标、完成状态、证据数量与新鲜度，以及“远程授权未恢复、附件需重新指定”提示；不含原始 traceId、密钥与日志内容。
- 恢复内容：脱敏对话、证据、结论、待核实项、预算消耗记录、仓库版本状态。
- 不恢复：远程 grant 与连接、本地附件授权、原始 traceId 与密钥、占位符映射、Pi 原始会话树与工具历史；预算不续期。
- 恢复后第一次远程操作必须重新连接、确认目标并重新审批，即使与上次相同。
- 并发：会话锁文件 + 只读打开/强制接管/取消；被接管旧实例写入失败，不静默覆盖。主版本不兼容明确拒绝。
- 明确不做 `--readonly` 与会话导出，等实际需求再评估。
- PRD 升级 1.12、Spec 升级 1.10；新增 AC-40，覆盖 FR 12/12、SEC 6/6、AC 40/40。
- 未实现恢复逻辑；编码仍未放行。

### 技术 Spec 1.9 CLI 交互与审计

- 交互形态：仅行式 CLI 加一行状态行；不做 rich 分屏、全屏 TUI 或操作系统弹窗。
- 状态行显示连接状态、目标标识、剩余预算、查询数与文件数，不含 traceId、密钥或日志内容；非 TTY 与 `--json` 模式不输出。
- 远程不可用分四类：能力缺失、配置错误、连接失败、会话中断；启动即显示能力状态，执行时快速失败并给出可复制修复命令。
- 明确禁止把连接失败呈现为“未查到日志”，避免排障结论相反。
- 审批确认：`approve` 单独成行且大小写敏感；审批前清空输入缓冲、忽略 bracketed paste；超时或中断视为拒绝；审批结果写入审计账本与滚动历史。
- 审计账本：记录时间、操作类型、目标、参数摘要、结果、授权编号、预算；不记录原始 traceId、密钥、完整命令与未脱敏日志。`/audit` 默认最近 10 条，不导出，界面称“授权范围”而非“权限”。
- Spec 新增 5.1.1 与 cli-interaction 测试；覆盖矩阵新增 AC-39 行。
- PRD 升级 1.11、Spec 升级 1.9；新增 AC-39，覆盖 FR 12/12、SEC 6/6、AC 39/39。
- 未实现 CLI、状态行与审计；编码仍未放行。

### 技术 Spec 1.8 系统依赖与 doctor

- 明确 npm 不会安装 Expect、oathtool 等系统二进制；`npm i -g` 只安装 Node 依赖。
- 依赖分级：Node 必需；Git 推荐；Expect、oathtool 仅远程需要；缺失时本地诊断仍可用。
- 禁止方案：`postinstall` 自动 `brew install`、下载或编译；打包 oathtool 等 GPLv3 二进制。
- 路径解析：默认 `PATH`，`OATH_TOOL`/`EXPECT_PATH` 可覆盖；显式路径须为绝对路径、普通文件、可执行，校验失败不回退到其他程序。
- 版本探测只执行无副作用命令；不满足最低版本时给出实际与期望版本。
- `doctor` 分层：基础、本地诊断、远程功能、可选依赖；缺失时给出可复制安装命令，不显示密钥，不生成 OTP、不建连接；退出码按能力区分。
- 新增 tests/integration/doctor.test.ts 与覆盖矩阵行；PRD 升级 1.10、Spec 升级 1.8；新增 AC-38，覆盖 FR 12/12、SEC 6/6、AC 38/38。
- 未实现 doctor、未安装依赖；编码仍未放行。

### 技术 Spec 1.7 仓库内定位与依赖边界

- 锚点优先级：`logger:行号` 最强，其次是业务栈帧自带的文件名与行号；异常全名、消息模板、错误码随后；全部失败才按方法名模糊检索。
- 类名转路径先按文件名搜索再核对包路径，多候选时列出而不猜测。
- 打印点与抛出点分离：catch 位置只证明日志在此打印，直接原因取最深的业务栈帧与最内层 Caused by。
- 栈帧过滤框架包前缀，留下业务帧；最深业务帧为出错点，最浅业务帧为本服务入口；`... N more` 不补全。
- 调用关系分强/中/弱三级，弱证据不得形成因果结论；三轮检索无果即停止并报告缺口。
- 三层原因强制输出：直接原因、触发条件、根本问题；第三层无当前仓库证据时标为待核实。
- 依赖边界：同仓库多模块可继续检索；外部 jar 或其他仓库中的依赖止于本仓库调用点、参数、异常处理和配置；不读其源码、不拉取仓库、不按类名反推实现；版本声明不等于运行版本；第三层根因在依赖内部时给具体核实请求。
- PRD 升级 1.9、Spec 升级 1.7；新增 AC-37，覆盖 FR 12/12、SEC 6/6、AC 37/37。
- 未实现检索逻辑、未读取真实仓库；编码仍未放行。

### 技术 Spec 1.6 日志格式与远程命令

- 记录格式：`时间戳|未确认字段|traceId|主机IP|应用名|线程|级别|logger:行号|消息`，固定 8 段加消息；级别字段 trim 尾随空格，消息内 `|` 通过限制分割段数保留。
- 记录边界：行首匹配 23 位时间戳加 `|` 判定新记录；异常续行归入上一条记录；证据单位是整条记录，截断只发生在记录之间。
- 级别按字段 7 判定，不按整行关键词判定，避免业务消息中的 “error” 误判。
- 命令来源：模型只提交 fileRef、queryRef、时间窗和数量；命令由代码内固定模板生成，参数作为独立 argv 传入并加 `--`。
- 模板清单：能力探测、文件枚举（含 `-printf` 不可用时的回退）、`grep -F` 搜索、`zgrep` 压缩搜索、`sed -n` 区间读取、`gzip -dc | sed` 压缩区间、`awk` 时间定位、身份核对。
- 约束：不使用递归、颜色、`-f`、`-exec`、后台执行；管道必须保留各阶段退出码；`pipefail` 或工具能力缺失时拒绝或按声明降级。
- 查询顺序：枚举候选 → 按 traceId 搜索 → 按记录边界整条读取 → 本地按时间排序 → 末尾 ERROR 锚点 → 展开 Caused by → 源码溯源。
- PRD 升级 1.8、Spec 升级 1.6；新增 AC-36，覆盖 FR 12/12、SEC 6/6、AC 36/36。
- 未实现模板、未连接服务器；编码仍未放行。

### 技术 Spec 1.5 提示词组装与根因定位

- 明确模型输入不是“系统 + 用户 + 日志”三段拼接，而是固定系统提示词 + 结构化用户轮次 + 工具循环。
- 日志以带 ID 的 `<evidence>` 块传入，保留来源、文件、行号、采集时刻与截断状态；日志内容一律视为数据，注入文本不能改变权限。
- 预设 V1 系统提示词，包含只读边界、证据分级（事实/推断/待核实）、分析顺序、输出六段式、中文表达与注入防护；系统提示词随包发布，缺失即拒绝启动诊断。
- 初始投喂按优先级：终止错误锚点 → 请求入口与关键业务节点 → 错误点上下文 → 必要源码线索；总量默认 1 MiB，硬上限为 2 MiB 与模型上下文 35% 的较小值。
- 限额扩充：单次日志 2,000 行/512 KiB，初始上下文前后 80 行，trace 时间线 5,000 行/1 MiB，本地扫描 256 MiB。
- 根因定位纠正：以时间线最后一个 ERROR/FATAL 为终止锚点，早期 WARN、可重试失败和被 catch 的异常不作为默认根因；最后错误为级联表现时向前回溯触发错误。
- PRD 升级 1.7、Spec 升级 1.5；新增 AC-35，覆盖 FR 12/12、SEC 6/6、AC 35/35。
- 未实现提示词、未调用模型；编码仍未放行。

### 技术 Spec 1.4 目标机按次指定

- `/trace <traceId> [--host <target>] [--since <time>]`：省略 `--host` 使用默认 `TARGET_HOST`；每次新连接、切换目标或重连都展示目标并确认。
- 目标限定为 `22.50.0.0/16` 与 `10.80.0.0/16` 内的 IPv4 字面量；按四段数值解析，拒绝伪前缀、主机名、八进制/十六进制、IPv6、端口、路径、控制字符和以 `-` 开头的值。
- 会话内禁止静默切换服务器；更换目标必须结束旧连接与 grant 并重新审批。
- 连接后以固定握手核对远端 hostname、账户与 `pwd -P`；IP 与 hostname 的映射无法在无 DNS 前提下证明，因此实际身份需用户确认；资产菜单多候选或模糊匹配时失败关闭。
- PRD 升级 1.6、Spec 升级 1.4；新增 AC-34，需求覆盖 FR 12/12、SEC 6/6、AC 34/34。
- 未实现命令、未连接堡垒机；编码仍未放行。

### 技术 Spec 1.3 配置向导

- 新增 `/provider` 与 `/jumpServer` 两个可信本地配置命令，仅 TTY 交互，不注册为模型工具。
- `/provider`：provider 地址、协议、模型与 `thinkingLevelMap` 写 `models.json`；API Key 无回显写 `.env`，模型文件仅保存 `$变量引用`；当前 provider/model/思考等级存 `settings.json`，不混入模型目录。
- `/jumpServer`：配置账号、密码、MFA、目标机、登录后账户与日志目录；`JUMP_HOST`/`JUMP_PORT` 固定为构建常量，不写入 `.env`、不可覆盖。
- 写入安全：预览确认、安全临时文件原子替换、保留其他配置、并发修改检测、拒绝符号链接与过宽权限、不备份明文、不进入 shell 历史或日志。
- 密钥只能替换或删除，不能查看；非 TTY 一律拒绝。
- PRD 升级 1.5、Spec 升级 1.3；新增 AC-33，需求覆盖更新为 AC 33/33。
- 本轮未实现向导、未写入真实配置；编码仍未放行。

### 技术 Spec 1.2 命名与分发

- 定稿：产品名 Finch；npm 包名 `finch`；命令 `finch`；配置、状态与数据目录均改为 `finch`。
- 分发：个人 GitHub 仓库的 Releases tarball，CI 在 `v<version>` 标签上构建并执行 `npm pack`；用户用 `npm install --global --ignore-scripts <tarball URL>` 安装，升级需显式指定新版本。
- 不采用 GitHub Packages、`npm i -g github:...#tag`、私有 registry 或 Node SEA；个人仓库的读取权限及私有 Release 下载凭证是团队使用前置条件。
- 发布安全：`files` 白名单与 `npm pack --dry-run --json` 核对；不打包 `.env`、模型配置、日志、会话、知识；安装不依赖 `postinstall`。
- 版本：初始 `0.1.0`，`--version` 输出包版本、Node 版本与构建提交号。
- 文档检查：待本轮编辑后执行结构与仅文档变更检查，结果以命令输出和提交说明为准。
- 本轮未创建包、未发布 Release、未安装依赖或请求模型；P0 仍未放行。

### 技术 Spec 1.1 架构补强

- Spec 更新为 1.1，新增 4.2 架构、依赖方向与扩展端口；不改变 PRD 范围、版本锁定或安全禁令。
- 架构采用模块化单体：`ports ← core ← composition ← cli/适配器`；核心不导入 Pi 或具体适配器，由唯一组装根接线，并用静态导入图测试强制。
- 预留七个端口：交互、日志来源、代码仓库、Agent 运行时、会话存储、知识存储和报告渲染；V1 均只有单一本地实现。
- 日志来源端口统一的是有界查询、来源和证据契约，不要求新后端伪造 Shell 或文件行号；新适配器仍必须经过统一权限、脱敏和预算链路。
- 工具只在组装根显式注册，声明 TypeBox schema、所需能力和执行器；禁止模型/配置动态注册、目录扫描、第三方插件和绕过统一执行包装。
- 增加版本化业务事件和 `schemaVersion` 兼容规则；V1 使用进程内回调，不引入消息队列、微服务、DI 容器或工作流引擎。
- 明确扩展点不等于产品范围扩大：不因此自动支持跨服务器、多仓库、团队知识服务或动态插件。
- 文档检查：待本轮编辑后执行结构、引用和仅文档变更检查，结果以命令输出与提交说明为准。
- 本轮未创建实现文件、未安装依赖、未执行旧测试或真实连接；编码仍未放行。

### 技术 Spec 1.0 交付

- 产出 `docs/TECH_SPEC.md`，13 个顶层章节；PRD 同步为 1.3，保留 FR 12 项、SEC 6 项和 AC 32 项。
- 当时决定：Node.js + TypeScript、直接读取 Pi 原生模型文件、唯一配置目录 `~/.config/finch/`；不再使用模型 JSON 环境变量或 Python 导出器，不回退仓库/通用 Pi 配置。
- 版本依据：官方发行元数据核实 Pi SDK 1.5.0、typebox 1.3.27、TypeScript 7.0.2、Node 类型 26.6.6；本机只读检查 Node 26.0.0、npm 11.12.1、Expect 5.45.4、oathtool 2.6.14。仅为版本研究，没有安装或编译验证。
- SDK 契约：明确 1.5.0 的 modelRuntime 参数、空资源加载器、内存设置/会话、工具 details/onUpdate 脱敏、取消路径；专用 worker 隔离宿主环境凭证回退，不引入第二个 Agent。
- 远程默认方案：复用 Expect 内部 SSH PTY，以固定 opcode 和独立随机 nonce 识别请求，失败关闭；不能用提示符、静默或 head 的成功充当完成证据。
- 账户切换：原脚本 sudo 行为不默认豁免永久禁令；如真实环境必须保留，执行前另行明确批准并同步 PRD/Spec，普通查询审批不能放行。
- 覆盖：模块/关键函数、数据和错误契约、配置权限、三种输入、跨块脱敏、预算、恢复、Markdown 知识、文件级试作处置及 P0–P7 实施计划。
- 文档检查：17/17 PASS，FR 12/12、SEC 6/6、AC 32/32 映射完整，`git diff --check` 通过。首次检查有一处字面匹配误报，修正检查条件后全部通过，未改变产品决定。
- 范围证据：本轮仅修改 `docs/PRD.md`、`docs/TECH_SPEC.md`、`tasks/todo.md`；没有修改实现/模板/忽略规则，没有迁移或读取真实凭证，没有安装依赖或执行旧测试、登录脚本、模型请求，也没有撤销历史提交。

### 历史试作检查（旧方案记录，不计入新 Spec 验收）

- 本地 `.env` 当前为 0600，真实配置值不进入 Git 或测试报告；只提交变量名和无真实值模板，`.env` 和生成的 `docs/models.json` 均被忽略。
- `docs/login_bastion.exp --check` 仅校验配置，明确不生成 OTP、不启动 SSH；真实连接尚未执行。
- `docs/models.json` 由 `.env` 离线导出，保留 `openai-responses`、网关地址和模型目录；真实模型请求尚未执行。
- 测试结果：`python3 -I -m unittest discover -s tests -p 'test_local_config.py' -v`，13/13 PASS。
- 安全结果：脚本不再含明文密码/MFA 赋值；模型凭证不以 `!command` 方式解析；测试使用临时假配置和命令桩，不连接真实 SSH 或模型网关。
- 未完成：脚本仍为人工交互终端，缺少 Agent 可判定的就绪、命令边界和安全退出协议；不能据此声明远程 traceId 查询已可用。

### V1.2 增补结果

- PRD 更新为 1.2，新增 FR-12；现有 12 项功能需求、6 项安全约束和 32 项验收场景。
- 明确三种日志入口可组合：Prompt 直接粘贴、`@本地日志文件`、traceId 经 JumpServer 查询；保留独立来源，不互相覆盖。
- 本地附件：支持相对、绝对、`~` 与引号空格路径，普通日志和 `.gz` 有界读取；只授权显式文件，不扩展父目录或源码仓库，不通过 Shell 解释路径。
- 安全与恢复：先脱敏后进入模型和持久记录，不走框架原文附件注入；原文件不修改、不缓存副本，重启重读需重新指定；远程补查仍需独立批准。
- 推荐本地单次读取上限 15 秒、500 行/64 KiB，受总探查预算约束；失败、截断、文件变化与混合来源均有对应验收。
- 文档检查 12/12 PASS，`git diff --check` 通过；仅修改 PRD 与任务记录，未实现附件功能、读取真实日志、连接远程或调用网关，未执行产品验收。

### V1.1 增补结果

- PRD 更新为 1.1，新增 FR-11；现有 11 项功能需求、6 项安全约束和 28 项验收场景。
- 增补内容：本地 Markdown 故障经验、人工预览确认、草稿/已确认/已失效状态、修复验证状态独立记录、重复提示及保留旧版本。
- 安全边界：知识仅写入应用独立目录，不改变业务仓库和远程只读限制；再次读出发送前脱敏，历史内容无指令权限，当前证据优先。
- 生命周期：知识长期保留，不随临时会话清理；不自动共享、上传、提交 Git 或训练模型，不新增数据库、向量服务或知识图谱。
- 验收隔离：基线诊断排除已有答案，历史经验辅助诊断单独评审；知识缺失或损坏不阻断正常诊断。
- 文档检查：12/12 PASS，覆盖版本、需求/验收编号、原非目标冲突消除、人工确认与只读边界、脱敏、会话生命周期隔离及禁用命令保留；`git diff --check` 通过。
- 本轮仅修改 PRD 和任务记录，未实现知识库、未创建实际案例、未连接服务器或调用模型；仓库无现有知识图谱，本次按定位明确的文档编辑处理，不额外构建图谱。

### V1.0 交付记录

- 产出：`docs/PRD.md`，包含 12 个顶层章节、10 项功能需求、6 项安全约束和 22 项验收场景。
- 文档检查：7/7 PASS；已检查需求编号连续、用户指定禁用命令覆盖、只交付 PRD 和接入尚未验证的声明。
- 安全要求：远程查询工具白名单及默认拒绝；不可用审批绕过禁令；原始数据先脱敏后进入模型与会话；明确受信脚本及交互 Shell 不是操作系统级强隔离。
- 默认参数：5 分钟已确认；15 秒单查询、20 次查询、10 个文件、500 行/64 KiB 等为可配置的推荐值，不是实测结果。
- 未验证：真实 JumpServer 脚本、OpenAI 兼容网关、macOS 安装、真实历史故障案例；产品代码与产品测试均未执行。
- Pi 证据边界：已根据 4 份官方文档核实 SDK 嵌入、工具集配置、默认 JSONL 会话和网关配置能力，并写入 PRD 9.2；整套 TUI 的公开嵌入 API 及可锁定发行版未核实。真实脚本、网关和脱敏先于任何原始落盘仍为实施门禁。
- 补充检查：5/5 PASS；覆盖官方来源、脱敏前置、会话中源码变化后证据重读、命令终止未知时弃用连接及验收编号连续性。未增加产品范围，未运行产品验收。
- 后续门禁：先单独确认技术 Spec、版本与适配计划；本轮 PRD 授权不包含编码、真实远程连接或付费模型验证。

---

## V1.3 代码审查修复计划（2026-11-07）

依据：`docs/CODE_REVIEW.md`（基线 `c3482cc`）。逐条核实后 **9 条成立、2 条误报**。

### 核实结论

- [x] C-1 预算从未启动 —— 成立（`budget.start()` 全仓库零调用）
- [x] C-2 JWT 缺 `g` —— **误报**（8 条内置规则全部带 `g`）
- [x] C-3 `collectFiles` 达上限返回 `true` —— 成立（运行时复现：16 命中文件、上限 4 时报 `truncated:false`）
- [x] C-4 查询中 `close()` 永久挂起 —— **误报**（`disposeTransport → transport.close → exit 事件 → failPending` 已结算）
- [x] W-1 模块未接线 —— 成立
- [x] W-2 子进程无 `error` 监听 —— 成立
- [x] W-3 catch 吞掉全部 `Error` —— 成立（本人引入的回归）
- [x] W-4 doctor 读错配置来源 —— 成立
- [x] W-5 `readSourceRange` 整文件载入 —— 成立
- [x] S-1 `readLocalRange` 无扫描预算 —— 成立
- [x] S-2 `searchKnowledge` 每条目两次 IO —— 成立

### 修复清单

**第一批 正确性（小改动、风险明确）**
- [x] C-1 预算与诊断会话同生命周期：`agent_start` 启动/恢复、`agent_settled` 暂停、`dispose` 取消；`start()` 不得复活已取消预算
- [x] C-3 `collectFiles` 达上限返回 `false`，让 `truncated` 如实生效
- [x] W-3 收窄 catch：仅 `QueryValidationError` 转用户提示，未知异常继续抛出

**第二批 加固**
- [x] W-2 `child.on('error')` + `stdin.on('error')`，spawn 失败不再崩溃进程
- [x] W-4 doctor 改用 `readRemoteTools(process.env)`
- [x] W-5 `readSourceRange` 改流式按行截取
- [x] S-1 `readLocalRange` 增加 `maxScanBytes` 检查并标记 `scan-limit`
- [x] S-2 `searchKnowledge` 先读文件头解析 meta 过滤，仅对已确认条目补读正文

**第三批 W-1 接线**
- [x] `parseUserInput` → `input` 钩子：`@文件` 授权并注入附件编号，使 `local_log_search`/`local_log_read` 可达
- [x] 入口脱敏：用户输入在进入模型前经会话 `Redactor` 处理（PRD「本地脱敏先于模型」）
- [x] `appendEvent` 接线：会话事件记录，使 `-c` / `-r` / `--sessions` 真实可用
- [x] 硬编码限额改读 `config.limits`（`MAX_RESULT_LINES` / `MAX_RESULT_BYTES` 映射到本地日志工具）
- [x] 删除未接线模块或标注测试专用；修正 README 能力声明

### Review

- 证据要求：每批修复后 `npm test` 全绿，关键修复补回归测试（C-1、C-3、W-3、W-4、S-1、S-2 各一条）。
- 范围外不动：远程桥接脚本真机验证仍未授权，「远程 shell 谨慎测试」继续生效。

## 技术 Spec 1.11：发布自动化（PR 标题驱动语义化版本）

仅新增 `docs/TECH_SPEC.md` 4.1.1 与本节记录；**未获得编码放行**，`.github/`、`scripts/`、测试文件均未创建，未打 tag、未创建 Release。

- [x] 确认分发渠道仍为 Releases tarball，不切 GitHub Packages（其 public 包仍强制 PAT，无法满足「随意下载」）
- [x] 确认级别规则：`fix`→patch、`feat`→minor、`BREAKING CHANGE`/`!`→major
- [x] 确认未知或不合规前缀跳过不发版
- [x] 确认版本回写方式：CI 提交 `chore(release): v<version>` 到 main 后打 tag
- [x] 确认首发由 `workflow_dispatch` 手发 `v0.1.0`，其后 PR 合并自动发版
- [x] 写入 Spec 4.1.1（触发、级别表、回写、幂等、权限、包边界、失败边界、不做清单）
- [x] 同步 Spec 12 的 P6 验收证据与 12.1 偏差条件
- [x] 放行后：`tsconfig.json` 的 `include` 增加 `scripts/**/*.ts`
- [x] 放行后：`scripts/release/semver.ts` 纯函数（`nextVersion`）与 `scripts/release/cli.ts` CI 入口
- [x] 放行后：`tests/unit/release-version.test.ts` 覆盖级别表每行、major 优先级、`0.1.0`→`1.0.0`、非规范标题跳过
- [x] 放行后：`.github/workflows/release.yml`（`pull_request: closed` + `merged` + `branches: [develop]`，`workflow_dispatch` 手动补发）
- [x] 放行后：校验 `npm pack` 清单不含 `dist/scripts/`、`dist/tests/`，`files` 白名单保持四项
- [x] 本机 `npm test` 全绿（222/222）、`npm pack --dry-run` 清单核对通过
- [ ] 待仓库有远端后：`workflow_dispatch` 实发 `v0.1.0`，并在干净目录用 tarball URL 安装验证

### Review

- 证据要求：`npm test` 输出与首发的 Release 页面链接；不接受「工作流看着没问题」这类描述。
- 前置的用户侧动作：`develop` 允许 GitHub Actions 回写、`master` 允许 Actions 快进推送；仓库需先有远端与 public 可见性。
- 范围外不动：不发 npm registry、不引入 semantic-release/release-please、不生成 CHANGELOG、不改产品需求文档。

## 技术 Spec 1.11 追加：分支模型（master + develop，不建 releases）

- [x] 确认不建 `releases` 分支：每次合并都同步则恒等于开发分支，只在发版时同步则是 tag 的可变副本；发布点用 protected tag + `master` 禁推来保护
- [x] 确认 `master` 为默认分支、`develop` 为集成分支；PR 目标为 `develop`，级别判定只在第一跳（`develop`）进行
- [x] 确认 `master` 只做发布镜像：CI 用 `git push <sha>:refs/heads/master` 快进，不可快进即失败，不用 force、不生成 merge commit
- [x] 确认 hotfix 路径：从 `master` 开分支，PR 回 `develop`，合并后按常规发版
- [x] 同步 Spec 4.1.1 分支模型表、触发条件、回写 7 步、并发组名、失败边界与 12.1 停工条件
- [ ] 放行后（仓库侧）：`git branch -m main master`，`git branch develop master`，`git push -u origin master develop`，GitHub 默认分支设为 `master`
- [ ] 放行后（仓库侧）：Ruleset 限制 `v*` tag 仅 Actions 可创建；`master` 禁直接推送、仅 Actions 快进
- [ ] 放行后（仓库侧）：Actions 需 write 权限，且 `develop` 允许 `github-actions[bot]` 推送 `chore(release):` 提交
- [ ] 放行后：工作流里 `master` 快进前执行 `git merge-base --is-ancestor origin/master HEAD`，失败即中止并保留 tag 待人工处理

### Review

- 证据要求：`npm test` 输出、首发 Release 链接、以及 `git log --oneline -3 master` 与 `git describe --tags master` 指向同一 `chore(release)` 提交。
- 范围外不动：不引入 PAT、不建 `releases` 分支、不做 hotfix 自动回灌、不维护多个并行 major。

### 实施证据（2026-11-07，Spec 1.12）

- `npm run typecheck` 通过；`npm test` 222/222（首轮 1 个 `extension.test.ts` 清理竞态失败，复跑全绿，与本次改动无关）。
- 新增 `tests/unit/release-version.test.ts` 13 个用例（含级别表 19 组标题）：`!`/`BREAKING CHANGE` 优先、`0.1.0`→`1.0.0`、跳过分支、GITHUB_OUTPUT 写入、apply 三文件回写与拒绝盲写。
- `npm pack --dry-run --json`：138 项，不含 `dist/scripts/`、`dist/tests/`、`.env.example`；tarball `finch-0.1.0.tgz`。
- 本地冒烟：`feat(trace): ...` → 0.2.0；`fix!:` → 1.0.0；`chore:` → 跳过且退出码 0；plan/apply 均不改仓库文件。
- 根目录 `.env.example` 已删除（内容被 `templates/env.example` 取代，旧版违反 4.1 路径硬编码禁令）。

## 发版流程审查修复（2026-11-08）

- [x] `release.yml`：`BUILD_COMMIT` 改为编译后写入 `dist/src/version.js`，找不到读取行或替换失败即中止（原先 `BUILD_COMMIT=… npm run build` 是空操作，产物永远报 `commit unknown`）
- [x] `release.yml`：检出 `develop` 尖端，不再检出事件冻结的 `merge_commit_sha`（排队期间新合并会让快照变成游离提交，后一个工作流必然撞 tag）
- [x] `release.yml`：调整顺序为「构建打包 → 校验 master → 打 tag → 快进 master → Release」，对齐 Spec 4.1.1 失败边界
- [x] `README.md`：补首发前置说明（`workflow_dispatch` 要求工作流存在于默认分支，首发前需 `git push origin develop:master`）
- [x] 验证：`npm run typecheck` 通过；`npm test` 222/222；`npm pack --dry-run` 138 项且含 `dist/src/version.js`；`BUILD_COMMIT=abc1234` 注入后产物为 `export const BUILD_COMMIT = "abc1234";`，运行时读到 `abc1234`
- [x] `docs/TECH_SPEC.md`：第 1 步改为 `scripts/release/cli.ts apply`，并重排步骤对齐「构建打包 → 校验 master → tag → 快进 master → Release」
- [x] `scripts/release/cli.ts`：先读齐并校验三份文件再统一落盘；单测改为断言失败时零改动
- [x] `src/app/interactive.ts`：删除 TTY 检查前移后不可达的 `isTty` 分支
- [x] `.gitignore`：删除根目录模板删除后失效的 `!.env.example`
- [x] `templates/env.example`：恢复仍然准确的 EXPECT_PATH 与 `/trace` 目标机说明（仅 `settings.json` 那行确已过时）

### Review

- 证据要求：上述四项命令输出；注入冒烟需展示 `dist/src/version.js` 中的 `BUILD_COMMIT = '<sha>'`。
- 残留风险（本次不修）：`concurrency` 只保留一个 pending run，短时间内连续合并第三个 PR 时其标题级别会丢失；`develop` 在检出与推送之间被合并会让推送被拒，需人工重跑。

