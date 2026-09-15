import { describe, expect, it } from "vitest";

import {
  assertTablePrefix,
  eventsDdl,
  leasesDdl,
  metaDdl,
  SCHEMA_VERSION,
  sessionsDdl,
  tableNames,
} from "../../src/schema.js";

describe("assertTablePrefix", () => {
  it("接受合法前缀", () => {
    expect(assertTablePrefix("dsh_")).toBe("dsh_");
    expect(assertTablePrefix("Prefix1_")).toBe("Prefix1_");
  });

  it("拒绝含非法字符的前缀（防标识符注入）", () => {
    expect(() => assertTablePrefix("dsh; DROP TABLE")).toThrow(/表前缀非法/);
    expect(() => assertTablePrefix("a-b")).toThrow(/表前缀非法/);
    expect(() => assertTablePrefix("a b")).toThrow(/表前缀非法/);
  });
});

describe("tableNames", () => {
  it("派生三张表名", () => {
    const names = tableNames("dsh_");
    expect(names.sessions).toBe("dsh_sessions");
    expect(names.events).toBe("dsh_events");
    expect(names.meta).toBe("dsh__meta");
  });
});

describe("DDL 语句", () => {
  it("sessions DDL 包含全部字段与中文注释", () => {
    const ddl = sessionsDdl("dsh_sessions");
    for (const field of [
      "session_id",
      "version",
      "created_at",
      "cwd",
      "parent_session",
      "seed_length",
      "origin",
      "delegation_depth",
      "agent_preset",
      "log_rev",
    ]) {
      expect(ddl).toContain(field);
    }
    for (const comment of ["品牌化会话 id", "日志修订号", "会话头表"]) {
      expect(ddl).toContain(comment);
    }
  });

  it("events DDL 引用正确的 sessions 表名", () => {
    const ddl = eventsDdl("dsh_events", "dsh_sessions");
    expect(ddl).toContain("REFERENCES `dsh_sessions`(session_id)");
    for (const field of ["session_id", "seq", "row_type", "payload"]) {
      expect(ddl).toContain(field);
    }
    for (const comment of ["复合主键", "存储行类型", "事件日志表"]) {
      expect(ddl).toContain(comment);
    }
  });

  it("meta DDL 包含 version 主键", () => {
    const ddl = metaDdl("dsh__meta");
    expect(ddl).toContain("PRIMARY KEY (version)");
  });

  it("当前 SCHEMA_VERSION 为 3（会话格式 v3 + leases 表）", () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  it("leases DDL 含围栏/到期列且不建外键", () => {
    const ddl = leasesDdl("dsh_leases");
    for (const field of [
      "session_id",
      "owner_id",
      "fence_token",
      "expires_at",
      "last_heartbeat_at",
    ]) {
      expect(ddl).toContain(field);
    }
    expect(ddl).toContain("PRIMARY KEY (session_id)");
    expect(ddl).not.toContain("FOREIGN KEY");
  });
});
