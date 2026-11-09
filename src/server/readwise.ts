import type { Config } from './config.js'

export class ReadwiseClient {
  constructor(private readonly config: Config['readwise']) {}

  get configured(): boolean {
    return Boolean(this.config.token)
  }

  async save(url: string, title: string): Promise<{ id?: string; url?: string }> {
    if (!this.config.token) throw new Error('Readwise is not configured')
    const response = await fetch('https://readwise.io/api/v3/save/', {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        title: title || undefined,
        location: this.config.location,
        saved_using: 'Paper',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Readwise save failed with ${response.status}`)
    return await response.json() as { id?: string; url?: string }
  }
}
