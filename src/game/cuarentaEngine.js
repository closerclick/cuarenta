// Motor de turnos autoritativo del Cuarenta para @closerclick/closer-click-lobby.
//
// Aporta funciones puras { initialState, reducer, view, isOver }. El lobby maneja
// asientos, presencia, sync y broadcast; acá SÓLO viven las reglas (ver
// cuarentaRules.js). El motor sólo se instancia en el host; los guests reflejan la
// `view` que reciben (su mano; nunca la del rival).
//
// Modo 2 ó 4 jugadores: el host fija `setPendingConfig({ activeSeats })` justo
// antes de arrancar (room.start()); initialState lo lee y lo embebe en el estado
// (equipos, orden). En 4 jugadores los equipos alternan asiento: {p1,p3} vs
// {p2,p4}. En 2, cada quien es su propio equipo.

import {
  makeDeck, shuffle, resolveCapture, carton, findRonda, TARGET, NO_CARTON_FROM
} from './cuarentaRules.js'

// Config que el host deja lista antes de arrancar (host-only, mismo contexto JS).
let _pendingConfig = null
export function setPendingConfig (cfg) { _pendingConfig = cfg }

const clone = (x) => JSON.parse(JSON.stringify(x))

function buildTeams (activeSeats) {
  const n = activeSeats.length
  const teams = n === 2
    ? [[activeSeats[0]], [activeSeats[1]]]
    : [[activeSeats[0], activeSeats[2]], [activeSeats[1], activeSeats[3]]]
  const teamOf = {}
  teams.forEach((arr, i) => arr.forEach(id => { teamOf[id] = i }))
  return { teams, teamOf }
}

// Reparte 5 cartas a cada asiento activo y aplica ronda. Si setTurn, fija el turno
// al jugador a la derecha de la data (repartidor).
function dealRound (s, rng, setTurn) {
  for (const id of s.activeSeats) {
    // Cada reparto entrega una mano nueva de 5 (las manos siempre se reparten
    // vacías: o por reparto de vuelta, o al rebarajar/empezar chica, donde las
    // sobras se descartan). Asignar, no concatenar.
    const give = s.deck.splice(0, 5)
    s.hands[id] = give
    const ron = findRonda(s.hands[id])
    if (ron && s.scores[s.teamOf[id]] < TARGET) {
      s.scores[s.teamOf[id]] += ron.pts
      s.lastEvents.push({ type: ron.type, seat: id, pts: ron.pts })
    }
  }
  s.lastPlay = null
  if (setTurn) {
    const n = s.activeSeats.length
    s.turn = s.activeSeats[(s.dealerIdx + 1) % n]
  }
}

function reshuffleAndDeal (s, rng) {
  s.deck = shuffle(makeDeck(), rng)
  s.dealerIdx = (s.dealerIdx + 1) % s.activeSeats.length
  s.capturedCount = [0, 0]
  s.table = []
  s.lastPlay = null
  s.lastCapturer = null
  dealRound(s, rng, true)
}

function endChica (s, team, rng) {
  s.chicasWon[team]++
  s.lastEvents.push({ type: 'chica', team })
  if (s.chicasWon[team] >= 2) {
    s.finished = true
    s.winnerTeam = team
    s.endReason = 'match'
    return
  }
  s.scores = [0, 0]
  reshuffleAndDeal(s, rng)
}

// Tras agotarse las manos: o se reparte otra vuelta, o (baraja vacía) se cuenta el
// cartón, se cierra la "data" y se sigue/termina la chica.
function refill (s, rng) {
  const allEmpty = s.activeSeats.every(id => s.hands[id].length === 0)
  if (!allEmpty) return

  const need = 5 * s.activeSeats.length
  if (s.deck.length >= need) { dealRound(s, rng, false); return }

  // Baraja agotada → fin de la data.
  if (s.table.length && s.lastCapturer != null) {
    s.capturedCount[s.teamOf[s.lastCapturer]] += s.table.length
    s.lastEvents.push({ type: 'sweep', seat: s.lastCapturer, n: s.table.length })
    s.table = []
  }
  for (const team of [0, 1]) {
    if (s.scores[team] < NO_CARTON_FROM) {
      const pts = carton(s.capturedCount[team])
      if (pts) {
        s.scores[team] += pts
        s.lastEvents.push({ type: 'carton', team, pts, cards: s.capturedCount[team] })
      }
    }
  }
  const w = s.scores.findIndex(x => x >= TARGET)
  if (w >= 0) { endChica(s, w, rng); return }
  reshuffleAndDeal(s, rng)
}

function nextSeat (s, seat) {
  const i = s.activeSeats.indexOf(seat)
  return s.activeSeats[(i + 1) % s.activeSeats.length]
}

function makeInitialState (rng) {
  const cfg = _pendingConfig || { activeSeats: ['p1', 'p2'] }
  const activeSeats = cfg.activeSeats.slice()
  const { teams, teamOf } = buildTeams(activeSeats)
  const s = {
    activeSeats,
    teams,
    teamOf,
    hands: Object.fromEntries(activeSeats.map(id => [id, []])),
    deck: shuffle(makeDeck(), rng),
    table: [],
    lastPlay: null,
    lastCapturer: null,
    capturedCount: [0, 0],
    scores: [0, 0],
    chicasWon: [0, 0],
    dealerIdx: 0,
    turn: null,
    lastEvents: [],
    finished: false,
    winnerTeam: null,
    endReason: null
  }
  dealRound(s, rng, true)
  return s
}

export function makeCuarentaEngine () {
  return {
    initialState: (rng) => makeInitialState(rng),

    // ctx = { seat, seats, rng, now }. seat ∈ activeSeats.
    reducer (state, action, ctx) {
      if (!action) throw new Error('no-action')
      if (state.finished) throw new Error('game-finished')

      if (action.type === 'resign') {
        const team = state.teamOf[ctx.seat]
        if (team == null) throw new Error('not-a-player')
        const s = clone(state)
        s.finished = true
        s.winnerTeam = team === 0 ? 1 : 0
        s.endReason = 'resign'
        s.lastEvents = [{ type: 'resign', seat: ctx.seat }]
        return s
      }

      if (action.type !== 'play') throw new Error('unknown-action')
      if (ctx.seat !== state.turn) throw new Error('not-your-turn')
      const hand = state.hands[ctx.seat]
      if (!hand) throw new Error('not-a-player')
      const idx = hand.findIndex(c => c.id === action.card)
      if (idx < 0) throw new Error('card-not-in-hand')

      const s = clone(state)
      s.lastEvents = []
      const played = s.hands[ctx.seat].splice(idx, 1)[0]
      const prevLast = state.lastPlay
      const team = s.teamOf[ctx.seat]

      const captured = resolveCapture(s.table, played)
      if (captured.length) {
        const capIds = new Set(captured.map(c => c.id))
        s.table = s.table.filter(c => !capIds.has(c.id))
        const caida = !!(prevLast && prevLast.card.r === played.r && capIds.has(prevLast.card.id))
        let pts = 0
        if (caida) { pts += 2 }
        s.capturedCount[team] += captured.length + 1 // capturadas + la jugada
        s.lastCapturer = ctx.seat
        const limpia = s.table.length === 0
        if (limpia) { pts += 2 }
        if (pts && s.scores[team] < TARGET) s.scores[team] += pts
        s.lastEvents.push({
          type: caida && limpia ? 'caidaLimpia' : caida ? 'caida' : limpia ? 'limpia' : 'levante',
          seat: ctx.seat, pts, n: captured.length + 1
        })
        s.lastPlay = null // la mesa no deja carta «cazable» encima
      } else {
        s.table.push(played)
        s.lastPlay = { seat: ctx.seat, card: played }
      }

      // ¿Los puntos de lance/ronda ya cerraron la chica?
      const wNow = s.scores.findIndex(x => x >= TARGET)
      if (wNow >= 0) { endChica(s, wNow, ctx.rng); return s }

      // Turno + reparto/cartón.
      s.turn = nextSeat(s, ctx.seat)
      refill(s, ctx.rng)
      return s
    },

    // Proyección por asiento: cada quien ve SU mano; del resto, sólo cuántas cartas.
    view (state, seat) {
      const pub = {
        numPlayers: state.activeSeats.length,
        activeSeats: state.activeSeats,
        teams: state.teams,
        teamOf: state.teamOf,
        table: state.table,
        lastPlay: state.lastPlay,
        turn: state.turn,
        dealer: state.activeSeats[state.dealerIdx],
        deckCount: state.deck.length,
        capturedCount: state.capturedCount,
        scores: state.scores,
        chicasWon: state.chicasWon,
        handCounts: Object.fromEntries(state.activeSeats.map(id => [id, state.hands[id].length])),
        lastEvents: state.lastEvents,
        finished: state.finished,
        winnerTeam: state.winnerTeam,
        endReason: state.endReason
      }
      pub.mySeat = seat || null
      pub.myTeam = (seat != null && state.teamOf[seat] != null) ? state.teamOf[seat] : null
      pub.myHand = (seat && state.hands[seat]) ? state.hands[seat] : []
      return pub
    },

    isOver (state) {
      if (!state.finished) return null
      const seats = state.teams[state.winnerTeam] || []
      return { winner: seats.join('+'), reason: state.endReason || 'match' }
    }
  }
}
