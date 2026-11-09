import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildKirbyNoteText, kirbyPanelUrl, KirbyPublisher } from '../src/server/kirby.js'

afterEach(() => vi.unstubAllGlobals())

const input = {
  title: 'SteamDB joins [Nexus Mods]',
  sourceUrl: 'https://example.test/posts/steamdb-(news)',
  quote: 'The first paragraph.\n\nThe second paragraph.',
}

describe('Kirby note publishing', () => {
  it('builds a source heading followed by a block quote', () => {
    expect(buildKirbyNoteText(input)).toBe([
      "**[SteamDB joins \\[Nexus Mods\\]](https://example.test/posts/steamdb-%28news%29)** <span class='source'>example.test</span>",
      '',
      '> The first paragraph.',
      '>',
      '> The second paragraph.',
    ].join('\n'))
  })

  it('creates a note draft with the existing Kirby publisher', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      id: 'notes/example',
      url: 'https://publishing.example.test/example',
      panelUrl: 'https://publishing.example.test/panel/pages/wrong-path',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const publisher = new KirbyPublisher({ publishUrl: 'https://publishing.example.test/api/obsidian/publish', token: 'secret' })
    await expect(publisher.createNote(input)).resolves.toEqual({
      id: 'notes/example',
      url: 'https://publishing.example.test/example',
      panelUrl: 'https://publishing.example.test/panel/pages/notes+example',
    })

    const [, request] = fetchMock.mock.calls[0]
    expect(request.headers).toEqual({ Authorization: 'Bearer secret' })
    const payload = JSON.parse(String((request.body as FormData).get('payload')))
    expect(payload.destination).toBe('notes')
    expect(payload.title).toBe(input.title)
    expect(payload.text).toContain('> The first paragraph.')
  })

  it('derives the Kirby editor URL from the page ID', () => {
    expect(kirbyPanelUrl(
      'https://publishing.example.test/api/obsidian/publish',
      'notes/monster-hunter-wilds-ascendance-is-turbocharging-combat',
    )).toBe('https://publishing.example.test/panel/pages/notes+monster-hunter-wilds-ascendance-is-turbocharging-combat')
  })

  it('explains duplicate-title conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'Already exists' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })))
    const publisher = new KirbyPublisher({ publishUrl: 'https://publishing.example.test/api/obsidian/publish', token: 'secret' })
    await expect(publisher.createNote(input)).rejects.toThrow('A Kirby draft with this title already exists')
  })
})
