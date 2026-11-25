import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lockedInstalls, npmInstalls } from './npminstalls.ts'

const dirs = (cmd: string) => npmInstalls(cmd).map((n) => [n.dir, n.ci, n.noLock])

test('npm installs anywhere in a command, in the folder they run in (Bug 191)', () => {
  assert.deepEqual(dirs('npm install'), [['', false, false]])
  assert.deepEqual(dirs('cd web && npm install'), [['web', false, false]])
  assert.deepEqual(dirs('cd web && npm install && npm start'), [['web', false, false]])
  assert.deepEqual(dirs('cd web; npm i'), [['web', false, false]])
  assert.deepEqual(dirs('cd web\nnpm ci'), [['web', true, false]])
  assert.deepEqual(dirs('(cd web; npm i) && npm ci'), [['web', false, false], ['', true, false]]) // the cd stays in its ( )
  assert.deepEqual(dirs('cd web && cd src && npm i'), [['web/src', false, false]])
  assert.deepEqual(dirs('cd web/.. && npm i'), [['', false, false]])
  assert.deepEqual(dirs('npm --prefix web install'), [['web', false, false]])
  assert.deepEqual(dirs('npm install --prefix web'), [['web', false, false]])
  assert.deepEqual(dirs('npm ci --prefix=web'), [['web', true, false]])
  assert.deepEqual(dirs('npm -C web i'), [['web', false, false]])
  assert.deepEqual(dirs('cd app && npm --prefix web ci'), [['app/web', true, false]])
  assert.deepEqual(dirs('npm --loglevel warn install'), [['', false, false]]) // warn is the option's value, not the command
  assert.deepEqual(dirs('npm --silent clean-install'), [['', true, false]])
  assert.deepEqual(dirs('NODE_ENV=development npm add left-pad'), [['', false, false]])
  assert.deepEqual(dirs('env CI=1 npm install-test'), [['', false, false]])
  assert.deepEqual(dirs('/opt/homebrew/bin/npm install'), [['', false, false]])
  assert.deepEqual(dirs("cd 'my web' && npm i"), [['my web', false, false]])
  assert.deepEqual(dirs('cd "web" && npm i --no-package-lock'), [['web', false, true]])
  assert.deepEqual(dirs('npm i --package-lock=false 2>&1 | tail -5'), [['', false, true]])
  assert.deepEqual(dirs('npm ci &> install.log && npm start'), [['', true, false]])
  assert.deepEqual(dirs('npm ci & npm --prefix web ci'), [['', true, false], ['web', true, false]])
  assert.deepEqual(dirs('npm ci || npm install'), [['', true, false], ['', false, false]])
})

test('a folder HQ can\'t follow comes back unknown', () => {
  for (const c of ['cd $WEB && npm i', 'cd "$WEB" && npm i', 'cd ~/web && npm i', 'cd /tmp/web && npm i', 'cd - && npm i', 'cd && npm i',
    'npm --prefix "$DIR" install', 'npm install --prefix /abs', 'popd && npm i', 'cd `pwd` && npm i', 'cd web* && npm i'])
    assert.deepEqual(dirs(c), [[null, false, false]], c)
  assert.deepEqual(dirs('(cd $X) && npm i'), [['', false, false]]) // the unknown cd ended with its ( )
})

test('what is not an npm install is left alone', () => {
  for (const c of ['pnpm install', 'yarn install', 'yarn', 'uv sync', 'pip install -r requirements.txt', 'bun install', 'bun ci',
    'echo npm install', 'echo "cd web && npm install"', "sh -c 'npm install'", 'npx npm-install-peers',
    'npm start', 'npm run dev', 'npm run install', 'npm test', 'npm run build -- --prefix web', 'npm exec -- npm install',
    './npm-install.sh', 'node_modules/.bin/npm-run-all build', 'cd npm && make', 'cd web && npminstall', 'make install',
    'npm', 'npm --prefix web', 'npm-install', 'NPM install', '"npm install"', 'npm install-ci', ''])
    assert.deepEqual(dirs(c), [], c)
})

const locked = (cmd: string) => lockedInstalls(cmd).map((n) => [n.lock, n.dir, n.frozen])

test('uv, yarn and pnpm installs anywhere in a command, in the folder they run in (Bug 211)', () => {
  assert.deepEqual(locked('uv sync'), [['uv.lock', '', false]])
  assert.deepEqual(locked('cd server && uv sync'), [['uv.lock', 'server', false]])
  assert.deepEqual(locked('(cd server; uv sync --locked) && cd web && yarn'), [['uv.lock', 'server', true], ['yarn.lock', 'web', false]])
  assert.deepEqual(locked('uv --directory server sync'), [['uv.lock', 'server', false]])
  assert.deepEqual(locked('uv sync --project=server --frozen'), [['uv.lock', 'server', true]])
  assert.deepEqual(locked('cd app && uv -q sync --python 3.12'), [['uv.lock', 'app', false]])
  assert.deepEqual(locked('UV_LOCKED=1 uv sync'), [['uv.lock', '', true]])
  assert.deepEqual(locked('UV_FROZEN=0 uv sync'), [['uv.lock', '', false]])
  assert.deepEqual(locked('cd web && yarn install'), [['yarn.lock', 'web', false]])
  assert.deepEqual(locked('cd web && yarn install --check-files'), [['yarn.lock', 'web', false]]) // any flags, not just bare `yarn install`
  assert.deepEqual(locked('yarn --cwd web'), [['yarn.lock', 'web', false]])
  assert.deepEqual(locked('yarn --network-timeout 100000 install'), [['yarn.lock', '', false]])
  assert.deepEqual(locked('cd web && yarn install --immutable'), [['yarn.lock', 'web', true]])
  assert.deepEqual(locked('YARN_ENABLE_IMMUTABLE_INSTALLS=true yarn'), [['yarn.lock', '', true]])
  assert.deepEqual(locked('cd web && pnpm install'), [['pnpm-lock.yaml', 'web', false]])
  assert.deepEqual(locked('pnpm -C web i'), [['pnpm-lock.yaml', 'web', false]])
  assert.deepEqual(locked('pnpm --dir=web install --frozen-lockfile'), [['pnpm-lock.yaml', 'web', true]])
  assert.deepEqual(locked('cd web && pnpm --filter app install 2>&1 | tail'), [['pnpm-lock.yaml', 'web', false]])
  assert.deepEqual(locked('/opt/homebrew/bin/uv sync'), [['uv.lock', '', false]])
  for (const c of ['cd $X && uv sync', 'uv --directory "$D" sync', 'yarn --cwd /abs install', 'pnpm -C ~/web i', 'cd - && yarn'])
    assert.deepEqual(locked(c).map((n) => n[1]), [null], c)
})

test('what is not a uv, yarn or pnpm install is left alone', () => {
  for (const c of ['uv pip install -r requirements.txt', 'uv lock', 'uvx ruff', 'uv tool run ruff', 'yarn dev',
    'yarn run build', 'yarn --version', 'yarn -v', 'yarn --cwd web dev', 'yarn -s start', 'pnpm dev', 'pnpm run install', 'pnpm --filter web dev',
    'pnpm -C web build', 'pnpm', 'echo uv sync', 'echo "cd server && uv sync"', "sh -c 'uv sync'", 'npx pnpm install', 'npm install',
    'cd yarn && make', './yarn-install.sh', '"uv sync"', 'yarn install-peers', 'pnpm installs', ''])
    assert.deepEqual(locked(c), [], c)
})

const kinds = (cmd: string) => lockedInstalls(cmd).map((n) => [n.tool, n.dir, n.frozen, n.noLock, n.run])

test('installs that write no lockfile, and `uv run`, which installs before it runs (Bug 239)', () => {
  assert.deepEqual(kinds('uv run app.py'), [['uv', '', false, false, true]])
  assert.deepEqual(kinds('uv --project server run app'), [['uv', 'server', false, false, true]])
  assert.deepEqual(kinds('cd server && uv run --no-sync uvicorn app:app'), [['uv', 'server', false, true, true]])
  assert.deepEqual(kinds('uv run --no-project script.py'), [['uv', '', false, true, true]])
  assert.deepEqual(kinds('UV_NO_SYNC=1 uv run app.py'), [['uv', '', false, true, true]])
  assert.deepEqual(kinds('uv run --locked app.py'), [['uv', '', true, false, true]])
  assert.deepEqual(kinds('uv sync --no-sync'), [['uv', '', false, false, false]]) // not an option of uv sync: still writes one
  assert.deepEqual(kinds('cd web && yarn install --pure-lockfile'), [['yarn', 'web', false, true, false]])
  assert.deepEqual(kinds('yarn --no-lockfile'), [['yarn', '', false, true, false]])
  for (const c of ['pnpm i --no-lockfile', 'pnpm install --lockfile=false', 'pnpm install --config.lockfile=false'])
    assert.deepEqual(kinds(c), [['pnpm', '', false, true, false]], c)
  assert.deepEqual(kinds('pnpm install --lockfile-only'), [['pnpm', '', false, false, false]]) // writes only the lockfile
})

test('bun installs: where they run, whether they follow the lockfile or write none (Bug 358)', () => {
  assert.deepEqual(locked('bun install'), [['bun.lock', '', false]]); assert.deepEqual(locked('cd web && bun i'), [['bun.lock', 'web', false]])
  assert.deepEqual(locked('bun install --frozen-lockfile'), [['bun.lock', '', true]]); assert.deepEqual(locked('bun ci'), [['bun.lock', '', true]])
  assert.deepEqual(locked('bun --cwd web install'), [['bun.lock', 'web', false]]); assert.deepEqual(locked('bun i --cwd=web --frozen-lockfile'), [['bun.lock', 'web', true]])
  assert.deepEqual(locked('bun --config ./bunfig.toml install'), [['bun.lock', '', false]]) // an option's value isn't the subcommand
  assert.deepEqual(kinds('bun install --no-save'), [['bun', '', false, true, false]])
  assert.deepEqual(kinds('BUN_CONFIG_SKIP_SAVE_LOCKFILE=1 bun i'), [['bun', '', false, true, false]])
  assert.deepEqual(locked('bun i --cwd "$WEB"').map((n) => n[1]), [null])
  // what it must not catch: bun running things, adding a package (the user's own change to package.json), bunx
  for (const c of ['bun run dev', 'bun dev', 'bun start', 'bun test', 'bun server.ts', 'bun --version', 'bun', 'bunx vite', 'bun add ms', 'bun x vite',
    'echo bun install', 'npm install', 'cd bun && make'])
    assert.deepEqual(locked(c), [], c)
})
