export function BackendSettings({ backend }: { backend: 'standalone' | 'freshrss' }) {
  return <section className="connection-settings backend-settings" aria-label="Backend and migration">
    <h3>Backend &amp; data</h3>
    <p>Current backend: <strong>{backend === 'standalone' ? 'Standalone' : 'FreshRSS'}</strong>.</p>
    <p>{backend === 'standalone'
      ? 'Paper fetches feeds and stores articles, reading state and folders in its data directory. Add a feed in Settings > Feeds. AI, Readwise and Kirby are optional.'
      : 'FreshRSS manages subscriptions and reading state. Paper keeps its local reading history, discussions, briefings and collections.'}</p>
    <p>Back up the entire data directory and private configuration while Paper and its briefing commands are stopped. Include generated secrets, connection settings and migration backups.</p>
    <details>
      <summary>Move a FreshRSS snapshot to standalone</summary>
      <p>Complete a successful sync, then stop Paper and any briefing commands. Save a private backup of your configuration. Run these commands from the directory containing your Compose file.</p>
      <pre className="backend-commands">{`docker compose stop paper
docker compose run --rm --no-deps paper node dist-server/migration-cli.js preview
docker compose run --rm --no-deps paper node dist-server/migration-cli.js apply --digest PLAN_DIGEST`}</pre>
      <p>Replace PLAN_DIGEST with the digest from the preview after reviewing its counts, references and identity decisions. Keep the original FreshRSS URL and username for preview. Unlinked historical articles keep their IDs and reading state. Future feed items may appear separately when publisher identity is unknown.</p>
      <p>After apply reports active, set PAPER_BACKEND=standalone in your private configuration and recreate Paper:</p>
      <pre className="backend-commands">docker compose up -d --no-build paper</pre>
      <p>Changing configuration alone cannot transfer data ownership. Migration never changes FreshRSS. Changes made there after the last Paper sync are outside this snapshot.</p>
    </details>
    <details>
      <summary>Resume or roll back a migration</summary>
      <p>Stop Paper first. Use status to inspect the recorded phase. Resume requires the original reviewed plan digest:</p>
      <pre className="backend-commands">{`docker compose run --rm --no-deps paper node dist-server/migration-cli.js status
docker compose run --rm --no-deps paper node dist-server/migration-cli.js resume --digest PLAN_DIGEST
docker compose run --rm --no-deps paper node dist-server/migration-cli.js rollback-preview
docker compose run --rm --no-deps paper node dist-server/migration-cli.js rollback-apply --digest ROLLBACK_DIGEST --acknowledge-loss`}</pre>
      <p>Review the rollback report first. Rollback restores the source snapshot; later standalone changes remain only in a verified post-activation backup. It does not merge them into FreshRSS. Restore the original FreshRSS configuration before restarting Paper.</p>
    </details>
    <p><a href="https://github.com/cliophate/paper-reader/blob/main/docs/backend-migration.md" target="_blank" rel="noreferrer">Migration and reviewed mapping instructions</a></p>
  </section>
}
