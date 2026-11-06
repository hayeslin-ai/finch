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

尚未实现：远程 traceId 查询（P4）、会话恢复与知识库（P5）。

## 安装

```bash
npm install --global --ignore-scripts <release tarball URL>
```

npm 不会安装 Expect 与 oathtool；缺少它们只影响远程功能，本地诊断不受影响。

## 配置

```text
~/.config/finch/.env         连接参数与凭证（0600）
~/.config/finch/models.json  Pi 原生模型配置（0600）
```

模板见 `templates/`。真实配置不得提交到仓库。
