import { applyMove, createGame, legalMoves, prestige, redact } from '../engine'
import type { GameConfig, GameState, Move, Seat } from '../engine'

export type SfxEvent = 'take' | 'reserve' | 'purchase' | 'noble' | 'return' | 'win' | 'lose'

export const RULES_VERSION = '1'

export abstract class BaseSession {
  cfg: GameConfig
  state = $state<GameState>() as GameState
  events = $state<{ id: number; sfx: SfxEvent }[]>([])
  private eventId = 0

  constructor(cfg: GameConfig, initial: GameState) {
    this.cfg = cfg
    this.state = initial
  }

  abstract readonly mode: 'hotseat' | 'online'
  /** The seat this client plays; null = plays every seat (hotseat) or none (spectator). */
  abstract get mySeat(): Seat | null
  /** Whose blind reserves the UI may show right now. */
  abstract get viewer(): Seat | null

  get names(): string[] {
    return this.cfg.names
  }

  get visibleState(): GameState {
    return redact(this.state, this.viewer)
  }

  get actor(): Seat {
    return this.state.pending?.actor ?? this.state.turn
  }

  /** Can the local human act right now? */
  get myTurn(): boolean {
    return this.mySeat === null || this.actor === this.mySeat
  }

  myMoves(): Move[] {
    if (!this.myTurn || this.state.result) return []
    return legalMoves(this.state, this.actor)
  }

  protected emit(sfx: SfxEvent) {
    this.events = [...this.events.slice(-4), { id: this.eventId++, sfx }]
  }

  protected applyLocal(actor: Seat, move: Move): void {
    const before = this.state
    const after = applyMove(before, actor, move)
    this.state = after

    if (move.type === 'take') this.emit('take')
    if (move.type === 'reserve') this.emit('reserve')
    if (move.type === 'purchase') this.emit('purchase')
    if (move.type === 'return') this.emit('return')
    const nobleCount = (s: GameState) => s.players.reduce((n, p) => n + p.nobles.length, 0)
    if (nobleCount(after) > nobleCount(before)) this.emit('noble')
    if (!before.result && after.result) {
      const won = this.mySeat === null || after.result.winners.includes(this.mySeat)
      this.emit(won ? 'win' : 'lose')
    }
  }

  abstract submit(move: Move): void
  destroy(): void {}
}

/* ------------------------------------------------------------------ */

export class HotseatSession extends BaseSession {
  readonly mode = 'hotseat'

  constructor(playerCount: 2 | 3 | 4, names: string[]) {
    const cfg: GameConfig = {
      playerCount,
      sharedSeed: crypto.getRandomValues(new Uint32Array(1))[0],
      startingSeat: Math.floor(Math.random() * playerCount),
      names: names.map((n, i) => n.trim() || `Player ${i + 1}`),
      rulesVersion: RULES_VERSION,
    }
    super(cfg, createGame(cfg))
  }

  get mySeat(): null {
    return null
  }

  /** On a shared screen only the acting player's blind reserves are shown. */
  get viewer(): Seat {
    return this.actor
  }

  submit(move: Move): void {
    this.applyLocal(this.actor, move)
  }
}

/** Prestige for every seat, for scoreboards. */
export function scores(state: GameState): number[] {
  return state.players.map((p) => prestige(p))
}
