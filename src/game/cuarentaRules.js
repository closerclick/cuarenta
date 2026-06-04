// Reglas puras del Cuarenta (40) — juego de naipes tradicional ecuatoriano.
//
// Sin dependencias del ecosistema: funciones puras y testeables en node. El motor
// autoritativo del lobby (cuarentaEngine.js) las consume. Fuente de las reglas:
// Wikipedia «40 (juego de naipes)» contrastada con 40caidaylimpia.com, El Universo
// y Saga Tevé. Valores de puntos según la tabla de Wikipedia (la fuente citada).
//
// Baraja: 40 cartas = baraja francesa SIN 8, 9, 10 ni comodines. Rangos por palo:
//   A(1) 2 3 4 5 6 7  J Q K   →  4 palos × 10 = 40 cartas.
// El orden de ESCALERA es consecutivo saltando los perros: …5 6 7 J Q K (la J
// sigue al 7). Por eso cada carta lleva `seq` (posición de escalera 1..10) y `sum`
// (valor aditivo para capturar por suma; sólo las numéricas 1..7 suman).

export const SUITS = ['d', 'h', 's', 'c'] // diamante, corazón, espada (pica), trébol
export const SUIT_SYMBOL = { d: '♦', h: '♥', s: '♠', c: '♣' }
export const SUIT_RED = { d: true, h: true, s: false, c: false }

// rango → { seq, sum }. sum=null en las figuras (no participan en capturas por suma).
export const RANKS = [
  { r: 'A', seq: 1, sum: 1 },
  { r: '2', seq: 2, sum: 2 },
  { r: '3', seq: 3, sum: 3 },
  { r: '4', seq: 4, sum: 4 },
  { r: '5', seq: 5, sum: 5 },
  { r: '6', seq: 6, sum: 6 },
  { r: '7', seq: 7, sum: 7 },
  { r: 'J', seq: 8, sum: null },
  { r: 'Q', seq: 9, sum: null },
  { r: 'K', seq: 10, sum: null }
]

/** Baraja de 40 cartas, ordenada (sin barajar). Cada carta: { id, r, s, seq, sum }. */
export function makeDeck () {
  const deck = []
  for (const s of SUITS) {
    for (const { r, seq, sum } of RANKS) {
      deck.push({ id: r + s, r, s, seq, sum })
    }
  }
  return deck
}

/** Fisher–Yates con rng determinista (sembrado por el motor). No muta el original. */
export function shuffle (array, rng) {
  const a = array.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor((rng ? rng() : Math.random()) * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Resuelve qué cartas de la mesa captura `played` (el "levante"). Tres formas:
 *  1) Igualdad + escalera: si hay en la mesa una carta del MISMO rango, se lleva
 *     todas las iguales y luego sube en escalera consecutiva (seq+1, seq+2…)
 *     mientras existan (ej.: tiras 3 y te llevas 3,4,5,6,7,J si están).
 *  2) Por suma: si `played` es numérica (sum≠null), captura el subconjunto de
 *     cartas numéricas de la mesa que sumen su valor (ej.: tiras 7, comes 3+4).
 *     Se elige el subconjunto de MAYOR cantidad de cartas (más cartón).
 * Devuelve el array de cartas capturadas (referencias del array `table`), o [].
 */
export function resolveCapture (table, played) {
  // 1) igualdad + escalera
  const byEqual = table.filter(c => c.r === played.r)
  if (byEqual.length) {
    const captured = byEqual.slice()
    let v = played.seq + 1
    while (true) {
      const next = table.filter(c => c.seq === v && !captured.includes(c))
      if (!next.length) break
      captured.push(...next)
      v++
    }
    return captured
  }
  // 2) por suma (sólo numéricas)
  if (played.sum != null) {
    const nums = table.filter(c => c.sum != null)
    const subset = largestSubsetSum(nums, played.sum)
    if (subset && subset.length) return subset
  }
  return []
}

/** Subconjunto de mayor cardinalidad cuyas `sum` totalicen `target`. Backtracking
 *  (la mesa nunca tiene muchas cartas numéricas). Devuelve null si no hay. */
export function largestSubsetSum (cards, target) {
  let best = null
  const choose = (i, acc, sum) => {
    if (sum === target && acc.length) {
      if (!best || acc.length > best.length) best = acc.slice()
      // no return: podría haber otro subconjunto más grande
    }
    if (sum >= target || i >= cards.length) return
    for (let k = i; k < cards.length; k++) {
      acc.push(cards[k])
      choose(k + 1, acc, sum + cards[k].sum)
      acc.pop()
    }
  }
  choose(0, [], 0)
  return best
}

/**
 * Conteo del "cartón" al agotarse la baraja: puntos por cartas capturadas.
 * Regla popular: 20 cartas = 6 puntos, y de ahí +1 por cada 2 cartas; si el conteo
 * es impar se redondea hacia arriba (par). Menos de 20 cartas no da cartón.
 *   evenCount = redondeo par;  puntos = evenCount/2 - 4  (mín 0, sólo si ≥ 20).
 * (Función única y comentada: es el punto más variable entre fuentes; fácil de
 *  afinar luego sin tocar el resto del motor.)
 */
export function carton (cardCount) {
  if (cardCount < 20) return 0 // «del 20 en adelante»
  const even = cardCount % 2 ? cardCount + 1 : cardCount
  return even / 2 - 4
}

/** ¿La mano recién repartida (5 cartas) trae ronda? 3 iguales = ronda (4 pts),
 *  4 iguales = doble ronda (8 pts). Devuelve { type, pts, r } o null. */
export function findRonda (hand) {
  const byRank = {}
  for (const c of hand) byRank[c.r] = (byRank[c.r] || 0) + 1
  let best = null
  for (const r in byRank) {
    const n = byRank[r]
    if (n >= 4) return { type: 'dobleRonda', pts: 8, r }
    if (n >= 3 && !best) best = { type: 'ronda', pts: 4, r }
  }
  return best
}

/** Puntos de las jugadas especiales (para UI / referencia). */
export const POINTS = { caida: 2, limpia: 2, caidaLimpia: 4, ronda: 4, dobleRonda: 8 }

/** Umbral de la chica y reglas de tope. */
export const TARGET = 40
export const NO_CARTON_FROM = 30 // desde 30 puntos «no sirve cartón»
