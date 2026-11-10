import { useEffect, useState } from 'react'

export function FeedMark({ title, url, iconUrl = '' }: { title: string; url: string; iconUrl?: string }) {
  const [iconFailed, setIconFailed] = useState(false)
  useEffect(() => setIconFailed(false), [iconUrl])
  const trimmedTitle = title.trim()
  let letter = (trimmedTitle.startsWith('@') ? trimmedTitle.charAt(1) : trimmedTitle.charAt(0)).toUpperCase() || '•'
  let hue = 210
  try { hue = [...new URL(url).hostname].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360 } catch { letter = title.charAt(0) }
  const showIcon = Boolean(iconUrl && !iconFailed)
  return <span className={`feed-mark ${showIcon ? 'has-icon' : ''}`} style={{ '--feed-hue': hue } as React.CSSProperties}>
    {showIcon ? <img src={iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setIconFailed(true)} /> : letter}
  </span>
}
