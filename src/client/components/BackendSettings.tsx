export function BackendSettings({ backend }: { backend: 'standalone' | 'freshrss' }) {
  return <section className="connection-settings backend-settings" aria-label="Backend and data">
    <h3>Backend &amp; data</h3>
    <p>Current backend: <strong>{backend === 'standalone' ? 'Standalone' : 'FreshRSS'}</strong>.</p>
    <p>{backend === 'standalone'
      ? 'Paper fetches feeds and stores articles, reading state and folders in its data directory. Add a feed in Settings > Feeds. AI, Readwise and Kirby are optional.'
      : 'FreshRSS manages subscriptions and reading state. Paper keeps its local reading history, discussions, briefings and collections.'}</p>
    <p>Back up the entire data directory and private configuration while Paper and its briefing commands are stopped. Include generated secrets and connection settings.</p>
  </section>
}
