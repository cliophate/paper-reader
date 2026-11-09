export interface DiscussionSource {
  title: string
  author: string
  url: string
  kind: 'feed' | 'fulltext'
  paragraphs: { id: string; text: string }[]
  warning: string
}
export interface DiscussionMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  quote?: string
  status: 'complete' | 'running' | 'stopped' | 'error'
  error?: string
}
export interface Discussion {
  entryId: string
  revision: number
  source: DiscussionSource
  messages: DiscussionMessage[]
}
