import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { asBoolean, asNumber, asString } from '../db/values.js'
import type { ReplacementRule } from '../text/segment.js'

/**
 * Stored replacement rules ("反和谐").
 *
 * Kept as a per-user library rather than a per-import field so a rule set can
 * be built once and reused across every import — and so the scheduler can apply
 * the same rules at send time even for tasks created before a rule was added.
 */

export interface ReplacementRuleRecord {
  readonly id: number
  readonly userId: number
  readonly pattern: string
  readonly replacement: string
  readonly isRegex: boolean
  readonly enabled: boolean
  readonly createdAt: number
}

function toRecord(row: Record<string, SQLOutputValue>): ReplacementRuleRecord {
  return {
    id: asNumber(row['id']),
    userId: asNumber(row['user_id']),
    pattern: asString(row['pattern']),
    replacement: asString(row['replacement']),
    isRegex: asBoolean(row['is_regex']),
    enabled: asBoolean(row['enabled'], true),
    createdAt: asNumber(row['created_at'])
  }
}

export function listRules(db: DatabaseSync, userId: number): ReplacementRuleRecord[] {
  const rows = db.prepare('SELECT * FROM replacement_rules WHERE user_id = ? ORDER BY id ASC').all(userId)
  return rows.map(toRecord)
}

export interface CreateRuleInput {
  readonly pattern: string
  readonly replacement: string
  readonly isRegex: boolean
}

/** Maximum stored rules per user. Beyond this the list stops being reviewable. */
export const MAX_RULES_PER_USER = 200

export function countRules(db: DatabaseSync, userId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM replacement_rules WHERE user_id = ?').get(userId)
  return row === undefined ? 0 : asNumber(row['n'])
}

export function createRule(
  db: DatabaseSync,
  userId: number,
  input: CreateRuleInput,
  now = Date.now()
): ReplacementRuleRecord {
  const info = db
    .prepare(
      'INSERT INTO replacement_rules (user_id, pattern, replacement, is_regex, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    )
    .run(userId, input.pattern, input.replacement, input.isRegex ? 1 : 0, now)

  const id = asNumber(info.lastInsertRowid)
  const row = db.prepare('SELECT * FROM replacement_rules WHERE id = ?').get(id)
  if (row === undefined) throw new Error('rule vanished immediately after insert')
  return toRecord(row)
}

export function getRule(db: DatabaseSync, userId: number, ruleId: number): ReplacementRuleRecord | null {
  const row = db.prepare('SELECT * FROM replacement_rules WHERE user_id = ? AND id = ?').get(userId, ruleId)
  return row === undefined ? null : toRecord(row)
}

export function setRuleEnabled(db: DatabaseSync, ruleId: number, enabled: boolean): void {
  db.prepare('UPDATE replacement_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, ruleId)
}

export function deleteRule(db: DatabaseSync, userId: number, ruleId: number): boolean {
  const info = db.prepare('DELETE FROM replacement_rules WHERE user_id = ? AND id = ?').run(userId, ruleId)
  return asNumber(info.changes) > 0
}

/**
 * Enabled rules in the shape the segmenter wants.
 *
 * Returned in insertion order, which is the order they will be applied — users
 * rely on this when one rule's output feeds another's pattern.
 */
export function enabledRulesFor(db: DatabaseSync, userId: number): ReplacementRule[] {
  const rows = db
    .prepare(
      'SELECT pattern, replacement, is_regex FROM replacement_rules WHERE user_id = ? AND enabled = 1 ORDER BY id ASC'
    )
    .all(userId)

  return rows.map(row => ({
    pattern: asString(row['pattern']),
    replacement: asString(row['replacement']),
    isRegex: asBoolean(row['is_regex'])
  }))
}
