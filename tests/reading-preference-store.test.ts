import { DATABASE_VERSION } from '../src/server/auth-schema'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { PaperDatabase } from '../src/server/db'
import { READING_PREFERENCES_VERSION } from '../src/server/reading-preference-store'
import { validReadingWrite, type ReadingWrite } from '../src/server/reading-preference-values'

const edit = (device: string, sequence: number, values: ReadingWrite['values'], action: ReadingWrite['action'] = 'edit'): ReadingWrite =>
  ({ device: device.repeat(32), writer: device.repeat(32), sequence, generation: 0, base: action === 'edit' ? Object.fromEntries(Object.keys(values).map(key => [key, 'none'])) : {}, values, action })

it('merges writes by key in commit order and ignores retries after a reset or a competing edit', () => {
  const db = new PaperDatabase(':memory:')
  try {
    const store = db.readingPreferences
    const first = edit('a', 1, { font: 'source', 'fullText:feed/one': 'always' }, 'import')
    const imported = store.write(first)
    expect(imported.revision).toBe(1)
    expect(store.write(edit('b', 1, { width: 'wide' }, 'import')).values.width).toBeUndefined()
    store.write({ ...edit('b', 2, { font: 'literata', 'fullText:feed/two': 'never' }), base: { font: imported.values.font!.token, 'fullText:feed/two': 'none' } })
    store.write(edit('a', 2, { spacing: 'compact' }))
    expect(store.write(first)).toMatchObject({ storeId: store.snapshot().storeId, revision: 3, generation: 0, values: {
      font: { value: 'literata', revision: 2 }, 'fullText:feed/one': { value: 'always', revision: 1 },
      'fullText:feed/two': { value: 'never', revision: 2 }, spacing: { value: 'compact', revision: 3 },
    } })
    const reset = edit('a', 3, {}, 'reset')
    expect(store.write(reset)).toEqual({ storeId: store.snapshot().storeId, revision: 4, appliedTokens: {}, generation: 1, values: {} })
    const later = store.write({ ...edit('b', 3, { markRead: 'manual' }), generation: 1 })
    expect(store.write(reset)).toEqual({ ...later, appliedTokens: {} })
    expect(store.write({ ...edit('c', 1, { width: 'wide' }, 'import'), generation: 1 })).toEqual(store.snapshot())
  } finally { db.close() }
})

it('accepts distinct writers even when their device and sequence match', () => {
  const db = new PaperDatabase(':memory:')
  try {
    const first = edit('a', 1, { width: 'wide' })
    const second = { ...edit('a', 1, { font: 'source' }), writer: 'b'.repeat(32) }
    db.readingPreferences.write(first)
    db.readingPreferences.write(second)
    expect(db.readingPreferences.write(first)).toMatchObject({ revision: 2, appliedTokens: { width: expect.stringMatching(/^[a-f0-9]{32}$/) },
      values: { width: { value: 'wide' }, font: { value: 'source' } } })
  } finally { db.close() }
})

it('accepts only reading keys and their defined values', () => {
  for (const values of [{ theme: 'light' }, { size: 'small' }, { 'fullText:': 'auto' }, { 'learned:f': 'always' },
    { 'fullText:sample': { articles: ['sample'] } }, { width: 'narrow', constructor: 'x' }, []]) {
    expect(validReadingWrite({ ...edit('a', 1, {}), values })).toBe(false)
  }
  const write = edit('a', 1, { width: 'wide' })
  for (const invalid of [{ storeId: 'invalid' }, { knownRevision: -1 }, { base: {} }, { base: { width: 0 } }, { base: { width: 1 } }, { base: { width: 'queued:1' } }, { generation: undefined }, { generation: -1 }, { writer: '' }]) {
    expect(validReadingWrite({ ...write, ...invalid })).toBe(false)
  }
  expect(validReadingWrite(edit('a', 1, { width: 'narrow', 'fullText:feed/a': 'never', 'learned:feed/a': 'on' }))).toBe(true)
})

it('backs up the prior schema and retains preferences and retry receipts after reopening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-reading-prefs-'))
  const name = path.join(dir, 'paper.sqlite')
  try {
    const old = new PaperDatabase(name)
    old.greaderDatabase.exec(`DROP TABLE reading_preferences; DROP TABLE reading_preference_devices;
      DELETE FROM sync_state WHERE key IN ('reading_preferences_revision', 'reading_preferences_generation', 'reading_preferences_id'); PRAGMA user_version = 24;`)
    old.close()
    const db = new PaperDatabase(name)
    const write = edit('a', 1, { markRead: 'manual' })
    expect(db.greaderDatabase.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION)
    const after = db.readingPreferences.write(write)
    db.close()
    const backup = new DatabaseSync(name + '.before-reading-preferences-v' + READING_PREFERENCES_VERSION, { readOnly: true })
    try {
      expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(24)
      expect(backup.prepare("SELECT 1 FROM sqlite_master WHERE name = 'reading_preferences'").get()).toBeUndefined()
    } finally { backup.close() }
    const reopened = new PaperDatabase(name)
    try { expect(reopened.readingPreferences.write(write)).toEqual(after) } finally { reopened.close() }
  } finally { fs.rmSync(dir, { recursive: true }) }
})

it.each([21, 22])('opens a pre-release v%i preference database with its saved values and device receipts', version => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-reading-prefs-'))
  const name = path.join(dir, 'paper.sqlite')
  try {
    const old = new PaperDatabase(name)
    old.greaderDatabase.exec(`PRAGMA user_version = ${version};
      DROP TABLE feed_overrides;
      ALTER TABLE reading_preference_devices DROP COLUMN tokens;
      ALTER TABLE reading_preferences DROP COLUMN token;
      ${version === 21 ? 'ALTER TABLE feed_fetch_state DROP COLUMN redirects_json;' : ''}
      INSERT INTO reading_preference_devices VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1);
      DELETE FROM sync_state WHERE key IN ('reading_preferences_id', 'reading_preferences_generation');
      UPDATE sync_state SET value = '2' WHERE key = 'reading_preferences_revision';
      INSERT INTO reading_preferences VALUES ('width', 'narrow', 2);`)
    old.close()
    const db = new PaperDatabase(name)
    try {
      expect(db.greaderDatabase.prepare("SELECT 1 FROM sqlite_master WHERE name = 'feed_overrides'").get()).toBeDefined()
      expect(db.greaderDatabase.prepare("SELECT name FROM pragma_table_info('feed_fetch_state') WHERE name = 'redirects_json'").get()).toBeDefined()
      const write = edit('a', 1, { width: 'wide' })
      expect(db.readingPreferences.write(write)).toEqual({ storeId: expect.stringMatching(/^[a-f0-9]{32}$/), revision: 2, generation: 2, values: { width: { value: 'narrow', revision: 2, token: expect.stringMatching(/^[a-f0-9]{32}$/) } } })
      expect(() => db.readingPreferences.write({ ...write, sequence: 2 })).toThrow('reset')
    } finally { db.close() }
  } finally { fs.rmSync(dir, { recursive: true }) }
})
