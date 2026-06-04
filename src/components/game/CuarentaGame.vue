<template>
  <div class="game">
    <!-- Marcador -->
    <div class="scoreboard">
      <div
        v-for="ti in [0, 1]" :key="ti"
        class="team" :class="['t' + ti, { lead: leadTeam === ti }]"
      >
        <div class="team-name">{{ teamLabel(ti) }}</div>
        <div class="team-pts" :data-testid="'score-team-' + ti">{{ teamScore(ti) }}<small>/40</small></div>
        <div class="team-sub">
          <span class="chip">{{ t.chicas }}: {{ teamChicas(ti) }}</span>
          <span class="chip" v-if="playing">{{ t.captured }}: {{ teamCards(ti) }}</span>
        </div>
      </div>
    </div>

    <!-- Mesa: fieltro central + asientos en su lado (tú siempre abajo) -->
    <div class="table-area" :class="'players-' + (visibleSeats.length || 2)">
      <!-- Fieltro central -->
      <div class="felt" data-testid="table-felt">
        <div class="deck" v-if="(game?.deckCount || 0) > 0">
          <PlayingCard face-down mini />
          <span class="deck-count">{{ game?.deckCount ?? 0 }}</span>
        </div>
        <span class="felt-label">{{ t.onTable }}</span>
        <transition-group name="lay" tag="div" class="table-cards">
          <PlayingCard
            v-for="c in (game?.table || [])" :key="c.id" :card="c"
            :class="{ last: game?.lastPlay && game.lastPlay.card.id === c.id }"
          />
        </transition-group>
        <div v-if="!(game?.table || []).length" class="table-empty">—</div>
      </div>

      <!-- Asientos alrededor de la mesa -->
      <div
        v-for="s in tableSeats" :key="s.id"
        class="seat" :class="['pos-' + s.pos, 'team' + (seatIds.indexOf(s.id) % 2), { me: s.id === mySeat, turn: playing && game?.turn === s.id, occ: seatOf(s.id)?.occupied, disc: seatOf(s.id)?.status === 'disconnected' }]"
        :data-testid="'seat-' + s.id" :data-seat-state="seatOf(s.id)?.occupied ? 'occupied' : 'open'"
      >
        <template v-if="seatOf(s.id)?.occupied">
          <div class="seat-head">
            <span class="seat-name">{{ seatOf(s.id).name || t.noName }}<span v-if="s.id === mySeat" class="you"> ({{ t.you }})</span></span>
            <button
              v-if="seatOf(s.id).pubkey && seatOf(s.id).pubkey !== myPubkey"
              class="link rate" @click="$emit('rate', seatOf(s.id))" :title="t.reputation" :aria-label="t.reputation"
            >★</button>
          </div>
          <div class="seat-cards" v-if="playing">
            <PlayingCard v-for="n in Math.min(game?.handCounts?.[s.id] || 0, 5)" :key="n" face-down mini />
          </div>
          <div class="seat-status">
            <span v-if="playing && game?.turn === s.id" class="turn-dot">●</span>
            <span v-if="!playing && seatOf(s.id).ready" class="ready-tag">✓ {{ t.ready }}</span>
            <span v-else-if="!playing" class="muted">…</span>
            <span v-if="seatOf(s.id).status === 'disconnected'" class="muted">⏸</span>
          </div>
          <div class="seat-actions" v-if="s.id === mySeat && !playing">
            <button class="sm" :class="{ success: seatOf(s.id).ready }" @click="setReady(!seatOf(s.id).ready)" :data-testid="'ready-' + s.id">
              {{ seatOf(s.id).ready ? t.notReady : t.ready }}
            </button>
            <button class="sm" @click="leaveSeat" :data-testid="'leave-seat-' + s.id">{{ t.leaveSeat }}</button>
          </div>
        </template>
        <template v-else>
          <div class="seat-empty">{{ t.emptySeat }}</div>
          <button
            v-if="!mySeat && !playing" class="sm primary" @click="takeSeat(s.id)" :data-testid="'take-' + s.id"
          >{{ t.takeSeat }}</button>
        </template>
      </div>
    </div>

    <!-- Estado / arranque -->
    <div class="banner" v-if="!playing && !finished">
      <template v-if="paused">⏸ {{ t.paused }}</template>
      <template v-else-if="occupiedCount < 2">{{ t.waitingPlayers }}</template>
      <template v-else-if="!allReady">{{ t.waitingReady }}</template>
      <template v-else-if="isHost">
        <button class="primary" :disabled="!canStart" @click="startGame" data-testid="start-game">{{ t.startGame }}</button>
        <small v-if="!canStart" class="muted">{{ t.needTwoOrFour }}</small>
      </template>
      <template v-else>{{ t.waitingHostStart }}</template>
    </div>

    <!-- Turno -->
    <div class="turn-bar" v-if="playing">
      <span v-if="isMyTurn" class="my-turn" data-testid="my-turn">▶ {{ t.yourTurn }}</span>
      <span v-else class="muted">{{ t.turnOf(seatOf(game?.turn)?.name || t.noName) }}</span>
    </div>

    <!-- Mi mano -->
    <div class="hand" v-if="game?.myHand?.length" data-testid="my-hand">
      <PlayingCard
        v-for="c in game.myHand" :key="c.id" :card="c"
        :clickable="isMyTurn" @play="onPlay"
      />
    </div>
    <div class="hand spectator-note" v-else-if="playing && !mySeat">
      {{ t.spectating }}
    </div>

    <!-- Toasts de puntos -->
    <div class="toasts" aria-live="polite">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.kind">{{ toast.text }}</div>
    </div>

    <!-- Controles -->
    <div class="controls">
      <button v-if="playing && mySeat" class="danger sm" @click="confirmResign = true" data-testid="resign">{{ t.resign }}</button>
      <button class="sm" @click="$emit('leave')" data-testid="leave-table">{{ t.leave }}</button>
    </div>

    <!-- Fin de partida -->
    <div v-if="finished" class="modal-overlay">
      <div class="result-modal">
        <h2>{{ t.winTitle }}</h2>
        <p class="result-line" :class="{ win: iWon, lose: mySeat && !iWon }">
          <template v-if="mySeat">{{ iWon ? t.youWin : t.youLose }}</template>
          <template v-else>{{ t.teamWins(teamLabel(game?.winnerTeam)) }}</template>
          <span v-if="game?.endReason === 'resign'"> ({{ t.byResign }})</span>
        </p>
        <div class="result-actions">
          <button v-if="rivalToRate" class="primary" @click="$emit('rate', rivalToRate)">{{ t.rateRivals }}</button>
          <button @click="$emit('leave')">{{ t.backToLobby }}</button>
        </div>
      </div>
    </div>

    <!-- Confirmación de abandono (sin confirm() del navegador) -->
    <div v-if="confirmResign" class="modal-overlay" @click.self="confirmResign = false">
      <div class="result-modal">
        <h3>{{ t.confirmResignTitle }}</h3>
        <p class="muted">{{ t.confirmResignBody }}</p>
        <div class="result-actions">
          <button @click="confirmResign = false">{{ t.cancel }}</button>
          <button class="danger" @click="doResign" data-testid="resign-confirm">{{ t.resign }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { t } from '@/i18n'
import { lobbyController as L } from '@/stores/lobbyController'
import PlayingCard from './PlayingCard.vue'

defineEmits(['leave', 'rate'])

const {
  STATUS, game, status, result, seats, seatIds, mySeat, myPubkey, isHost,
  isMyTurn, occupiedCount, allReady, canStart,
  takeSeat, leaveSeat, setReady, startGame, playCard, resign
} = L

const confirmResign = ref(false)
const playing = computed(() => status.value === STATUS.PLAYING)
const finished = computed(() => status.value === STATUS.ENDED || !!game.value?.finished)
const paused = computed(() => status.value === STATUS.PAUSED)

const seatOf = (id) => seats.value?.[id] || null

// En espera se muestran los 4 asientos (para sentarse); ya en juego, sólo los que
// están en juego (los activos del motor, o los ocupados como respaldo).
const visibleSeats = computed(() => {
  if (!playing.value) return seatIds.value
  return game.value?.activeSeats || seatIds.value.filter(id => seatOf(id)?.occupied)
})

// Posiciones alrededor de la mesa, en sentido horario, con MI asiento siempre
// abajo. En 4 jugadores: yo abajo, rival a la derecha, compañero enfrente, rival
// a la izquierda (asientos alternados = compañero al frente).
const POS_LAYOUT = { 1: ['bottom'], 2: ['bottom', 'top'], 4: ['bottom', 'right', 'top', 'left'] }
const tableSeats = computed(() => {
  const ids = visibleSeats.value
  const n = ids.length
  const layout = POS_LAYOUT[n] || POS_LAYOUT[2]
  let base = 0
  if (mySeat.value) { const i = ids.indexOf(mySeat.value); if (i >= 0) base = i }
  return layout.map((pos, k) => ({ id: ids[(base + k) % n], pos }))
})

// Equipos (autoritativos durante el juego; antes, por paridad de asiento).
function teamMembers (ti) {
  const teams = game.value?.teams
  if (teams && teams[ti]) return teams[ti]
  return seatIds.value.filter(id => seatIds.value.indexOf(id) % 2 === ti)
}
function teamLabel (ti) {
  if (ti == null) return ''
  const names = teamMembers(ti).map(id => seatOf(id)?.name).filter(Boolean)
  if (names.length) return names.join(' + ')
  return ti === 0 ? t.value.teamA : t.value.teamB
}
const teamScore = (ti) => game.value?.scores?.[ti] ?? 0
const teamChicas = (ti) => game.value?.chicasWon?.[ti] ?? 0
const teamCards = (ti) => game.value?.capturedCount?.[ti] ?? 0
const leadTeam = computed(() => {
  const s = game.value?.scores
  if (!s) return null
  if (s[0] === s[1]) return null
  return s[0] > s[1] ? 0 : 1
})

const myTeam = computed(() => (mySeat.value != null ? game.value?.teamOf?.[mySeat.value] : null))
const iWon = computed(() => myTeam.value != null && game.value?.winnerTeam === myTeam.value)

const rivalToRate = computed(() => {
  // Primer rival con pubkey distinto al mío (para calificar tras la partida).
  for (const id of seatIds.value) {
    const s = seatOf(id)
    if (s?.occupied && s.pubkey && s.pubkey !== myPubkey.value) return s
  }
  return null
})

function onPlay (card) { if (isMyTurn.value) playCard(card.id) }
function doResign () { confirmResign.value = false; resign() }

// ── toasts de eventos de puntos ─────────────────────────────────────
const toasts = ref([])
let toastSeq = 0
const EV_TEXT = {
  caida: () => t.value.evCaida,
  limpia: () => t.value.evLimpia,
  caidaLimpia: () => t.value.evCaidaLimpia,
  ronda: () => t.value.evRonda,
  dobleRonda: () => t.value.evDobleRonda,
  carton: (e) => t.value.evCarton(e.pts),
  chica: () => t.value.evChica
}
watch(() => game.value?.lastEvents, (evs) => {
  if (!Array.isArray(evs)) return
  for (const e of evs) {
    const fn = EV_TEXT[e.type]
    if (!fn) continue
    const id = ++toastSeq
    toasts.value.push({ id, text: fn(e), kind: e.type })
    setTimeout(() => { toasts.value = toasts.value.filter(x => x.id !== id) }, 2600)
  }
}, { deep: true })
</script>

<style scoped>
.game { display: flex; flex-direction: column; gap: 14px; padding: 12px; max-width: 920px; margin: 0 auto; }

.scoreboard { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.team { border: 1px solid var(--color-border); border-radius: var(--border-radius-md); padding: 10px 14px; background: var(--color-surface); }
.team.t0 { border-left: 4px solid var(--color-primary); }
.team.t1 { border-left: 4px solid var(--color-info); }
.team.lead { box-shadow: 0 0 0 2px var(--color-primary) inset; }
.team-name { font-weight: 600; font-size: 0.92rem; color: var(--color-text-secondary); }
.team-pts { font-family: var(--font-headline); font-size: 2rem; line-height: 1.1; }
.team-pts small { font-size: 0.9rem; color: var(--color-text-tertiary); }
.team-sub { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }

/* ── Mesa: fieltro central + asientos en cada lado ── */
.table-area {
  position: relative;
  width: min(94vw, 540px);
  height: min(94vw, 540px);
  margin: 6px auto;
}
.felt {
  position: absolute;
  border-radius: 50% / 42%;
  background: radial-gradient(circle at 50% 42%, #3f7a3c, #234b22 72%, #1c3c1b);
  border: 6px solid #5a431f;
  box-shadow: inset 0 4px 26px rgba(0,0,0,.45), 0 8px 24px rgba(0,0,0,.35);
  display: flex; align-items: center; justify-content: center;
}
/* deja sitio a los asientos: 2 jug. arriba/abajo; 4 también a los lados */
.players-2 .felt, .players-1 .felt { top: 96px; bottom: 96px; left: 8px; right: 8px; }
.players-4 .felt { top: 96px; bottom: 96px; left: 96px; right: 96px; }
.felt-label { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); font-size: 0.66rem; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.45); }
.deck { position: absolute; top: 10px; right: 12px; display: flex; align-items: center; gap: 5px; }
.deck-count { font-size: 0.72rem; color: rgba(255,255,255,.7); }
.table-cards { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; justify-content: center; max-width: 86%; }
.table-empty { color: rgba(255,255,255,.4); font-size: 1.6rem; }
:deep(.pcard.last) { outline: 2px solid var(--color-warning); }

/* asientos posicionados */
.seat {
  position: absolute; box-sizing: border-box;
  width: 150px; max-width: 42vw;
  border: 1px solid var(--color-border); border-radius: var(--border-radius-md);
  padding: 7px 9px; background: var(--color-surface);
  display: flex; flex-direction: column; gap: 5px; align-items: center; text-align: center;
  box-shadow: var(--shadow-sm);
}
.seat.pos-bottom { bottom: 0; left: 50%; transform: translateX(-50%); }
.seat.pos-top    { top: 0;    left: 50%; transform: translateX(-50%); }
.seat.pos-left   { left: 0;   top: 50%; transform: translateY(-50%); width: 92px; }
.seat.pos-right  { right: 0;  top: 50%; transform: translateY(-50%); width: 92px; }
.seat.team0 { border-top: 3px solid var(--color-primary); }
.seat.team1 { border-top: 3px solid var(--color-info); }
.seat.me { background: var(--bg-elev); box-shadow: 0 0 0 1px var(--color-primary) inset, var(--shadow-sm); }
.seat.turn { box-shadow: 0 0 0 2px var(--color-primary), 0 0 16px rgba(205,163,80,.4); }
.seat.disc { opacity: 0.6; }
.seat-head { display: flex; align-items: center; justify-content: center; gap: 4px; max-width: 100%; }
.seat-name { font-weight: 600; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.you { color: var(--color-primary); font-weight: 400; }
.seat-cards { display: flex; }
.seat-cards :deep(.pcard) { margin-left: -14px; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
.seat-cards :deep(.pcard:first-child) { margin-left: 0; }
.seat-empty { color: var(--color-text-tertiary); font-size: 0.82rem; font-style: italic; }
.ready-tag { color: var(--color-success); font-size: 0.78rem; font-weight: 600; }
.turn-dot { color: var(--color-primary); font-size: 0.7rem; }
.muted { color: var(--color-text-tertiary); font-size: 0.8rem; }
.seat-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
button.sm { padding: 0.35em 0.7em; font-size: 0.8rem; }
button.link { background: none; border: none; color: var(--color-primary); padding: 0 4px; font-size: 1rem; }
button.link:hover { transform: none; background: none; }

@media (max-width: 460px) {
  .players-4 .felt { left: 70px; right: 70px; top: 84px; bottom: 84px; }
  .seat { width: 124px; }
  .seat.pos-left, .seat.pos-right { width: 66px; padding: 5px; }
  .seat.pos-left .seat-name, .seat.pos-right .seat-name { font-size: 0.72rem; }
}

.banner { text-align: center; padding: 10px; display: flex; flex-direction: column; gap: 8px; align-items: center; color: var(--color-text-secondary); }
.turn-bar { text-align: center; min-height: 24px; }
.my-turn { color: var(--color-primary); font-weight: 700; }

.hand { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; padding: 8px; min-height: 96px; }
.spectator-note { color: var(--color-text-secondary); align-items: center; }

.controls { display: flex; gap: 8px; justify-content: center; }

.toasts { position: fixed; top: 70px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; z-index: 900; pointer-events: none; }
.toast { background: var(--color-primary); color: #1a1408; padding: 8px 16px; border-radius: 999px; font-weight: 700; box-shadow: var(--shadow-md); animation: pop .3s ease; }
.toast.chica { background: var(--color-secondary); color: #0f1408; }
.toast.carton { background: var(--color-info); color: #fff; }
@keyframes pop { from { transform: scale(.7); opacity: 0; } }

.lay-enter-active { transition: all .2s ease; }
.lay-enter-from { opacity: 0; transform: translateY(-20px); }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 1rem; }
.result-modal { background: var(--color-card-bg); border: 1px solid var(--color-border); border-radius: var(--border-radius-lg); padding: 1.5rem; max-width: 420px; width: 100%; text-align: center; box-shadow: var(--shadow-lg); }
.result-line { font-size: 1.3rem; font-weight: 700; margin: 0.8rem 0; }
.result-line.win { color: var(--color-success); }
.result-line.lose { color: var(--color-error); }
.result-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 1rem; }
</style>
