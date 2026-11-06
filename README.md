# Finch

只读的 Java / Spring Boot / Spring Cloud 故障诊断 CLI。

## 本地开发

```bash
npm install          # 安装锁定版本依赖
npm run dev          # 编译并进入交互式诊断
npm run dev -- --help   # 编译并运行 CLI，可追加任意参数
npm run cli -- --version   # 直接运行已编译产物，不重新编译
npm run doctor       # 编译并执行 doctor
npm run init         # 编译并初始化用户配置目录
npm test             # 编译并运行全部测试
npm run clean        # 删除 dist
```

## 状态

已完成：版本与帮助、`init`、`doctor`、`provider`、`jumpserver` 配置向导、
配置与权限边界、预算控制、日志记录解析、本地日志读取、单仓库源码检索、
输入解析、证据存储、固定系统提示词、受限只读工具、交互式诊断主循环。

诊断主循环已接入真实模型网关并完成端到端验证：模型可自动调用源码检索工具、
生成证据编号并在结论中引用；未编造源码或行号。

已完成：会话事件记录与恢复（`-c`、`-r`、`--sessions`）、本地 Markdown 故障知识库。

远程 `/trace`：已完成目标解析（日志提取 / 最近使用 / 显式指定）、
确认流程与工具环境检查；**尚未建立真实连接**，桥接脚本需在真实环境验证后启用。

知识库：`/knowledge` 支持列表、检索、保存与失效标记。

## 安装

```bash
npm install --global --ignore-scripts <release tarball URL>
```

npm 不会安装 Expect 与 oathtool；缺少它们只影响远程功能，本地诊断不受影响。

## 配置

```text
~/.config/finch/.env         连接参数与凭证（0600，人工编辑）
~/.config/finch/models.json  Pi 原生模型配置（0600）
```

只有一个模型时自动采用；有多个时用 `--model <provider>/<modelId>` 指定，
或启动后用 `/model` 切换（仅本次会话）。`/effort` 可切换思考等级。

交互界面：输入区上下由红色横线包围，输入 `/` 会显示命令列表，
方向键选择、Tab 补全；下方常驻状态行显示
`[模型·思考级别 | 工作目录 | Git 分支 | 会话]`。

模板见 `templates/`。真实配置不得提交到仓库。
