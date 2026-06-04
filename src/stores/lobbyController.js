// lobbyController — fuente única de verdad del Cuarenta sobre
// @closerclick/closer-click-lobby. Patrón calcado del ajedrez
// (simple-websocket-chess): una sola conexión al proxy identificada por el vault,
// salas/asientos/espectadores/sync/reputación los maneja el paquete; acá sólo se
// orquesta el estado reactivo de Vue y las acciones del juego.
//
// Cuarenta admite 2 ó 4 jugadores. Se declaran 4 asientos (p1..p4) y el arranque
// es MANUAL: el host pulsa «Empezar» cuando hay 2 ó 4 sentados y listos; en ese
// momento se fija la config del motor (setPendingConfig) según los asientos
// ocupados (en 4: equipos {p1,p3} vs {p2,p4}).

import { ref, shallowRef, computed } from 'vue'
import { createLobby, STATUS } from '@closerclick/closer-click-lobby'
import { getWebSocketProxyClient } from '@closerclick/closer-click-proxy-client'
import { Identity } from '@closerclick/closer-click-identity'
import { createVaultReputation } from '@closerclick/closer-click-reputation'
import { makeCuarentaEngine, setPendingConfig } from '@/game/cuarentaEngine'

const GAME_ID = 'cuarenta'
const SEATS = ['p1', 'p2', 'p3', 'p4']

const engine = makeCuarentaEngine()

// ── estado reactivo (singleton de módulo) ──────────────────────────
let lobby = null
let identity = null
let reputation = null

const room = shallowRef(null)
const snapshot = ref(null)
const connected = ref(false)
const mode = ref(null) // null | 'host' | 'guest'
const visibility = ref(null)
const roomId = ref(null)
const myToken = ref(null)
const publicRooms = ref([])
const myPubkey = ref(null)
const myNickname = ref(localStorage.getItem('cuarenta_nickname') || '')
const peerIdentities = ref(new Map())
const trustMap = ref(new Map())
const connectionError = ref(null)

const nickModalOpen = ref(false)
let pendingNickAction = null

const myElo = ref(null)
const _eloCache = new Map()
const ELO_TTL = 60000

export { STATUS }

// ── identidad ──────────────────────────────────────────────────────
async function ensureIdentity () {
  if (identity) return identity
  try { identity = await Identity.connect() } catch (_) { identity = null }
  if (identity) {
    try { reputation = createVaultReputation(identity) } catch (_) { reputation = null }
  }
  return identity
}

async function refreshIdentity () {
  await ensureIdentity()
  if (!identity) return
  myPubkey.value = identity.me?.publickey || null
  if (identity.me?.nickname) myNickname.value = identity.me.nickname
  try {
    const all = await identity.listPeers()
    const next = new Map()
    for (const p of all) {
      const r = p?.myRating?.rating
      if (typeof r === 'number' && r > 0) next.set(p.publickey, r)
    }
    trustMap.value = next
  } catch (_) {}
}

async function refreshPeers () {
  const s = snapshot.value
  if (!s) return
  const pubkeys = new Set()
  for (const id of SEATS) { const seat = s.seats?.[id]; if (seat?.pubkey) pubkeys.add(seat.pubkey) }
  for (const sp of (s.spectators || [])) if (sp.pubkey) pubkeys.add(sp.pubkey)
  pubkeys.delete(myPubkey.value)
  const next = new Map()
  for (const pk of pubkeys) {
    const nameSeat = SEATS.map(id => s.seats?.[id]).find(seat => seat?.pubkey === pk)
    const nameSpec = (s.spectators || []).find(sp => sp.pubkey === pk)
    let peer = null
    if (identity) { try { peer = await identity.getPeer(pk) } catch (_) {} }
    next.set(pk, { pubkey: pk, peer, announcedNickname: (nameSeat || nameSpec)?.name || null })
  }
  peerIdentities.value = next
}

// ── ELO (registro de reputación compartido) ────────────────────────
async function eloOf (pubkey) {
  if (!pubkey || !reputation || typeof reputation.eloOf !== 'function') return null
  const hit = _eloCache.get(pubkey)
  if (hit && (Date.now() - hit.ts) < ELO_TTL) return hit.v
  let v = null
  try { v = await reputation.eloOf(pubkey, GAME_ID) } catch (_) { v = null }
  if (v) _eloCache.set(pubkey, { v, ts: Date.now() })
  return v
}
async function loadMyElo () {
  if (!myPubkey.value) return
  _eloCache.delete(myPubkey.value)
  myElo.value = await eloOf(myPubkey.value)
}
function samePubkeyStr (a, b) {
  if (!a || !b) return false
  if (a === b) return true
  try { const pa = JSON.parse(a), pb = JSON.parse(b); return pa.x === pb.x && pa.y === pb.y && pa.crv === pb.crv } catch (_) { return false }
}
async function onResult (ev) {
  if (!reputation || typeof reputation.reportResult !== 'function' || !ev?.coSigned) return
  try {
    const res = await reputation.reportResult(ev.coSigned)
    const meIsA = samePubkeyStr(ev.a, myPubkey.value)
    const raw = meIsA ? res.a : res.b
    if (raw) { const mine = { elo: raw.value, games: raw.count }; myElo.value = mine; _eloCache.set(myPubkey.value, { v: mine, ts: Date.now() }) }
    _eloCache.delete(meIsA ? ev.b : ev.a)
  } catch (_) {}
}

// ── conexión / lobby ───────────────────────────────────────────────
// El nº de asientos es de la SALA, pero el paquete lo fija a nivel de lobby
// (roomId == token del host, un lobby = una sala a la vez). Por eso el lobby se
// (re)crea con los asientos del tamaño elegido (2 ó 4) al hostear; el guest los
// adopta del estado que difunde el host, así que su tamaño local da igual.
let lobbySeatsKey = null

function seatsForSize (size) {
  return size === 2 ? ['p1', 'p2'] : ['p1', 'p2', 'p3', 'p4']
}

async function ensureLobby (seatsArr) {
  await ensureIdentity()
  const key = seatsArr.join(',')
  if (lobby && lobbySeatsKey === key) { connected.value = true; return true }
  if (lobby) { try { await lobby.destroy() } catch (_) {} lobby = null }
  try {
    lobby = await createLobby({
      gameId: GAME_ID,
      seats: seatsArr,
      engine,
      proxy: getWebSocketProxyClient(),
      identity,
      reputation,
      start: 'manual', // el host arranca cuando la mesa está completa (2 ó 4) y todos listos
      onSeatVacated: 'pause',
      allowSpectators: true,
      matchmaking: { preferContacts: true }
    })
  } catch (e) {
    connectionError.value = e?.message || 'Error de conexión'
    return false
  }
  lobbySeatsKey = key
  myToken.value = lobby.transport?.token || null
  myPubkey.value = identity?.me?.publickey || myPubkey.value
  connected.value = true
  connectionError.value = null
  lobby.on('rooms-changed', () => { listPublicHosts() })
  await refreshIdentity()
  loadMyElo()
  return true
}

// Para navegar/listar/unir basta con un lobby cualquiera (4 asientos por defecto).
async function connect () { return ensureLobby(seatsForSize(4)) }

function _bind (r) {
  room.value = r
  roomId.value = r.roomId
  const refresh = () => { snapshot.value = { ...r.state }; refreshPeers() }
  r.on('update', refresh)
  r.on('state', refresh)
  r.on('ended', refresh)
  r.on('started', refresh)
  r.on('result', onResult)
  r.on('closed', () => { connectionError.value = 'La sala se cerró'; refresh() })
  refresh()
  return r
}

async function createTable (vis = 'public', size = 2) {
  // (Re)crea el lobby con los asientos del tamaño de mesa elegido (2 ó 4).
  if (!await ensureLobby(seatsForSize(size === 4 ? 4 : 2))) return false
  mode.value = 'host'
  visibility.value = vis
  roomId.value = lobby?.transport?.token || null
  myToken.value = roomId.value
  try {
    const r = await lobby.createRoom({ playerName: myNickname.value })
    _bind(r)
    return true
  } catch (e) { connectionError.value = e?.message; return false }
}

async function joinTable (hostToken) {
  if (!hostToken) return false
  if (!lobby) { if (!await connect()) return false }
  mode.value = 'guest'
  visibility.value = null
  try {
    const r = await lobby.joinRoom(hostToken, { playerName: myNickname.value })
    _bind(r)
    return true
  } catch (e) {
    connectionError.value = e?.message || 'No se pudo unir'
    return false
  }
}

async function leaveTable () {
  const r = room.value
  if (r) { try { await r.leave() } catch (_) {} }
  room.value = null
  snapshot.value = null
  mode.value = null
  visibility.value = null
  roomId.value = null
  return true
}

async function listPublicHosts () {
  if (!lobby) return []
  try {
    const rooms = await lobby.listRooms({ timeout: 900 })
    await Promise.all(rooms.map(async (r) => { if (r.hostPubkey) { const e = await eloOf(r.hostPubkey); if (e) r.hostElo = e.elo } }))
    publicRooms.value = rooms
    return rooms
  } catch (_) { return publicRooms.value }
}

// ── asientos / arranque ────────────────────────────────────────────
function takeSeat (id) { room.value?.takeSeat(id); return true }
function leaveSeat () { room.value?.leaveSeat(); return true }
function setReady (b) { room.value?.setReady(b); return true }
function spectate () { room.value?.spectate(); return true }

// Host: arranca con 2 ó 4 asientos ocupados+listos. Fija la config del motor
// (asientos activos en orden p1..p4) justo antes de start().
function startGame () {
  const r = room.value
  if (!r || mode.value !== 'host') return false
  const s = snapshot.value
  const ids = Object.keys(s?.seats || {})
  const active = ids.filter(id => s?.seats?.[id]?.occupied)
  if (active.length !== 2 && active.length !== 4) return false
  setPendingConfig({ activeSeats: active })
  return r.start()
}

function playCard (cardId) {
  const r = room.value
  if (!r) return false
  r.action({ type: 'play', card: cardId })
  return true
}
function resign () { room.value?.action({ type: 'resign' }); return true }

// ── nickname requerido ─────────────────────────────────────────────
const hasNick = computed(() => !!(myNickname.value && myNickname.value.trim().length >= 2))
function requireNick (fn) {
  if (hasNick.value) { if (fn) fn(); return }
  pendingNickAction = typeof fn === 'function' ? fn : null
  nickModalOpen.value = true
}
async function submitNick (v) {
  const name = (v || '').trim()
  if (name.length < 2) return false
  await setMyNickname(name)
  nickModalOpen.value = false
  const a = pendingNickAction; pendingNickAction = null
  if (a) { try { await a() } catch (_) {} }
  return true
}
function cancelNick () { nickModalOpen.value = false; pendingNickAction = null }

// ── identidad / reputación (UI de perfil/rating) ───────────────────
async function setMyNickname (nick) {
  const v = (nick || '').trim().slice(0, 20)
  myNickname.value = v
  localStorage.setItem('cuarenta_nickname', v)
  await ensureIdentity()
  if (identity) { try { await identity.setMyNickname(v) } catch (_) {} }
}
async function ratePeer (pubkey, rating, notes) {
  await ensureIdentity()
  if (!identity) throw new Error('Identity vault not available')
  const updated = await identity.setRating(pubkey, rating, notes)
  try { await identity.addContact({ publickey: pubkey }) } catch (_) {}
  if (reputation) { try { await reputation.rate(pubkey, { confianza: rating }, { notes }) } catch (_) {} }
  await refreshIdentity(); await refreshPeers()
  return updated
}
async function setPeerNickname (pubkey, nick) {
  await ensureIdentity()
  if (!identity) throw new Error('Identity vault not available')
  const updated = await identity.setNickname(pubkey, nick)
  await refreshPeers()
  return updated
}
function getReputation () { return reputation }

// ── derivados de estado ────────────────────────────────────────────
const game = computed(() => snapshot.value?.game || null)
const status = computed(() => snapshot.value?.status || (room.value ? STATUS.WAITING : null))
const result = computed(() => snapshot.value?.result || null)
const seats = computed(() => snapshot.value?.seats || {})
// Ids de asiento REALES de la sala (2 ó 4 según el tamaño con que se creó).
const seatIds = computed(() => Object.keys(seats.value || {}))
const tableSize = computed(() => seatIds.value.length)
const spectators = computed(() => snapshot.value?.spectators || [])
const mySeat = computed(() => {
  const s = snapshot.value
  if (!s) return null
  if (s.mySeatId) return s.mySeatId
  if (room.value?.mySeat) return room.value.mySeat
  if (myPubkey.value && s.seats) {
    for (const id of seatIds.value) if (s.seats[id]?.pubkey === myPubkey.value) return id
  }
  return null
})
const isHost = computed(() => mode.value === 'host')
const isGuest = computed(() => mode.value === 'guest')
const inRoom = computed(() => !!room.value)
const isMyTurn = computed(() => !!mySeat.value && game.value?.turn === mySeat.value && status.value === STATUS.PLAYING)
const occupiedCount = computed(() => seatIds.value.filter(id => seats.value?.[id]?.occupied).length)
const allReady = computed(() => {
  const occ = seatIds.value.map(id => seats.value?.[id]).filter(x => x?.occupied)
  return occ.length > 0 && occ.every(x => x.ready)
})
// La mesa arranca cuando está COMPLETA (todos los asientos de la sala ocupados).
// Sentarse ya cuenta como estar listo: no hay paso de "listo".
const canStart = computed(() => isHost.value && status.value === STATUS.WAITING &&
  (tableSize.value === 2 || tableSize.value === 4) &&
  occupiedCount.value === tableSize.value)

export const lobbyController = {
  SEATS, STATUS,
  // conexión / rol
  connect, createTable, joinTable, leaveTable, listPublicHosts,
  isHost, isGuest, inRoom, mode, visibility, roomId, myToken, publicRooms,
  connectionError, room, snapshot,
  // identidad / reputación
  myPubkey, myNickname, peerIdentities, trustMap, refreshIdentity,
  setMyNickname, ratePeer, setPeerNickname, getReputation, myElo, eloOf,
  // nickname requerido
  hasNick, nickModalOpen, requireNick, submitNick, cancelNick,
  // asientos / juego
  takeSeat, leaveSeat, setReady, spectate, startGame, playCard, resign,
  game, status, result, seats, seatIds, tableSize, spectators, mySeat, isMyTurn,
  occupiedCount, allReady, canStart
}
