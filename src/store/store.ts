import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundJob, OutboundJob, OutboundKind, OutboundStatus, QueueHealth } from "../types.js";
import type { SmsProviderError } from "../types.js";
import { CryptoBox } from "../security/crypto-box.js";

interface InboundRow {
  delivery_id: string;
  sender_ciphertext: string;
  body_ciphertext: string;
  attempts: number;
}

interface OutboundRow {
  id: string;
  kind: OutboundKind;
  recipient_ciphertext: string;
  body_ciphertext: string;
  attempts: number;
}

interface CountRow { count: number; }
interface StatusRow { status: OutboundStatus; attempts: number; }
interface StaleJobRow { id: string; kind?: OutboundKind; delivery_id?: string; }
type InboundActionStatus = "started" | "completed" | "ambiguous";
interface StaleInboundRow { delivery_id: string; action_status: InboundActionStatus | null; }
interface ConversationStateRow { state_ciphertext: string; version: number; }
interface VoiceTurnRow { response_ciphertext: string | null; status: "processing" | "completed" | "failed"; }
type OrderSubmissionStatus = "started" | "pending" | "placed" | "ambiguous" | "action_required" | "declined";
type CartPreparationStatus = "checking" | "mutating" | "uncertain";
interface CartPreparationRow { attempt_id: string; status: CartPreparationStatus; }

export type CartPreparationStart =
  | { status: "acquired" }
  | { status: "checking" | "mutating" | "uncertain" };

export class SmsStore {
  private readonly db: DatabaseSync;

  constructor(
    filename: string,
    private readonly cryptoBox: CryptoBox,
    private readonly now: () => Date = () => new Date()
  ) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  loadConversationState(phone: string): { stateJson: string; version: number } | undefined {
    const row = this.db.prepare(`
      SELECT state_ciphertext, version FROM phone_order_sessions
      WHERE customer_fingerprint = ?
    `).get(this.cryptoBox.fingerprint(phone)) as unknown as ConversationStateRow | undefined;
    if (!row) return undefined;
    return { stateJson: this.cryptoBox.decrypt(row.state_ciphertext), version: row.version };
  }

  saveConversationState(phone: string, expectedVersion: number, stateJson: string): number | undefined {
    return this.transaction(() => {
      const fingerprint = this.cryptoBox.fingerprint(phone);
      const timestamp = this.isoNow();
      if (expectedVersion === 0) {
        const inserted = this.db.prepare(`
          INSERT OR IGNORE INTO phone_order_sessions(
            customer_fingerprint, state_ciphertext, version, created_at, updated_at
          ) VALUES (?, ?, 1, ?, ?)
        `).run(fingerprint, this.cryptoBox.encrypt(stateJson), timestamp, timestamp);
        return inserted.changes === 1 ? 1 : undefined;
      }
      const updated = this.db.prepare(`
        UPDATE phone_order_sessions
        SET state_ciphertext = ?, version = version + 1, updated_at = ?
        WHERE customer_fingerprint = ? AND version = ?
      `).run(this.cryptoBox.encrypt(stateJson), timestamp, fingerprint, expectedVersion);
      return updated.changes === 1 ? expectedVersion + 1 : undefined;
    });
  }

  beginVoiceTurn(deliveryId: string, phone: string): "new" | "processing" | "completed" | "failed" {
    const existing = this.db.prepare(`
      SELECT response_ciphertext, status FROM voice_turns WHERE delivery_id = ?
    `).get(deliveryId) as unknown as VoiceTurnRow | undefined;
    if (existing) return existing.status;
    const timestamp = this.isoNow();
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO voice_turns(
        delivery_id, customer_fingerprint, status, response_ciphertext, created_at, updated_at
      ) VALUES (?, ?, 'processing', NULL, ?, ?)
    `).run(deliveryId, this.cryptoBox.fingerprint(phone), timestamp, timestamp);
    if (inserted.changes === 1) return "new";
    const raced = this.db.prepare("SELECT status FROM voice_turns WHERE delivery_id = ?")
      .get(deliveryId) as unknown as { status: "processing" | "completed" | "failed" };
    return raced.status;
  }

  completeVoiceTurn(
    deliveryId: string,
    responseJson: string,
    followUp?: { to: string; body: string; dedupeKey: string }
  ): void {
    this.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE voice_turns SET status = 'completed', response_ciphertext = ?, updated_at = ?
        WHERE delivery_id = ? AND status = 'processing'
      `).run(this.cryptoBox.encrypt(responseJson), this.isoNow(), deliveryId);
      if (updated.changes !== 1) throw new Error("Voice turn state changed before completion");
      if (followUp) this.insertOutbound("user_reply", followUp.to, followUp.body, followUp.dedupeKey);
    });
  }

  failVoiceTurn(deliveryId: string): void {
    this.db.prepare(`
      UPDATE voice_turns SET status = 'failed', updated_at = ?
      WHERE delivery_id = ? AND status = 'processing'
    `).run(this.isoNow(), deliveryId);
  }

  voiceTurnResponse(deliveryId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT response_ciphertext, status FROM voice_turns WHERE delivery_id = ?
    `).get(deliveryId) as unknown as VoiceTurnRow | undefined;
    if (!row?.response_ciphertext || row.status !== "completed") return undefined;
    return this.cryptoBox.decrypt(row.response_ciphertext);
  }

  recoverInterruptedPhoneActions(): {
    voiceTurnsFailed: number;
    orderSubmissionsAmbiguous: number;
    cartChecksReleased: number;
    cartPreparationsUncertain: number;
  } {
    return this.transaction(() => {
      const timestamp = this.isoNow();
      const voiceTurnsFailed = Number(this.db.prepare(`
        UPDATE voice_turns SET status = 'failed', updated_at = ? WHERE status = 'processing'
      `).run(timestamp).changes);
      const orderSubmissionsAmbiguous = Number(this.db.prepare(`
        UPDATE order_submissions SET status = 'ambiguous', updated_at = ? WHERE status = 'started'
      `).run(timestamp).changes);
      const cartChecksReleased = Number(this.db.prepare(`
        DELETE FROM cart_preparation_guard WHERE singleton = 1 AND status = 'checking'
      `).run().changes);
      const cartPreparationsUncertain = Number(this.db.prepare(`
        UPDATE cart_preparation_guard SET status = 'uncertain', updated_at = ?
        WHERE singleton = 1 AND status = 'mutating'
      `).run(timestamp).changes);
      return { voiceTurnsFailed, orderSubmissionsAmbiguous, cartChecksReleased, cartPreparationsUncertain };
    });
  }

  beginCartPreparation(attemptId: string): CartPreparationStart {
    return this.transaction(() => {
      const timestamp = this.isoNow();
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO cart_preparation_guard(
          singleton, attempt_id, status, created_at, updated_at
        ) VALUES (1, ?, 'checking', ?, ?)
      `).run(attemptId, timestamp, timestamp);
      if (inserted.changes === 1) return { status: "acquired" };
      const existing = this.db.prepare(`
        SELECT attempt_id, status FROM cart_preparation_guard WHERE singleton = 1
      `).get() as unknown as CartPreparationRow | undefined;
      if (!existing) throw new Error("Cart preparation guard changed unexpectedly");
      return { status: existing.status };
    });
  }

  markCartPreparationMutating(attemptId: string): boolean {
    return this.transaction(() => this.db.prepare(`
      UPDATE cart_preparation_guard SET status = 'mutating', updated_at = ?
      WHERE singleton = 1 AND attempt_id = ? AND status = 'checking'
    `).run(this.isoNow(), attemptId).changes === 1);
  }

  releaseCartPreparation(attemptId: string, expectedStatus: "checking" | "mutating"): boolean {
    return this.transaction(() => this.db.prepare(`
      DELETE FROM cart_preparation_guard
      WHERE singleton = 1 AND attempt_id = ? AND status = ?
    `).run(attemptId, expectedStatus).changes === 1);
  }

  holdCartPreparation(attemptId: string): boolean {
    return this.transaction(() => this.db.prepare(`
      UPDATE cart_preparation_guard SET status = 'uncertain', updated_at = ?
      WHERE singleton = 1 AND attempt_id = ? AND status IN ('checking','mutating')
    `).run(this.isoNow(), attemptId).changes === 1);
  }

  cartPreparationStatus(): CartPreparationStatus | undefined {
    const row = this.db.prepare(`
      SELECT status FROM cart_preparation_guard WHERE singleton = 1
    `).get() as unknown as { status: CartPreparationStatus } | undefined;
    return row?.status;
  }

  resolveUncertainCartPreparationAfterReview(): boolean {
    return this.transaction(() => this.db.prepare(`
      DELETE FROM cart_preparation_guard WHERE singleton = 1 AND status = 'uncertain'
    `).run().changes === 1);
  }

  beginOrderSubmission(input: {
    phone: string;
    expectedSessionVersion: number;
    nextStateJson: string;
    approvalId: string;
    purchaseRunId: string;
    previewHash: string;
    idempotencyKey: string;
  }): number | undefined {
    return this.transaction(() => {
      const timestamp = this.isoNow();
      const fingerprint = this.cryptoBox.fingerprint(input.phone);
      const existingGuard = this.db.prepare(`
        SELECT approval_id FROM live_purchase_run_guard WHERE purchase_run_id = ?
      `).get(input.purchaseRunId) as unknown as { approval_id: string } | undefined;
      if (existingGuard) return undefined;
      const openSubmission = this.db.prepare(`
        SELECT approval_id FROM order_submissions
        WHERE status IN ('started','pending','ambiguous','action_required')
        LIMIT 1
      `).get() as unknown as { approval_id: string } | undefined;
      if (openSubmission) return undefined;
      const updated = this.db.prepare(`
        UPDATE phone_order_sessions
        SET state_ciphertext = ?, version = version + 1, updated_at = ?
        WHERE customer_fingerprint = ? AND version = ?
      `).run(
        this.cryptoBox.encrypt(input.nextStateJson),
        timestamp,
        fingerprint,
        input.expectedSessionVersion
      );
      if (updated.changes !== 1) return undefined;
      const guard = this.db.prepare(`
        INSERT OR IGNORE INTO live_purchase_run_guard(
          purchase_run_id, approval_id, preview_hash, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(input.purchaseRunId, input.approvalId, input.previewHash, timestamp);
      if (guard.changes !== 1) throw new Error("The authorized live purchase run is already consumed");
      this.db.prepare(`
        INSERT OR IGNORE INTO live_purchase_guard(singleton, approval_id, created_at)
        VALUES (1, ?, ?)
      `).run(input.approvalId, timestamp);
      this.db.prepare(`
        INSERT INTO order_submissions(
          approval_id, customer_fingerprint, preview_hash, idempotency_key,
          status, order_ref_ciphertext, safe_summary_ciphertext, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'started', NULL, NULL, ?, ?)
      `).run(
        input.approvalId,
        fingerprint,
        input.previewHash,
        input.idempotencyKey,
        timestamp,
        timestamp
      );
      return input.expectedSessionVersion + 1;
    });
  }

  completeOrderSubmission(input: {
    phone: string;
    expectedSessionVersion: number;
    nextStateJson: string;
    approvalId: string;
    status: OrderSubmissionStatus;
    orderRef?: string;
    safeSummary: string;
  }): number | undefined {
    return this.transaction(() => {
      const timestamp = this.isoNow();
      const fingerprint = this.cryptoBox.fingerprint(input.phone);
      const ledger = this.db.prepare(`
        UPDATE order_submissions
        SET status = ?, order_ref_ciphertext = ?, safe_summary_ciphertext = ?, updated_at = ?
        WHERE approval_id = ? AND customer_fingerprint = ? AND status = 'started'
      `).run(
        input.status,
        input.orderRef ? this.cryptoBox.encrypt(input.orderRef) : null,
        this.cryptoBox.encrypt(input.safeSummary),
        timestamp,
        input.approvalId,
        fingerprint
      );
      if (ledger.changes !== 1) return undefined;
      const session = this.db.prepare(`
        UPDATE phone_order_sessions
        SET state_ciphertext = ?, version = version + 1, updated_at = ?
        WHERE customer_fingerprint = ? AND version = ?
      `).run(
        this.cryptoBox.encrypt(input.nextStateJson),
        timestamp,
        fingerprint,
        input.expectedSessionVersion
      );
      if (session.changes !== 1) throw new Error("Order session changed before submission result commit");
      return input.expectedSessionVersion + 1;
    });
  }

  reconcileOrderSubmission(input: {
    phone: string;
    expectedSessionVersion: number;
    nextStateJson: string;
    approvalId: string;
    status: Exclude<OrderSubmissionStatus, "started">;
    orderRef?: string;
    safeSummary: string;
  }): number | undefined {
    return this.transaction(() => {
      const timestamp = this.isoNow();
      const fingerprint = this.cryptoBox.fingerprint(input.phone);
      const ledger = this.db.prepare(`
        UPDATE order_submissions
        SET status = ?, order_ref_ciphertext = COALESCE(?, order_ref_ciphertext),
            safe_summary_ciphertext = ?, updated_at = ?
        WHERE approval_id = ? AND customer_fingerprint = ?
          AND status IN ('pending','ambiguous','action_required')
      `).run(
        input.status,
        input.orderRef ? this.cryptoBox.encrypt(input.orderRef) : null,
        this.cryptoBox.encrypt(input.safeSummary),
        timestamp,
        input.approvalId,
        fingerprint
      );
      if (ledger.changes !== 1) return undefined;
      const session = this.db.prepare(`
        UPDATE phone_order_sessions
        SET state_ciphertext = ?, version = version + 1, updated_at = ?
        WHERE customer_fingerprint = ? AND version = ?
      `).run(
        this.cryptoBox.encrypt(input.nextStateJson),
        timestamp,
        fingerprint,
        input.expectedSessionVersion
      );
      if (session.changes !== 1) throw new Error("Order session changed before reconciliation commit");
      return input.expectedSessionVersion + 1;
    });
  }

  orderSubmissionCount(): number {
    return this.count("order_submissions", "1 = 1");
  }

  purchaseRunConsumed(purchaseRunId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS consumed FROM live_purchase_run_guard WHERE purchase_run_id = ?
    `).get(purchaseRunId) as unknown as { consumed: number } | undefined;
    return row?.consumed === 1;
  }

  hasOpenOrderSubmission(): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS open FROM order_submissions
      WHERE status IN ('started','pending','ambiguous','action_required')
      LIMIT 1
    `).get() as unknown as { open: number } | undefined;
    return row?.open === 1;
  }

  enqueueInbound(input: {
    deliveryId: string;
    agentId: string;
    providerTimestampSeconds: number;
    sender: string;
    body: string;
  }): boolean {
    const timestamp = this.isoNow();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO inbound_jobs(
        delivery_id, agent_fingerprint, provider_timestamp_seconds,
        sender_ciphertext, sender_fingerprint, body_ciphertext,
        status, attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `).run(
      input.deliveryId,
      this.cryptoBox.fingerprint(input.agentId),
      input.providerTimestampSeconds,
      this.cryptoBox.encrypt(input.sender),
      this.cryptoBox.fingerprint(input.sender),
      this.cryptoBox.encrypt(input.body),
      timestamp,
      timestamp,
      timestamp
    );
    return result.changes === 1;
  }

  claimInbound(adminPhone: string, leaseSeconds = 60): InboundJob | undefined {
    return this.transaction(() => {
      const current = this.isoNow();
      const stale = this.db.prepare(`
        SELECT jobs.delivery_id, actions.status AS action_status
        FROM inbound_jobs AS jobs
        LEFT JOIN inbound_action_attempts AS actions ON actions.delivery_id = jobs.delivery_id
        WHERE jobs.status = 'processing' AND jobs.lease_expires_at < ?
      `).all(current) as unknown as StaleInboundRow[];
      for (const item of stale) {
        if (item.action_status) {
          this.db.prepare(`
            UPDATE inbound_action_attempts
            SET status = 'ambiguous', last_error_code = 'PROCESS_CRASH_OUTCOME_UNKNOWN', updated_at = ?
            WHERE delivery_id = ? AND status = 'started'
          `).run(current, item.delivery_id);
          this.db.prepare(`
            UPDATE inbound_jobs
            SET status = 'failed', lease_expires_at = NULL, last_error_code = 'PROCESS_CRASH_OUTCOME_UNKNOWN',
                body_ciphertext = ?, updated_at = ?
            WHERE delivery_id = ? AND status = 'processing'
          `).run(this.cryptoBox.encrypt("[redacted after interrupted processing]"), current, item.delivery_id);
          this.insertOutbound(
            "admin_alert",
            adminPhone,
            `Orderly SMS inbound job ${item.delivery_id.slice(-8)} was interrupted after a business action began. Its outcome is unknown and it will not be replayed automatically.`,
            `inbound-interrupted:${item.delivery_id}`
          );
        } else {
          // No non-idempotent action began. Releasing the lease is safe because
          // retry-safe handlers receive the same durable idempotency key.
          this.db.prepare(`
            UPDATE inbound_jobs
            SET status = 'queued', lease_expires_at = NULL,
                last_error_code = 'PROCESS_INTERRUPTED_RETRY_SAFE', available_at = ?, updated_at = ?
            WHERE delivery_id = ? AND status = 'processing'
          `).run(current, current, item.delivery_id);
        }
      }
      const row = this.db.prepare(`
        SELECT delivery_id, sender_ciphertext, body_ciphertext, attempts
        FROM inbound_jobs
        WHERE status = 'queued' AND available_at <= ?
        ORDER BY created_at ASC
        LIMIT 1
      `).get(current) as unknown as InboundRow | undefined;
      if (!row) return undefined;
      const lease = new Date(this.now().getTime() + leaseSeconds * 1000).toISOString();
      const changed = this.db.prepare(`
        UPDATE inbound_jobs
        SET status = 'processing', attempts = attempts + 1, lease_expires_at = ?, updated_at = ?
        WHERE delivery_id = ? AND status = 'queued' AND available_at <= ?
      `).run(lease, current, row.delivery_id, current).changes;
      if (changed !== 1) return undefined;
      return {
        deliveryId: row.delivery_id,
        sender: this.cryptoBox.decrypt(row.sender_ciphertext),
        body: this.cryptoBox.decrypt(row.body_ciphertext),
        attempts: row.attempts + 1
      };
    });
  }

  completeInboundWithReply(job: InboundJob, reply: string, kind: OutboundKind = "user_reply"): void {
    this.transaction(() => {
      this.insertOutbound(kind, job.sender, reply, `reply:${job.deliveryId}`);
      const changed = this.db.prepare(`
        UPDATE inbound_jobs
        SET status = 'completed', lease_expires_at = NULL, body_ciphertext = ?, updated_at = ?
        WHERE delivery_id = ? AND status = 'processing'
      `).run(this.cryptoBox.encrypt("[redacted after processing]"), this.isoNow(), job.deliveryId).changes;
      if (changed !== 1) throw new Error("Inbound job state changed before completion");
    });
  }

  beginInboundAction(job: InboundJob, idempotencyKey: string): void {
    const timestamp = this.isoNow();
    const result = this.db.prepare(`
      INSERT INTO inbound_action_attempts(
        delivery_id, idempotency_key, status, created_at, updated_at
      )
      SELECT delivery_id, ?, 'started', ?, ?
      FROM inbound_jobs
      WHERE delivery_id = ? AND status = 'processing'
      ON CONFLICT(delivery_id) DO NOTHING
    `).run(idempotencyKey, timestamp, timestamp, job.deliveryId);
    if (result.changes !== 1) {
      throw Object.assign(new Error("Inbound action has already been attempted or is not processing"), {
        code: "INBOUND_ACTION_REPLAY_BLOCKED"
      });
    }
  }

  completeInboundActionWithReply(job: InboundJob, idempotencyKey: string, reply: string): void {
    this.transaction(() => {
      const timestamp = this.isoNow();
      const actionChanged = this.db.prepare(`
        UPDATE inbound_action_attempts
        SET status = 'completed', last_error_code = NULL, updated_at = ?
        WHERE delivery_id = ? AND idempotency_key = ? AND status = 'started'
      `).run(timestamp, job.deliveryId, idempotencyKey).changes;
      if (actionChanged !== 1) throw new Error("Inbound action state changed before completion");

      this.insertOutbound("user_reply", job.sender, reply, `reply:${job.deliveryId}`);
      const inboundChanged = this.db.prepare(`
        UPDATE inbound_jobs
        SET status = 'completed', lease_expires_at = NULL, body_ciphertext = ?, updated_at = ?
        WHERE delivery_id = ? AND status = 'processing'
      `).run(this.cryptoBox.encrypt("[redacted after processing]"), timestamp, job.deliveryId).changes;
      if (inboundChanged !== 1) throw new Error("Inbound job state changed before action completion");
    });
  }

  failInboundActionAmbiguous(job: InboundJob, idempotencyKey: string, errorCode: string, adminPhone: string): void {
    this.transaction(() => {
      const timestamp = this.isoNow();
      const actionChanged = this.db.prepare(`
        UPDATE inbound_action_attempts
        SET status = 'ambiguous', last_error_code = ?, updated_at = ?
        WHERE delivery_id = ? AND idempotency_key = ? AND status = 'started'
      `).run(errorCode.slice(0, 80), timestamp, job.deliveryId, idempotencyKey).changes;
      if (actionChanged !== 1) throw new Error("Inbound action state changed before ambiguity hold");

      const inboundChanged = this.db.prepare(`
        UPDATE inbound_jobs
        SET status = 'failed', lease_expires_at = NULL, last_error_code = ?,
            body_ciphertext = ?, updated_at = ?
        WHERE delivery_id = ? AND status = 'processing'
      `).run(
        errorCode.slice(0, 80),
        this.cryptoBox.encrypt("[redacted after ambiguous action]"),
        timestamp,
        job.deliveryId
      ).changes;
      if (inboundChanged !== 1) throw new Error("Inbound job state changed before ambiguity hold");

      this.insertOutbound(
        "admin_alert",
        adminPhone,
        `Orderly SMS inbound job ${job.deliveryId.slice(-8)} has an unknown business-action outcome. Do not replay it until the external system is reconciled.`,
        `inbound-action-ambiguous:${job.deliveryId}`
      );
    });
  }

  inboundActionStatus(deliveryId: string): InboundActionStatus | undefined {
    const row = this.db.prepare("SELECT status FROM inbound_action_attempts WHERE delivery_id = ?")
      .get(deliveryId) as unknown as { status: InboundActionStatus } | undefined;
    return row?.status;
  }

  completeInboundSilently(job: InboundJob): void {
    const result = this.db.prepare(`
      UPDATE inbound_jobs
      SET status = 'completed', lease_expires_at = NULL, body_ciphertext = ?, updated_at = ?
      WHERE delivery_id = ? AND status = 'processing'
    `).run(this.cryptoBox.encrypt("[redacted after processing]"), this.isoNow(), job.deliveryId);
    if (result.changes !== 1) throw new Error("Inbound job state changed before silent completion");
  }

  setOptedOut(phone: string, optedOut: boolean): void {
    this.transaction(() => {
      const fingerprint = this.cryptoBox.fingerprint(phone);
      const timestamp = this.isoNow();
      this.db.prepare(`
        INSERT INTO contact_preferences(recipient_fingerprint, opted_out, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(recipient_fingerprint) DO UPDATE SET opted_out = excluded.opted_out, updated_at = excluded.updated_at
      `).run(fingerprint, optedOut ? 1 : 0, timestamp);
      if (optedOut) {
        this.db.prepare(`
          UPDATE outbound_messages
          SET status = 'cancelled', last_error_code = 'RECIPIENT_OPTED_OUT', updated_at = ?
          WHERE recipient_fingerprint = ? AND kind = 'user_reply' AND status = 'queued'
        `).run(timestamp, fingerprint);
      }
    });
  }

  isOptedOut(phone: string): boolean {
    const row = this.db.prepare("SELECT opted_out FROM contact_preferences WHERE recipient_fingerprint = ?")
      .get(this.cryptoBox.fingerprint(phone)) as unknown as { opted_out: number } | undefined;
    return row?.opted_out === 1;
  }

  recentOutboundCount(phone: string, withinMinutes = 10): number {
    const since = new Date(this.now().getTime() - withinMinutes * 60_000).toISOString();
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM outbound_messages
      WHERE recipient_fingerprint = ? AND created_at >= ? AND status IN ('queued','sending','accepted')
    `).get(this.cryptoBox.fingerprint(phone), since) as unknown as CountRow;
    return row.count;
  }

  failOrRetryInbound(job: InboundJob, errorCode: string, maxAttempts: number, adminPhone: string): "retried" | "failed" {
    return this.transaction(() => {
      const timestamp = this.isoNow();
      if (job.attempts < maxAttempts) {
        const next = new Date(this.now().getTime() + Math.min(60, 2 ** job.attempts) * 1000).toISOString();
        this.db.prepare(`
          UPDATE inbound_jobs
          SET status = 'queued', available_at = ?, lease_expires_at = NULL, last_error_code = ?, updated_at = ?
          WHERE delivery_id = ? AND status = 'processing'
        `).run(next, errorCode.slice(0, 80), timestamp, job.deliveryId);
        return "retried";
      }
      this.db.prepare(`
        UPDATE inbound_jobs
        SET status = 'failed', lease_expires_at = NULL, last_error_code = ?, body_ciphertext = ?, updated_at = ?
        WHERE delivery_id = ? AND status = 'processing'
      `).run(errorCode.slice(0, 80), this.cryptoBox.encrypt("[redacted after failure]"), timestamp, job.deliveryId);
      this.insertOutbound(
        "admin_alert",
        adminPhone,
        `Orderly SMS inbound job ${job.deliveryId.slice(-8)} failed after ${job.attempts} attempts. Review the service queue.`,
        `inbound-failed:${job.deliveryId}`
      );
      return "failed";
    });
  }

  enqueueOutbound(kind: OutboundKind, to: string, body: string, dedupeKey: string = crypto.randomUUID()): string {
    return this.transaction(() => this.insertOutbound(kind, to, body, dedupeKey));
  }

  claimOutbound(adminPhone: string, leaseSeconds = 60): OutboundJob | undefined {
    return this.transaction(() => {
      const current = this.isoNow();
      const stale = this.db.prepare(`
        SELECT id, kind FROM outbound_messages
        WHERE status = 'sending' AND lease_expires_at < ?
      `).all(current) as unknown as StaleJobRow[];
      for (const item of stale) {
        this.db.prepare(`
          UPDATE outbound_messages
          SET status = 'ambiguous', lease_expires_at = NULL,
              last_error_code = 'PROCESS_CRASH_OUTCOME_UNKNOWN', updated_at = ?
          WHERE id = ? AND status = 'sending'
        `).run(current, item.id);
        if (item.kind !== "admin_alert") {
          this.insertOutbound(
            "admin_alert",
            adminPhone,
            `Orderly SMS outbound job ${item.id.slice(-8)} was interrupted while sending. Do not resend it until AgentPhone message history is reconciled.`,
            `outbound-interrupted:${item.id}`
          );
        }
      }
      const row = this.db.prepare(`
        SELECT id, kind, recipient_ciphertext, body_ciphertext, attempts
        FROM outbound_messages
        WHERE status = 'queued' AND available_at <= ?
        ORDER BY created_at ASC
        LIMIT 1
      `).get(current) as unknown as OutboundRow | undefined;
      if (!row) return undefined;
      const lease = new Date(this.now().getTime() + leaseSeconds * 1000).toISOString();
      const changed = this.db.prepare(`
        UPDATE outbound_messages
        SET status = 'sending', attempts = attempts + 1, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'queued' AND available_at <= ?
      `).run(lease, current, row.id, current).changes;
      if (changed !== 1) return undefined;
      return {
        id: row.id,
        kind: row.kind,
        to: this.cryptoBox.decrypt(row.recipient_ciphertext),
        body: this.cryptoBox.decrypt(row.body_ciphertext),
        attempts: row.attempts + 1
      };
    });
  }

  markOutboundAccepted(id: string, providerMessageId: string): void {
    const result = this.db.prepare(`
      UPDATE outbound_messages
      SET status = 'accepted', provider_message_id = ?, body_ciphertext = ?,
          lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
      WHERE id = ? AND status = 'sending'
    `).run(providerMessageId, this.cryptoBox.encrypt("[redacted after provider acceptance]"), this.isoNow(), id);
    if (result.changes !== 1) throw new Error("Outbound job state changed before acceptance");
  }

  cancelClaimedOutbound(id: string, reason = "RECIPIENT_OPTED_OUT"): void {
    const result = this.db.prepare(`
      UPDATE outbound_messages
      SET status = 'cancelled', lease_expires_at = NULL, last_error_code = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'
    `).run(reason.slice(0, 80), this.isoNow(), id);
    if (result.changes !== 1) throw new Error("Outbound job state changed before cancellation");
  }

  failOrRetryOutbound(
    job: OutboundJob,
    error: SmsProviderError,
    maxAttempts: number,
    adminPhone: string,
    retryDelaySeconds: number
  ): "retried" | "failed" | "ambiguous" {
    return this.transaction(() => {
      const timestamp = this.isoNow();
      if (error.retryable && !error.ambiguous && job.attempts < maxAttempts) {
        const next = new Date(this.now().getTime() + Math.max(0, retryDelaySeconds) * 1000).toISOString();
        this.db.prepare(`
          UPDATE outbound_messages
          SET status = 'queued', available_at = ?, lease_expires_at = NULL, last_error_code = ?, updated_at = ?
          WHERE id = ? AND status = 'sending'
        `).run(next, error.code.slice(0, 80), timestamp, job.id);
        return "retried";
      }

      const terminal: OutboundStatus = error.ambiguous ? "ambiguous" : "failed";
      this.db.prepare(`
        UPDATE outbound_messages
        SET status = ?, lease_expires_at = NULL, last_error_code = ?, updated_at = ?
        WHERE id = ? AND status = 'sending'
      `).run(terminal, error.code.slice(0, 80), timestamp, job.id);

      if (job.kind !== "admin_alert") {
        const wording = terminal === "ambiguous" ? "has an unknown provider outcome" : "failed";
        this.insertOutbound(
          "admin_alert",
          adminPhone,
          `Orderly SMS outbound job ${job.id.slice(-8)} ${wording}. Do not repeat any related business action; review message history first.`,
          `outbound-terminal:${job.id}`
        );
      }
      return terminal;
    });
  }

  queueHealth(): QueueHealth {
    return {
      inboundQueued: this.count("inbound_jobs", "status IN ('queued','processing')"),
      inboundFailed: this.count("inbound_jobs", "status = 'failed'"),
      outboundQueued: this.count("outbound_messages", "status IN ('queued','sending')"),
      outboundFailed: this.count("outbound_messages", "status = 'failed'"),
      outboundAmbiguous: this.count("outbound_messages", "status = 'ambiguous'"),
      failedAdminAlerts: this.count("outbound_messages", "status = 'failed' AND kind = 'admin_alert'"),
      voiceProcessing: this.count("voice_turns", "status = 'processing'"),
      voiceFailed: this.count("voice_turns", "status = 'failed'"),
      orderSubmissionsOpen: this.count("order_submissions", "status IN ('started','pending','ambiguous','action_required')"),
      orderSubmissionsAmbiguous: this.count("order_submissions", "status = 'ambiguous'"),
      cartPreparationsActive: this.count("cart_preparation_guard", "status IN ('checking','mutating')"),
      cartPreparationsUncertain: this.count("cart_preparation_guard", "status = 'uncertain'"),
      oldestInboundAgeSeconds: this.oldestAge("inbound_jobs", "status IN ('queued','processing')"),
      oldestOutboundAgeSeconds: this.oldestAge("outbound_messages", "status IN ('queued','sending')"),
      oldestVoiceAgeSeconds: this.oldestAge("voice_turns", "status = 'processing'"),
      oldestOrderSubmissionAgeSeconds: this.oldestAge("order_submissions", "status IN ('started','pending','ambiguous','action_required')")
    };
  }

  inboundCount(): number {
    return this.count("inbound_jobs", "1 = 1");
  }

  outboundCount(kind?: OutboundKind): number {
    return kind
      ? this.count("outbound_messages", `kind = '${kind}'`)
      : this.count("outbound_messages", "1 = 1");
  }

  outboundStatus(id: string): StatusRow | undefined {
    const row = this.db.prepare("SELECT status, attempts FROM outbound_messages WHERE id = ?")
      .get(id) as unknown as StatusRow | undefined;
    return row ? { status: row.status, attempts: row.attempts } : undefined;
  }

  private insertOutbound(kind: OutboundKind, to: string, body: string, dedupeKey: string): string {
    const existing = this.db.prepare("SELECT id FROM outbound_messages WHERE dedupe_key = ?")
      .get(dedupeKey) as unknown as { id: string } | undefined;
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    const timestamp = this.isoNow();
    this.db.prepare(`
      INSERT INTO outbound_messages(
        id, dedupe_key, kind, recipient_ciphertext, recipient_fingerprint,
        body_ciphertext, status, attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `).run(
      id,
      dedupeKey,
      kind,
      this.cryptoBox.encrypt(to),
      this.cryptoBox.fingerprint(to),
      this.cryptoBox.encrypt(body),
      timestamp,
      timestamp,
      timestamp
    );
    return id;
  }

  private count(table: "inbound_jobs" | "outbound_messages" | "voice_turns" | "order_submissions" | "cart_preparation_guard", predicate: string): number {
    // Table and predicates are internal constants, never user input.
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get() as unknown as CountRow;
    return row.count;
  }

  private oldestAge(table: "inbound_jobs" | "outbound_messages" | "voice_turns" | "order_submissions", predicate: string): number | null {
    const row = this.db.prepare(`SELECT MIN(created_at) AS oldest FROM ${table} WHERE ${predicate}`)
      .get() as unknown as { oldest: string | null };
    if (!row.oldest) return null;
    return Math.max(0, Math.floor((this.now().getTime() - new Date(row.oldest).getTime()) / 1000));
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_jobs (
        delivery_id TEXT PRIMARY KEY,
        agent_fingerprint TEXT NOT NULL,
        provider_timestamp_seconds INTEGER NOT NULL,
        sender_ciphertext TEXT NOT NULL,
        sender_fingerprint TEXT NOT NULL,
        body_ciphertext TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','processing','completed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_expires_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_claim ON inbound_jobs(status, available_at, created_at);

      CREATE TABLE IF NOT EXISTS inbound_action_attempts (
        delivery_id TEXT PRIMARY KEY REFERENCES inbound_jobs(delivery_id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('started','completed','ambiguous')),
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbound_messages (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('user_reply','compliance_reply','admin_alert')),
        recipient_ciphertext TEXT NOT NULL,
        recipient_fingerprint TEXT NOT NULL,
        body_ciphertext TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','sending','accepted','failed','ambiguous','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_expires_at TEXT,
        provider_message_id TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_claim ON outbound_messages(status, available_at, created_at);

      CREATE TABLE IF NOT EXISTS phone_order_sessions (
        customer_fingerprint TEXT PRIMARY KEY,
        state_ciphertext TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS voice_turns (
        delivery_id TEXT PRIMARY KEY,
        customer_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('processing','completed','failed')),
        response_ciphertext TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_submissions (
        approval_id TEXT PRIMARY KEY,
        customer_fingerprint TEXT NOT NULL,
        preview_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('started','pending','placed','ambiguous','action_required','declined')),
        order_ref_ciphertext TEXT,
        safe_summary_ciphertext TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      DROP INDEX IF EXISTS idx_one_open_order_submission;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_order_submission
      ON order_submissions(customer_fingerprint)
      WHERE status IN ('started','pending','ambiguous','action_required');

      CREATE TABLE IF NOT EXISTS live_purchase_guard (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        approval_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO live_purchase_guard(singleton, approval_id, created_at)
      SELECT 1, approval_id, created_at FROM order_submissions ORDER BY created_at ASC LIMIT 1;

      CREATE TABLE IF NOT EXISTS live_purchase_run_guard (
        purchase_run_id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE,
        preview_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO live_purchase_run_guard(
        purchase_run_id, approval_id, preview_hash, created_at
      )
      SELECT 'legacy-singleton-v1', legacy.approval_id, submissions.preview_hash, legacy.created_at
      FROM live_purchase_guard AS legacy
      JOIN order_submissions AS submissions ON submissions.approval_id = legacy.approval_id;

      CREATE TABLE IF NOT EXISTS cart_preparation_guard (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        attempt_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('checking','mutating','uncertain')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contact_preferences (
        recipient_fingerprint TEXT PRIMARY KEY,
        opted_out INTEGER NOT NULL CHECK(opted_out IN (0,1)),
        updated_at TEXT NOT NULL
      );
    `);
  }
}
