/**
 * Repository for the stored-script tables: `scripts`, `script_versions`,
 * `script_approvals` and `script_runs`.
 *
 * JSON columns (`manifest`, `dry_run_report`) are stored and returned as text;
 * this repository never parses them. IDs are supplied by the caller.
 */

import type Database from 'better-sqlite3';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../../errors/index.js';
import type { VersionState } from '../../../scripts/types.js';
import { BaseRepository } from './base-repository.js';
import { runLedgerTransaction } from './image-repository.js';

/** Row shape matching the `scripts` table. */
export interface ScriptRow {
  id: string;
  persona_id: string;
  name: string;
  created_at: number;
}

/** Row shape matching the `script_versions` table. */
export interface ScriptVersionRow {
  id: string;
  script_id: string;
  version: number;
  content_hash: string;
  manifest: string;
  state: VersionState;
  thread_id: string | null;
  dry_run_report: string | null;
  created_at: number;
  updated_at: number;
}

/** Row shape matching the `script_approvals` table. */
export interface ScriptApprovalRow {
  id: string;
  version_id: string;
  code_hash: string;
  channel_name: string;
  external_thread_id: string;
  expires_at: number;
  decided_at: number | null;
  decision: 'approved' | 'rejected' | null;
  created_at: number;
}

export type ScriptRunTrigger = 'test' | 'dry-run' | 'schedule';

/** Row shape matching the `script_runs` table. */
export interface ScriptRunRow {
  id: string;
  version_id: string;
  mode: string;
  trigger: ScriptRunTrigger;
  schedule_id: string | null;
  ok: number | null;
  error_code: string | null;
  call_count: number;
  started_at: number;
  ended_at: number | null;
}

/** Input for a new version. The version number is assigned by the repository. */
export interface InsertScriptVersionInput {
  id: string;
  scriptId: string;
  contentHash: string;
  /** JSON text. */
  manifest: string;
  threadId: string | null;
}

/** Input for a new approval request. */
export interface InsertScriptApprovalInput {
  id: string;
  versionId: string;
  codeHash: string;
  channelName: string;
  externalThreadId: string;
  expiresAt: number;
}

/** Input for a new run. */
export interface InsertScriptRunInput {
  id: string;
  versionId: string;
  mode: string;
  trigger: ScriptRunTrigger;
  scheduleId?: string | null;
  startedAt: number;
}

/** Repository for stored scripts, their versions, approvals and runs. */
export class ScriptRepository extends BaseRepository {
  private readonly findScriptStmt: Database.Statement;
  private readonly getScriptStmt: Database.Statement;
  private readonly failOpenRunsStmt: Database.Statement;
  private readonly insertScriptStmt: Database.Statement;
  private readonly maxVersionStmt: Database.Statement;
  private readonly insertVersionStmt: Database.Statement;
  private readonly getVersionStmt: Database.Statement;
  private readonly latestVersionStmt: Database.Statement;
  private readonly latestApprovedStmt: Database.Statement;
  private readonly setDryRunReportStmt: Database.Statement;
  private readonly insertApprovalStmt: Database.Statement;
  private readonly findOpenApprovalStmt: Database.Statement;
  private readonly getApprovalStmt: Database.Statement;
  private readonly expireOpenApprovalsStmt: Database.Statement;
  private readonly decideApprovalStmt: Database.Statement;
  private readonly setVersionStateOnlyStmt: Database.Statement;
  private readonly retireOtherApprovedStmt: Database.Statement;
  private readonly insertRunStmt: Database.Statement;
  private readonly finishRunStmt: Database.Statement;
  private readonly activeRunStmt: Database.Statement;
  private readonly lastFinishedRunStmt: Database.Statement;

  constructor(db: Database.Database) {
    super(db);

    this.findScriptStmt = db.prepare(`SELECT * FROM scripts WHERE persona_id = ? AND name = ?`);
    this.getScriptStmt = db.prepare(`SELECT * FROM scripts WHERE id = ?`);
    this.failOpenRunsStmt = db.prepare(
      `UPDATE script_runs SET ended_at = ?, ok = 0, error_code = 'SANDBOX' WHERE ended_at IS NULL`,
    );
    this.insertScriptStmt = db.prepare(
      `INSERT INTO scripts (id, persona_id, name, created_at) VALUES (?, ?, ?, ?)`,
    );

    this.maxVersionStmt = db.prepare(
      `SELECT COALESCE(MAX(version), 0) AS max_version FROM script_versions WHERE script_id = ?`,
    );
    this.insertVersionStmt = db.prepare(`
      INSERT INTO script_versions
        (id, script_id, version, content_hash, manifest, state, thread_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
    `);
    this.getVersionStmt = db.prepare(`SELECT * FROM script_versions WHERE id = ?`);
    this.latestVersionStmt = db.prepare(
      `SELECT * FROM script_versions WHERE script_id = ? ORDER BY version DESC LIMIT 1`,
    );
    this.latestApprovedStmt = db.prepare(`
      SELECT * FROM script_versions
      WHERE script_id = ? AND state = 'approved'
      ORDER BY version DESC LIMIT 1
    `);
    this.setDryRunReportStmt = db.prepare(
      `UPDATE script_versions SET dry_run_report = ?, updated_at = ? WHERE id = ?`,
    );
    this.setVersionStateOnlyStmt = db.prepare(
      `UPDATE script_versions SET state = ?, updated_at = ? WHERE id = ?`,
    );
    this.retireOtherApprovedStmt = db.prepare(`
      UPDATE script_versions SET state = 'retired', updated_at = @now
      WHERE script_id = @script_id AND id <> @id AND state = 'approved'
    `);

    this.insertApprovalStmt = db.prepare(`
      INSERT INTO script_approvals
        (id, version_id, code_hash, channel_name, external_thread_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.findOpenApprovalStmt = db.prepare(
      `SELECT * FROM script_approvals WHERE code_hash = ? AND decided_at IS NULL`,
    );
    this.getApprovalStmt = db.prepare(`SELECT * FROM script_approvals WHERE id = ?`);
    this.expireOpenApprovalsStmt = db.prepare(
      `UPDATE script_approvals SET expires_at = ? WHERE version_id = ? AND decided_at IS NULL`,
    );
    this.decideApprovalStmt = db.prepare(
      `UPDATE script_approvals SET decided_at = ?, decision = ? WHERE id = ? AND decided_at IS NULL`,
    );

    this.insertRunStmt = db.prepare(`
      INSERT INTO script_runs (id, version_id, mode, trigger, schedule_id, call_count, started_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `);
    this.finishRunStmt = db.prepare(`
      UPDATE script_runs SET ok = ?, error_code = ?, call_count = ?, ended_at = ?
      WHERE id = ?
    `);
    this.activeRunStmt = db.prepare(`
      SELECT r.* FROM script_runs r
      JOIN script_versions v ON v.id = r.version_id
      WHERE v.script_id = ? AND r.ended_at IS NULL
      ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1
    `);
    this.lastFinishedRunStmt = db.prepare(`
      SELECT r.* FROM script_runs r
      JOIN script_versions v ON v.id = r.version_id
      WHERE v.script_id = ? AND r.trigger = ? AND r.ended_at IS NOT NULL
      ORDER BY r.ended_at DESC, r.rowid DESC LIMIT 1
    `);
  }

  private fail(action: string, cause: unknown): DbError {
    return new DbError(
      `Failed to ${action}: ${String(cause)}`,
      cause instanceof Error ? cause : undefined,
    );
  }

  /** Returns the script for `(personaId, name)`, creating it with `id` if absent. */
  upsertScript(personaId: string, name: string, id: string): Result<ScriptRow, DbError> {
    try {
      const existing = this.findScriptStmt.get(personaId, name) as ScriptRow | undefined;
      if (existing) {
        return ok(existing);
      }
      this.insertScriptStmt.run(id, personaId, name, this.now());
      return ok(this.findScriptStmt.get(personaId, name) as ScriptRow);
    } catch (cause) {
      return err(this.fail('upsert script', cause));
    }
  }

  findScript(personaId: string, name: string): Result<ScriptRow | null, DbError> {
    try {
      return ok((this.findScriptStmt.get(personaId, name) as ScriptRow | undefined) ?? null);
    } catch (cause) {
      return err(this.fail('find script', cause));
    }
  }

  getScript(id: string): Result<ScriptRow | null, DbError> {
    try {
      return ok((this.getScriptStmt.get(id) as ScriptRow | undefined) ?? null);
    } catch (cause) {
      return err(this.fail('get script', cause));
    }
  }

  /** Marks every unfinished run as failed (SANDBOX); returns how many changed. */
  failOpenRuns(now: number): Result<number, DbError> {
    try {
      return ok(this.failOpenRunsStmt.run(now).changes);
    } catch (cause) {
      return err(this.fail('fail open script runs', cause));
    }
  }

  /** Inserts a draft version numbered highest + 1, in one transaction. */
  insertVersion(input: InsertScriptVersionInput): Result<ScriptVersionRow, DbError> {
    return runLedgerTransaction(this, () => {
      try {
        const { max_version } = this.maxVersionStmt.get(input.scriptId) as { max_version: number };
        const ts = this.now();
        this.insertVersionStmt.run(
          input.id,
          input.scriptId,
          max_version + 1,
          input.contentHash,
          input.manifest,
          input.threadId,
          ts,
          ts,
        );
        return ok(this.getVersionStmt.get(input.id) as ScriptVersionRow);
      } catch (cause) {
        return err(this.fail('insert script version', cause));
      }
    });
  }

  getVersion(id: string): Result<ScriptVersionRow | null, DbError> {
    try {
      return ok((this.getVersionStmt.get(id) as ScriptVersionRow | undefined) ?? null);
    } catch (cause) {
      return err(this.fail('get script version', cause));
    }
  }

  latestVersion(scriptId: string): Result<ScriptVersionRow | null, DbError> {
    try {
      return ok((this.latestVersionStmt.get(scriptId) as ScriptVersionRow | undefined) ?? null);
    } catch (cause) {
      return err(this.fail('get latest script version', cause));
    }
  }

  /** The `approved` version with the highest version number, or null. */
  latestApproved(scriptId: string): Result<ScriptVersionRow | null, DbError> {
    try {
      return ok((this.latestApprovedStmt.get(scriptId) as ScriptVersionRow | undefined) ?? null);
    } catch (cause) {
      return err(this.fail('get latest approved script version', cause));
    }
  }

  /**
   * Moves a version to `to` only if its current state is in `from`. Returns
   * true if a row changed, false otherwise.
   */
  setVersionState(
    id: string,
    from: readonly VersionState[],
    to: VersionState,
  ): Result<boolean, DbError> {
    if (from.length === 0) {
      return ok(false);
    }
    try {
      const placeholders = from.map(() => '?').join(', ');
      const info = this.db
        .prepare(
          `UPDATE script_versions SET state = ?, updated_at = ?
           WHERE id = ? AND state IN (${placeholders})`,
        )
        .run(to, this.now(), id, ...from);
      return ok(info.changes > 0);
    } catch (cause) {
      return err(this.fail('set script version state', cause));
    }
  }

  /**
   * Ends a test in one transaction. Moves the version to `to` only if it is
   * `draft` or `tested`; writes `report` only if that move happened and `to` is
   * `tested`. Returns false, changing nothing, if the state was something else.
   */
  recordTestResult(
    versionId: string,
    result: { report: string | null; to: 'tested' | 'draft' },
  ): Result<boolean, DbError> {
    return runLedgerTransaction(this, () => {
      try {
        const info = this.db
          .prepare(
            `UPDATE script_versions SET state = ?, updated_at = ?
             WHERE id = ? AND state IN ('draft', 'tested')`,
          )
          .run(result.to, this.now(), versionId);
        if (info.changes === 0) {
          return ok(false);
        }
        if (result.to === 'tested' && result.report !== null) {
          this.setDryRunReportStmt.run(result.report, this.now(), versionId);
        }
        return ok(true);
      } catch (cause) {
        return err(this.fail('record test result', cause));
      }
    });
  }

  setDryRunReport(id: string, json: string): Result<void, DbError> {
    try {
      this.setDryRunReportStmt.run(json, this.now(), id);
      return ok(undefined);
    } catch (cause) {
      return err(this.fail('set dry-run report', cause));
    }
  }

  insertApproval(input: InsertScriptApprovalInput): Result<ScriptApprovalRow, DbError> {
    try {
      this.insertApprovalStmt.run(
        input.id,
        input.versionId,
        input.codeHash,
        input.channelName,
        input.externalThreadId,
        input.expiresAt,
        this.now(),
      );
      return ok(this.getApprovalStmt.get(input.id) as ScriptApprovalRow);
    } catch (cause) {
      return err(this.fail('insert script approval', cause));
    }
  }

  /** The approval for `codeHash` if it is undecided. Expiry is the caller's check. */
  findOpenApproval(codeHash: string): Result<ScriptApprovalRow | null, DbError> {
    try {
      return ok((this.findOpenApprovalStmt.get(codeHash) as ScriptApprovalRow | undefined) ?? null);
    } catch (cause) {
      return err(this.fail('find open script approval', cause));
    }
  }

  /** Sets `expires_at = now` on the undecided approvals of a version. */
  expireOpenApprovals(versionId: string, now: number): Result<void, DbError> {
    try {
      this.expireOpenApprovalsStmt.run(now, versionId);
      return ok(undefined);
    } catch (cause) {
      return err(this.fail('expire script approvals', cause));
    }
  }

  /**
   * Decides an approval and moves its version, in one transaction. Returns
   * false, changing nothing, if the approval is already decided or its version
   * is not `awaiting-approval`. An approval retires every other approved
   * version of the same script.
   */
  decideApproval(
    id: string,
    decision: 'approved' | 'rejected',
    now: number,
  ): Result<boolean, DbError> {
    return runLedgerTransaction(this, () => {
      try {
        const approval = this.getApprovalStmt.get(id) as ScriptApprovalRow | undefined;
        if (!approval || approval.decided_at !== null) {
          return ok(false);
        }
        const version = this.getVersionStmt.get(approval.version_id) as
          ScriptVersionRow | undefined;
        if (!version || version.state !== 'awaiting-approval') {
          return ok(false);
        }
        this.decideApprovalStmt.run(now, decision, id);
        this.setVersionStateOnlyStmt.run(decision, now, version.id);
        if (decision === 'approved') {
          this.retireOtherApprovedStmt.run({ now, script_id: version.script_id, id: version.id });
        }
        return ok(true);
      } catch (cause) {
        return err(this.fail('decide script approval', cause));
      }
    });
  }

  insertRun(input: InsertScriptRunInput): Result<ScriptRunRow, DbError> {
    try {
      this.insertRunStmt.run(
        input.id,
        input.versionId,
        input.mode,
        input.trigger,
        input.scheduleId ?? null,
        input.startedAt,
      );
      return ok(
        this.db.prepare(`SELECT * FROM script_runs WHERE id = ?`).get(input.id) as ScriptRunRow,
      );
    } catch (cause) {
      return err(this.fail('insert script run', cause));
    }
  }

  finishRun(
    id: string,
    runOk: boolean,
    errorCode: string | null,
    callCount: number,
    now: number,
  ): Result<void, DbError> {
    try {
      this.finishRunStmt.run(runOk ? 1 : 0, errorCode, callCount, now, id);
      return ok(undefined);
    } catch (cause) {
      return err(this.fail('finish script run', cause));
    }
  }

  /** The newest unfinished run of any version of the script, or null. */
  activeRun(scriptId: string): Result<ScriptRunRow | null, DbError> {
    try {
      return ok((this.activeRunStmt.get(scriptId) as ScriptRunRow | undefined) ?? null);
    } catch (cause) {
      return err(this.fail('find active script run', cause));
    }
  }

  /** The newest finished run of the script for a trigger, or null. */
  lastFinishedRun(
    scriptId: string,
    trigger: ScriptRunTrigger,
  ): Result<ScriptRunRow | null, DbError> {
    try {
      return ok(
        (this.lastFinishedRunStmt.get(scriptId, trigger) as ScriptRunRow | undefined) ?? null,
      );
    } catch (cause) {
      return err(this.fail('find last finished script run', cause));
    }
  }
}
