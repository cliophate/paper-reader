import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { removeBrokenArticleImage, shouldShowArticleLeadImage } from '../src/client/articleImages'

function documentWith(html: string): Document {
  return new JSDOM(html).window.document
}

describe('broken article images', () => {
  it('removes a single-image figure with its orphaned caption', () => {
    const document = documentWith('<figure><picture><source srcset="bad.webp"><img src="bad.jpg"></picture><figcaption>Image credit</figcaption></figure>')
    removeBrokenArticleImage(document.querySelector('img') as HTMLImageElement)
    expect(document.querySelector('figure')).toBeNull()
    expect(document.body.textContent).not.toContain('Image credit')
  })

  it('keeps a figure when another image remains', () => {
    const document = documentWith('<figure><img id="bad" src="bad.jpg"><img id="good" src="good.jpg"><figcaption>Gallery</figcaption></figure>')
    removeBrokenArticleImage(document.querySelector('#bad') as HTMLImageElement)
    expect(document.querySelector('#bad')).toBeNull()
    expect(document.querySelector('#good')).not.toBeNull()
    expect(document.querySelector('figcaption')?.textContent).toBe('Gallery')
  })

  it('removes a broken picture wrapper outside a figure', () => {
    const document = documentWith('<div><picture><source srcset="bad.webp"><img src="bad.jpg"></picture><p>Keep me</p></div>')
    removeBrokenArticleImage(document.querySelector('img') as HTMLImageElement)
    expect(document.querySelector('picture')).toBeNull()
    expect(document.querySelector('p')?.textContent).toBe('Keep me')
  })
})

describe('article lead images', () => {
  it('shows a feed thumbnail that Readability omitted from the body', () => {
    expect(shouldShowArticleLeadImage(
      'https://images.example.test/lead.jpg?quality=80',
      '<p>Article text.</p><img src="https://images.example.test/inside.jpg">',
    )).toBe(true)
  })

  it('does not duplicate the thumbnail when the body has another size of it', () => {
    expect(shouldShowArticleLeadImage(
      'https://images.example.test/lead.jpg?width=600',
      '<img src="https://images.example.test/lead.jpg?width=1200">',
    )).toBe(false)
  })

  it('recognises WordPress filename size variants as the same image', () => {
    expect(shouldShowArticleLeadImage(
      'https://example.test/uploads/hero-150x84.jpg',
      '<img src="https://example.test/uploads/hero.jpg">',
    )).toBe(false)
  })

  it('checks responsive image candidates and rejects invalid thumbnails', () => {
    expect(shouldShowArticleLeadImage(
      'https://images.example.test/lead.jpg',
      '<img src="fallback.jpg" srcset="https://images.example.test/lead.jpg?width=600 600w, https://images.example.test/lead.jpg?width=1200 1200w">',
    )).toBe(false)
    expect(shouldShowArticleLeadImage('', '<p>Article text.</p>')).toBe(false)
  })
})
