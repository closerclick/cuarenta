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
  makeDeck, shuffle, isValidCapture, captureExists, carton, findRonda,
  TARGET, NO_CARTON_FROM, FAULT_POINTS
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
  s.phase = 'play'
  s.claimSeat = null
  s.claimCardId = null
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
    // fase del turno: 'play' (alguien tira) | 'claim' (hay algo que levantar y se
    // espera que alguien lo tome/robe; el turno NO avanza)
    phase: 'play',
    claimSeat: null, // quién tiró la carta que quedó por levantar
    claimCardId: null, // id de esa carta (el "resultado")
    lastEvents: [],
    finished: false,
    winnerTeam: null,
    endReason: null
  }
  dealRound(s, rng, true)
  return s
}

// Aplica una captura al equipo `team`: saca de la mesa las cartas capturadas (y la
// carta resultado), suma al cartón, y otorga caída/limpia. `resultOnTable` indica
// si la carta resultado ya estaba en la mesa (caso robar).
function applyCapture (s, team, seat, resultCard, capturedCards, prevLast, allowCaida, resultOnTable) {
  const capIds = new Set(capturedCards.map(c => c.id))
  s.table = s.table.filter(c => !capIds.has(c.id) && !(resultOnTable && c.id === resultCard.id))
  s.capturedCount[team] += capturedCards.length + 1 // capturadas + la carta resultado
  s.lastCapturer = seat
  let pts = 0
  const caida = !!(allowCaida && prevLast && prevLast.card.r === resultCard.r && capIds.has(prevLast.card.id))
  if (caida) pts += 2
  const limpia = s.table.length === 0
  if (limpia) pts += 2
  if (pts && s.scores[team] < TARGET) s.scores[team] += pts
  s.lastEvents.push({
    type: caida && limpia ? 'caidaLimpia' : caida ? 'caida' : limpia ? 'limpia' : 'levante',
    seat, pts, n: capturedCards.length + 1
  })
  s.lastPlay = null
  s.phase = 'play'
  s.claimSeat = null
  s.claimCardId = null
}

// Error fatal ("pasa la mano con 10"): +10 al equipo contrario, se rebaraja todo y
// se reparte de nuevo; el puntaje de la chica se conserva.
function applyFault (s, faultTeam, rng) {
  const other = faultTeam === 0 ? 1 : 0
  s.scores[other] += FAULT_POINTS
  s.lastEvents = [{ type: 'fault', team: other, pts: FAULT_POINTS }]
  s.phase = 'play'
  s.claimSeat = null
  s.claimCardId = null
  s.lastPlay = null
  const w = s.scores.findIndex(x => x >= TARGET)
  if (w >= 0) { endChica(s, w, rng); return }
  reshuffleAndDeal(s, rng)
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

      // ── ROBAR: durante la ventana de claim, cualquier jugador toma la carta
      // que quedó por levantar seleccionando la combinación. Inválido = fatal.
      if (action.type === 'rob') {
        if (state.phase !== 'claim') throw new Error('not-claim-phase')
        const team = state.teamOf[ctx.seat]
        if (team == null) throw new Error('not-a-player')
        const s = clone(state)
        s.lastEvents = []
        const resultCard = s.table.find(c => c.id === state.claimCardId)
        if (!resultCard) throw new Error('no-claim-card')
        const selIds = Array.isArray(action.captured) ? action.captured : []
        const pool = s.table.filter(c => c.id !== resultCard.id)
        const selected = selIds.map(id => pool.find(c => c.id === id))
        const okSel = selected.length > 0 && selected.every(Boolean) &&
          new Set(selIds).size === selIds.length && isValidCapture(resultCard, selected)
        if (!okSel) { applyFault(s, team, ctx.rng); return s }
        applyCapture(s, team, ctx.seat, resultCard, selected, null, false, true)
        const wNow = s.scores.findIndex(x => x >= TARGET)
        if (wNow >= 0) { endChica(s, wNow, ctx.rng); return s }
        // el turno sigue desde quien tiró (claimSeat)
        s.turn = nextSeat(s, state.claimSeat)
        refill(s, ctx.rng)
        return s
      }

      if (action.type !== 'play') throw new Error('unknown-action')
      if (state.phase !== 'play') throw new Error('not-play-phase')
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
      const selIds = Array.isArray(action.captured) ? action.captured : []

      if (selIds.length) {
        // el jugador seleccionó una combinación: validar (selección manual)
        const selected = selIds.map(id => s.table.find(c => c.id === id))
        const okSel = selected.every(Boolean) && new Set(selIds).size === selIds.length &&
          isValidCapture(played, selected)
        if (!okSel) { applyFault(s, team, ctx.rng); return s } // combinación inválida = fatal
        applyCapture(s, team, ctx.seat, played, selected, prevLast, true, false)
      } else {
        // no seleccionó: ¿había algo que levantar con esa carta? (evaluar contra la
        // mesa SIN la carta tirada). Luego se bota a la mesa.
        const canClaim = captureExists(s.table, played)
        s.table.push(played)
        s.lastPlay = { seat: ctx.seat, card: played }
        if (canClaim) {
          // hay algo que levantar → ventana de robar; el turno NO avanza
          s.phase = 'claim'
          s.claimSeat = ctx.seat
          s.claimCardId = played.id
          return s
        }
      }

      // ¿Los puntos ya cerraron la chica?
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
        phase: state.phase,
        claimSeat: state.claimSeat,
        claimCardId: state.claimCardId,
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
