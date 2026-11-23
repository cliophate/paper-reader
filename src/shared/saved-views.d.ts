export interface SavedView {
  id: string
  title: string
  query: string
  revision: number
}

export interface ViewCount {
  count: number
  capped: boolean
}
