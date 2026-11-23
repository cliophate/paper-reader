export type RuleAction = 'hide' | 'read' | 'star' | 'notify'
export type RuleScope = 'title' | 'content' | 'any' | 'query'

export interface ArticleRule {
  id: string
  phrase: string
  scope: RuleScope
  feedId: string
  feedTitle: string
  matchCount: number
  disabled?: boolean
  matching: boolean
  createdAt: string
  actions: RuleAction[]
  targetId: string
  targetName: string
  undoTokens: string[]
}
