import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './styles/theme.css'
import './style.css'
import App from './App.vue'
import '@closerclick/closer-click-support'
import '@closerclick/closer-click-profile'
import '@closerclick/closer-click-install'
import { createBackNav } from '@closerclick/closer-click-nav'

// Capturamos el hash inicial ANTES de que el lobby consuma un deep-link #table=
// (history.replaceState lo limpia al conectar), para que el tutorial sepa si la
// visita fue "limpia" o por un enlace compartido.
if (typeof window !== 'undefined' && window.__ccInitialHash === undefined) {
  window.__ccInitialHash = location.hash
}

// Navegación "volver" unificada del ecosistema (botón físico de Android / gesto
// de iOS / atrás del navegador / chevron del header → cierra modal o sale a
// closer.click).
createBackNav()

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
