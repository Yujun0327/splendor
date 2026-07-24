<script lang="ts">
  import { HotseatSession } from './app/session.svelte'
  import Gallery from './ui/Gallery.svelte'
  import GameScreen from './ui/GameScreen.svelte'
  import Home from './ui/Home.svelte'

  let hash = $state(location.hash)
  let hotseat = $state<HotseatSession | null>(null)
  let hotseatConfig: { playerCount: 2 | 3 | 4; names: string[] } | null = null

  $effect(() => {
    const handler = () => (hash = location.hash)
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  })

  const showGallery = $derived(import.meta.env.DEV && hash === '#gallery')

  // dev-only: auto-seat a 3P hotseat game for visual QA / screenshots
  $effect(() => {
    if (import.meta.env.DEV && hash === '#demo' && !hotseat) {
      startHotseat(3, ['Ana', 'Bo', 'Cy'])
    }
  })

  function startHotseat(playerCount: 2 | 3 | 4, names: string[]) {
    hotseatConfig = { playerCount, names }
    hotseat = new HotseatSession(playerCount, names)
  }

  function exitToHome() {
    hotseat = null
  }

  function rematch() {
    if (hotseat && hotseatConfig) {
      hotseat = new HotseatSession(hotseatConfig.playerCount, hotseatConfig.names)
    }
  }
</script>

{#if showGallery}
  <Gallery />
{:else if hotseat}
  <GameScreen session={hotseat} onExit={exitToHome} onRematch={rematch} />
{:else}
  <Home onHotseat={startHotseat} />
{/if}
