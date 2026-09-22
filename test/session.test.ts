// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import { Mesh } from '@yujun/game-net/mesh'
import { OnlineSession } from '../src/app/session.svelte'
import { mulberry32, publicHash } from '../src/engine'
import type { Move } from '../src/engine'
import GameScreen from '../src/ui/GameScreen.svelte'
import PlayingProbe from './support/PlayingProbe.svelte'

// jsdom has no Web Animations API; Svelte transitions need a finishing stub
if (!Element.prototype.animate) {
  Element.prototype.animate = function () {
    const anim = {
      cancel() {},
      finish() {},
      finished: Promise.resolve(),
      set onfinish(fn: (() => void) | null) {
        fn?.()
      },
    }
    return anim as unknown as Animation
  }
}

const ROOM = 'TESTROOM'
let clock = 1_000_000
const now = () => clock

/** Deterministic room: an in-memory broadcast mesh plus a manual clock. */
class World {
  mesh = new Mesh<never>()
  sessions: OnlineSession[] = []

  add(i: number, creator = false): OnlineSession {
    const s = new OnlineSession(
      ROOM,
      creator,
      { key: `key-${i}`, name: `P${i}` },
      { transport: this.mesh.peer(`peer-${i}`), now, timers: false },
    )
    this.sessions.push(s)
    return s
  }

  /** One second passes: everyone ticks, then the mesh delivers. */
  second(times = 1): void {
    for (let i = 0; i < times; i++) {
      clock += 1000
      for (const s of this.sessions) s.net.tick()
      this.mesh.flush()
    }
  }

  flush(): void {
    this.mesh.flush()
  }

  remove(s: OnlineSession): void {
    s.destroy()
    this.sessions = this.sessions.filter((x) => x !== s)
  }

  /** Host + n-1 joiners, everyone ready, host deals. */
  start(n: number): OnlineSession[] {
    const host = this.add(0, true)
    for (let i = 1; i < n; i++) this.add(i)
    this.second(2)
    for (const s of this.sessions) s.setReady(true)
    this.flush()
    host.startGame()
    this.flush()
    return this.sessions
  }

  acting(): OnlineSession {
    return this.sessions.find((s) => s.myTurn)!
  }
}

beforeEach(() => {
  localStorage.clear()
  clock = 1_000_000
})

describe('lobby', () => {
  it('seats joiners in order and gates start on ready', () => {
    const w = new World()
    const host = w.add(0, true)
    w.flush()
    const b = w.add(1)
    w.second()
    const c = w.add(2)
    w.second()

    expect(host.seats.map((s) => s.name)).toEqual(['P0', 'P1', 'P2'])
    expect(b.seats.length).toBe(3) // roster reached joiners
    expect(b.hostKey).toBe('key-0')
    expect(host.canStart).toBe(false)

    host.setReady(true)
    b.setReady(true)
    c.setReady(true)
    w.flush()
    expect(host.canStart).toBe(true)

    host.startGame()
    w.flush()
    for (const s of [host, b, c]) {
      expect(s.playing).toBe(true)
      expect(s.cfg.playerCount).toBe(3)
    }
    expect([host.seat, b.seat, c.seat]).toEqual([0, 1, 2])
    expect(publicHash(b.state)).toBe(publicHash(host.state))
  })

  it('renders the lobby→game transition reactively on every client', () => {
    // regression: templates must track something while `playing` is false
    const w = new World()
    const host = w.add(0, true)
    const guest = w.add(1)
    w.second()

    const targets = [host, guest].map((session) => {
      const target = document.createElement('div')
      document.body.appendChild(target)
      const instance = mount(PlayingProbe, { target, props: { session } })
      return { target, instance }
    })
    flushSync()
    expect(targets.map((t) => t.target.textContent)).toEqual(['LOBBY', 'LOBBY'])

    host.setReady(true)
    guest.setReady(true)
    w.flush()
    host.startGame()
    w.flush()
    flushSync()

    expect(targets.map((t) => t.target.textContent)).toEqual(['GAME', 'GAME'])
    for (const t of targets) {
      unmount(t.instance)
      t.target.remove()
    }
  })

  it('drops a departed seat so it cannot ghost-block the start', () => {
    const w = new World()
    const host = w.add(0, true)
    const b = w.add(1)
    const c = w.add(2)
    w.second()
    for (const s of [host, b, c]) s.setReady(true)
    w.flush()
    expect(host.canStart).toBe(true)

    w.remove(c) // closes the tab without un-readying
    w.second(16) // presence timeout
    expect(host.seats.length).toBe(2)
    expect(host.canStart).toBe(true)

    host.startGame()
    w.flush()
    expect(host.cfg.playerCount).toBe(2)
    expect(b.playing).toBe(true)
  })

  it('turns a fifth arrival away', () => {
    const w = new World()
    w.add(0, true)
    for (let i = 1; i < 5; i++) w.add(i)
    w.second(3)
    expect(w.sessions[4].status).toBe('room-full')
    expect(w.sessions[0].seats.length).toBe(4)
  })

  it('a renamed player shows up under the new name everywhere', () => {
    const w = new World()
    const host = w.add(0, true)
    const b = w.add(1)
    w.second()
    b.rename('Bo')
    w.flush()
    expect(host.seats[1].name).toBe('Bo')
    expect(b.myName).toBe('Bo')
  })
})

describe('play across the mesh', () => {
  function playRandomGame(n: 2 | 3 | 4, seed: number, lossy = false) {
    const w = new World()
    const sessions = w.start(n)
    const rng = mulberry32(seed)

    for (let step = 0; step < 4000 && !sessions[0].state.result; step++) {
      const current = sessions.find((s) => s.myTurn)
      if (current && !current.state.result) {
        const moves = current.myMoves()
        expect(moves.length).toBeGreaterThan(0)
        const purchases = moves.filter((m) => m.type === 'purchase')
        const pool = purchases.length > 0 && rng() < 0.7 ? purchases : moves
        current.submit(pool[Math.floor(rng() * pool.length)] as Move)
      }
      if (lossy) w.mesh.filter = () => rng() > 0.4
      w.second()
    }
    w.mesh.filter = () => true
    w.second(4)

    const reference = publicHash(sessions[0].state)
    for (const s of sessions) {
      expect(s.state.result).not.toBe(null)
      expect(publicHash(s.state)).toBe(reference)
      expect(s.status).toBe('playing')
    }
  }

  it('3 peers finish a full random game in lockstep', () => playRandomGame(3, 11))
  it('4 peers finish a full random game in lockstep', () => playRandomGame(4, 12))
  it('3 peers converge through 40% beacon loss', () => playRandomGame(3, 13, true))

  it('emits sound effects for remote moves', () => {
    const w = new World()
    const sessions = w.start(2)
    const acting = w.acting()
    const other = sessions.find((s) => s !== acting)!
    acting.submit({ type: 'reserve', from: { deck: 1 } })
    w.flush()
    expect(other.events.at(-1)?.sfx).toBe('reserve')
    expect(acting.events.at(-1)?.sfx).toBe('reserve')
  })
})

describe('online play through the rendered UI', () => {
  function mountGame(session: OnlineSession) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const instance = mount(GameScreen, {
      target,
      props: { session, onExit: () => {}, onRematch: () => {} },
    })
    flushSync()
    return {
      target,
      cleanup: () => {
        unmount(instance)
        target.remove()
        document.querySelectorAll('.backdrop').forEach((n) => n.remove())
      },
    }
  }

  it('lets the acting player reserve via clicks and syncs it to the peer', () => {
    const w = new World()
    const sessions = w.start(2)
    const acting = w.acting()
    const other = sessions.find((s) => !s.myTurn)!
    const { target, cleanup } = mountGame(acting)

    const slot = [...target.querySelectorAll('button.slot')].find(
      (b) => b.getAttribute('aria-label') === 'tier 1 card',
    ) as HTMLButtonElement
    slot.click()
    flushSync()
    const reserveBtn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent!.trim().startsWith('Reserve'),
    )!
    expect(reserveBtn.disabled).toBe(false)
    reserveBtn.click()
    flushSync()
    w.flush()

    expect(acting.state.players[acting.seat!].reserved.length).toBe(1)
    expect(acting.state.players[acting.seat!].tokens.gold).toBe(1)
    expect(publicHash(other.state)).toBe(publicHash(acting.state)) // peer applied it
    cleanup()
  })

  it('tells the waiting player why the card actions are unavailable', () => {
    const w = new World()
    const sessions = w.start(2)
    const waiting = sessions.find((s) => !s.myTurn)!
    const { target, cleanup } = mountGame(waiting)

    const slot = [...target.querySelectorAll('button.slot')].find(
      (b) => b.getAttribute('aria-label') === 'tier 1 card',
    ) as HTMLButtonElement
    slot.click()
    flushSync()

    const buttons = [...document.querySelectorAll('button')]
    const buy = buttons.find((b) => b.textContent!.trim().startsWith('Purchase'))!
    const reserveBtn = buttons.find((b) => b.textContent!.trim().startsWith('Reserve'))!
    expect(buy.disabled).toBe(true)
    expect(reserveBtn.disabled).toBe(true)
    expect(document.body.textContent).toContain('to finish their turn')
    cleanup()
  })
})

describe('reconnect and spectators', () => {
  it('replays from local storage and catches up over the wire', () => {
    const w = new World()
    const sessions = w.start(3)
    const gone = sessions[2]
    const lostSeat = gone.seat

    for (let i = 0; i < 3; i++) {
      w.acting().submit(w.acting().myMoves()[0])
      w.second()
    }
    w.remove(gone)

    // two more moves happen while they are away
    for (let i = 0; i < 2; i++) {
      const s = w.sessions.find((x) => x.myTurn)
      if (!s) break // it may be the absent player's turn
      s.submit(s.myMoves()[0])
      w.second()
    }

    // same playerKey returns on a fresh transport: storage replay + beacon catch-up
    const revived = w.add(2)
    expect(revived.playing).toBe(true) // restored from localStorage before any wire traffic
    w.second(2)

    expect(revived.seat).toBe(lostSeat) // seat reclaimed
    expect(publicHash(revived.state)).toBe(publicHash(sessions[0].state))
  })

  it('marks the table as waiting when the acting player disconnects', () => {
    const w = new World()
    const sessions = w.start(2)
    const acting = w.acting()
    const waiting = sessions.find((s) => s !== acting)!
    w.remove(acting)
    w.second(16)
    expect(waiting.waitingOn).toBe(acting.myName)
  })

  it('gives a latecomer a spectator view, blind reserves hidden', () => {
    const w = new World()
    const sessions = w.start(2)

    // the acting player blind-reserves so there is something to hide
    const acting = w.acting()
    acting.submit({ type: 'reserve', from: { deck: 1 } })
    w.flush()

    const spec = w.add(7)
    w.second(2)

    expect(spec.playing).toBe(true)
    expect(spec.spectator).toBe(true)
    expect(spec.myTurn).toBe(false)
    expect(spec.myMoves()).toEqual([])
    expect(publicHash(spec.state)).toBe(publicHash(sessions[0].state))
    const hidden = spec.visibleState.players[acting.seat!].reserved
    expect(hidden[0].card).toBe(-1) // masked for spectators
  })
})

describe('rematch', () => {
  it('any player can ask; the host deals a fresh game with rotated start', () => {
    const w = new World()
    const sessions = w.start(2)
    const rng = mulberry32(5)
    for (let step = 0; step < 4000 && !sessions[0].state.result; step++) {
      const current = w.acting()
      const moves = current.myMoves()
      const purchases = moves.filter((m) => m.type === 'purchase')
      const pool = purchases.length > 0 && rng() < 0.7 ? purchases : moves
      current.submit(pool[Math.floor(rng() * pool.length)] as Move)
      w.flush()
    }
    const before = sessions[0].cfg.startingSeat
    const guest = sessions.find((s) => !s.isHost)!
    guest.requestRematch()
    w.second(2)
    for (const s of sessions) {
      expect(s.state.result).toBe(null)
      expect(s.playing).toBe(true)
    }
    expect(sessions[0].cfg.startingSeat).toBe((before + 1) % 2)
    expect(publicHash(guest.state)).toBe(publicHash(sessions[0].state))
  })
})
