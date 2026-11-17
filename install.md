# Finch AI 安装执行书

> 本文件是给 AI 编程助手（Claude Code / Codex / pi 等）执行的安装说明。
> 把本文件的 raw 地址交给 AI，AI 应严格按以下步骤完成安装。
>
> 适用系统：macOS（官方验证）、Linux（尽力支持，未官方验证）、Windows（仅 WSL2）。
> Finch 是**只读**故障诊断 CLI，不会修改业务仓库、不会提交代码、不会重启服务。

## 给用户的用法

把下面这段话和 raw 地址一起发给 AI：

```text
请读取 https://raw.githubusercontent.com/hayeslin-ai/finch/master/install.md，
严格按照文档为我安装 Finch。
遇到系统级安装（sudo / brew / apt / dnf / pacman / 安装 Node）或需要修改 shell 配置时，
先停下来征求我的同意。
密钥我会自己在本地填写，不要让我在对话里粘贴密钥。
```

合并到 `master` 后的 raw 地址：

```text
https://raw.githubusercontent.com/hayeslin-ai/finch/master/install.md
```

> 调试时如果文件还在其他分支，把 `master` 换成对应分支名，例如
> `https://raw.githubusercontent.com/hayeslin-ai/finch/develop/install.md`。
>
> 如果仓库是私有的，raw 链接需要对应的访问权限；没有权限时，直接把本文件内容粘贴给 AI。

---

# 以下是给 AI 的执行协议

## 0. 目标、约束与停止条件

### 0.1 最终目标

安装完成后，用户机器上应具备：

1. Node.js `>= 22.19.0`。
2. `expect` 与 `oathtool` 可用（远程查询需要；本地诊断不依赖）。
3. 全局命令 `finch` 可用，`finch --version` 正常输出。
4. `~/.config/finch/` 已初始化，权限为 `0700`。
5. `~/.config/finch/models.json` 中有且只有一个模型定义，凭证使用 `$MODEL_API_KEY` 变量引用。
6. 用户已在本地填写 API Key；如果用户需要远程查询，`.env` 中已配置堡垒机字段。
7. `finch doctor` 的「基础」与「本地诊断」分组通过。

### 0.2 硬性约束（必须遵守）

1. **不得输出、回显、记录任何密钥值**：API Key、堡垒机密码、MFA Secret、TOTP 都不能出现在对话、日志、报告或命令回显中。
2. **不得覆盖用户已有的配置**：`~/.config/finch/.env` 与 `models.json` 只能补缺失项或按用户确认合并，不能整体重写、不能删除未知字段。
3. **系统级操作必须先征得同意**：`sudo`、`brew install`、`apt/dnf/pacman/zypper`、安装 Node、修改 shell profile、修改 npm 全局 prefix，都要先说明将要执行的命令，得到用户明确同意后再执行。
4. **不要在非 TTY 环境运行交互命令**：`finch`、`finch provider`、`finch jumpserver` 需要真实终端。AI 的 shell 通常不是 TTY，运行会失败或触发不必要的交互。
5. **不要修改业务仓库**：不执行 `git add / commit / push`，不在用户项目里创建文件。
6. **不要 `source ~/.config/finch/.env`**：Finch 只做字面量解析；`source` 会让密码中的特殊字符被 Shell 执行。
7. **失败即停**：每一步必须有可验证的输出或退出码；不要用“应该没问题”掩盖失败。
8. **不要安装来源不明的二进制**：`expect` / `oathtool` 只从系统包管理器安装，不编译源码、不下载随机脚本。
9. **不要生成 TOTP、不要测试堡垒机登录、不要请求模型**：安装阶段只做配置与 `finch doctor` 自检；`doctor` 本身不会连接服务器或调用模型。
10. **用户拒绝系统级安装时降级继续**：跳过 `expect` / `oathtool` 等系统依赖，明确标注远程能力不可用，但仍完成 Node、Finch、配置与本地自检。Node 本身仍必须满足最低版本，否则按停止条件处理。

### 0.3 交互节奏

- 需要用户提供非敏感信息时，一次性列清问题，等用户回答后再继续。
- 如果宿主不支持中途提问（例如非交互式 Codex / pi），把所有需要用户确认的内容汇总输出，等待用户回复后再继续；不要猜测或跳过。
- 密钥不要通过对话收集。让用户在本地终端或编辑器中填写，AI 只负责写占位符与变量名。
- 每完成一个阶段，输出一行简短进度（阶段名 + 结果），不要刷屏。
- 最终输出验收报告，报告中不得包含任何密钥。

### 0.4 停止条件

出现以下任一情况，停止并说明原因：

- 操作系统不是 macOS、Linux 或 WSL2。
- Node 无法升级到 `>= 22.19.0`，且用户拒绝继续。
- npm 全局目录不可写，且用户拒绝调整 prefix 或使用其他安装方式。
- `finch --version` 无法执行。
- `finch doctor` 的「基础」或「本地诊断」分组仍有错误，且无法修复。
- 配置目录是符号链接、属主不是当前用户，或用户拒绝修复权限。

---

## 1. 环境探测（只读）

依次执行并记录结果：

```bash
uname -s 2>/dev/null || echo "uname-unavailable"
uname -m 2>/dev/null || true
node -v 2>/dev/null || true
npm -v 2>/dev/null || true
command -v node || true
command -v npm || true
command -v brew || true
command -v fnm || true
command -v volta || true
command -v mise || true
command -v asdf || true
command -v expect || true
command -v oathtool || true
command -v git || true
echo "$HOME"
echo "$SHELL"
test -t 0 && echo "stdin=TTY" || echo "stdin=NOT_TTY"
test -t 1 && echo "stdout=TTY" || echo "stdout=NOT_TTY"
```

Linux 额外执行：

```bash
cat /etc/os-release
```

判定规则：

| `uname -s` 结果 | 处理 |
| --- | --- |
| `Darwin` | 继续。记录 `arm64` / `x86_64`。 |
| `Linux` | 继续，但要告知用户：Linux 未官方验证，流程尽力而为；远程功能依赖系统包。 |
| `MINGW*` / `MSYS*` / `CYGWIN*` | 停止。Finch 不支持 Windows 原生，请在 WSL2 的 Linux 发行版中重跑。 |
| 其他 | 停止，说明不支持的系统。 |

如果 `uname` 不可用，检查 `$OS` 或 `ver` 的输出：

```bash
printf '%s\n' "${OS:-}"
```

包含 `Windows_NT` 时按 Windows 原生处理：停止，并引导用户安装 WSL2：

```text
wsl --install -d Ubuntu
```

安装后在 WSL2 的 Linux 环境中重新运行本流程。不要混用 Windows 侧的 Node / npm 与 WSL2 侧的 Finch。

**检查 HOME。** `echo "$HOME"` 必须是用户的真实家目录。如果 AI 运行在容器或沙箱中（例如 `/root`、`/tmp/...`），安装出的配置不会出现在用户机器上；此时停止，要求用户在真实终端中运行本流程。

后续所有 `~/.config/finch` 都指 `$HOME/.config/finch`。

---

## 2. Node.js 升级到 `>= 22.19.0`

### 2.1 检查当前版本

```bash
node -v
npm -v
```

版本判定：`major > 22`，或 `major == 22 && minor >= 19`，即满足。若 `node` / `npm` 不存在或版本不足，进入 2.2。

### 2.2 选择升级方式

按以下优先级探测，找到第一个可用的方式即可。**不要同时使用多种方式，避免 PATH 冲突。**

下面的命令使用最低可验证版本 `22.19.0`；如果你更倾向最新 LTS，可以选择更高的版本，只要最终 `node -v` 满足 `>= 22.19.0`。

#### 方式 A：nvm（用户级，推荐给已有 nvm 的机器）

```bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 22.19.0
nvm use 22.19.0
nvm alias default 22.19.0
hash -r
```

#### 方式 B：fnm

```bash
eval "$(fnm env)"
fnm install 22.19.0
fnm default 22.19.0
hash -r
```

#### 方式 C：volta

```bash
volta install node@22.19.0
```

#### 方式 D：mise

```bash
mise install node@22.19.0
mise use -g node@22.19.0
```

#### 方式 E：Homebrew（仅 macOS）

```bash
# 如果非交互 shell 找不到 brew：
if ! command -v brew >/dev/null 2>&1 && [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif ! command -v brew >/dev/null 2>&1 && [ -x /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

brew install node@22
# 如果 node 仍指向旧版本：
brew link --overwrite --force node@22
hash -r
```

说明：`node@22` 会安装 22.x 的最新补丁，只要 `>= 22.19.0` 即可。若已经通过 Homebrew 安装过 `node`，可先用 `brew upgrade node`。

#### 方式 F：Linux 包管理器（仅在版本满足时使用）

先检查包管理器提供的版本；低于 `22.19.0` 就不要硬装。

- Debian / Ubuntu：

  ```bash
  apt-cache policy nodejs
  sudo apt-get update
  sudo apt-get install -y nodejs npm
  ```

- Fedora：

  ```bash
  sudo dnf install -y nodejs npm
  ```

- Arch：

  ```bash
  sudo pacman -S --needed nodejs npm
  ```

- openSUSE：

  ```bash
  sudo zypper --non-interactive install nodejs npm
  ```

#### 方式 G：NodeSource（Linux，系统级）

仅当发行版仓库版本过旧，且用户同意执行 NodeSource 安装脚本时使用：

- Debian / Ubuntu：

  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

- RHEL / Fedora：

  ```bash
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
  sudo dnf install -y nodejs
  ```

执行前必须明确告知用户：这会从 NodeSource 下载脚本并以 root 权限执行。

#### 方式 H：兜底

如果以上都不可用，停止并让用户手动安装 Node `>= 22.19.0`：

```text
https://nodejs.org/en/download
```

安装完成后重新从第 2 步开始。

### 2.3 验证

```bash
node -v
npm -v
command -v node
command -v npm
```

要求：

- `node -v` 输出 `v22.19.0` 或更高。
- `npm -v` 正常输出。
- `command -v node` 指向刚安装的版本。

**持久化检查。** 如果使用 nvm / fnm / volta / mise，需要确认新终端也能拿到正确版本：

- nvm：已执行 `nvm alias default 22.19.0`。
- fnm：已执行 `fnm default 22.19.0`，且 shell profile 中有 `eval "$(fnm env)"`。
- volta / mise：已写入全局默认。

如果无法持久化，明确告诉用户：新终端需要先加载对应的版本管理器，否则会回到旧 Node。

---

## 3. 安装 `expect` 与 `oathtool`

这两个程序只影响远程查询；本地粘贴日志、读取源码不依赖它们。

### 3.1 先检查

```bash
command -v expect || true
command -v oathtool || true
expect -v 2>/dev/null || true
oathtool --version 2>/dev/null || true
```

已经存在且可执行时，记录路径和版本，跳到第 4 步。

### 3.2 macOS

- `expect`：macOS 通常自带 `/usr/bin/expect`，先检查即可。
- `oathtool`：由 Homebrew 的 `oath-toolkit` 提供。

```bash
# 非交互 shell 找不到 brew 时：
if ! command -v brew >/dev/null 2>&1 && [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

brew install expect oath-toolkit
```

如果机器上没有 Homebrew：停止，询问用户是否愿意安装 Homebrew。不要私自执行 Homebrew 安装脚本。用户拒绝时，明确标注远程功能不可用。

### 3.3 Debian / Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y expect oathtool
```

### 3.4 Fedora

```bash
sudo dnf install -y expect oathtool
```

### 3.5 RHEL / CentOS

```bash
sudo dnf install -y epel-release
sudo dnf install -y expect oathtool
```

如果系统未启用 EPEL 或没有订阅源，停止并告知用户需要管理员协助。

### 3.6 Arch

```bash
sudo pacman -S --needed expect oath-toolkit
```

### 3.7 openSUSE

```bash
sudo zypper --non-interactive install expect oathtool
```

### 3.8 验证

```bash
command -v expect
command -v oathtool
expect -v
oathtool --version
```

如果安装失败：

- 本地诊断仍可继续。
- 明确标注「远程查询不可用」，并给出手工安装命令。
- 不要用源码编译或来源不明的二进制替代。

---

## 4. 安装 Finch

### 4.1 检查 npm 全局目录是否可写

```bash
prefix=$(npm prefix -g)
echo "$prefix"
if [ -w "$prefix" ]; then echo "writable"; else echo "not-writable"; fi
```

如果不可写，先和用户确认处理方式：

- **方案 A（推荐，用户级）**：把 npm 全局 prefix 改到用户目录。

  ```bash
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  hash -r
  ```

  需要把 `export PATH="$HOME/.npm-global/bin:$PATH"` 写入用户 shell profile（`~/.zshrc` 或 `~/.bashrc`）才能对未来的终端生效。修改 profile 前必须征得用户同意。

- **方案 B**：使用 `sudo npm install --global ...`。必须明确告知用户这会用 root 权限写全局目录；不推荐，仅作兜底。

- **方案 C**：用户自行修复全局目录权限。

### 4.2 安装（必须保留 `--ignore-scripts`）

推荐带 SHA256 校验的安装方式。把下面整段作为一次 Shell 调用执行：

```bash
tmp="$(mktemp -d)"
base="https://github.com/hayeslin-ai/finch/releases/latest/download"

curl -fsSL -o "$tmp/finch.tgz" "$base/finch.tgz"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"

# SHA256SUMS 同时包含 finch-<version>.tgz 与 finch.tgz 两行；
# 只校验本次下载的 finch.tgz，避免因缺少版本化文件而误报。
if ! grep -q ' finch.tgz$' "$tmp/SHA256SUMS"; then
  echo "SHA256SUMS 中缺少 finch.tgz 校验行，停止安装。" >&2
  rm -rf "$tmp"
  exit 1
fi
grep ' finch.tgz$' "$tmp/SHA256SUMS" > "$tmp/finch.tgz.sha256"
if ! (
  cd "$tmp"
  shasum -a 256 -c finch.tgz.sha256 2>/dev/null || sha256sum -c finch.tgz.sha256
); then
  echo "finch.tgz SHA256 校验失败，停止安装。" >&2
  rm -rf "$tmp"
  exit 1
fi

if ! npm install --global --ignore-scripts "$tmp/finch.tgz"; then
  echo "npm 全局安装失败，停止。" >&2
  rm -rf "$tmp"
  exit 1
fi
rm -rf "$tmp"
```

说明：

- `--ignore-scripts` 必须保留。
- 上面的地址永远指向最新版，不需要随版本号修改；这是项目发布契约，与 README 的安装命令保持一致。
- 需要固定版本时，使用 `https://github.com/hayeslin-ai/finch/releases/download/v<version>/finch-<version>.tgz`，并从同目录的 `SHA256SUMS` 校验。固定版本必须使用精确的 `v<version>` tag，不要使用其他浮动 tag；校验时把上面的 `finch.tgz` 换成 `finch-<version>.tgz`。
- 如果网络无法访问 GitHub，让用户配置代理或使用内部镜像；不要从来源不明的地址下载。
- `npm install --global` 还会从当前 npm registry 拉取依赖；如果公司网络限制访问 registry，先按用户环境配置可信的 registry 或代理。
- 如果校验工具不可用，可以回退到简化安装，但必须在报告中注明「未校验 SHA256」。

简化安装（不校验）：

```bash
npm install --global --ignore-scripts \
  https://github.com/hayeslin-ai/finch/releases/latest/download/finch.tgz
```

### 4.3 验证

```bash
finch --version
```

期望输出形如：

```text
finch <version> (node v<version>, commit <hash>)
```

如果提示 `command not found`：

```bash
npm prefix -g
echo "$PATH"
```

确认 `<prefix>/bin`（用户级 prefix 时为 `~/.npm-global/bin`）在 `PATH` 中。需要时把 PATH 配置写入 shell profile，并让用户新开终端。

---

## 5. 执行 `finch init`

```bash
finch init
echo "exit=$?"
```

期望：

- 退出码为 `0`。
- 输出包含 `已创建`、`已同步` 或 `保持不变`，涉及：
  - `~/.config/finch/`
  - `~/.config/finch/.env`
  - `~/.config/finch/models.json`
  - `~/.config/finch/login_agent.exp`

`finch init` 只创建缺失项，不覆盖已有配置。两个配置文件的初始内容直接来自包内模板：

- `.env` ← `templates/env.example`：已含 `JUMP_HOST`、`JUMP_PORT` 与全部远程键，值留空待填。
- `models.json` ← `templates/models.example.json`：含一个占位 provider `example`，需要按第 6 步替换。

### 5.1 如果退出码为 3

表示路径不安全、属主不符、存在符号链接，或包内模板缺失（安装产物不完整）。先检查，不要删除用户文件：

```bash
ls -ld "$HOME/.config/finch"
ls -l "$HOME/.config/finch"
```

- 如果只是权限过宽，且属主是当前用户、不是符号链接，征得用户同意后修复：

  ```bash
  chmod 700 "$HOME/.config/finch"
  chmod 600 "$HOME/.config/finch/.env"
  chmod 600 "$HOME/.config/finch/models.json"
  chmod 600 "$HOME/.config/finch/login_agent.exp"
  ```

  然后重新执行 `finch init`。

- 如果路径是符号链接，或属主不是当前用户：停止，让用户决定如何处理。
- 如果报告「模板文件缺失」：说明 npm 包不完整，重新安装 Finch（第 4 步），不要手工创建空配置。

### 5.2 验证

```bash
ls -la "$HOME/.config/finch"
```

不要 `cat` `.env`，避免密钥进入对话。

---

## 6. 配置 `models.json`（必做）

### 6.1 检查现有模型

`finch init` 生成的 `models.json` 来自包内模板 `templates/models.example.json`，自带一个占位 provider：

```text
example / group/example-model  (baseUrl: http://127.0.0.1:3425/v1)
```

因此刚执行完 `init` 时 `candidates=1`，但这是占位配置，**不能直接使用**，必须按 6.3 替换为真实网关。

先看当前模型（只打印 provider / model ID，不打印任何密钥）：

```bash
node -e '
const fs = require("fs");
const p = process.env.HOME + "/.config/finch/models.json";
try {
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  let n = 0;
  for (const [pid, cfg] of Object.entries(d.providers || {})) {
    for (const m of cfg.models || []) {
      if (m && typeof m.id === "string" && m.id) {
        n += 1;
        console.log(pid + "/" + m.id);
      }
    }
  }
  console.log("candidates=" + n);
} catch (e) {
  console.error("读取失败：" + e.message);
  process.exit(1);
}
'
```

- `candidates=0`：继续配置。
- `candidates=1` 且是输出中的 `example/group/example-model`：这是 `init` 的占位配置，继续按 6.3 替换。
- `candidates=1` 且不是占位配置：如果用户确认已有配置可用，跳到 6.5 检查凭证是否已就位。
- `candidates>1`：当前 Finch 版本按单模型启动，多模型会拒绝启动。让用户决定保留哪一个；只有在用户明确确认后才删除其余定义，不要擅自删除。

### 6.2 收集非敏感信息

向用户一次性询问以下信息：

1. 模型网关 `baseUrl`（必须是 `http://` 或 `https://` 地址）。
2. provider 名称（字母、数字、`.`、`_`、`-`，1–64 个字符）。
3. `api` 协议：常见值为 `openai-responses` 或 `openai-completions`；以网关文档为准。
4. 模型 ID（可以包含 `/`，例如 `team/finch-model`）。
5. 模型显示名（可留空，默认与模型 ID 相同）。
6. `contextWindow` / `maxTokens`（可留空；不知道就省略，不要编造）。
7. 凭证变量名（默认 `MODEL_API_KEY`）。本安装书后续统一按 `MODEL_API_KEY` 书写；如果用户选择其他名称，把后文所有 `MODEL_API_KEY` 替换为该名称。

### 6.3 写入 `models.json`

规则：

- 只保留**一个**模型定义。
- 如果当前是 `init` 生成的占位 provider（`example` / `group/example-model` / `http://127.0.0.1:3425/v1`），**替换**它，不要追加；追加会变成两个模型，导致启动被拒绝。
- `apiKey` 只写变量引用 `$MODEL_API_KEY`，不要写明文。
- 保留 `$schema` 与用户自定义的其他字段。
- 如果文件已有真实配置，先读取并按对象合并；不要整体覆盖。
- 最终权限必须是 `0600`。

模板：

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "my-gateway": {
      "baseUrl": "https://your-gateway.example.com/v1",
      "api": "openai-responses",
      "apiKey": "$MODEL_API_KEY",
      "models": [
        {
          "id": "team/finch-model",
          "name": "finch-model",
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

说明：

- `contextWindow` 与 `maxTokens` 是可选项；未知时删除这两行。Pi 的默认值分别是 `128000` 与 `16384`。
- `api` 支持 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai` 等；Finch 的 README 示例使用 `openai-responses`。
- `apiKey` 也可以写 `$VAR` 或 `${VAR}` 形式；Finch 会从 `~/.config/finch/.env` 读取同名变量。

写入后校验 JSON 与权限：

```bash
node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(process.env.HOME+"/.config/finch/models.json","utf8")); console.log("models.json: valid JSON")'

chmod 600 "$HOME/.config/finch/models.json"

stat -f '%Sp %N' "$HOME/.config/finch/models.json" 2>/dev/null \
  || stat -c '%a %n' "$HOME/.config/finch/models.json"
```

### 6.4 让用户本地填写 API Key（必做）

**不要询问、不要接收、不要回显密钥值。** 给用户一条可自行执行的命令。

推荐方式：用户在自己的终端里编辑文件。

```bash
${EDITOR:-vi} "$HOME/.config/finch/.env"
```

模板 `templates/env.example` 刻意不包含 `MODEL_API_KEY=`（有测试锁定），所以需要手动添加一行：

```dotenv
MODEL_API_KEY=
```

把密钥填在等号后面，保存退出。完成后执行：

```bash
chmod 600 "$HOME/.config/finch/.env"
```

可选的一次性输入方式（用户在本地终端执行，AI 不要代跑）：

```bash
if grep -q '^MODEL_API_KEY=' "$HOME/.config/finch/.env"; then
  echo "MODEL_API_KEY 已存在，请直接编辑原行，不要追加。" >&2
else
  printf 'MODEL_API_KEY: '
  stty -echo
  IFS= read -r key
  stty echo
  printf '\n'
  if [ -n "$key" ]; then
    printf 'MODEL_API_KEY=%s\n' "$key" >> "$HOME/.config/finch/.env"
  fi
  unset key
  chmod 600 "$HOME/.config/finch/.env"
fi
```

注意：

- 如果 `.env` 里已经有 `MODEL_API_KEY=`，不要追加，否则会出现重复键；让用户编辑原行。
- 值可以包含大多数特殊字符；首尾空白需要用单引号或双引号包裹。
- 不要执行 `source`。
- `.env` 解析器不支持变量展开、命令替换或转义。

### 6.5 检查凭证是否就位（不打印值）

如果 `models.json` 使用的是其他变量名（例如 `$MY_KEY`），把下面的 `MODEL_API_KEY` 换成实际变量名。

```bash
if grep -Eq '^MODEL_API_KEY=.+' "$HOME/.config/finch/.env"; then
  echo "MODEL_API_KEY: present"
else
  echo "MODEL_API_KEY: missing"
fi
```

不要把 `grep` 换成 `cat`，也不要把匹配到的值打印出来。

---

## 7. 配置远程查询（可选）

先问用户：**是否需要通过堡垒机读取远程服务器日志？**

- 不需要：跳到第 8 步。
- 需要：继续。

### 7.1 收集非敏感信息

1. `JUMP_HOST`：堡垒机入口，必须是标准 IPv4 字面量，不接受主机名或域名。
2. `JUMP_PORT`：SSH 端口。模板中该值为空，但 `doctor` 要求非空；标准端口填 `22`。
3. `JUMP_USER`：堡垒机账号。
4. `APP_GROUP`：登录后的初始账户组，默认 `appgroup`。
5. `APP_USER`：目标业务账户，默认 `app`。
6. `LOG_DIR`：远程日志根目录，默认 `~/sxpservice/logs/`。

`JUMP_PASSWORD` 与 `MFA_SECRET` **不要通过对话收集**，由用户本地填写。

### 7.2 写入 `.env`

`finch init` 生成的 `.env` 直接复制包内模板 `templates/env.example`，已经包含全部远程键：

```dotenv
JUMP_HOST=
JUMP_PORT=

JUMP_USER=
JUMP_PASSWORD=
MFA_SECRET=

APP_GROUP=appgroup
APP_USER=app
LOG_DIR=~/sxpservice/logs/
```

不需要新增键，只需要填值。`APP_GROUP` / `APP_USER` / `LOG_DIR` 已预置默认值，按实际环境修改。

合并规则：

- 已存在的键保留原值，只填空白值，不覆盖。
- 只有模板中确实没有的键才追加；不要重复添加同一个键（重复键会被 `doctor` 报错）。
- 不要写 `TARGET_HOST`（已废弃，写了也不生效）。
- 不要写 `MODEL_PROVIDER` / `MODEL_ID`（当前版本不读取）。
- 权限保持 `0600`。

字段校验规则（与程序一致）：

- `JUMP_HOST`：标准 IPv4 字面量，四段十进制，每段 0–255。
- `JUMP_PORT`：1–65535 的十进制整数。
- `JUMP_USER` / `APP_USER` / `APP_GROUP`：只能包含字母、数字与 `_ . -`，且不能以符号开头。
- `LOG_DIR`：只能包含字母、数字与 `_ . / ~ -`，不能有空白或 Shell 字符。
- `.env` 是字面量解析：不要 `source`，不要变量展开，不要命令替换；重复键会被 `doctor` 报错。

### 7.3 让用户本地填写密码与 MFA Secret

同样不要通过对话收集。让用户编辑：

```bash
${EDITOR:-vi} "$HOME/.config/finch/.env"
```

填写：

```dotenv
JUMP_PASSWORD=
MFA_SECRET=
```

`MFA_SECRET` 是 TOTP 密钥（通常是 Base32 字符串）。不要在这里生成 OTP，也不要尝试登录。

完成后：

```bash
chmod 600 "$HOME/.config/finch/.env"
```

### 7.4 检查键是否存在（不打印值）

```bash
for k in JUMP_HOST JUMP_PORT JUMP_USER JUMP_PASSWORD MFA_SECRET APP_GROUP APP_USER LOG_DIR; do
  if grep -Eq "^${k}=.+" "$HOME/.config/finch/.env"; then
    echo "$k: present"
  else
    echo "$k: missing"
  fi
done
```

### 7.5 工具路径

- 默认从 `PATH` 查找 `expect` / `oathtool`。
- 如果不在 `PATH`，用户可以在 shell 中设置绝对路径：

  ```bash
  export EXPECT_PATH=/absolute/path/to/expect
  export OATH_TOOL=/absolute/path/to/oathtool
  ```

  这两个变量**不进** `.env`；需要写入 shell profile 才能对未来的终端生效。
- 不要硬编码 `/opt/homebrew/bin/...`；先用 `command -v` 找到真实路径。

### 7.6 远程查询的当前限制

- 远程查询的目标 IP 只允许属于 `22.50.0.0/16` 或 `10.80.0.0/16`（代码内置限制）。
- 搜索是字面量 `grep`，关键词仅限 ASCII。
- 时间窗过滤（`--since` / `--until`）尚未提供。
- 每次远程查询都需要用户确认计划并重新授权；授权不会跨会话恢复。

---

## 8. 自检

### 8.1 本地诊断

```bash
finch doctor
echo "exit=$?"
```

判定：

- 退出码 `0`：「基础」与「本地诊断」通过。
- 退出码 `3`：「基础」或「本地诊断」有错误，按报告中的 `→` 提示逐项修复后重跑。
- 「远程功能」缺失不会阻止本地诊断；如果用户不需要远程，可以接受。
- `doctor` 不会调用模型、不会生成 OTP、不会连接服务器，可以安全执行。
- `doctor` 只校验模型定义与配置结构；**不读取、不验证模型 API Key**（既不检查是否存在，也不验证是否可用），也不探测 `baseUrl` 是否可达。凭证是否存在由 6.5 的检查负责，真实可用性要等用户启动 `finch` 后才会暴露。

### 8.2 远程（仅在用户需要远程时）

```bash
finch doctor --remote
echo "exit=$?"
```

检查报告中的：

- 登录脚本是否生成。
- `expect` / `oathtool` 是否找到。
- 远程配置是否齐全。

注意：**远程分组的问题不会改变退出码**。退出码只由「基础」与「本地诊断」决定，所以必须读报告文本，不能只看 `exit=`。

如果工具已安装但 `doctor --remote` 找不到，可以先在当前 shell 显式指定路径验证：

```bash
OATH_TOOL="$(command -v oathtool)" EXPECT_PATH="$(command -v expect)" finch doctor --remote
```

验证通过后，再把 PATH 或 `EXPECT_PATH` / `OATH_TOOL` 持久化到 shell profile（需用户同意）。

### 8.3 不要运行交互模式

`finch`、`finch provider`、`finch jumpserver` 需要 TTY。AI 的 shell 通常不是 TTY，运行会返回退出码 `3` 或用法错误。把这些命令留给用户在自己的终端执行。

`finch provider` / `finch jumpserver` 只适合用户手工运行；AI 已经通过直接写入 `models.json` 与 `.env` 完成配置，不需要再跑向导。

---

## 9. 验收与交接

### 9.1 收集证据

必须实际执行并记录以下输出：

```bash
finch --version
finch doctor
```

如果用户需要远程，再执行：

```bash
finch doctor --remote
```

### 9.2 输出安装报告（不含密钥）

按以下格式给用户：

```text
Finch 安装完成报告
- 系统：macOS 15.x / arm64（或 Linux 发行版 / WSL2）
- Node：vX.Y.Z（安装方式：nvm / fnm / Homebrew / 系统包 / NodeSource）
- npm：X.Y.Z
- Finch：X.Y.Z
- 配置目录：~/.config/finch（0700）
- models.json：1 个模型（provider/model-id）
- 凭证：MODEL_API_KEY 已由用户在本地填写（未读取）
- 远程：已配置 / 未配置（原因）
- expect：路径 / 版本 或 未安装
- oathtool：路径 / 版本 或 未安装
- doctor：基础 通过；本地诊断 通过；远程 通过 / 未配置
- 需要用户完成：
  1. 打开新终端（加载 PATH 变更）
  2. 进入业务仓库根目录，执行 `finch`（诊断范围取当前 Git 仓库根目录；不在 Git 仓库内时取当前目录）
  3. 如需远程：在会话中执行 `/remote <目标IP> <诉求>`
```

### 9.3 完成标准

- `finch --version` 退出码为 `0`。
- `finch doctor` 退出码为 `0`。
- `models.json` 中不再是 `init` 的占位 provider（`example` / `group/example-model` / `http://127.0.0.1:3425/v1`）。
- 如果运行了 `finch doctor --remote`，远程分组的未配置提示不改变退出码，但必须在报告中如实标注。
- 用户能在真实终端中启动 `finch`。

**没有实际命令输出作为证据，不得声称安装完成。**

---

## 附录 A：故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `finch: command not found` | npm 全局 bin 不在 `PATH` | `npm prefix -g`，把 `<prefix>/bin` 加入 `PATH`；用户级 prefix 时加入 `~/.npm-global/bin` |
| `npm install` 报 `EACCES` | npm 全局目录不可写 | 设置用户级 prefix，或在用户同意后使用 `sudo` |
| `node -v` 仍是旧版本 | `PATH` 未刷新 / 版本管理器未加载 | `command -v node`、`node -v`；新开终端或先加载 nvm/fnm |
| `doctor` 报模型不存在 | `models.json` 为空或格式错误 | 按第 6 步写入；确保只有一个模型定义 |
| 启动提示多个模型 | 当前版本按单模型启动 | 只保留一个模型定义 |
| 提示缺少模型凭证 | `$MODEL_API_KEY` 为空或变量名不匹配 | 检查 `.env` 中是否存在非空的同名变量 |
| 提示配置路径不安全 | 权限过宽、属主不符或符号链接 | 目录 `chmod 700`、文件 `chmod 600`；移除符号链接 |
| 远程工具缺失 | `expect` / `oathtool` 不在 `PATH` | `command -v` 确认；或设置 `EXPECT_PATH` / `OATH_TOOL` 绝对路径 |
| 远程登录失败 | 堡垒机地址、账号、密码或 MFA 不对 | 让用户在终端手工验证账号；安装阶段不要反复尝试登录 |
| `finch` 提示需要 TTY | AI / 管道 / 重定向环境 | 用户在真实终端中运行 |
| GitHub 下载失败 | 网络或代理问题 | 配置代理或使用内部镜像；下载后校验 SHA256 |
| `doctor --remote` 退出码仍为 0 | 远程问题不属于阻断项 | 读报告文本，不要只看退出码 |

## 附录 B：配置字段速查

### `.env`

| 键 | 必填 | 说明 |
| --- | --- | --- |
| `MODEL_API_KEY` | 是（当 `models.json` 使用 `$MODEL_API_KEY` 时） | 模型网关 API Key，用户本地填写 |
| `JUMP_HOST` | 远程必填 | 堡垒机 IPv4 地址 |
| `JUMP_PORT` | 远程必填 | 堡垒机 SSH 端口 |
| `JUMP_USER` | 远程必填 | 堡垒机账号 |
| `JUMP_PASSWORD` | 远程必填 | 堡垒机密码 |
| `MFA_SECRET` | 远程必填 | TOTP 密钥 |
| `APP_GROUP` | 远程必填 | 登录后初始账户组，默认 `appgroup` |
| `APP_USER` | 远程必填 | 目标业务账户，默认 `app` |
| `LOG_DIR` | 远程必填 | 远程日志根目录，默认 `~/sxpservice/logs/` |

可调上限（写入 `.env` 即生效）：

| 键 | 默认值 | 范围 |
| --- | --- | --- |
| `DIAGNOSIS_TIMEOUT_MS` | 300000 | 60000–1800000 |
| `QUERY_TIMEOUT_MS` | 15000 | 1000–60000 |
| `CONNECT_TIMEOUT_MS` | 60000 | 10000–180000 |
| `MAX_QUERY_COUNT` | 20 | 1–100 |
| `MAX_FILES` | 10 | 1–100 |
| `MAX_RESULT_LINES` | 2000 | 10–5000 |
| `MAX_RESULT_BYTES` | 524288 | 4096–1048576 |

### `models.json`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `providers.<id>.baseUrl` | 是 | 模型网关地址，`http(s)://` |
| `providers.<id>.api` | 是 | `openai-responses` / `openai-completions` 等 |
| `providers.<id>.apiKey` | 是 | 推荐写 `$MODEL_API_KEY` |
| `providers.<id>.models[].id` | 是 | 模型 ID，可含 `/` |
| `providers.<id>.models[].name` | 否 | 显示名 |
| `providers.<id>.models[].contextWindow` | 否 | 默认 128000 |
| `providers.<id>.models[].maxTokens` | 否 | 默认 16384 |

---

## 附录 C：安全边界（给用户的说明）

- Finch 不会修改业务仓库、不会提交代码、不会重启服务。
- 远程查询只读，且每次都需要用户确认查询计划并重新授权。
- `.env` 与 `models.json` 的权限必须是 `0600`，目录 `0700`；Finch 会拒绝读取权限过宽、属主不符或符号链接的配置。
- API Key、堡垒机密码、MFA Secret 只保存在本机 `~/.config/finch/.env`，不要提交到任何仓库。
- 安装过程中唯一会写全局目录的动作是 `npm install --global`；升级检查之外，Finch 不会自动发起外部请求。
- 本工具为内部工具；确认你已获得使用授权，不要对外分发安装包或配置。
