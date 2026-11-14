export function BackendSettings({ backend }: { backend: 'standalone' | 'freshrss' | 'miniflux' }) {
  return <section className="connection-settings backend-settings" aria-label="Backend and data">
    <h3>Backend &amp; data</h3>
    <p>Current backend: <strong>{backend === 'standalone' ? 'Standalone' : backend === 'miniflux' ? 'Miniflux' : 'FreshRSS'}</strong>.</p>
    <p>{backend === 'standalone'
      ? 'Paper fetches feeds and stores articles, reading state and folders in its data directory. Add a feed in Settings > Feeds. AI, Readwise and Kirby are optional.'
      : `${backend === 'miniflux' ? 'Miniflux' : 'FreshRSS'} manages subscriptions and reading state. Paper keeps its local reading history, discussions, briefings and collections.`}</p>
    {backend === 'miniflux' && <>
      <p>Connect with PAPER_BACKEND=miniflux, MINIFLUX_BASE_URL and MINIFLUX_API_KEY in your private configuration. Create a dedicated API key in Miniflux Settings &gt; API Keys. Miniflux 2.3.2 or newer is required. Paper uses the native API.</p>
      <p>Use a new Paper data directory when connecting an account. Miniflux must be reachable when Paper or a briefing command starts. Existing local articles remain readable during a later connection outage. Token rotation keeps the same account binding; changing the server or account requires a separate data directory.</p>
      <p>Choose a real category when moving feeds. Adding a feed without a category uses Miniflux's default. Folder management, ordering and feed URL repair are currently unavailable. Back up Miniflux separately.</p>
    </>}
    <p>Back up the entire data directory and private configuration while Paper and its briefing commands are stopped. Include generated secrets and connection settings.</p>
  </section>
}
