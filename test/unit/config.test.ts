import { describe, expect, it } from "vitest";

import { loadSettingsFromEnv, mergeSettings } from "../../src/config.js";

/** 一组合法的最小 env 快照。 */
function validEnv(): Record<string, string> {
  return {
    MYSQL_HOST: "127.0.0.1",
    MYSQL_PORT: "3306",
    MYSQL_USER: "dsh",
    MYSQL_PASSWORD: "secret",
    MYSQL_DATABASE: "dsh_session",
    MYSQL_TABLE_PREFIX: "dsh_",
  };
}

describe("loadSettingsFromEnv", () => {
  it("解析完整设置，缺省池/持久化参数落到默认值", () => {
    const settings = loadSettingsFromEnv(validEnv());
    expect(settings.connection.host).toBe("127.0.0.1");
    expect(settings.connection.port).toBe(3306);
    expect(settings.connection.tablePrefix).toBe("dsh_");
    expect(settings.persistence.writeBatchMaxDelayMs).toBe(200);
    expect(settings.persistence.packChunks).toBe(true);
    expect(settings.pool.poolSize).toBe(10);
    expect(settings.security.schemaAutoMigrate).toBe(true);
  });

  it("缺库场景：缺 MYSQL_HOST 抛错（fail-closed）", () => {
    const env = validEnv();
    delete env.MYSQL_HOST;
    expect(() => loadSettingsFromEnv(env)).toThrow(/MYSQL_HOST/);
  });

  it("缺库场景：缺 MYSQL_PASSWORD 抛错", () => {
    const env = validEnv();
    delete env.MYSQL_PASSWORD;
    expect(() => loadSettingsFromEnv(env)).toThrow(/MYSQL_PASSWORD/);
  });

  it("非法端口抛错", () => {
    const env = validEnv();
    env.MYSQL_PORT = "not-a-number";
    expect(() => loadSettingsFromEnv(env)).toThrow(/MYSQL_PORT/);
  });

  it("读库未配置时复用写库连接（同库模式）", () => {
    const settings = loadSettingsFromEnv(validEnv());
    expect(settings.readConnection).toBe(settings.connection);
  });

  it("配置读库时读库独立", () => {
    const env = validEnv();
    env.MYSQL_READ_HOST = "read-host";
    env.MYSQL_READ_USER = "readuser";
    env.MYSQL_READ_PASSWORD = "readpass";
    const settings = loadSettingsFromEnv(env);
    expect(settings.readConnection.host).toBe("read-host");
    expect(settings.readConnection.user).toBe("readuser");
    expect(settings.readConnection).not.toBe(settings.connection);
  });

  it("packChunks=false 可关闭折叠", () => {
    const env = validEnv();
    env.MYSQL_PACK_CHUNKS = "false";
    expect(loadSettingsFromEnv(env).persistence.packChunks).toBe(false);
  });
});

describe("mergeSettings", () => {
  it("用户覆盖优先级高于 env 基址", () => {
    const base = loadSettingsFromEnv(validEnv());
    const merged = mergeSettings(base, {
      connection: { user: "override-user" },
      pool: { poolSize: 42 },
    });
    expect(merged.connection.user).toBe("override-user");
    expect(merged.pool.poolSize).toBe(42);
    expect(merged.connection.host).toBe(base.connection.host);
  });

  it("无覆盖时返回与基址一致的值", () => {
    const base = loadSettingsFromEnv(validEnv());
    const merged = mergeSettings(base, undefined);
    expect(merged.connection).toEqual(base.connection);
  });
});
