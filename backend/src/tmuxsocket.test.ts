// scripts/tmux-socket.mjs: what it takes for a tmux call with no socket, what it leaves alone, and when the check fails (Bug 295).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-expect-error a plain script, no types
import { tmuxCalls, withoutComments, verdict, readBaseline, codeFiles } from '../../scripts/tmux-socket.mjs'

type Found = { line: number; kind: string; ok: boolean; why: string }
const found = (text: string): string[] => tmuxCalls(text).map((x: Found) => `${x.line}:${x.kind}:${x.ok ? 'ok' : 'bare'}`)

test('a child-process call of tmux passes when its arguments begin -S or -L, and fails when they do not or cannot be read', () => {
  assert.deepEqual(found("execFile('tmux', ['-S', socket(), ...args], cb)"), ['1:call:ok'])
  assert.deepEqual(found('execFileSync("tmux", ["-L", "hq-test", "kill-server"])'), ['1:call:ok'])
  assert.deepEqual(found("const p = pty.spawn('tmux', ['-S', socket(), 'attach-session', '-t', s], {})"), ['1:call:ok'])
  assert.deepEqual(found("spawnSync(\n  'tmux',\n  [\n    '-S', sock, 'ls'])"), ['1:call:ok'], 'over several lines')
  assert.deepEqual(found("execFileSync('tmux', ['kill-server'])"), ['1:call:bare'])
  assert.deepEqual(found("x()\nspawn('tmux', ['new-session', '-d', '-S', sock])"), ['2:call:bare'], 'the socket has to come first, as tmux reads it')
  assert.deepEqual(found("execFileSync('tmux', args)"), ['1:call:bare'], 'a list in a variable cannot be read')
  assert.deepEqual(found("execFileSync('tmux')"), ['1:call:bare'])
  assert.match(tmuxCalls("execFileSync('tmux', args)")[0].why, /not written out as a list/)
  assert.match(tmuxCalls("execFileSync('tmux', ['ls'])")[0].why, /don't begin '-S' or '-L'/)
  assert.deepEqual(found("execFileSync('tmux', ['-V'], { stdio: 'ignore' })"), ['1:call:ok'], 'its version only: no server is reached')
  assert.deepEqual(found("execFileSync('tmux', ['-V', 'kill-server'])"), ['1:call:bare'])
  // a child script kept in a template string is read too (owntmptmux.test.ts)
  assert.deepEqual(found("const child = `\n  execFileSync('tmux', ['-S', sock, 'new-session'])\n  execFileSync('tmux', ['display', '-p'])`"), ['2:call:ok', '3:call:bare'])
})

test('a tmux command in text a shell will run fails without -S or -L before the command', () => {
  assert.deepEqual(found("execSync('tmux kill-server')"), ['1:shell:bare'])
  assert.deepEqual(found("spawn('sh', ['-c', `tmux kill-session -t ${name}`])"), ['1:shell:bare'])
  assert.deepEqual(found('const cmd = "tmux ls"'), ['1:shell:bare'])
  assert.deepEqual(found("sh(`tmux new -d -s x 'sleep 5'`)"), ['1:shell:bare'])
  assert.deepEqual(found("sh('tmux -2 attach -t x')"), ['1:shell:bare'], 'another flag is not a socket')
  assert.deepEqual(found("sh(`tmux -S '${sock}' kill-server`)"), ['1:shell:ok'])
  assert.deepEqual(found('sh(`tmux -L hq-test new-session -d`)'), ['1:shell:ok'])
  assert.deepEqual(found("row(20, 20, 3_000, 'tmux -S /private/tmp/tmux-501/default new-session')"), ['1:shell:ok'])
  assert.match(tmuxCalls("execSync('tmux kill-server')")[0].why, /"tmux kill-server" names no socket/)
})

test('what is left alone: wrappers, a stand-in tmux, other programs, the word in prose, and anything in a comment', () => {
  assert.deepEqual(found("await tmux.killSession(s); hq.tmux('kill-session', '-t', a.tmux_session); tmux('ls')"), [], 'calls through the wrappers')
  assert.deepEqual(found("fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\\ncase \" $* \" in *\" kill-session \"*) sleep 2;; esac\\nexec \"${real}\" \"$@\"\\n`)"), [], 'a stand-in')
  assert.deepEqual(found("execFileSync('sh', ['-c', 'command -v tmux']); execFile('git', ['status']); spawn('sleep', ['600'])"), [])
  assert.deepEqual(found("test('a style tmux set on an earlier line still counts', () => {})"), [], 'prose: "set" with no flag after it')
  assert.deepEqual(found("throw new Error(`tmux ${args[0]}: ${stderr}`); log('tmux is installed'); const how = by === 'typed' ? 'tmux' : 'mod'"), [])
  assert.deepEqual(found("// never a bare `tmux kill-server`: execFileSync('tmux', ['kill-server'])\nx() /* tmux ls\n tmux kill-server */ + y()"), [])
  assert.deepEqual(found("const u = 'http://x/tmux/kill-server'; const f = 'my-tmux kill-server'; const g = 'xtmux ls'"), [], 'part of another word or a path')
  // comments go, strings stay, and every line keeps its number
  assert.equal(withoutComments("a // b\n'// not a comment' /* c\nd */ e"), "a     \n'// not a comment'     \n     e")
  assert.equal(withoutComments("const s = 'it\\'s // here'; // gone"), "const s = 'it\\'s // here';        ")
})

test('the check: a bare call fails it, so does a count that is not the baseline\'s, and the tree as it is passes', () => {
  assert.equal(readBaseline('calls 9\n'), 9); assert.ok(Number.isNaN(readBaseline('nonsense')))
  const call = (ok: boolean, f = 'backend/src/x.ts') => ({ f, line: 3, kind: 'call', ok, why: ok ? '' : "its arguments don't begin '-S' or '-L'" })
  assert.deepEqual(verdict([call(true), call(true)], 2).fails, [])
  assert.deepEqual(verdict([call(true), call(true)], 2).lines, ['tmux calls: 2 written out (baseline 2), 0 in shell text, 0 with no socket named'])
  const bare = verdict([call(true), call(false)], 2).fails
  assert.equal(bare[0], "backend/src/x.ts:3  its arguments don't begin '-S' or '-L'"); assert.match(bare[1], /can reach the live HQ's tmux/); assert.equal(bare.length, 2)
  assert.match(verdict([call(true)], 2).fails.join('\n'), /^1 fewer written-out calls than the baseline: .*this script has stopped seeing them\.$/)
  assert.match(verdict([call(true), call(true), call(true)], 2).fails.join('\n'), /^1 more written-out calls than the baseline: .*raise "calls"/)
  assert.match(verdict([call(true)], readBaseline('nonsense')).fails.join('\n'), /^The baseline can't be read/)
  // it reads the real code, this file's sources among it, and passes on the tree as it is
  const files: string[] = codeFiles()
  for (const f of ['backend/src/tmux.ts', 'backend/src/terminal.ts', 'backend/e2e/harness.ts', 'scripts/own-tmp.mjs']) assert.ok(files.includes(f), f)
  assert.ok(files.length > 250, String(files.length)); assert.ok(!files.includes('backend/src/tmuxsocket.test.ts'), 'its own examples are not read')
  const script = path.resolve(import.meta.dirname, '../../scripts/tmux-socket.mjs'), r = spawnSync(process.execPath, [script, '--list'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^tmux calls: \d+ written out \(baseline \d+\), \d+ in shell text, 0 with no socket named$/m)
  for (const f of ['backend/src/tmux.ts', 'backend/src/terminal.ts', 'backend/e2e/harness.ts', 'scripts/own-tmp.mjs']) assert.match(r.stdout, new RegExp(`^  ${f}:\\d+  call$`, 'm'))
})

test('a bare call planted in a copy of the code fails the script itself, with the file and line', () => {
  // The script reads the tree it stands in, so the copy is a small tree of its own: the script, a baseline of 1, one file with one good call
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-tmuxsocket-')), sh = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  try {
    fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'backend', 'src'), { recursive: true })
    fs.copyFileSync(path.resolve(import.meta.dirname, '../../scripts/tmux-socket.mjs'), path.join(dir, 'scripts', 'tmux-socket.mjs'))
    fs.writeFileSync(path.join(dir, 'scripts', 'tmux-socket.baseline'), 'calls 1\n')
    const file = path.join(dir, 'backend', 'src', 'a.ts'), good = "execFile('tmux', ['-S', sock, 'ls'])\n"
    fs.writeFileSync(file, good); sh('init', '-q'); sh('add', '-A')
    const run = () => spawnSync(process.execPath, [path.join(dir, 'scripts', 'tmux-socket.mjs')], { encoding: 'utf8' })
    assert.equal(run().status, 0, run().stderr)
    fs.writeFileSync(file, good + "// a comment\nexecSync('tmux kill-server')\n")
    const bare = run(); assert.equal(bare.status, 1); assert.match(bare.stderr, /^backend\/src\/a\.ts:3 {2}"tmux kill-server" names no socket/m)
    fs.writeFileSync(file, "run()\n"); const none = run(); assert.equal(none.status, 1); assert.match(none.stderr, /1 fewer written-out calls than the baseline/)
    fs.writeFileSync(file, good + "execFileSync('tmux', ['-S', sock, 'kill-server'])\n"); const more = run(); assert.equal(more.status, 1)
    assert.match(more.stderr, /1 more written-out calls than the baseline/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
