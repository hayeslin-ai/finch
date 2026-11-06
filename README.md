# Finch

只读的 Java / Spring Boot / Spring Cloud 故障诊断 CLI。

## 本地开发

```bash
npm install          # 安装锁定版本依赖
npm run dev -- --help   # 编译并运行 CLI，可追加任意参数
npm run cli -- --version   # 直接运行已编译产物，不重新编译
npm run doctor       # 编译并执行 doctor
npm run init         # 编译并初始化用户配置目录
npm test             # 编译并运行全部测试
npm run clean        # 删除 dist
```

## 状态

P1 基础：版本、帮助、`init`、`doctor`、配置与权限边界、预算控制。
诊断主流程、配置向导、远程查询与会话恢复将在后续阶段实现。

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
