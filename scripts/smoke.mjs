#!/usr/bin/env node
import fs from "node:fs";
import { config as loadDotenv } from "dotenv";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";

import MysqlSessionPersistence from "../lib/index.js";

const LOG_PATH = "/tmp/smoke.log";
fs.writeFileSync(LOG_PATH, "");
const log = (msg) => fs.appendFileSync(LOG_PATH, `[smoke] ${msg}\n`);

loadDotenv({ quiet: true, path: process.env.SMOKE_ENV ?? undefined });

async function main() {
  log("starting");
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  log("sessions plugin loaded");

  const persistence = new MysqlSessionPersistence(ctx, {});
  log("persistence constructed");
  await persistence[Symbol.for("cordis.init")]?.();
  log("persistence initialized");

  const id = SessionId(`smoke-${Date.now()}`);
  const header = {
    version: 3,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd: process.cwd(),
  };
  const writeHandle = await persistence.create(header);
  log(`created handle, id = ${writeHandle.id}`);

  const events = [];
  for (let i = 0; i < 4; i++) {
    events.push({ type: "turn/start", seq: i, time: Date.now() + i, data: { turn: 0 } });
  }
  await writeHandle.append(events);
  log(`appended ${events.length} events`);

  const slice = await writeHandle.read(0);
  log(`read back ${slice.events.length} events, first seq = ${slice.events[0]?.seq}`);

  await writeHandle.flush();
  log("flushed");

  const snap = await persistence.stat(id);
  log(`stat eventCount = ${snap?.eventCount}`);

  const all = await persistence.list();
  log(`list size = ${all.length}`);

  const readHandle = await persistence.open(id, "read");
  const reread = await readHandle.read();
  log(`reopen+read size = ${reread.events.length}`);
  await readHandle.close();

  await writeHandle.close();
  log("writes closed");

  await persistence.flush();
  log("service flush ok");

  await ctx.fiber.dispose();
  log("ctx disposed");
  log("PASS");
}

main().catch((err) => {
  log(`FAIL ${err?.stack ?? err}`);
  process.exit(1);
});
