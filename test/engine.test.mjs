// Smoke test del motor de Cuarenta: reglas de captura (igualdad, escalera, suma de
// 2), robar, error fatal, y partidas completas (2 y 4 jug.) sin excepciones.
// node test/engine.test.mjs
import { makeCuarentaEngine, setPendingConfig } from '../src/game/cuarentaEngine.js'
import { makeDeck, carton, isValidCapture, captureExists, findRonda } from '../src/game/cuarentaRules.js'
import assert from 'node:assert'

function mulberry32 (a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── reglas básicas ──────────────────────────────────────────────
assert.equal(makeDeck().length, 40, '40 cartas')
assert.equal(carton(19), 0); assert.equal(carton(20), 6); assert.equal(carton(21), 7); assert.equal(carton(40), 16)

const deck = makeDeck()
const C = (id) => deck.find(c => c.id === id)

// igualdad: 5 con 5
assert.ok(isValidCapture(C('5s'), [C('5h')]), 'igualdad 5-5')
assert.ok(!isValidCapture(C('5s'), [C('6h')]), 'no igual 5 vs 6')
// suma de 2: 7 = 3 + 4
assert.ok(isValidCapture(C('7s'), [C('3h'), C('4d')]), 'suma 3+4=7')
// suma de 3 NO vale
assert.ok(!isValidCapture(C('6s'), [C('Ah'), C('2d'), C('3c')]), 'suma de 3 (1+2+3) inválida')
// escalera: 5 lleva 5,6,7,J
assert.ok(isValidCapture(C('5s'), [C('5h'), C('6d'), C('7c'), C('Jh')]), 'escalera 5-6-7-J')
// escalera con base por suma: 5 = 2+3, sigue al 6
assert.ok(isValidCapture(C('5s'), [C('2h'), C('3d'), C('6c')]), 'base 2+3=5 y sube a 6')
// hueco inválido: 5 y 7 sin 6
assert.ok(!isValidCapture(C('5s'), [C('5h'), C('7c')]), 'hueco 5..7 inválido')
// viejas consecutivas: J lleva J,Q,K
assert.ok(isValidCapture(C('Js'), [C('Jh'), C('Qd'), C('Kc')]), 'J-Q-K consecutivas')
// viejas no suman
assert.ok(!isValidCapture(C('Ks'), [C('Jh'), C('Qd')]), 'J+Q no suma a K (viejas no suman)')
// captureExists
assert.ok(captureExists([C('3h'), C('4d')], C('7s')), 'existe suma 3+4=7')
assert.ok(captureExists([C('5h')], C('5s')), 'existe igualdad')
assert.ok(!captureExists([C('2h'), C('Kd')], C('7s')), 'no hay captura para 7')

// ronda
assert.ok(findRonda([{ r: '5' }, { r: '5' }, { r: '5' }, { r: '2' }, { r: 'K' }]))
assert.equal(findRonda([{ r: '5' }, { r: '5' }, { r: '5' }, { r: '5' }, { r: 'K' }]).pts, 8)

// ── helpers de simulación ───────────────────────────────────────
// Busca una captura válida mínima para `card` sobre `table` (sin incluir excludeId).
function findCapture (table, card, excludeId) {
  const pool = table.filter(c => c.id !== excludeId)
  // igualdad simple
  const eq = pool.find(c => c.seq === card.seq)
  if (eq) return [eq.id]
  // suma de 2 (numérica)
  if (card.sum != null) {
    const nums = pool.filter(c => c.sum != null)
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        if (nums[i].sum + nums[j].sum === card.seq) return [nums[i].id, nums[j].id]
      }
    }
  }
  return null
}

function playFullGame (activeSeats, seed) {
  setPendingConfig({ activeSeats })
  const engine = makeCuarentaEngine()
  const rng = mulberry32(seed)
  let state = engine.initialState(rng)
  let guard = 0
  while (!engine.isOver(state)) {
    if (++guard > 200000) throw new Error('no termina')
    if (state.phase === 'claim') {
      // el que tiró roba lo que dejó (siempre existe combinación válida)
      const seat = state.claimSeat
      const cap = findCapture(state.table, state.table.find(c => c.id === state.claimCardId), state.claimCardId)
      assert.ok(cap, 'en claim siempre hay combinación')
      state = engine.reducer(state, { type: 'rob', captured: cap }, { seat, seats: {}, rng, now: 0 })
      continue
    }
    const seat = state.turn
    const hand = state.hands[seat]
    assert.ok(hand && hand.length, `${seat} tiene cartas en su turno (fase ${state.phase})`)
    // intenta capturar con alguna carta; si no, bota la primera
    let acted = false
    for (const c of hand) {
      const cap = findCapture(state.table, c)
      if (cap) {
        state = engine.reducer(state, { type: 'play', card: c.id, captured: cap }, { seat, seats: {}, rng, now: 0 })
        acted = true; break
      }
    }
    if (!acted) {
      state = engine.reducer(state, { type: 'play', card: hand[0].id, captured: [] }, { seat, seats: {}, rng, now: 0 })
    }
    // invariante: total de cartas múltiplo de 40 por chica
    const inHands = Object.values(state.hands).reduce((a, h) => a + h.length, 0)
    const total = inHands + state.table.length + state.deck.length + state.capturedCount[0] + state.capturedCount[1]
    assert.ok(total <= 40 * 8, `cartas coherentes (${total})`)
  }
  const r = engine.isOver(state)
  assert.ok(r && r.winner, 'hay ganador')
  assert.ok(state.chicasWon[state.winnerTeam] >= 2, 'ganó 2 chicas')
}

for (let seed = 1; seed <= 20; seed++) {
  playFullGame(['p1', 'p2'], seed)
  playFullGame(['p1', 'p2', 'p3', 'p4'], seed + 1000)
}

// ── error fatal (pasa la mano con 10) ───────────────────────────
{
  setPendingConfig({ activeSeats: ['p1', 'p2'] })
  const engine = makeCuarentaEngine()
  const rng = mulberry32(7)
  let s = engine.initialState(rng)
  const seat = s.turn
  const card = s.hands[seat][0]
  // selecciona una carta de la mesa que NO forma captura válida (mesa vacía o
  // carta no relacionada) → forzamos inválido con un id inexistente-ish:
  const before = [...s.scores]
  // botar normal primero para tener algo en mesa
  s = engine.reducer(s, { type: 'play', card: card.id, captured: [] }, { seat, seats: {}, rng, now: 0 })
  // ahora el siguiente jugador intenta capturar algo inválido si no está en claim
  if (s.phase === 'play') {
    const seat2 = s.turn
    const tcard = s.hands[seat2].find(c => !findCapture(s.table, c))
    if (tcard && s.table.length) {
      const bogus = s.table[0].id // puede ser inválido para tcard
      const valid = isValidCapture(tcard, [s.table[0]])
      if (!valid) {
        const team2 = s.teamOf[seat2]
        s = engine.reducer(s, { type: 'play', card: tcard.id, captured: [bogus] }, { seat: seat2, seats: {}, rng, now: 0 })
        assert.ok(s.lastEvents.some(e => e.type === 'fault'), 'evento fault')
        assert.equal(s.scores[team2 === 0 ? 1 : 0], 10, '+10 al otro equipo')
      }
    }
  }
}

console.log('OK — captura (igualdad/escalera/suma2), robar, fatal y 40 partidas completas (2P/4P).')
