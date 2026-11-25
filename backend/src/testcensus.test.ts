// Bug 411: which of a project's test files does HQ's test command run nothing of (testcensus.ts)? The layouts are ones real projects have: a frontend beside
// a Python backend, a Python app with its JavaScript at the top, a Go server with a web folder, a workspace, a second project nested in the first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kindOf, notRun, notRunWords, ruleParts, type RunPart } from './testcensus.ts'

/** The test files of `files` that `parts` run nothing of. `texts`: what's in the files that are read (a package.json). */
const skipped = (files: string[], parts: RunPart[], texts: Record<string, string> = {}) => notRun(files, parts, (p) => files.includes(p), (p) => texts[p] ?? '')
const WEB = ['frontend/package.json', 'frontend/src/list.test.ts', 'frontend/src/api.test.tsx', 'frontend/src/list.ts']
const API = ['backend/pyproject.toml', 'backend/app/main.py', 'backend/tests/test_app.py', 'backend/tests/test_downloads.py', 'backend/tests/conftest.py']

test('the parts of the command HQ\'s rules build: one per folder, or one at the root, each with the kind of tests it runs', () => {
  assert.deepEqual(ruleParts('(cd "frontend" && npm test)'), [{ dir: 'frontend', kind: 'js' }])
  assert.deepEqual(ruleParts(' (cd "api" && pnpm test) && (cd "my app" && bun run test) '), [{ dir: 'api', kind: 'js' }, { dir: 'my app', kind: 'js' }])
  assert.deepEqual(['npm test', 'yarn test', 'uv run pytest -q', '.venv/bin/python -m pytest -q', 'cargo test', 'go test ./...', 'make test'].map((c) => ruleParts(c)[0]),
    [{ dir: '.', kind: 'js' }, { dir: '.', kind: 'js' }, { dir: '.', kind: 'python' }, { dir: '.', kind: 'python' }, { dir: '.', kind: 'rust' }, { dir: '.', kind: 'go' }, { dir: '.', kind: 'any' }])
})
test('a frontend beside a Python backend: the rules stop at the frontend, and the backend\'s tests are the ones not run', () => {
  assert.deepEqual(skipped([...WEB, ...API], ruleParts('(cd "frontend" && npm test)')), [{ dir: 'backend', kind: 'python', count: 3, example: 'backend/tests/test_app.py' }])
  assert.deepEqual(skipped([...WEB, ...API], [{ dir: 'frontend', kind: 'js' }, { dir: 'backend', kind: 'python' }]), []) // both run: nothing to say
  assert.deepEqual(skipped([...WEB, ...API], []), [{ dir: 'backend', kind: 'python', count: 3, example: 'backend/tests/test_app.py' },
    { dir: 'frontend', kind: 'js', count: 2, example: 'frontend/src/list.test.ts' }]) // the rules found nothing to run: every test file, most first
})
test('one folder, two kinds of tests: a test script at the top runs the JavaScript, and the Python beside it is not run', () => {
  const files = ['package.json', 'client/src/api.test.js', 'app/core/tests/test_pages.py', 'app/tests.py', 'test_settings.py', 'server_test.go']
  assert.deepEqual(skipped(files, ruleParts('npm test')), [{ dir: 'app', kind: 'python', count: 2, example: 'app/core/tests/test_pages.py' }, // Django's `tests.py` counts
    { dir: '.', kind: 'python', count: 1, example: 'test_settings.py' }, { dir: '.', kind: 'go', count: 1, example: 'server_test.go' }])
  assert.deepEqual(skipped(files, ruleParts('make test')), []) // HQ can't tell what `make test` runs: every kind, as far as it knows
})
test('a project of its own further down isn\'t run by the one above it, unless that one is a workspace\'s root', () => {
  const files = ['package.json', 'src/a.test.js', 'client/package.json', 'client/src/b.test.js', 'client/e2e/package.json', 'client/e2e/login.spec.ts']
  assert.deepEqual(skipped(files, ruleParts('npm test'), { 'package.json': '{"scripts":{"test":"node --test"}}' }), [{ dir: 'client', kind: 'js', count: 2, example: 'client/src/b.test.js' }])
  assert.deepEqual(skipped(files, ruleParts('npm test'), { 'package.json': '{"workspaces": ["client"], "scripts":{"test":"x"}}' }), []) // its `npm test` may run each one's
  assert.deepEqual(skipped([...files, 'pnpm-workspace.yaml'], ruleParts('pnpm test')), [])
  assert.deepEqual(skipped(files, ruleParts('(cd "client" && npm test)'), {}), [{ dir: 'client', kind: 'js', count: 1, example: 'client/e2e/login.spec.ts' },
    { dir: 'src', kind: 'js', count: 1, example: 'src/a.test.js' }]) // the part in client/ doesn't run the project nested in it, nor the tests outside its folder
  // Go: `go test ./...` stops at a module of its own
  const go = ['go.mod', 'cart_test.go', 'internal/cart/cart_test.go', 'sdk/go.mod', 'sdk/client_test.go']
  assert.deepEqual(skipped(go, ruleParts('go test ./...')), [{ dir: 'sdk', kind: 'go', count: 1, example: 'sdk/client_test.go' }])
  // Python and Rust: one project's runner goes through the folders below it (pytest from the root, a cargo workspace)
  assert.deepEqual(skipped(['pyproject.toml', 'tests/test_a.py', 'tools/pyproject.toml', 'tools/tests/test_b.py'], ruleParts('uv run pytest -q')), [])
  assert.deepEqual(skipped(['Cargo.toml', 'tests/cli.rs', 'crates/core/Cargo.toml', 'crates/core/tests/api.rs'], ruleParts('cargo test')), [])
})
test('tests in a language the rules have no command for are named, by folder and kind', () => {
  const files = [...WEB, 'server/pom.xml', 'server/src/test/java/shop/CartTest.java', 'server/src/main/java/shop/Cart.java', 'spec/models/user_spec.rb', 'spec/spec_helper.rb',
    'ios/AppTests/LoginTests.swift', 'lib/app_test.exs']
  const got = skipped(files, ruleParts('(cd "frontend" && npm test)'))
  assert.deepEqual(got.map(notRunWords), ['spec/ (2 Ruby test files)', 'lib/ (1 Elixir test file)', 'server/ (1 Java test file)']) // most first, then by folder
  assert.equal(got.some((g) => g.kind === 'swift'), false) // `AppTests/LoginTests.swift` is no test file by HQ's rule (a folder named test or tests, or a name ending in test)
  assert.equal(notRunWords({ dir: '.', kind: 'go', count: 3, example: 'a_test.go' }), 'the top folder (3 Go test files)')
})
test('what the list must not hold: other people\'s code, what tests read, files that are no code, and a file that only sounds like a test', () => {
  const files = ['node_modules/x/x.test.js', 'web/node_modules/y/test/a.js', 'vendor/lib/lib_test.go', 'third_party/z/tests/test_z.py', 'tests/fixtures/app/test_app.py',
    'src/__snapshots__/list.test.ts', 'test/testdata/case_test.go', 'tests/data.json', 'tests/README.md', 'docs/testing.md', '.github/scripts/test_release.py', 'dist/a.test.js',
    'src/latest.ts', 'src/contest.py', 'attest.go']
  assert.deepEqual(skipped(files, []), [])
  assert.deepEqual([kindOf('a/b.TSX'), kindOf('x_test.go'), kindOf('notes.md'), kindOf('Makefile')], ['js', 'go', undefined, undefined])
})
