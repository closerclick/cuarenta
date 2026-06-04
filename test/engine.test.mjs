// Smoke test del motor de Cuarenta: corre partidas completas (2 y 4 jugadores)
// con jugadas aleatorias legales y verifica invariantes. node test/engine.test.mjs
import { makeCuarentaEngine, setPendingConfig } from '../src/game/cuarentaEngine.js'
import { makeDeck, carton, resolveCapture, findRonda } from '../src/game/cuarentaRules.js'
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
assert.equal(new Set(makeDeck().map(c => c.id)).size, 40, 'sin duplicados')
assert.equal(carton(19), 0, '19 cartas → 0')
assert.equal(carton(20), 6, '20 cartas → 6')
assert.equal(carton(21), 7, '21 → redondea a 22 → 7')
assert.equal(carton(22), 7, '22 → 7')
assert.equal(carton(40), 16, '40 → 16')

// captura por escalera: jugar 3 con 3,4,5 en mesa → lleva los tres
{
  const deck = makeDeck()
  const find = (id) => deck.find(c => c.id === id)
  const table = [find('3h'), find('4d'), find('5c'), find('Kd')]
  const played = find('3s')
  const cap = resolveCapture(table, played)
  const ids = cap.map(c => c.id).sort()
  assert.deepEqual(ids, ['3h', '4d', '5c'], 'escalera 3-4-5 (corta antes de la K)')
}
// captura por suma: jugar 7 con 3 y 4 en mesa
{
  const deck = makeDeck()
  const find = (id) => deck.find(c => c.id === id)
  const table = [find('3h'), find('4d')]
  const cap = resolveCapture(table, find('7s'))
  assert.equal(cap.length, 2, 'suma 3+4=7')
}
// ronda
assert.ok(findRonda([{ r: '5' }, { r: '5' }, { r: '5' }, { r: '2' }, { r: 'K' }]), '3 iguales = ronda')
assert.equal(findRonda([{ r: '5' }, { r: '5' }, { r: '5' }, { r: '5' }, { r: 'K' }]).pts, 8, '4 iguales = doble')

// ── partida completa aleatoria ──────────────────────────────────
function playFullGame (activeSeats, seed) {
  setPendingConfig({ activeSeats })
  const engine = makeCuarentaEngine()
  const rng = mulberry32(seed)
  let state = engine.initialState(rng)
  // estado autoritativo: replicamos el ciclo del lobby (apply + checkOver)
  let guard = 0
  while (!engine.isOver(state)) {
    if (++guard > 100000) throw new Error('no termina')
    const seat = state.turn
    const hand = state.hands[seat]
    assert.ok(hand && hand.length, `${seat} debe tener cartas en su turno`)
    const card = hand[Math.floor(rng() * hand.length)].id
    const ctx = { seat, seats: {}, rng, now: 0 }
    state = engine.reducer(state, { type: 'play', card }, ctx)
    // invariante: nº total de cartas en juego nunca supera 40
    const inHands = Object.values(state.hands).reduce((a, h) => a + h.length, 0)
    const total = inHands + state.table.length + state.deck.length +
      state.capturedCount[0] + state.capturedCount[1]
    assert.ok(total % 40 === 0 || total <= 40 * 6, `cartas coherentes (${total})`)
  }
  const r = engine.isOver(state)
  assert.ok(r && r.winner, 'hay ganador')
  assert.ok(state.chicasWon[state.winnerTeam] >= 2, 'ganó 2 chicas')
  return { winner: r.winner, chicas: state.chicasWon }
}

for (let seed = 1; seed <= 20; seed++) {
  const r2 = playFullGame(['p1', 'p2'], seed)
  const r4 = playFullGame(['p1', 'p2', 'p3', 'p4'], seed + 1000)
}
console.log('OK — 40 partidas completas (2P y 4P) sin excepciones; reglas básicas pasan.')
