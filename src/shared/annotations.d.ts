export interface PassageAnchor {
  body: 'feed' | 'full'
  quote: { exact: string; prefix: string; suffix: string }
  position: { start: number; end: number }
}

export interface Annotation {
  id: number
  entryId: string
  parentId: number | null
  anchor: PassageAnchor | null
  note: string
  revision: number
  createdAt: string
  title: string
  author: string
  url: string
  publishedAt: string
  linkNumber: number
}

export interface AnnotationPage {
  items: Annotation[]
  parents: Record<number, PassageAnchor>
  next: number | null
}

export type NewAnnotation = { entryId: string } & (
  { anchor: PassageAnchor } | { note: string; parentId?: number }
)
