#!/usr/bin/env python3
"""将本地 .env 离线导出为 Pi 原生配置，不执行命令或发出网络请求。"""

import json
import os
from pathlib import Path
import re
import tempfile


# 与 Expect 使用同一字面量格式，避免把密钥中的 $ 或反引号当作代码。
def load_dotenv(path: Path) -> dict[str, str]:
    values = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)", line)
        if not match:
            raise ValueError(f".env 第 {number} 行格式错误；内容未显示")
        name, value = match.groups()
        value = value.strip()
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError(f".env 第 {number} 行引号未闭合；内容未显示")
            value = value[1:-1]
        values[name] = value
    return values


# 只允许整字段的环境变量引用，不执行 Pi 支持的 !command 形式。
def resolve_credential(value: str, values: dict[str, str]) -> str:
    if not isinstance(value, str):
        raise ValueError("模型凭证必须是环境变量引用")
    match = re.fullmatch(r"\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}", value)
    if not match:
        raise ValueError("模型凭证仅支持 $NAME 或 ${NAME} 引用")
    name = match.group(1) or match.group(2)
    secret = values.get(name)
    if not secret:
        raise ValueError(f"缺少模型凭证变量：{name}")
    # Pi 会展开 $ 和开头的 !，用官方转义表示法保留凭证原值而不执行命令。
    return secret.replace("$", "$$").replace("!", "$!")


# .env 是唯一配置来源；先完整校验，再原子替换本地文件，失败不破坏旧配置。
def export_models(root: Path) -> Path:
    values = load_dotenv(root / ".env")
    raw_models = values.get("PI_MODELS_JSON")
    if not raw_models:
        raise ValueError("缺少 PI_MODELS_JSON")
    models = json.loads(raw_models)
    if not isinstance(models, dict) or not isinstance(models.get("providers"), dict):
        raise ValueError("PI_MODELS_JSON 必须包含 providers 对象")
    if not models["providers"]:
        raise ValueError("PI_MODELS_JSON 至少需要一个 provider")
    for provider in models["providers"].values():
        if not isinstance(provider, dict):
            raise ValueError("provider 配置必须是对象")
        if "apiKey" in provider:
            provider["apiKey"] = resolve_credential(provider["apiKey"], values)
        if "headers" in provider:
            if not isinstance(provider["headers"], dict):
                raise ValueError("provider headers 必须是对象")
            provider["headers"] = {
                key: resolve_credential(value, values)
                for key, value in provider["headers"].items()
            }
    output = root / "docs" / "models.json"
    if output.is_symlink():
        raise ValueError("拒绝覆盖符号链接形式的模型配置")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".models-", suffix=".tmp", dir=output.parent)
    try:
        # mkstemp 初始权限为 0600；凭证不会短暂暴露为普通可读文件。
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(models, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return output


# 错误仅输出类别，不打印解析原文或凭证；导出不等于网关联调通过。
def main() -> int:
    try:
        export_models(Path(__file__).resolve().parents[1])
    except (OSError, ValueError, TypeError) as error:
        print(f"导出失败（{type(error).__name__}）；请检查本地 .env，配置内容未显示。")
        return 2
    print("PASS：已离线导出 docs/models.json（权限 0600）；未调用模型网关。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
