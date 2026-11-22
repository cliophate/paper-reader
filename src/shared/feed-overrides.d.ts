export interface ExtractionRules {
  contentSelector: string
  removeSelectors: string[]
  lazyImages: boolean
  stripTracking: boolean
}

export interface FeedOverrideOptions extends ExtractionRules {
  userAgent: string
  articleCookieOrigin: string
}

export interface FeedOverrideUpdate extends FeedOverrideOptions {
  cookie?: string | null
  expectedCookieOrigin?: string
}

export interface FeedOverrideView extends FeedOverrideOptions {
  cookieSet: boolean
  cookieOrigin: string
  articles: Array<{ id: string; title: string }>
}
