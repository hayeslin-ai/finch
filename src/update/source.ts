/**
 * 版本检查用到的外部地址与阈值。
 *
 * WHY 集中成常量：package.json 没有 `repository` 字段（`private: true`，
 * 靠 Release tarball 分发），运行时无从推断仓库地址，只能显式声明。
 * 集中一处也让测试、README 与实现对同一个事实来源。
 */

/** GitHub 仓库标识。 */
export const REPOSITORY = 'hayeslin-ai/finch';

/**
 * 「最新发布」接口。未认证只读，仅取 `tag_name`。
 *
 * WHY 用 releases 而不是 npm registry：本包不从 registry 分发，
 * registry 上不存在同名包，查 registry 只会得到假结果。
 */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

/**
 * 不消耗 API 额度的「最新发布」页面地址。
 *
 * WHY 存在这个地址：api.github.com 未认证限额只有 60 次/小时/IP，
 * 办公网 NAT 下多人共享出口 IP 极易打光；打光后全是 403，
 * 功能就静默失效（开发期实测过 remaining=0 导致每次假阴性）。
 * 本地址返回 302，`location` 形如 `.../releases/tag/v0.3.0`，
 * 信息量足够且不计入 API 配额，因此作为主路径。
 */
export const LATEST_HTML_URL = `https://github.com/${REPOSITORY}/releases/latest`;

/**
 * 安装包稳定地址。
 *
 * 与 README 的安装命令、release.yml 上传的固定资产名保持同一个值：
 * 它永远指向最新版，不随版本号变化。
 */
export const INSTALL_TARBALL_URL = `https://github.com/${REPOSITORY}/releases/latest/download/finch.tgz`;

/**
 * 检查间隔。
 *
 * WHY 不是「每次启动都查」：GitHub 未认证 API 限 60 次/小时/**IP**，
 * 办公网 NAT 下多人共用一个出口 IP，全员每次启动都请求会很快打光额度；
 * 打光后检查全部静默失败，等于功能永久失效。24h 是体感与额度的折中。
 */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 单次请求超时。
 *
 * WHY 不能更短（实测教训）：本机实测首次冷连接（DNS + TLS + 建连）需要
 * 1.8～2.0 秒，2s 超时会恰好卡在边界上，于是「新装用户第一次启动”
 * 永远是假阴性——版本永远查不到，提示永远不出现，而单元测试
 * 用假 fetch 完全发现不了。5s 下冷启动 8/8 成功。
 *
 * 既然检查在后台跑、不阻塞启动，放宽到 5s 不会拖慢任何用户可见的行为。
 * 浏览器等环境仍靠 TTL 与静默失败兜底。
 */
export const FETCH_TIMEOUT_MS = 5_000;

/** footer 提示的停留时间。 */
export const NOTICE_DURATION_MS = 15_000;

/** 环境变量：设为任意非空值即彻底关闭启动检查（不发任何请求）。 */
export const DISABLE_ENV = 'FINCH_NO_UPDATE_CHECK';

/** 缓存文件名，落在 `stateDir` 下。 */
export const CACHE_FILE_NAME = 'update-check.json';
