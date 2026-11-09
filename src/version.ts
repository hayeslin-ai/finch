/**
 * 版本与构建标识。
 *
 * WHY：`--version` 用于排障时确认团队实际安装的版本；
 * 同时保留构建提交号，避免“版本号相同但代码不同”的情况无法区分。
 */
export const PACKAGE_NAME = 'finch';

/** 与 package.json 的 version 保持一致，由测试强制校验。 */
export const VERSION = '0.2.0';

/**
 * 构建提交号。发布构建通过环境变量注入；本地开发未注入时标记为 unknown，
 * 不伪造提交号，避免把未追踪的本地构建当成正式发布。
 */
export const BUILD_COMMIT = process.env['BUILD_COMMIT'] ?? 'unknown';
