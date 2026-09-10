# 两处本地修复的动机 —— raw-artifact 导出 & append 幂等（0.1.5 已重做）

> 记录动机：原 0.1.2 实现提交 `5261100`（导出）与 `7e78fa4`（幂等）已从 `main` 撤销并丢弃，
> 0.1.5-rc.1 上已按下文重做（append 幂等）或确认无需实现（raw-artifact，由上游承接）。
> 两处都源自线上分布式（共享 MySQL）环境的实际故障：Session 导出 HTTP 501、追加问题时
> `Duplicate entry 'session-...-557' for key 'dsh_session_events.PRIMARY'`。

## 背景（0.1.2-rc.1 时代的故障）
- **导出 501**：`dsh-session-log-export` 的 export 路由在 `sessionPersistence.supportsRawArtifacts === false`
  时直接返回 501。本插件当时硬编码 `supportsRawArtifacts = false`，故 MySQL 后端的 Session 日志导出**必然**不可用。
- **重复主键**：MySQL 后端不决定 `seq`，只按协调器给的事件插入。共享 MySQL + 多驱动方（web / headless / 集群 worker）
  并发写同一会话时，协调器可能“提交成功但 ack 前断连”后重发同批（at-least-once），或两个进程都取到同一 next-seq，
  第二次插入撞 `(session_id, seq)` 主键，被当作错误抛给用户，导致整轮失败。

## 修复一：raw-artifact 导出（`5261100`）
- **动机**：解除 MySQL 后端 `/export` 的 501，让 Session 日志可导出为可被 dsh 重新读取/还原的工件。
- **做法**：`supportsRawArtifacts = true` + 实现 `readRaw(id)`，从 DB 行**重构**会话 JSONL：
  首行 `{"type":"session",...}`（含 `seedLength` 仅 `isSeeded` 时），随后每行一条存储记录
  （`packChunkRuns` 折叠 + `encodeSeqRanges` provenance 范围编码），逐字节对齐官方
  `dsh-session-persistence-jsonl` plaintext；会话缺失返回 `undefined`。
- **文件**：`src/raw-artifact.ts`（`serializeSessionJsonl` / `RAW_ARTIFACT_FILENAME`）、
  `src/index.ts`（`supportsRawArtifacts` + `readRaw`）；测试 `test/unit/raw-artifact.test.ts`、
  `test/helpers/decode-jsonl.ts`、`test/e2e/plugin.test.ts`（真实 DB 往返 + 导出一致性）。
- **0.1.5 重做注意**：0.1.5-rc.1 的 `@deepseek-ai/dsh-session-persistence` 抽象面已改为
  `create/open/flush/stat/list`（`SessionHandle`），**不再有 `supportsRawArtifacts`/`readRaw`**（已核对 d.ts）。
  需先查清 0.1.5 的“导出/原始工件”能力落在哪个接缝（或确认该能力已移出 sessionPersistence），再重做；
  不可直接照搬旧 API。

## 修复二：append 主键重复的幂等判定（`7e78fa4`）
- **动机**：把“已提交批次的 at-least-once 重放”从用户可见的失败改为幂等 no-op，同时不掩盖真冲突。
- **做法**：`appendBatchOnce` 捕获重复键（MySQL errno 1062）后，用 `(session_id, seq)` 读回已存在行 payload，
  与本次事件的规范化内容逐条比较：
  - **全部一致** → 视为同批重放，no-op 成功返回；
  - **存在同 seq 不同内容** → 判为多个驱动方并发写同一会话的真冲突，抛出更明确的错误，不静默。
- **文件**：`src/mysql-backend.ts`（`isDuplicateKey` / `committedMatches` / 事件规范化比较）、
  `test/integration/backend.test.ts`（同内容重放成功、不同内容拒绝）。
- **0.1.5 重做注意**：0.1.5 写路径在 `MysqlBackend.persistBatch`/`persistBatchOnce`（handle 层驱动），
  旧 `appendBatchOnce` 已不存在；需把同样的“内容一致才 no-op”判定搬到 `persistBatchOnce`。
  另外 0.1.5 当前行为：sessions INSERT 重复 → `SessionAlreadyExistsError`；events INSERT 重复 →
  `SessionHandleClosedError`——重做时应确认该语义是否合理（重复事件更可能是重放而非 closed）。

## 重做时的验收（沿用 0.1.2 版口径）
- 导出：`readRaw` 返回的 JSONL 经解码后事件与原日志逐条一致；chunk 折叠/seed/provenance 往返无损。
- 幂等：同内容重放成功且不产生重复行；同 seq 不同内容抛出明确冲突错误。
- 门禁：`typecheck` / `lint` / `build` / `test:coverage`（lines≥90）。

## 0.1.5 重做结果（2026-09-10）
- **append 幂等：已重做**。移植到 0.1.5 的 `MysqlBackend.persistBatchOnce`：sessions INSERT 与 events INSERT
  两处重复键都先 `committedMatches` 做“同 seq 内容逐条一致”判定，一致 → 回滚后 no-op；不一致 →
  `SessionAlreadyExistsError` / 明确冲突错误。回归见 `test/integration/backend.test.ts`。
  注：这同时修正了 `persistBatchOnce` 里“events 重复 → `SessionHandleClosedError`”的旧语义。
- **raw-artifact 导出：确认无需实现**。0.1.5 的 `@deepseek-ai/dsh-session-log-export@0.1.5-rc.1` 已改为
  经 `sessionPersistence.open(id,"read")` + `SessionHandle.read()` 读取，并自行 `serializeSessionLog`
  生成 canonical JSONL；`SessionPersistence` 抽象面不再有 `supportsRawArtifacts`/`readRaw`，
  旧的 501 由上游设计消除。本插件只要 `open`/`read` 正确即天然支持导出。
  已加导出路径回归 `test/integration/handle.test.ts`（open(read) + read(0, undefined) 全量读并可序列化）。
