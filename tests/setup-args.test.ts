import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSetupArgs, setupUsage } from '../lib/setup/args.js'
import { SetupError } from '../lib/setup/errors.js'

const ttyTrue = () => true
const ttyFalse = () => false

describe('parseSetupArgs', () => {
  describe('happy path', () => {
    test('accepts --yes --repo owner/repo', () => {
      const result = parseSetupArgs(['--yes', '--repo', 'owner/repo'], { isTty: ttyTrue })
      assert.deepEqual(result, {
        kind: 'run',
        args: {
          repo: 'owner/repo',
          forge: 'github',
          yes: true,
          dryRun: false,
          smeeUrl: null,
        },
      })
    })

    test('-y is an alias for --yes', () => {
      const result = parseSetupArgs(['-y', '--repo', 'owner/repo'], { isTty: ttyTrue })
      assert.equal(result.kind, 'run')
      if (result.kind === 'run') assert.equal(result.args.yes, true)
    })

    test('accepts --forge github explicitly', () => {
      const result = parseSetupArgs(
        ['--forge', 'github', '--yes', '--repo', 'owner/repo'],
        { isTty: ttyTrue },
      )
      assert.equal(result.kind, 'run')
      if (result.kind === 'run') assert.equal(result.args.forge, 'github')
    })

    test('accepts --dry-run', () => {
      const result = parseSetupArgs(
        ['--yes', '--repo', 'owner/repo', '--dry-run'],
        { isTty: ttyTrue },
      )
      assert.equal(result.kind, 'run')
      if (result.kind === 'run') assert.equal(result.args.dryRun, true)
    })

    test('accepts --smee-url', () => {
      const result = parseSetupArgs(
        ['--yes', '--repo', 'owner/repo', '--smee-url', 'https://smee.io/abc'],
        { isTty: ttyTrue },
      )
      assert.equal(result.kind, 'run')
      if (result.kind === 'run') assert.equal(result.args.smeeUrl, 'https://smee.io/abc')
    })

    test('TTY + no --yes + --repo → repo is set', () => {
      const result = parseSetupArgs(['--repo', 'owner/repo'], { isTty: ttyTrue })
      assert.equal(result.kind, 'run')
      if (result.kind === 'run') {
        assert.equal(result.args.repo, 'owner/repo')
        assert.equal(result.args.yes, false)
      }
    })

    test('TTY + no --yes + no --repo → repo is null (runner will prompt)', () => {
      const result = parseSetupArgs([], { isTty: ttyTrue })
      assert.equal(result.kind, 'run')
      if (result.kind === 'run') {
        assert.equal(result.args.repo, null)
        assert.equal(result.args.yes, false)
      }
    })
  })

  describe('help flag', () => {
    test('--help returns help result', () => {
      const result = parseSetupArgs(['--help'], { isTty: ttyTrue })
      assert.deepEqual(result, { kind: 'help' })
    })

    test('-h returns help result', () => {
      const result = parseSetupArgs(['-h'], { isTty: ttyTrue })
      assert.deepEqual(result, { kind: 'help' })
    })

    test('--help short-circuits matrix checks (no --repo required)', () => {
      // Even with --yes and no --repo, --help wins.
      const result = parseSetupArgs(['--yes', '--help'], { isTty: ttyFalse })
      assert.deepEqual(result, { kind: 'help' })
    })
  })

  describe('interactive/non-interactive matrix', () => {
    test('--yes without --repo (TTY) → --yes requires --repo', () => {
      assert.throws(
        () => parseSetupArgs(['--yes'], { isTty: ttyTrue }),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('--yes requires --repo'),
      )
    })

    test('--yes without --repo (non-TTY) → --yes requires --repo', () => {
      assert.throws(
        () => parseSetupArgs(['--yes'], { isTty: ttyFalse }),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('--yes requires --repo'),
      )
    })

    test('--yes --dry-run without --repo → --yes requires --repo (dry-run does not relax this)', () => {
      assert.throws(
        () => parseSetupArgs(['--yes', '--dry-run'], { isTty: ttyTrue }),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('--yes requires --repo'),
      )
    })

    test('non-TTY + no --yes + no --repo → stdin is not a TTY', () => {
      assert.throws(
        () => parseSetupArgs([], { isTty: ttyFalse }),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('stdin is not a TTY'),
      )
    })

    test('non-TTY + no --yes + --repo → stdin is not a TTY (still fails, because per-step confirmations need a TTY)', () => {
      // Regression test: previously the TTY check was only applied when
      // --repo was missing, so `setup --repo owner/repo` on non-TTY
      // stdin would parse successfully and then fail later inside the
      // interactive Io. The check now applies whenever !yes, regardless
      // of whether --repo was set.
      assert.throws(
        () =>
          parseSetupArgs(['--repo', 'owner/repo'], { isTty: ttyFalse }),
        (err: SetupError) =>
          err instanceof SetupError &&
          err.userMessage.includes('stdin is not a TTY'),
      )
    })

    test('non-TTY + --yes + --repo → valid (fully non-interactive)', () => {
      const result = parseSetupArgs(
        ['--yes', '--repo', 'owner/repo'],
        { isTty: ttyFalse },
      )
      assert.equal(result.kind, 'run')
    })
  })

  describe('forge validation', () => {
    test('--forge gitlab → v1 scoping message with MCP server note', () => {
      assert.throws(
        () =>
          parseSetupArgs(
            ['--forge', 'gitlab', '--yes', '--repo', 'owner/repo'],
            { isTty: ttyTrue },
          ),
        (err: SetupError) =>
          err instanceof SetupError &&
          err.userMessage.includes('MCP server itself supports all three forges') &&
          err.userMessage.includes('gitlab'),
      )
    })

    test('--forge gitea → v1 scoping message', () => {
      assert.throws(
        () =>
          parseSetupArgs(
            ['--forge', 'gitea', '--yes', '--repo', 'owner/repo'],
            { isTty: ttyTrue },
          ),
        (err: SetupError) =>
          err instanceof SetupError &&
          err.userMessage.includes('MCP server itself supports all three forges') &&
          err.userMessage.includes('gitea'),
      )
    })

    test('--forge unknown → v1 scoping message', () => {
      assert.throws(
        () =>
          parseSetupArgs(
            ['--forge', 'bitbucket', '--yes', '--repo', 'owner/repo'],
            { isTty: ttyTrue },
          ),
        (err: SetupError) =>
          err instanceof SetupError &&
          err.userMessage.includes('bitbucket'),
      )
    })
  })

  describe('repo format validation', () => {
    const invalidRepos = [
      'bad"value',
      'owner',
      'owner/',
      '/repo',
      '',
      'owner/repo/extra',
      'space in/repo',
      'owner/repo with space',
    ]

    for (const bad of invalidRepos) {
      test(`rejects invalid repo: ${JSON.stringify(bad)}`, () => {
        assert.throws(
          () => parseSetupArgs(['--yes', '--repo', bad], { isTty: ttyTrue }),
          (err: SetupError) =>
            err instanceof SetupError && err.userMessage.includes('Invalid --repo value'),
        )
      })
    }

    test('accepts repo with dots, underscores, dashes', () => {
      const result = parseSetupArgs(
        ['--yes', '--repo', 'my-org.co/my_repo-v2.0'],
        { isTty: ttyTrue },
      )
      assert.equal(result.kind, 'run')
      if (result.kind === 'run') assert.equal(result.args.repo, 'my-org.co/my_repo-v2.0')
    })
  })

  describe('unknown and malformed flags', () => {
    test('unknown flag → SetupError', () => {
      assert.throws(
        () => parseSetupArgs(['--unknown'], { isTty: ttyTrue }),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('Unknown flag'),
      )
    })

    test('positional argument → SetupError', () => {
      assert.throws(
        () => parseSetupArgs(['positional'], { isTty: ttyTrue }),
        (err: SetupError) =>
          err instanceof SetupError &&
          err.userMessage.includes('Unexpected positional argument'),
      )
    })

    test('value flag missing value → SetupError', () => {
      assert.throws(
        () => parseSetupArgs(['--repo'], { isTty: ttyTrue }),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('Missing value'),
      )
    })

    test('value flag followed by another flag → SetupError', () => {
      assert.throws(
        () => parseSetupArgs(['--repo', '--yes'], { isTty: ttyTrue }),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('Missing value'),
      )
    })
  })

  describe('repeated flags', () => {
    test('duplicate --repo → SetupError', () => {
      assert.throws(
        () =>
          parseSetupArgs(
            ['--repo', 'a/b', '--repo', 'c/d', '--yes'],
            { isTty: ttyTrue },
          ),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('Duplicate flag: --repo'),
      )
    })

    test('duplicate --yes → SetupError', () => {
      assert.throws(
        () =>
          parseSetupArgs(
            ['--yes', '--yes', '--repo', 'owner/repo'],
            { isTty: ttyTrue },
          ),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('Duplicate flag: --yes'),
      )
    })

    test('--yes followed by -y → SetupError (same canonical form)', () => {
      assert.throws(
        () =>
          parseSetupArgs(
            ['--yes', '-y', '--repo', 'owner/repo'],
            { isTty: ttyTrue },
          ),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('Duplicate flag: --yes'),
      )
    })

    test('duplicate --dry-run → SetupError', () => {
      assert.throws(
        () =>
          parseSetupArgs(
            ['--dry-run', '--dry-run', '--yes', '--repo', 'owner/repo'],
            { isTty: ttyTrue },
          ),
        (err: SetupError) =>
          err instanceof SetupError && err.userMessage.includes('Duplicate flag: --dry-run'),
      )
    })
  })
})

describe('setupUsage', () => {
  test('contains the command name and option list', () => {
    const usage = setupUsage()
    assert.match(usage, /Usage: ci-channel setup/)
    assert.match(usage, /--repo/)
    assert.match(usage, /--forge/)
    assert.match(usage, /--yes/)
    assert.match(usage, /--dry-run/)
    assert.match(usage, /--smee-url/)
    assert.match(usage, /--help/)
  })

  test('mentions INSTALL.md for manual install path', () => {
    const usage = setupUsage()
    assert.match(usage, /INSTALL\.md/)
  })
})
