# TypeScript 代码审查报告

- **审查对象**：`src/` 全部 24 个模块，约 6.5K 行（不含 `tests/`）
- **审查日期**：2026-02-14
- **审查基线**：commit `c3482cc`（refactor: 交互界面改用 Pi 自带 UI，删除自研输入组件）
- **基线验证**：`tsc --noEmit` 零错误；`npm test` 180/180 通过
- **验证方法**：静态阅读 + 关键疑点运行时复现（见各条目「验证」标注）

## 总体评价

工程质量整体较高：tsconfig strict 全开（含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）；协议层（nonce/seq/帧校验）设计严谨；路径遍历、注入、凭证泄漏等安全边界处理到位；边界注释解释 WHY 而非 WHAT。

但存在 4 个 Critical 缺陷，均与产品核心承诺直接冲突，必须修复后才能合入。

---

## 🔴 Critical（会导致 bug 或数据错误）

### C-1 预算控制器从未启动，DIAGNOSIS_TIMEOUT_MS 形同虚设

- **位置**：`src/core/budget.ts`（`BudgetController`）+ `src/app/composition.ts:245`
- **问题**：全仓库没有任何 `budget.start()` 调用，预算永不计时，四个工具永不被预算拦截。
- **触发条件**：`compose()` 构造 `BudgetController` 后以 `canWork: () => budget.canStartWork()` 注入工具。`canStartWork()` 依赖 `remainingMs() > 0`，而 `consumedMs` 只有 `pause()/cancel()`（经 `accrue()`）才累计，`startedAt` 只有 `start()` 才设置——两者在生产路径均从未被调用（唯一调用方 `Diagnosis.runTurn` 本身是死代码，见 W-1）。因此 `remainingMs()` 恒等于 `totalMs`。
- **影响**：任意时长的诊断会话都不会触发「探查预算已用尽」，与 Spec「预算是安全边界的一部分」直接矛盾。
- **验证**：grep 全仓库 `budget.start` / `\.start()` 零命中（排除无关项）。
- **建议**（`composition.ts`）：

```ts
// compose() 内，runtime 创建成功后启动计时（WHY: 预算是安全边界，必须与诊断会话同生命周期）
budget.start();
// ...
dispose: () => {
  budget.cancel();
  redactor.clear();
  evidence.clear();
},
```

若短期内无法接入完整 `Diagnosis` 编排，至少要在 `compose()` 里 `start()`，让现有 `canWork` 生效。

### C-2 JWT 脱敏规则缺 `g` 标志，同段文本只替换第一处

- **位置**：`src/security/redactor.ts:28`（`DEFAULT_RULES` 的 `jwt` 规则）
- **问题**：JWT 正则缺 `g` 标志，`String.replace` 只替换第一处匹配，后续 JWT 原样漏出。
- **触发条件**：工具层调用 `redactor.redact(lines.join('\n'))`（`agent/tools.ts` 多处）——多行合并后一次替换。日志中两行各含一个 JWT（如 Authorization 头与 cookie 各一个）时，第二个明文进入模型上下文与证据库。
- **影响**：敏感信息泄漏；接口注释自己声明「正则必须带全局标志」，内置规则却违反。
- **建议**：

```ts
{ id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'JWT' },
```

### C-3 collectFiles 达到 maxFiles 上限时误报「完整扫描」，静默丢弃未扫描文件

- **位置**：`src/repository/read.ts:118-123`（`collectFiles`）
- **问题**：达到 `maxFiles` 上限时 `return true`（「完整」），未扫描文件被静默丢弃，`truncated=false`、`skippedFiles=0`。
- **触发条件**：仓库含较多候选文件、命中内容位于第 `maxFiles` 个及之后的文件中。
- **影响**：模型收到「未找到匹配（已扫描 N 个文件）」且无任何未覆盖提示，直接误导诊断方向；违反本项目「上限触发必须如实标记未覆盖」的核心承诺。
- **验证**：运行时复现——16 个命中文件、`maxFiles: 4` 时结果为 `filesScanned=4, truncated=false, skippedFiles=0`。
- **建议**：

```ts
  for (const entry of entries) {
    if (output.length >= limit) {
      // WHY: 达到上限=扫描不完整，必须返回 false 让调用方标记 truncated
      return false;
    }
```

递归处 `if (!complete) return false` 已能正确传播，`searchRepository` 中 `truncated = !complete` 也就如实生效。

### C-4 查询进行中调用 close() 导致 query() 永久挂起

- **位置**：`src/remote/session.ts`（`close()`）
- **问题**：RUNNING 状态下 `close()` 不结算 `pending`，`send()` 返回的 Promise 永不 resolve。
- **触发条件**：`query()` 在途时触发关闭（超时后弃用连接、Ctrl-C 清理）：`close()` → `disposeTransport()`，但 `pending.resolve` 只在 `handleLine`/`failPending`/超时路径触发，`disposeTransport` 不调用 `failPending`。`await session.query(...)` 永久悬挂（泄漏 timer 与 Promise）。
- **影响**：调用方挂死；现有单测未覆盖「RUNNING 中 close」路径。
- **建议**：

```ts
  async close(): Promise<void> {
    const midQuery = this.state === 'RUNNING';
    if (this.transport !== undefined && this.state === 'READY') {
      /* ...原有 CLOSE 帧发送逻辑不变... */
    }
    if (midQuery) {
      // WHY: 查询未完成即关闭，远端执行状态未知；必须让等待方落地，否则 query() 永不返回
      this.state = 'TERMINATION_UNKNOWN';
      this.failPending(new Error('查询未完成即关闭，远端执行状态未知'));
    }
    this.disposeTransport();
  }
```

---

## 🟡 Warning（潜在风险或明显坏味道）

### W-1 大量「已完成」模块未接线，文档声明与实际行为不符

- **位置**：多个模块（详见下表）
- **问题**：grep 全仓库零生产调用。
- **验证**：对下列每个符号做全仓库调用点搜索，均无命中。

| 模块 | 死代码 | 实际后果 |
| --- | --- | --- |
| `storage/session.ts` | `appendEvent` 无任何调用 | 会话目录永不产生；`-c`/`-r`/`--sessions` 永远显示「没有历史会话」，而 README 声称「已完成会话事件记录与恢复」 |
| `cli/input.ts` | `parseUserInput` 无调用 | `attachmentPaths` 恒为 `undefined` → `attachments` 恒为空 Map → **`local_log_search`/`local_log_read` 在生产中不可达**，模型调用只会得到「未知的附件编号」 |
| `core/diagnosis.ts` / `agent/turn-runner.ts` | `Diagnosis`、`SessionTurnRunner` | 预算暂停/恢复、轮次审计、引用校验编排全部未生效（C-1 的根因之一） |
| `agent/runtime.ts` | `createDiagnosisRuntime` 仅测试引用 | 与 `composition.ts` 形成两套平行运行时组装，安全开关各写一份，是漂移温床 |
| `security/redactor.ts` | `StreamingRedactor` | 流式脱敏未使用 |
| `config/load.ts:145` | `findSingleModelCandidate` | 与 `resolveModelSelection` 功能重复 |
| `config/limits.ts` | `MAX_QUERY_COUNT`/`MAX_RESULT_LINES`/`MAX_RESULT_BYTES` | 未被 `agent/tools.ts` 引用，工具内硬编码 2_000/64MB 等数值 |
- **建议**：短期至少修正 README 与注释中的能力声明；把硬编码限额改为读 `config.limits`；`agent/runtime.ts` 标注「仅测试使用」或删除。中期按模块逐个接线或删除。

### W-2 spawn 失败以未处理 error 事件崩溃整个进程

- **位置**：`src/remote/transport.ts:44`（`spawn`）、`write()`（~86 行）
- **问题**：子进程无 `error` 事件监听；`stdin` 的异步 EPIPE 同样无人处理。
- **触发条件**：`EXPECT_PATH` 指向不存在的路径时，`spawn` 同步成功返回但异步抛 `error` 事件——Node 对 `ChildProcess` 的 `error` 无监听即抛顶层异常，与「缺少外部程序只影响远程功能」的设计约束矛盾。
- **建议**：

```ts
  child.on('error', () => {
    // WHY: spawn 失败（如 ENOENT）以 error 事件异步到达；不监听会崩溃进程。
    closed = true;
    exitHandler?.();
  });
  child.stdin.on('error', () => {
    // WHY: 对端关闭后写入触发 EPIPE；只推进状态，由会话侧超时/退出兜底。
    closed = true;
  });
```

### W-3 query() 的 catch 分支把一切 Error 伪装成「参数不合法」

- **位置**：`src/remote/session.ts:160-165`
- **问题**：`error instanceof QueryValidationError || error instanceof Error` 中后者完全覆盖前者，任何 `Error`（包括程序缺陷）都被吞成 `ok:false` 的用户提示。
- **触发条件**：`toWirePayload` 未来重构中任何意外抛错都会被伪装成参数问题，与注释「未知异常仍然抛出，避免把程序缺陷伪装成参数问题」的意图相反。
- **建议**：

```ts
      if (error instanceof QueryValidationError) {
        return { state: this.state, ok: false, frames: [], message: error.message };
      }
      throw error;
```

### W-4 doctor --remote 从错误的来源读取工具配置，探测永远 skipped

- **位置**：`src/cli/doctor-command.ts:85-92`
- **问题**：从 `config.values`（`.env` 解析结果）读取 `OATH_TOOL`/`EXPECT_PATH`，但这两个键已改为只从进程环境变量读取、绝不写入配置文件——`values.get()` 恒为 `undefined`，`enabled` 恒 `false`。
- **触发条件**：用户正确设置三个环境变量并补齐 `.env` 后运行 `doctor --remote`，永远得到「skipped: 远程功能未配置」，与实际配置状态相反。
- **建议**：改用已有的 `readRemoteTools(process.env)`：

```ts
  if (options.checkRemote) {
    const tools = readRemoteTools(process.env);
    if (!tools.ok) {
      results.push({
        group: 'remote', name: 'oathtool / expect', status: 'skipped',
        hint: `缺少环境变量：${tools.missing.join(', ')}`,
      });
    } else {
      results.push(...(await checkRemoteTools({
        oathTool: tools.config.oathTool,
        expectTool: tools.config.expectPath,
        enabled: true,
      })));
    }
  }
```

### W-5 readSourceRange 整文件载入后才切片，无字节保护

- **位置**：`src/repository/read.ts:264`
- **问题**：`readFile(resolved, 'utf8')` 整文件载入后才 `slice` 行区间；400 行上限只在 `agent/tools.ts` 调用前检查。
- **触发条件**：绕过工具层直接调用（或未来新调用点），且仓库中被检入大文件（如 100MB SQL dump，未命中二进制扩展名名单）匹配 `isEligible` 后被整体读入内存。
- **建议**：改为流式按行截取：

```ts
  const reader = createInterface({ input: createReadStream(resolved), crlfDelay: Infinity });
  const lines: string[] = [];
  let index = 0;
  try {
    for await (const line of reader) {
      index += 1;
      if (index < startLine) continue;
      if (index > endLine) break;
      lines.push(line);
    }
  } finally {
    reader.close();
  }
  return { ok: true, lines };
```

---

## 🟢 Suggestion（可选优化）

### S-1 readLocalRange 缺扫描预算，三个读函数限额口径不一致

- **位置**：`src/logs/local.ts:143-151`
- **问题**：逐行 `continue` 跳过前置行；`startLine` 很大时仍要解压/读取全部前缀，且该函数不检查 `maxScanBytes`（`readLocalLog` 与 `searchLocalLog` 都检查）。
- **触发条件**：gzip 附件 + 请求靠近文件尾部的区间时，单次调用消耗全部解压 CPU 却无 scan-limit 标记。
- **建议**：

```ts
  let scannedBytes = 0;
  for await (const line of reader) {
    index += 1;
    scannedBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (scannedBytes > limits.maxScanBytes) {
      truncated = 'scan-limit';
      break;
    }
    if (index < startLine) continue;
```

### S-2 searchKnowledge 每条目两次 IO 且全文读入只为算权重

- **位置**：`src/knowledge/store.ts`（`searchKnowledge`）
- **问题**：每个条目 `listRevisions`（readdir）+ `readRevision`（全文 readFile），条目多时串行放大。
- **触发条件**：知识库积累到几百条后，每次 `/knowledge search` 都是数百次串行 IO。
- **建议**：元数据块固定在文件头部，只读前 4KB 解析 meta 即可完成 status 过滤与签名/标题加权，正文命中仅在候选条目上补读：

```ts
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    // 复用 parseEntry 的 meta 解析逻辑，正文为空时跳过 body 加权
  } finally {
    await handle.close();
  }
```

---

## 合入结论

**修复 Critical 后可合入。**

4 个 Critical 均有明确触发条件，且与产品核心承诺（预算硬边界、脱敏完整性、「如实标记截断」、无挂起连接）直接冲突，必须先修。W-1（模块未接线）建议在同版本内至少修正 README 与注释中的能力声明，避免使用者对能力产生错误预期。

### 建议修复顺序

1. C-2（一行修复，防泄漏）→ C-3（一行修复，防误报）→ C-4（会话挂起）→ C-1（需要设计决策：接入完整 Diagnosis 编排还是最小接线）
2. W-4（doctor 误报）→ W-2（进程崩溃）→ W-3（异常伪装）
3. W-1 文档声明修正可与上述并行
