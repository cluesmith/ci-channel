import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CI_SERVER_ENTRY,
  detectIndent,
  mergeCiServer,
  readMcpJson,
  writeMcpJson,
  type McpJsonReadResult,
} from '../lib/setup/mcp-json.js'
import { SetupError } from '../lib/setup/errors.js'

let tmpDir: string
let mcpPath: string

describe('mcp-json', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ci-channel-mcp-'))
    mcpPath = join(tmpDir, '.mcp.json')
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true })
    } catch {}
  })

  describe('readMcpJson', () => {
    test('missing file returns { exists: false }', () => {
      const result = readMcpJson(mcpPath)
      assert.deepEqual(result, { exists: false })
    })

    test('valid JSON returns content + indent', () => {
      writeFileSync(mcpPath, '{\n  "mcpServers": {}\n}\n')
      const result = readMcpJson(mcpPath)
      assert.equal(result.exists, true)
      if (result.exists) {
        assert.deepEqual(result.content, { mcpServers: {} })
        assert.equal(result.indent, 2)
      }
    })

    test('invalid JSON throws SetupError with parse detail', () => {
      writeFileSync(mcpPath, '{invalid json')
      assert.throws(
        () => readMcpJson(mcpPath),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('not valid JSON'),
      )
    })
  })

  describe('mergeCiServer — the 7-shape matrix', () => {
    test('shape 1: missing file → creates .mcp.json with ci entry', () => {
      const raw: McpJsonReadResult = { exists: false }
      const result = mergeCiServer(raw)
      assert.equal(result.action, 'created')
      assert.deepEqual(result.updated, {
        mcpServers: { ci: { ...CI_SERVER_ENTRY } },
      })
    })

    test('shape 2: has mcpServers.ci already → skipped, unchanged', () => {
      const existing = {
        mcpServers: {
          ci: { command: 'other', args: ['something', 'else'] },
        },
      }
      const raw: McpJsonReadResult = {
        exists: true,
        content: existing,
        indent: 2,
      }
      const result = mergeCiServer(raw)
      assert.equal(result.action, 'skipped_exists')
      // Intentionally unchanged — the installer does not overwrite existing entries.
      assert.deepEqual(result.updated, existing)
    })

    test('shape 3: has other mcpServers → merges, preserves other entries', () => {
      const raw: McpJsonReadResult = {
        exists: true,
        content: {
          mcpServers: {
            other: { command: 'foo', args: ['bar'] },
          },
        },
        indent: 2,
      }
      const result = mergeCiServer(raw)
      assert.equal(result.action, 'merged')
      assert.deepEqual(result.updated, {
        mcpServers: {
          other: { command: 'foo', args: ['bar'] },
          ci: { ...CI_SERVER_ENTRY },
        },
      })
    })

    test('shape 4: valid object without mcpServers key → adds mcpServers', () => {
      const raw: McpJsonReadResult = {
        exists: true,
        content: { somethingElse: 42 },
        indent: 2,
      }
      const result = mergeCiServer(raw)
      assert.equal(result.action, 'merged')
      assert.deepEqual(result.updated, {
        somethingElse: 42,
        mcpServers: { ci: { ...CI_SERVER_ENTRY } },
      })
    })

    test('shape 5a: mcpServers is null → SetupError', () => {
      const raw: McpJsonReadResult = {
        exists: true,
        content: { mcpServers: null },
        indent: 2,
      }
      assert.throws(
        () => mergeCiServer(raw),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('invalid `mcpServers`'),
      )
    })

    test('shape 5b: mcpServers is a string → SetupError', () => {
      const raw: McpJsonReadResult = {
        exists: true,
        content: { mcpServers: 'not an object' },
        indent: 2,
      }
      assert.throws(
        () => mergeCiServer(raw),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('invalid `mcpServers`'),
      )
    })

    test('shape 5c: mcpServers is an array → SetupError', () => {
      const raw: McpJsonReadResult = {
        exists: true,
        content: { mcpServers: ['a', 'b'] },
        indent: 2,
      }
      assert.throws(
        () => mergeCiServer(raw),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('invalid `mcpServers`'),
      )
    })

    test('shape 6a: top-level is an array → SetupError', () => {
      const raw: McpJsonReadResult = {
        exists: true,
        content: ['a', 'b'],
        indent: 2,
      }
      assert.throws(
        () => mergeCiServer(raw),
        (err: SetupError) =>
          err instanceof SetupError &&
          err.userMessage.includes('top-level is not an object'),
      )
    })

    test('shape 6b: top-level is null → SetupError', () => {
      const raw: McpJsonReadResult = {
        exists: true,
        content: null,
        indent: 2,
      }
      assert.throws(
        () => mergeCiServer(raw),
        (err: SetupError) =>
          err instanceof SetupError &&
          err.userMessage.includes('top-level is not an object'),
      )
    })

    test('shape 6c: top-level is a string → SetupError', () => {
      const raw: McpJsonReadResult = {
        exists: true,
        content: 'just a string',
        indent: 2,
      }
      assert.throws(
        () => mergeCiServer(raw),
        (err: SetupError) =>
          err instanceof SetupError &&
          err.userMessage.includes('top-level is not an object'),
      )
    })
  })

  describe('round-trip: parse → merge → stringify → parse', () => {
    test('a simple config round-trips through the merge cleanly', () => {
      writeFileSync(
        mcpPath,
        JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2) +
          '\n',
      )
      const raw = readMcpJson(mcpPath)
      const { updated, action } = mergeCiServer(raw)
      writeMcpJson(mcpPath, updated, raw.exists ? raw.indent : 2)

      // Re-read and verify structure is preserved + ci is present.
      const reread = JSON.parse(readFileSync(mcpPath, 'utf-8'))
      assert.equal(action, 'merged')
      assert.deepEqual(reread.mcpServers.other, { command: 'x' })
      assert.deepEqual(reread.mcpServers.ci, { ...CI_SERVER_ENTRY })
    })

    test('skipped_exists does not disturb file contents when written', () => {
      const original = {
        mcpServers: {
          ci: { command: 'preserved', args: ['values'] },
          other: { command: 'x' },
        },
      }
      writeFileSync(mcpPath, JSON.stringify(original, null, 2) + '\n')
      const raw = readMcpJson(mcpPath)
      const { updated, action } = mergeCiServer(raw)
      // Even though action is skipped_exists, updated is still the
      // original content; writing it back should be a no-op.
      assert.equal(action, 'skipped_exists')
      assert.deepEqual(updated, original)
    })
  })

  describe('detectIndent', () => {
    test('2-space file → 2', () => {
      const raw = '{\n  "a": 1\n}'
      assert.equal(detectIndent(raw), 2)
    })

    test('4-space file → 4', () => {
      const raw = '{\n    "a": 1\n}'
      assert.equal(detectIndent(raw), 4)
    })

    test('no-indent file defaults to 2', () => {
      const raw = '{"a":1}'
      assert.equal(detectIndent(raw), 2)
    })

    test('empty file defaults to 2', () => {
      assert.equal(detectIndent(''), 2)
    })
  })

  describe('writeMcpJson', () => {
    test('writes JSON with trailing newline', () => {
      writeMcpJson(mcpPath, { mcpServers: { ci: { ...CI_SERVER_ENTRY } } }, 2)
      const content = readFileSync(mcpPath, 'utf-8')
      assert.ok(content.endsWith('\n'))
      const parsed = JSON.parse(content)
      assert.deepEqual(parsed.mcpServers.ci, { ...CI_SERVER_ENTRY })
    })

    test('respects indent argument', () => {
      writeMcpJson(mcpPath, { a: 1, b: 2 }, 4)
      const content = readFileSync(mcpPath, 'utf-8')
      assert.match(content, /^ {4}"a"/m)
    })
  })
})
