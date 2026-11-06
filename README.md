# Finch

只读的 Java / Spring Boot / Spring Cloud 故障诊断 CLI。

## 状态

P0 骨架：仅提供版本与帮助命令。诊断、远程查询、配置向导与 doctor 将在后续阶段实现。

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
