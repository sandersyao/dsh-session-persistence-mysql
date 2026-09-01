#!/usr/bin/env node
// 手动冒烟脚本：真实挂载插件，走一遍 create/append/load/list/readFrom，
// 逐项断言并打印 PASS/FAIL。运行前先 `pnpm build`（import 自 lib/）。
import { Context } from "@deepseek-ai/cordis";
import SessionStore from "@deepseek-ai/dsh-session";
import { createPool } from "mysql2/promise";

import { MysqlSessionPersistence } from "../lib/index.js";

/** 简单结构事件构造。 */
function ev(type, seq, data) {
  return { type, seq, time: 1_000 + seq, data };
}

/** 一条平衡轮次（seq 从 startSeq 起，4 条）。 */
function balancedTurn(startSeq, turn) {
  return [
    ev("turn/start", startSeq, { turn }),
    ev("step/start", startSeq + 1, { turn, step: 1 }),
    ev("step/end", startSeq + 2, { turn, step: 1 }),
    ev("turn/end", startSeq + 3, { turn, reason: { kind: "completed" } }),
  ];
}

const checks = [];
function check(name, cond) {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
}

const c = new Context();
const prefix = `smoke_${Date.now().toString(36)}_`;
let pool;

try {
  console.log("[1] 挂载 SessionStore …");
  await c.plugin(SessionStore);
  console.log("[2] 挂载 MysqlSessionPersistence …");
  await c.plugin(MysqlSessionPersistence, { connection: { tablePrefix: prefix } });
  const sp = c.sessionPersistence;
  check("插件注册 ctx.sessionPersistence", !!sp);
  check("初始 list 为空（lazy）", (await sp.list()).length === 0);

  const id = "smoke-1";
  await sp.create({ version: 0, id, createdAt: 1_700_000_000_000, cwd: "/tmp" });
  check("未 append 前 list 仍为空（lazy materialization）", (await sp.list()).length === 0);

  await sp.append(id, balancedTurn(0, 1));
  await sp.append(id, balancedTurn(4, 2));
  check("append 后 list 可见 1 个会话", (await sp.list()).length === 1);

  const loaded = await sp.load(id);
  check(
    "load 还原全部 8 条事件",
    loaded.events.map((e) => e.seq).join(",") === "0,1,2,3,4,5,6,7",
  );

  const suffix = await sp.readFrom(id, 4);
  check("readFrom(4) seek 返回 4..7", suffix.events.map((e) => e.seq).join(",") === "4,5,6,7");

  const snaps = await sp.listSnapshots();
  check("listSnapshots 返回 revision", snaps.length === 1 && typeof snaps[0].revision === "string");

  console.log(`\n结果：${checks.filter((x) => x.ok).length}/${checks.length} 通过`);
  process.exitCode = checks.every((x) => x.ok) ? 0 : 1;
} catch (error) {
  console.error("冒烟失败：", error);
  process.exitCode = 1;
} finally {
  // 清理测试表并关池。
  try {
    pool ??= createPool({
      host: "127.0.0.1",
      port: 3306,
      user: process.env.MYSQL_USER ?? "dsh",
      password: process.env.MYSQL_PASSWORD ?? "dsh_dev_password",
      database: process.env.MYSQL_DATABASE ?? "dsh_session",
    });
    const names = {
      events: `${prefix}events`,
      sessions: `${prefix}sessions`,
      meta: `${prefix}_meta`,
    };
    await pool.query(
      `DROP TABLE IF EXISTS \`${names.events}\`, \`${names.sessions}\`, \`${names.meta}\``,
    );
    await pool.end();
    console.log("[cleanup] 已清理测试表并关闭连接池");
  } catch {
    /* 清理失败不影响结果 */
  }
  // cordis 上下文可能持有定时器，显式退出避免挂起。
  process.exit(process.exitCode ?? 0);
}
