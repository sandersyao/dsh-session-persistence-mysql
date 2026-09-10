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

describe("loadSettingsFromEnv：独享 SESSION_* 优先于共享 MYSQL_*", () => {
  it("SESSION_* 设置时覆盖共享 MYSQL_*", () => {
    const env = {
      ...validEnv(),
      SESSION_DATABASE: "dsh_session_excl",
      SESSION_TABLE_PREFIX: "sess_",
      SESSION_PORT: "4406",
      SESSION_POOL_SIZE: "22",
      SESSION_PACK_CHUNKS: "false",
    };
    const settings = loadSettingsFromEnv(env);
    expect(settings.connection.database).toBe("dsh_session_excl");
    expect(settings.connection.tablePrefix).toBe("sess_");
    expect(settings.connection.port).toBe(4406);
    expect(settings.pool.poolSize).toBe(22);
    expect(settings.persistence.packChunks).toBe(false);
    // 未设 SESSION_HOST → 回退共享 MYSQL_HOST。
    expect(settings.connection.host).toBe("127.0.0.1");
  });

  it("SESSION_READ_HOST 配置读库时读库独立", () => {
    const env = {
      ...validEnv(),
      SESSION_READ_HOST: "ro-host",
      SESSION_READ_USER: "ro",
      SESSION_READ_PASSWORD: "rop",
    };
    const settings = loadSettingsFromEnv(env);
    expect(settings.readConnection.host).toBe("ro-host");
    expect(settings.readConnection.user).toBe("ro");
    expect(settings.readConnection).not.toBe(settings.connection);
  });

  it("SESSION_SCHEMA_AUTO_MIGRATE=false 关闭自动迁移", () => {
    const env = { ...validEnv(), SESSION_SCHEMA_AUTO_MIGRATE: "false" };
    expect(loadSettingsFromEnv(env).security.schemaAutoMigrate).toBe(false);
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
