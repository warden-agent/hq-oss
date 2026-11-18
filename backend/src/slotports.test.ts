// Bug 259: engineers' ports come from a window of this HQ's own, so two HQs on one machine never give their engineers the same ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freeBase, portsNote, SLOT_SIZE, slotBases, slotWindow } from './slotports.ts'

const overlap = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1]

test('slotWindow (Bug 259): each HQ\'s window comes from its UI port, and HQs on one machine get windows that don\'t overlap', () => {
  const live = slotWindow(4780)
  assert.deepEqual(live, slotWindow(4780)); assert.equal(live[1] - live[0] + 1, 200) // the same after a restart; 20 engineers' worth
  assert.ok(live[0] >= 10000 && live[1] < 32768) // never in an OS's own range of ports it hands out
  assert.notEqual(slotWindow(4780)[0], 3110) // not the old fixed 3100+10n
  // the live HQ next to the test HQs of isohq.sh (its default 4890, the fixers' 6000s ranges) and the e2e harness's random ports
  for (const other of [4890, 6380, 6400, 6420, 4783, 4800, 49152, 60001]) assert.ok(!overlap(live, slotWindow(other)), `4780 vs ${other}`)
  for (let a = 1024; a < 1024 + 96; a++) for (let b = a + 1; b <= a + 96; b++) assert.ok(!overlap(slotWindow(a), slotWindow(b)), `${a} vs ${b}`)
  for (let ui = 1024; ui <= 65535; ui += 7) { const w = slotWindow(ui); assert.ok(w[0] >= 10000 && w[1] <= 29399, String(ui)) }
})

test('slotWindow: HQ_SLOT_PORTS picks the window by hand, and a bad one is refused', () => {
  assert.deepEqual(slotWindow(4780, '20000-20199'), [20000, 20199]); assert.deepEqual(slotWindow(4780, ' 3110 - 3119 '), [3110, 3119])
  assert.deepEqual(slotWindow(4780, ''), slotWindow(4780)) // set but empty: the default
  for (const bad of ['3110', '80-200', '3119-3110', '3110-3115', '60000-70000', '10000-11000', 'x']) {
    assert.throws(() => slotWindow(4780, bad), /HQ_SLOT_PORTS must look like 20000-20199/, bad)
  }
})

test('slotBases: blocks of 10, none holding one of HQ\'s own or preview ports', () => {
  assert.deepEqual(slotBases([20000, 20049]), [20000, 20010, 20020, 20030, 20040])
  assert.deepEqual(slotBases([20000, 20055]), [20000, 20010, 20020, 20030, 20040]) // a short block at the end isn't used
  assert.deepEqual(slotBases([20000, 20049], [20015, 20039, 19999, 20050]), [20000, 20020, 20040]) // ports just outside don't count
})

test('freeBase: the lowest block none of this HQ\'s engineers holds and nothing listens on; null when there is none', async () => {
  const bases = [20000, 20010, 20020, 20030], none = () => new Set<number>(), free = async () => false
  assert.equal(await freeBase(bases, none, free, (b) => b), 20000)
  assert.equal(await freeBase(bases, () => new Set([20000, 20020]), free, (b) => b), 20010)
  const asked: number[] = []
  const busy = async (p: number) => { asked.push(p); return p === 20009 || p === 20010 } // another HQ's engineer, or any program
  assert.equal(await freeBase(bases, none, busy, (b) => b), 20020)
  assert.deepEqual(asked.filter((p) => p >= 20020).length, SLOT_SIZE) // all ten ports of a block are looked at; the next block isn't
  assert.equal(await freeBase(bases, none, async () => true, (b) => b), null)
  // taken by another launch during the wait: the next block, claimed in the same step as the check
  const held = new Set<number>()
  const slow = async (p: number) => { if (p === 20000) held.add(20000); return false }
  assert.equal(await freeBase(bases, () => held, slow, (b) => b), 20010)
})

test('portsNote: the engineer is told its own ports and database name', () => {
  const n = portsNote({ PORT: '15400', HQ_PORT_BASE: '15400', DB_NAME: 'hq_w1_15400', HQ_WORKER: '1' })
  assert.match(n, /15400–15409/); assert.match(n, /\$PORT and \$HQ_PORT_BASE are set to 15400/); assert.match(n, /hq_w1_15400/)
  assert.doesNotMatch(n, /3110|3100/)
})
