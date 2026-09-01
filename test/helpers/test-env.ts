import { config as loadDotenv } from "dotenv";

/**
 * vitest setupFiles：每个 worker 启动时执行。
 * 覆盖 process.env.MYSQL_DATABASE 为测试库、清空读库（同库模式），
 * 使所有自动化测试（含插件经 Config 读 env）使用测试库，隔离于生产库。
 * 测试库的建库/授权由 globalSetup 负责。
 */
loadDotenv({ quiet: true });

process.env.MYSQL_DATABASE = process.env.MYSQL_TEST_DATABASE ?? "test";
// 清空读库 → 测试同库模式。
delete process.env.MYSQL_READ_HOST;
