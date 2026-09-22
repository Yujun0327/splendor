// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { Mesh } from '@yujun/game-net/mesh'
import { Ledger, MONEY_RULES, identityFromSeed, verify, type Settlement } from '@yujun/game-net/wallet'
import { OnlineSession } from '../src/app/session.svelte'
import { mulberry32 } from '../src/engine'
import type { Move } from '../src/engine'

/** Records signed posts; completes a settlement once every seat has signed. */
class FakeLedger extends Ledger {
  posts: { action: string; player: string; msg: string; sig: string }[] = []
  constructor() {
    super({ url: 'http://fake', anonKey: 'x' }, async (input, init) => {
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { action: string; player: string; msg: string; sig: string }
        this.posts.push(body)
        if (body.action === 'settle') {
          if (!verify(body.player, 'settle', body.msg, body.sig)) return json({ ok: false, error: 'bad sig' }, 401)
          const s = JSON.parse(body.msg) as Settlement
          const signed = new Set(this.posts.filter((p) => p.action === 'settle' && JSON.parse(p.msg).gameId === s.gameId).map((p) => p.player))
          return json({ ok: true, status: signed.size === s.seats.length ? 'settled' : 'pending' })
        }
        return json({ ok: true, status: 'ok' })
      }
      void input
      return json([])
    })
  }
}

const ids = [1, 2, 3].map((n) => identityFromSeed(new Uint8Array(32).fill(n)))
let clock = 1_000_000
const now = () => clock

beforeEach(() => {
  localStorage.clear()
  clock = 1_000_000
})

describe('wallet settlement', () => {
  it('every seat signs the same casual settlement and the winner is paid by the rules', async () => {
    const mesh = new Mesh<never>()
    const ledger = new FakeLedger()
    const sessions = ids.map(
      (id, i) =>
        new OnlineSession(ROOM, i === 0, { key: id.id, name: `P${i}` }, { transport: mesh.peer(`peer-${i}`), now, timers: false, ledger, identity: id }),
    )
    const second = () => {
      clock += 1000
      for (const s of sessions) s.net.tick()
      mesh.flush()
    }
    second()
    second()
    for (const s of sessions) s.setReady(true)
    mesh.flush()
    sessions[0].startGame()
    mesh.flush()

    const rng = mulberry32(3)
    for (let step = 0; step < 4000 && !sessions[0].state.result; step++) {
      const current = sessions.find((s) => s.myTurn)
      if (current && !current.state.result) {
        const moves = current.myMoves()
        const purchases = moves.filter((m) => m.type === 'purchase')
        const pool = purchases.length > 0 && rng() < 0.7 ? purchases : moves
        current.submit(pool[Math.floor(rng() * pool.length)] as Move)
      }
      second()
    }
    await new Promise((r) => setTimeout(r, 20))
    second()

    const settles = ledger.posts.filter((p) => p.action === 'settle')
    expect(new Set(settles.map((p) => p.player)).size).toBe(3)
    expect(new Set(settles.map((p) => p.msg)).size).toBe(1) // identical canonical settlement everywhere
    const s = JSON.parse(settles[0].msg) as Settlement
    expect(s.app).toBe('splendor')
    expect(s.mode).toBe('casual')
    expect(s.winners).toEqual(sessions[0].state.result!.winners)
    expect(s.logLen).toBeGreaterThanOrEqual(MONEY_RULES.splendor.minMoves)
    for (const x of sessions) expect(['pending', 'settled']).toContain(x.payout?.status)
    for (const x of sessions) x.destroy()
  })
})
const ROOM = 'WALLET1'
