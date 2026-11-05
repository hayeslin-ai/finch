"""使用临时假配置和 Tcl 命令桩验证迁移；不读取真实 .env、不连接 SSH 或模型。"""

import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPERS = runpy.run_path(str(ROOT / "scripts" / "export_models.py"))

# 替换所有外部交互命令，确保脚本即使回归也无法建立真实 SSH 或执行 OTP 工具。
HARNESS = r'''
set ::events [split $::env(TEST_EVENTS) |]
set ::sent {}
proc exec {args} {
    if {$::env(TEST_OTP_FAIL) eq "1"} {
        error "must-not-leak-test-secret"
    }
    puts OTP_STUB
    return 123456
}
proc spawn {args} { puts SPAWN_STUB }
proc sleep {args} {}
proc interact {} { puts INTERACT_STUB }
proc send {args} {
    if {[llength $args] != 2 || [lindex $args 0] ne "--"} {
        error "send must use --"
    }
    lappend ::sent [lindex $args 1]
}
# 按真实提示词选择分支，而非直接跳过 expect，覆盖账户切换及变量化提示词。
proc expect {body} {
    if {[llength $::events] == 0} { error "unexpected expect call" }
    set event [lindex $::events 0]
    set ::events [lrange $::events 1 end]
    set i 0
    while {$i < [llength $body]} {
        set pattern [lindex $body $i]
        incr i
        set regex 0
        if {$pattern eq "-re"} {
            set regex 1
            set pattern [lindex $body $i]
            incr i
        }
        set action [lindex $body $i]
        incr i
        set pattern [uplevel 1 [list subst -nocommands -nobackslashes $pattern]]
        if {$pattern eq "timeout"} {
            set matched [expr {$event eq "TIMEOUT"}]
        } elseif {$regex} {
            set matched [regexp -- $pattern $event]
        } else {
            set matched [string match $pattern $event]
        }
        if {$matched} {
            uplevel 1 $action
            return
        }
    }
    error "no matching expect branch"
}
set argv {}
if {$::env(TEST_ARGUMENT) ne ""} { set argv [list $::env(TEST_ARGUMENT)] }
set argc [llength $argv]
if {[catch {source [file join $::env(TEST_ROOT) docs login_bastion.exp]} message]} {
    puts stderr $message
    exit 1
}
foreach value $::sent { puts "SENT:$value" }
'''


class LocalConfigTests(unittest.TestCase):
    # 每例独立配置目录，防止测试访问真实凭证或产生共享状态。
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "docs").mkdir()
        shutil.copyfile(ROOT / "docs" / "login_bastion.exp", self.root / "docs" / "login_bastion.exp")
        self.values = {
            "JUMP_HOST": "bastion.example.test",
            "JUMP_PORT": "2222",
            "JUMP_USER": "test_operator",
            "JUMP_PASSWORD": "fake-password",
            "MFA_SECRET": "fake-secret",
            "APP_USER": "service_user",
            "APP_GROUP": "initial_user",
            "LOG_DIR": "~/service logs/",
            "OATH_TOOL": "/not-executed/oathtool",
            "TARGET_HOST": "target.example.test",
            "MAGPIE_API_KEY": "fake-api-key",
            "PI_MODELS_JSON": json.dumps({"providers": {"Fixture": {
                "baseUrl": "http://127.0.0.1:1/v1",
                "api": "openai-responses",
                "apiKey": "$MAGPIE_API_KEY",
                "models": [{"id": "fixture-model", "maxTokens": 1024}],
            }}}),
        }

    # 与模板约定一致：引号内按字面量读取，既不做 Shell 也不做 Tcl 插值。
    def write_env(self, suffix=""):
        content = "\n".join(f"{key}='{value}'" for key, value in self.values.items())
        (self.root / ".env").write_text(content + "\n" + suffix, encoding="utf-8")

    # 使用不含父进程凭证的环境，确保缺项测试不能被真实环境变量补齐。
    def run_login(self, argument="", events="OTP|Opt>|service_user@host", otp_fail=False):
        self.write_env()
        environment = {
            "PATH": os.defpath,
            "HOME": str(self.root),
            "TEST_ROOT": str(self.root),
            "TEST_ARGUMENT": argument,
            "TEST_EVENTS": events,
            "TEST_OTP_FAIL": "1" if otp_fail else "0",
        }
        return subprocess.run(
            ["/usr/bin/tclsh"], input=HARNESS, text=True, capture_output=True,
            env=environment, cwd=self.root, timeout=5,
        )

    # 静态检查必须在所有外部操作前退出。
    def test_check_only_has_no_external_calls(self):
        result = self.run_login("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS", result.stdout)
        self.assertNotIn("_STUB", result.stdout)

    # 不传目标时使用 .env 默认值，同时正确保留远端 HOME 与空格目录。
    def test_default_target_and_log_directory(self):
        result = self.run_login()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SENT:target.example.test", result.stdout)
        self.assertIn('SENT:cd -- "$HOME"/\'service logs/\'', result.stdout)
        self.assertIn("INTERACT_STUB", result.stdout)

    # 显式目标优先，并覆盖原有 sudo 切换账户分支，不赋予新 Agent 权限。
    def test_argument_override_and_account_switch(self):
        result = self.run_login("override.example.test", "OTP|Opt>|initial_user@host|service_user@host")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SENT:override.example.test", result.stdout)
        self.assertIn("SENT:sudo su - service_user", result.stdout)
        self.assertNotIn("SENT:target.example.test", result.stdout)

    # 特殊字符密码只能作为字面量发送；配置内容不能调用 Tcl exec。
    def test_password_is_literal(self):
        self.values["JUMP_PASSWORD"] = "-literal$[exec BAD]`value`#tail"
        result = self.run_login(events="Password:|OTP|Opt>|service_user@host")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SENT:" + self.values["JUMP_PASSWORD"], result.stdout)
        self.assertEqual(result.stdout.count("OTP_STUB"), 1)

    # 未配置默认目标时保留只到菜单的原有手动用法。
    def test_no_target_keeps_menu_flow(self):
        self.values["TARGET_HOST"] = ""
        result = self.run_login(events="OTP")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("SENT:cd", result.stdout)

    # 缺少凭证在 OTP 和 SSH 之前失败，错误只显示键名。
    def test_missing_setting_stops_before_connection(self):
        del self.values["MFA_SECRET"]
        result = self.run_login()
        self.assertEqual(result.returncode, 2)
        self.assertIn("MFA_SECRET", result.stderr)
        self.assertNotIn("_STUB", result.stdout)

    # 连接参数中的控制和组合字符不得进入终端协议。
    def test_invalid_target_and_port(self):
        for target, port in [("host;unexpected", "2222"), ("host", "65536")]:
            with self.subTest(target=target, port=port):
                self.values["JUMP_PORT"] = port
                result = self.run_login(target)
                self.assertEqual(result.returncode, 2)
                self.assertNotIn("_STUB", result.stdout)

    # 密钥工具的原始错误可能回显参数，必须替换为不含原值的错误。
    def test_otp_error_redacted(self):
        result = self.run_login(otp_fail=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("must-not-leak-test-secret", result.stdout + result.stderr)
        self.assertNotIn("SPAWN_STUB", result.stdout)

    # 模型地址、协议、模型目录及凭证均从临时 .env 导出，文件仅当前用户可读。
    def test_model_export_and_permissions(self):
        self.write_env()
        output = HELPERS["export_models"](self.root)
        provider = json.loads(output.read_text(encoding="utf-8"))["providers"]["Fixture"]
        self.assertEqual(provider["apiKey"], "fake-api-key")
        self.assertEqual(provider["api"], "openai-responses")
        self.assertEqual(provider["models"][0]["id"], "fixture-model")
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    # Pi 自身会插值凭证，需验证导出值不会变成命令或二次环境变量展开。
    def test_model_credential_escaping(self):
        self.values["MAGPIE_API_KEY"] = "!literal$KEY"
        self.write_env()
        output = HELPERS["export_models"](self.root)
        self.assertEqual(json.loads(output.read_text())["providers"]["Fixture"]["apiKey"], "$!literal$$KEY")

    # 失败时保留上次可用的配置，不能用半成品覆盖。
    def test_bad_model_config_keeps_previous_output(self):
        output = self.root / "docs" / "models.json"
        output.write_text('{"previous":true}', encoding="utf-8")
        self.values["PI_MODELS_JSON"] = "not-json"
        self.write_env()
        with self.assertRaises(ValueError):
            HELPERS["export_models"](self.root)
        self.assertEqual(output.read_text(), '{"previous":true}')

    # 配置语法错误不得静默忽略，防止读取到了部分或意外的凭证。
    def test_dotenv_format_errors(self):
        for line in ["BAD LINE", "BROKEN='not-closed"]:
            with self.subTest(line=line):
                self.write_env(line)
                with self.assertRaises(ValueError):
                    HELPERS["load_dotenv"](self.root / ".env")

    # 本地模型导出不得执行 !command 取凭证。
    def test_model_command_credentials_rejected(self):
        with self.assertRaises(ValueError):
            HELPERS["resolve_credential"]("!unexpected-command", self.values)


if __name__ == "__main__":
    unittest.main()
