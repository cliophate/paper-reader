import { RetentionSettings } from './RetentionSettings'

export function BackendSettings({ backend }: { backend: 'standalone' | 'freshrss' | 'miniflux' }) {
  const name = backend === 'standalone' ? 'Standalone' : backend === 'miniflux' ? 'Miniflux' : 'FreshRSS'
  return <section className="connection-settings backend-settings" aria-label="Backend and data">
    <h3>Backend &amp; data</h3>
    <p>Current backend: <strong>{name}</strong></p>
    <p className="settings-intro">{backend === 'standalone'
      ? 'Paper fetches feeds and saves articles, feed icons, reading state and folders in its data directory.'
      : `${name} manages subscriptions and reading state. Paper keeps local history, discussions, briefings and collections.`}</p>
    {backend === 'miniflux' && <div className="backend-notes">
      <p>Set PAPER_BACKEND=miniflux, MINIFLUX_BASE_URL and MINIFLUX_API_KEY in your private configuration. Create a dedicated key in Miniflux Settings &gt; API Keys. Paper uses the native API and requires Miniflux 2.3.2 or newer.</p>
      <p>Use a new Paper data directory for each server or account. Miniflux must be reachable when Paper or a briefing command starts. Local articles stay readable during later outages. Rotating the key keeps the same account.</p>
      <p>Choose a category when moving feeds. New feeds use Miniflux's default if you omit one. Folder management, ordering and feed URL repair are unavailable. Back up Miniflux separately.</p>
    </div>}
    <section className="backend-backups" aria-label="Backups">
      <h4>Backups</h4>
      <p className="settings-intro">Stop Paper and all briefing commands, then back up the whole data directory and private configuration. Include generated secrets and connection settings.</p>
    </section>
    <RetentionSettings backend={backend} />
  </section>
}
