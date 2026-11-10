import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api, ApiError } from '../api'
import { useDialogFocus, useMenuFocus } from '../dialogFocus'
import type { Feed, Folder, NavigationPayload, StreamRef } from '../types'
import type { OrganizationCommand, OrganizationView } from '../../shared/organization'
import { Icon } from './Icon'
import { FeedMark } from './FeedMark'

type Member = { feed: Feed; folderId: string | null }
type Target = { kind: 'feed'; member: Member } | { kind: 'folder'; folder: Folder }
type Action = { type: 'unsubscribe'; members: Member[] } | { type: 'create' } | { type: 'rename' | 'remove'; target: Target } | { type: 'move'; members: Member[] } | { type: 'merge'; folder: Folder }
type Drag = Target
type Placement = { row: string; edge: 'before' | 'after' | 'inside'; commands: OrganizationCommand[]; label: string }
const folderRow = (id: string | null) => JSON.stringify(['folder', id])
const feedRow = (member: Member) => JSON.stringify(['feed', member.folderId, member.feed.id])
const memberKey = (member: Member) => JSON.stringify([member.folderId, member.feed.id])
const targetTitle = (target: Target) => target.kind === 'feed' ? target.member.feed.title : target.folder.title

export function OrganizationSidebar({ snapshot, navigation, active, unreadOnly, online, onSnapshot, onOpen, onMarkFeed, onMarkFolder, onManage, onAddFeed }: {
  snapshot: OrganizationView | null
  navigation: NavigationPayload | null
  active: StreamRef | null
  unreadOnly: boolean
  online: boolean
  onSnapshot: (snapshot: OrganizationView) => void
  onOpen: (stream: StreamRef) => void
  onMarkFeed: (feed: Feed) => void
  onMarkFolder: (folder: Folder) => void
  onManage: (feed: Feed) => void
  onAddFeed: () => void
}) {
  const [expanded, setExpanded] = useState(new Set<string | null>())
  const [organizing, setOrganizing] = useState(false)
  const [selected, setSelected] = useState<Member[]>([])
  const [menu, setMenu] = useState<{ target: Target; left: number; top: number } | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{ kind: 'add' | 'options'; left: number; top: number } | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const placementRef = useRef<Placement | null>(null)
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null)
  const pointer = useRef<{ id: number; startX: number; startY: number; x: number; y: number; item: Drag; moving: boolean } | null>(null)
  const scrollFrame = useRef<number | null>(null)
  const keyboardIndex = useRef(0)
  const dragHelp = useId()
  const sidebar = useRef<HTMLElement>(null)
  const editRevision = useRef<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const focusAfterClose = useRef(false)
  const toolbar = useRef<HTMLButtonElement>(null)
  const selectionDone = useRef<HTMLButtonElement>(null)
  const capabilities = snapshot?.capabilities
  const writable = online && !!snapshot && !busy && !needsReload
  const folders = navigation?.folders || []
  const namedUncategorized = snapshot?.backend === 'freshrss' && folders.some(folder => folder.title === 'Uncategorized')
  const feedsIn = (id: string | null) => id === null ? navigation?.uncategorized || [] : folders.find(folder => folder.id === id)?.feeds || []
  const members = [...folders.flatMap(folder => folder.feeds.map(feed => ({ feed, folderId: folder.id }))), ...(navigation?.uncategorized || []).map(feed => ({ feed, folderId: null }))]
  const selectedNow = selected.map(item => members.find(member => memberKey(member) === memberKey(item))).filter((item): item is Member => !!item)
  const toggle = (id: string | null) => setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const restoreFocus = () => { focusAfterClose.current = true }
  useEffect(() => {
    if (menu || headerMenu || action || !focusAfterClose.current) return
    focusAfterClose.current = false
    if (returnFocus.current?.isConnected) returnFocus.current.focus()
    else (selectionDone.current || toolbar.current)?.focus()
  }, [menu, headerMenu, action, snapshot, organizing])
  const closeHeaderMenu = () => { setHeaderMenu(null); restoreFocus() }
  const closeMenu = () => { setMenu(null); restoreFocus() }
  const closeAction = () => { setAction(null); restoreFocus() }
  const begin = (next: Action) => { if (!menu) editRevision.current = snapshot?.revision ?? null; setMenu(null); setHeaderMenu(null); setFeedback(null); setAction(next) }
  const reload = async () => {
    setBusy(true)
    try { const refreshed = await api.organization(true); onSnapshot(refreshed); editRevision.current = refreshed.revision; setNeedsReload(false); setFeedback({ error: false, text: 'Organization reloaded. Review your choices before submitting again.' }) }
    catch { setFeedback({ error: true, text: 'Could not reload organization. Check the connection and try again.' }) }
    finally { setBusy(false) }
  }
  const apply = async (commands: OrganizationCommand[], labels: string[], moving?: Member[]) => {
    if (!writable || !snapshot) return
    setBusy(true); setFeedback(null)
    try {
      const result = await api.organize({ expectedRevision: editRevision.current, commands })
      if (result.snapshot) onSnapshot(result.snapshot)
      setNeedsReload(!result.snapshot || !!result.refreshError || result.results.some(item => item.status === 'failed' && (item.code === 'remote-failure' || item.code === 'conflict')))
      const failed = result.results.filter(item => item.status === 'failed')
      const applied = result.results.length - failed.length
      const details = failed.map(item => `${labels[item.index]}: ${item.message}`).join(' ')
      setFeedback({ error: failed.length > 0 || !!result.refreshError, text: `${applied} of ${commands.length} changes confirmed.${details ? ` ${details}` : ''}${result.refreshError ? ` ${result.refreshError}` : ''}` })
      if (moving) {
        const succeeded = new Set(result.results.filter(item => item.status === 'applied').map(item => memberKey(moving[item.index])))
        setSelected(current => current.filter(item => !succeeded.has(memberKey(item))))
      }
      // Partial batches are never replayed from the old dialog.
      if (applied > 0 || failed.length === 0) { setAction(null); setMenu(null); restoreFocus() }
    } catch (error) {
      setNeedsReload(true)
      setFeedback({ error: true, text: error instanceof ApiError && error.code === 'conflict'
        ? 'Organization changed on another device. No changes from this request were applied. Reload and review your choices.'
        : 'Could not confirm these changes. Reload organization before trying again.' })
    } finally { setBusy(false) }
  }
  const showMenu = (target: Target, element: HTMLElement, point?: { x: number; y: number }) => {
    cancelDrag(); setHeaderMenu(null)
    editRevision.current = snapshot?.revision ?? null
    element.focus()
    returnFocus.current = element
    const box = element.getBoundingClientRect()
    setMenu({ target, left: Math.max(8, Math.min(point?.x ?? box.left, window.innerWidth - 268)), top: Math.max(8, Math.min(point?.y ?? box.bottom, window.innerHeight - 420)) })
  }
  const reorderFeed = (member: Member, beforeId: string | null) => {
    const ids = feedsIn(member.folderId).map(feed => feed.id).filter(id => id !== member.feed.id)
    ids.splice(beforeId === null ? ids.length : ids.indexOf(beforeId), 0, member.feed.id)
    void apply([{ type: 'order-feeds', folderId: member.folderId, feedIds: ids }], [member.feed.title])
  }
  const step = (target: Target, direction: -1 | 1) => {
    setMenu(null)
    if (target.kind === 'folder') {
      const index = folders.findIndex(folder => folder.id === target.folder.id)
      void apply([{ type: 'move-folder', folderId: target.folder.id, beforeId: folders[index + (direction < 0 ? -1 : 2)]?.id || null }], [target.folder.title])
    } else {
      const feeds = feedsIn(target.member.folderId), index = feeds.findIndex(feed => feed.id === target.member.feed.id)
      reorderFeed(target.member, feeds[index + (direction < 0 ? -1 : 2)]?.id || null)
    }
  }
  const indicate = (next: Placement | null) => { if (JSON.stringify(next) === JSON.stringify(placementRef.current)) return; placementRef.current = next; setPlacement(next) }
  const cancelDrag = () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null; pointer.current = null; setDrag(null); setDragPoint(null); indicate(null) }
  useEffect(() => {
    if (!drag) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancelDrag() } }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [drag])
  useEffect(() => { if (!writable) cancelDrag() }, [writable])
  const drop = (item: Drag) => {
    const next = placementRef.current
    cancelDrag()
    if (next) void apply(next.commands, next.commands.map(() => targetTitle(item)))
  }
  const orderPlacement = (item: Drag, index: number): Placement | null => {
    if (item.kind === 'folder') {
      if (!capabilities?.orderFolders) return null
      const remaining = folders.filter(folder => folder.id !== item.folder.id)
      const before = remaining[index]
      const last = remaining.at(-1)
      if (!before && !last) return null
      return { row: folderRow((before || last)!.id), edge: before ? 'before' : 'after', commands: [{ type: 'move-folder', folderId: item.folder.id, beforeId: before?.id ?? null }], label: before ? `Before ${before.title}` : 'After all folders' }
    }
    if (!capabilities?.orderFeeds) return null
    const remaining = feedsIn(item.member.folderId).filter(feed => feed.id !== item.member.feed.id)
    const before = remaining[index], last = remaining.at(-1)
    if (!before && !last) return null
    const ids = remaining.map(feed => feed.id)
    ids.splice(index, 0, item.member.feed.id)
    return { row: feedRow({ feed: (before || last)!, folderId: item.member.folderId }), edge: before ? 'before' : 'after', commands: [{ type: 'order-feeds', folderId: item.member.folderId, feedIds: ids }], label: before ? `Before ${before.title}` : 'After all feeds' }
  }
  const locate = (item: Drag, x: number, y: number): Placement | null => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-organization-row]')
    if (!row || !sidebar.current?.contains(row)) return null
    const [kind, folderId, feedId] = JSON.parse(row.dataset.organizationRow!) as [string, string | null, string?]
    const box = row.getBoundingClientRect(), after = y > box.top + box.height / 2
    if (item.kind === 'feed' && item.member.folderId !== folderId && capabilities?.moveFeed) {
      const title = folders.find(folder => folder.id === folderId)?.title || 'Uncategorized'
      const commands: OrganizationCommand[] = [{ type: 'move-feed', feedId: item.member.feed.id, fromFolderId: item.member.folderId, toFolderId: folderId }]
      if (folderId === null && capabilities.multipleMemberships && members.some(member => member.feed.id === item.member.feed.id && member.folderId !== null && member.folderId !== item.member.folderId)) {
        const source = folders.find(folder => folder.id === item.member.folderId)?.title || 'source folder'
        return { row: row.dataset.organizationRow!, edge: 'inside', commands, label: `Remove from ${source}; keep other folders` }
      }
      if (kind === 'feed' && capabilities.orderFeeds && capabilities.conditionalWrites) {
        const destination = feedsIn(folderId).map(feed => feed.id)
        const ids = destination.filter(id => id !== item.member.feed.id)
        const index = feedId === item.member.feed.id ? destination.indexOf(feedId) : ids.indexOf(feedId!) + Number(after)
        ids.splice(index, 0, item.member.feed.id)
        commands.push({ type: 'order-feeds', folderId, feedIds: ids })
        return { row: row.dataset.organizationRow!, edge: after ? 'after' : 'before', commands, label: `${after ? 'After' : 'Before'} ${feedsIn(folderId).find(feed => feed.id === feedId)?.title} in ${title}` }
      }
      return { row: row.dataset.organizationRow!, edge: 'inside', commands, label: `Move to ${title}` }
    }
    if (item.kind === 'folder' && kind === 'folder' && folderId !== null && folderId !== item.folder.id) {
      const remaining = folders.filter(folder => folder.id !== item.folder.id)
      return orderPlacement(item, remaining.findIndex(folder => folder.id === folderId) + Number(after))
    }
    if (item.kind === 'feed' && kind === 'feed' && folderId === item.member.folderId && feedId !== item.member.feed.id) {
      const remaining = feedsIn(folderId).filter(feed => feed.id !== item.member.feed.id)
      return orderPlacement(item, remaining.findIndex(feed => feed.id === feedId) + Number(after))
    }
    return null
  }
  const locateRef = useRef(locate)
  locateRef.current = locate
  useEffect(() => {
    if (!drag || !pointer.current?.moving) return
    const tick = () => {
      const pending = pointer.current
      if (!pending?.moving) return
      const scroll = sidebar.current?.closest<HTMLElement>('.source-nav')
      if (scroll) {
        const box = scroll.getBoundingClientRect()
        const distance = pending.y < box.top + 32 ? pending.y - box.top : box.bottom - pending.y
        if (distance < 32) {
          const before = scroll.scrollTop
          const speed = Math.min(16, Math.max(4, (32 - distance) / 2))
          scroll.scrollTop += pending.y < box.top + 32 ? -speed : speed
          if (scroll.scrollTop !== before) indicate(locateRef.current(pending.item, pending.x, pending.y))
        }
      }
      scrollFrame.current = requestAnimationFrame(tick)
    }
    scrollFrame.current = requestAnimationFrame(tick)
    return () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null }
  }, [drag])
  const rowProps = (row: string) => ({ 'data-organization-row': row, 'data-drop-edge': placement?.row === row && !(row.startsWith('["folder"') && placement.edge === 'after') ? placement.edge : undefined })
  const handle = (item: Drag) => <button type="button" className="organization-handle" data-organization-handle="" aria-label={`Move ${targetTitle(item)}`} aria-describedby={dragHelp} aria-pressed={drag !== null && (drag.kind === 'folder' && item.kind === 'folder' ? drag.folder.id === item.folder.id : drag.kind === 'feed' && item.kind === 'feed' && memberKey(drag.member) === memberKey(item.member))} disabled={!writable}
    onPointerDown={event => {
      if (!writable || event.button !== 0) return
      event.preventDefault(); event.currentTarget.focus(); returnFocus.current = event.currentTarget; event.currentTarget.setPointerCapture(event.pointerId)
      editRevision.current = snapshot?.revision ?? null
      pointer.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, item, moving: false }
    }}
    onPointerMove={event => {
      const pending = pointer.current
      if (!pending || pending.id !== event.pointerId) return
      if (!pending.moving && Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) < 4) return
      pending.moving = true; pending.x = event.clientX; pending.y = event.clientY
      setDrag(pending.item); setMenu(null); setDragPoint({ x: event.clientX, y: event.clientY })
      indicate(locate(pending.item, event.clientX, event.clientY))
    }}
    onPointerUp={event => { const pending = pointer.current; if (pending?.id === event.pointerId) { if (pending.moving) drop(pending.item); else cancelDrag() } }}
    onBlur={() => { if (!pointer.current?.moving) cancelDrag() }}
    onPointerCancel={cancelDrag}
    onLostPointerCapture={() => { if (pointer.current) cancelDrag() }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); cancelDrag(); return }
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault()
        if (!(item.kind === 'folder' ? capabilities?.orderFolders : capabilities?.orderFeeds)) { showMenu(item, event.currentTarget); return }
        if (drag) { drop(drag); return }
        returnFocus.current = event.currentTarget
        editRevision.current = snapshot?.revision ?? null
        keyboardIndex.current = item.kind === 'folder' ? folders.findIndex(folder => folder.id === item.folder.id) : feedsIn(item.member.folderId).findIndex(feed => feed.id === item.member.feed.id)
        setDrag(item); setMenu(null); indicate(null); return
      }
      if (drag && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
        const length = drag.kind === 'folder' ? folders.length : feedsIn(drag.member.folderId).length
        keyboardIndex.current = Math.max(0, Math.min(length - 1, keyboardIndex.current + (event.key === 'ArrowUp' ? -1 : 1)))
        indicate(orderPlacement(drag, keyboardIndex.current))
      }
      if (event.key === 'Tab') cancelDrag()
    }}><svg viewBox="0 0 12 18" aria-hidden="true">{[4, 9, 14].flatMap(y => [3, 8].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />))}</svg></button>
  const renderFeeds = (folderId: string | null) => <div className="feed-list">
    {feedsIn(folderId).filter(feed => organizing || drag !== null || !unreadOnly || feed.unread > 0).map(feed => {
      const member = { feed, folderId }, target: Target = { kind: 'feed', member }
      return <div key={feed.id}>
        <div className="feed-row-wrapper" {...rowProps(feedRow(member))}>
          {(capabilities?.moveFeed || capabilities?.orderFeeds) && handle(target)}
          {organizing && <input type="checkbox" aria-label={`Select ${feed.title} in ${folders.find(folder => folder.id === folderId)?.title || 'Uncategorized'}`} checked={selectedNow.some(item => memberKey(item) === memberKey(member))} onChange={event => setSelected(current => event.target.checked ? [...current, member] : current.filter(item => memberKey(item) !== memberKey(member)))} />}
          <button className={`feed-row ${active?.kind === 'feed' && active.id === feed.id ? 'active' : ''}`} onClick={() => onOpen({ kind: 'feed', id: feed.id, title: feed.title })} onContextMenu={event => { event.preventDefault(); showMenu(target, event.currentTarget, { x: event.clientX, y: event.clientY }) }} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); showMenu(target, event.currentTarget) } }}>
            <FeedMark title={feed.title} url={feed.siteUrl || feed.url} iconUrl={feed.iconUrl} /><span className="source-label">{feed.title}</span>{feed.unread > 0 && <span className="source-count">{feed.unread}</span>}
          </button>
          <button className="row-options" aria-label={`Options for ${feed.title}`} aria-haspopup="menu" onClick={event => showMenu(target, event.currentTarget)}>⋯</button>
        </div>
      </div>
    })}
    {feedsIn(folderId).length === 0 && <p className="organization-empty">No feeds</p>}
  </div>
  return <section ref={sidebar} className="organization-sidebar" aria-label="Feed organization" onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation() }}>
    <span id={dragHelp} className="visually-hidden">{capabilities?.orderFeeds || capabilities?.orderFolders ? 'Drag to reorder or move to a folder. With the keyboard, press Space, use Up or Down to reorder, then Space to drop. Escape cancels. Use the options menu to move between folders.' : 'Drag to move to a folder. Press Enter or Space for the options menu.'}</span>
    <span className="visually-hidden" role="status">{drag ? `${targetTitle(drag)} picked up. ${placement?.label || 'Choose a position.'}` : ''}</span>
    {drag && dragPoint && createPortal(<div className="organization-drag-preview" style={{ left: dragPoint.x + 12, top: dragPoint.y + 12 }} aria-hidden="true"><span>{targetTitle(drag)}</span>{placement && <small>{placement.label}</small>}</div>, document.body)}
    <div className="organization-header">
      <h2>{organizing ? `${selectedNow.length} selected` : 'Feeds'}</h2>
      {organizing ? <button ref={selectionDone} className="organization-done" disabled={busy} onClick={() => { setOrganizing(false); setSelected([]); returnFocus.current = null; restoreFocus() }}>Done</button> : <div className="organization-header-actions">
        {(['add', 'options'] as const).map(kind => <button key={kind} ref={kind === 'options' ? toolbar : undefined} className="icon-button" aria-label={kind === 'add' ? 'Add feed or folder' : 'Feed options'} title={kind === 'add' ? 'Add feed or folder' : 'Feed options'} aria-haspopup="menu" aria-expanded={headerMenu?.kind === kind} disabled={kind === 'add' ? !writable : busy} onClick={event => {
          cancelDrag(); setMenu(null); returnFocus.current = event.currentTarget
          editRevision.current = snapshot?.revision ?? null
          const box = event.currentTarget.getBoundingClientRect()
          setHeaderMenu({ kind, left: Math.max(8, Math.min(box.left, window.innerWidth - 268)), top: Math.max(8, Math.min(box.bottom, window.innerHeight - 420)) })
        }}>{kind === 'add' ? <Icon name="plus" /> : '⋯'}</button>)}
      </div>}
    </div>
    {organizing && <p className="organization-note">{capabilities?.conditionalWrites ? 'Select feeds to move them together. Use the grip to drag, or use the options menus.' : 'FreshRSS supports feed edits and unsubscribe. Folder management and ordering are unavailable. Bulk changes can partly succeed; concurrent remote edits cannot be revision-checked.'}</p>}
    {!online && <p className="organization-note">Connect to organize feeds.</p>}
    {feedback && <p className="organization-feedback" role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {(needsReload || !snapshot) && <button disabled={busy || !online} onClick={() => void reload()}>Reload organization</button>}
    {organizing && selectedNow.length > 0 && <div className="organization-bulk"><button disabled={!writable || !capabilities?.moveFeed || selectedNow.length > 200} onClick={event => { returnFocus.current = event.currentTarget; begin({ type: 'move', members: selectedNow }) }}>Move selected</button>{capabilities?.unsubscribe && <button disabled={!writable || selectedNow.length > 200} onClick={event => { returnFocus.current = event.currentTarget; begin({ type: 'unsubscribe', members: [...new Map(selectedNow.map(member => [member.feed.id, member])).values()] }) }}>Unsubscribe selected</button>}</div>}
    {folders.filter(folder => organizing || drag !== null || !unreadOnly || folder.unread > 0).map(folder => {
      const target: Target = { kind: 'folder', folder }
      return <div className="folder" key={folder.id} data-folder-drop-after={placement?.row === folderRow(folder.id) && placement.edge === 'after' ? true : undefined}>
        <div className="folder-row-wrapper" {...rowProps(folderRow(folder.id))}>
          {capabilities?.orderFolders && handle(target)}
          <button className="folder-expand" aria-label={`${expanded.has(folder.id) ? 'Collapse' : 'Expand'} ${folder.title}`} aria-expanded={expanded.has(folder.id)} onClick={() => toggle(folder.id)}><Icon name="chevron" className={expanded.has(folder.id) ? 'rotated' : ''} /></button>
          <button className={`folder-row ${active?.kind === 'category' && active.id === folder.id ? 'active' : ''}`} onClick={() => onOpen({ kind: 'category', id: folder.id, title: folder.title })} onContextMenu={event => { event.preventDefault(); showMenu(target, event.currentTarget, { x: event.clientX, y: event.clientY }) }} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); showMenu(target, event.currentTarget) } }}><span className="source-label">{folder.title}</span>{folder.unread > 0 && <span className="source-count">{folder.unread}</span>}</button>
          <button className="row-options" aria-label={`Options for ${folder.title}`} aria-haspopup="menu" onClick={event => showMenu(target, event.currentTarget)}>⋯</button>
        </div>
        {expanded.has(folder.id) && renderFeeds(folder.id)}
      </div>
    })}
    {((organizing && !namedUncategorized) || (navigation?.uncategorized || []).some(feed => !unreadOnly || feed.unread > 0) || (drag?.kind === 'feed' && !namedUncategorized)) && <div className="folder">
      <button className="folder-row" {...rowProps(folderRow(null))} aria-expanded={expanded.has(null)} onClick={() => toggle(null)}><Icon name="chevron" className={expanded.has(null) ? 'rotated' : ''} /><span className="source-label">Uncategorized</span></button>
      {expanded.has(null) && renderFeeds(null)}
    </div>}
    {headerMenu && createPortal(<OrganizationMenu menu={{ ...headerMenu, title: headerMenu.kind === 'add' ? 'Add' : 'Feeds' }} onClose={closeHeaderMenu}>
      {headerMenu.kind === 'add' ? <>
        <button role="menuitem" disabled={!writable} onClick={() => { setHeaderMenu(null); returnFocus.current?.focus(); onAddFeed() }}>Add feed</button>
        {capabilities?.createEmptyFolder && <button role="menuitem" disabled={!writable} onClick={() => begin({ type: 'create' })}>New folder</button>}
      </> : <button role="menuitem" disabled={busy} onClick={() => { setOrganizing(true); setSelected([]); setHeaderMenu(null); returnFocus.current = null; focusAfterClose.current = true }}>Select feeds</button>}
    </OrganizationMenu>, document.body)}
    {menu && createPortal(<OrganizationMenu menu={menu} onClose={closeMenu}>
      <button role="menuitem" onClick={() => { const target = menu.target; closeMenu(); onOpen(target.kind === 'feed' ? { kind: 'feed', id: target.member.feed.id, title: target.member.feed.title } : { kind: 'category', id: target.folder.id, title: target.folder.title }) }}>Open {menu.target.kind}</button>
      <button role="menuitem" disabled={(menu.target.kind === 'feed' ? menu.target.member.feed.unread : menu.target.folder.unread) === 0} onClick={() => { menu.target.kind === 'feed' ? onMarkFeed(menu.target.member.feed) : onMarkFolder(menu.target.folder); closeMenu() }}>Mark {menu.target.kind} read</button>
      {(menu.target.kind === 'feed' ? capabilities?.renameFeed : capabilities?.renameFolder) && <button role="menuitem" disabled={!writable} onClick={() => begin({ type: 'rename', target: menu.target })}>Rename {menu.target.kind}</button>}
      {menu.target.kind === 'feed' && <>
        {capabilities?.moveFeed && <button role="menuitem" disabled={!writable} onClick={() => menu.target.kind === 'feed' && begin({ type: 'move', members: [menu.target.member] })}>Move feed</button>}
        <button role="menuitem" onClick={() => { if (menu.target.kind === 'feed') onManage(menu.target.member.feed); closeMenu() }}>Feed settings</button>
        {menu.target.member.feed.siteUrl && <a role="menuitem" href={menu.target.member.feed.siteUrl} target="_blank" rel="noopener noreferrer" onClick={closeMenu}>Open website</a>}
        <button role="menuitem" onClick={() => { if (menu.target.kind === 'feed') void navigator.clipboard.writeText(menu.target.member.feed.url).then(() => setFeedback({ error: false, text: 'Feed URL copied' })).catch(() => setFeedback({ error: true, text: 'Could not copy feed URL' })); closeMenu() }}>Copy feed URL</button>
      </>}
      {menu.target.kind === 'folder' && capabilities?.atomicMerge && <button role="menuitem" disabled={!writable || folders.length < 2} onClick={() => menu.target.kind === 'folder' && begin({ type: 'merge', folder: menu.target.folder })}>Merge folder</button>}
      {(menu.target.kind === 'feed' ? capabilities?.orderFeeds : capabilities?.orderFolders) && [-1, 1].map(direction => {
        const items = menu.target.kind === 'folder' ? folders : feedsIn(menu.target.member.folderId)
        const index = items.findIndex(item => item.id === (menu.target.kind === 'folder' ? menu.target.folder.id : menu.target.member.feed.id))
        return <button role="menuitem" key={direction} disabled={!writable || index + direction < 0 || index + direction >= items.length} onClick={() => step(menu.target, direction as -1 | 1)}>Move {direction < 0 ? 'up' : 'down'}</button>
      })}
      {(menu.target.kind === 'feed' ? capabilities?.unsubscribe : capabilities?.removeFolder) && <button role="menuitem" className="danger" disabled={!writable} onClick={() => begin({ type: 'remove', target: menu.target })}>{menu.target.kind === 'feed' ? 'Unsubscribe' : 'Remove folder'}</button>}
    </OrganizationMenu>, document.body)}
    {action && createPortal(<OrganizationDialog action={action} folders={folders} multipleMemberships={!!capabilities?.multipleMemberships} defaultFolderLabel={namedUncategorized ? 'Default folder' : 'Uncategorized'} busy={busy} writable={writable} feedback={feedback} needsReload={needsReload} onReload={() => void reload()} onClose={closeAction} onSubmit={(commands, labels, moving) => void apply(commands, labels, moving)} />, document.body)}
  </section>
}

function OrganizationMenu({ menu, onClose, children }: { menu: { target?: Target; title?: string; left: number; top: number }; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const title = menu.target ? targetTitle(menu.target) : menu.title || 'Feeds'
  useMenuFocus(ref)
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [onClose])
  return <div ref={ref} className="feed-context-menu organization-menu" role="menu" aria-label={`${title} options`} style={{ left: menu.left, top: menu.top }} onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onClose() } }}><strong>{title}</strong>{children}</div>
}

function OrganizationDialog({ action, folders, multipleMemberships, defaultFolderLabel, busy, writable, feedback, needsReload, onReload, onClose, onSubmit }: {
  action: Action; folders: Folder[]; multipleMemberships: boolean; defaultFolderLabel: string; busy: boolean; writable: boolean
  feedback: { error: boolean; text: string } | null; needsReload: boolean; onReload: () => void; onClose: () => void
  onSubmit: (commands: OrganizationCommand[], labels: string[], moving?: Member[]) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocus(ref)
  const [title, setTitle] = useState(action.type === 'rename' ? targetTitle(action.target) : '')
  const [destination, setDestination] = useState(action.type === 'merge' ? folders.find(folder => folder.id !== action.folder.id)?.id || '' : '')
  const heading = action.type === 'unsubscribe' ? `Unsubscribe from ${action.members.length} ${action.members.length === 1 ? 'feed' : 'feeds'}?` : action.type === 'create' ? 'New folder' : action.type === 'rename' ? `Rename ${action.target.kind}` : action.type === 'move' ? 'Move feeds' : action.type === 'merge' ? `Merge ${action.folder.title}` : action.target.kind === 'feed' ? `Unsubscribe from ${targetTitle(action.target)}?` : `Remove ${targetTitle(action.target)}?`
  const submit = () => {
    if (action.type === 'unsubscribe') onSubmit(action.members.map(member => ({ type: 'unsubscribe', feedId: member.feed.id })), action.members.map(member => member.feed.title), action.members)
    else if (action.type === 'create') onSubmit([{ type: 'create-folder', title }], [title])
    else if (action.type === 'rename') onSubmit([action.target.kind === 'feed' ? { type: 'rename-feed', feedId: action.target.member.feed.id, title } : { type: 'rename-folder', folderId: action.target.folder.id, title }], [targetTitle(action.target)])
    else if (action.type === 'merge') onSubmit([{ type: 'merge-folders', sourceId: action.folder.id, destinationId: destination }], [action.folder.title])
    else if (action.type === 'move') onSubmit(action.members.map(member => ({ type: 'move-feed', feedId: member.feed.id, fromFolderId: member.folderId, toFolderId: destination || null })), action.members.map(member => member.feed.title), action.members)
    else onSubmit([action.target.kind === 'feed' ? { type: 'unsubscribe', feedId: action.target.member.feed.id } : { type: 'remove-folder', folderId: action.target.folder.id }], [targetTitle(action.target)])
  }
  return <div className="modal-backdrop organization-backdrop" onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation(); if (event.key === 'Escape' && !busy) onClose() }}><div ref={ref} role="dialog" aria-modal="true" aria-labelledby="organization-dialog-title" tabIndex={-1} className="organization-dialog">
    <h2 id="organization-dialog-title">{heading}</h2>
    <form onSubmit={event => { event.preventDefault(); if (writable) submit() }}>
      {(action.type === 'create' || action.type === 'rename') && <label>Name<input value={title} required maxLength={4096} onChange={event => setTitle(event.target.value)} /></label>}
      {(action.type === 'move' || action.type === 'merge') && <label>Destination<select value={destination} onChange={event => setDestination(event.target.value)}>{action.type === 'move' && <option value="">{defaultFolderLabel}</option>}{folders.filter(folder => action.type !== 'merge' || folder.id !== action.folder.id).map(folder => <option key={folder.id} value={folder.id}>{folder.title}</option>)}</select></label>}
      {action.type === 'move' && <><p>{action.members.map(member => member.feed.title).join(', ')}</p>{!multipleMemberships && <p>FreshRSS returns feeds without a chosen folder to its default category, which may appear as a named folder.</p>}{multipleMemberships && <p>Moves remove only the selected source membership. Other folders keep this feed. Choosing Uncategorized removes that membership; the feed appears there only when no memberships remain.</p>}</>}
      {action.type === 'merge' && <p>The destination keeps its name and order. New feeds append in source order, duplicate memberships appear once, and other folders keep their feeds. The source folder is removed.</p>}
      {action.type === 'unsubscribe' && <p>This stops new articles from {action.members.map(member => member.feed.title).join(', ')}. Saved article history, stars and reading positions stay available.</p>}
      {action.type === 'remove' && <p>{action.target.kind === 'folder' ? 'Subscriptions stay active. Feeds with no other folders move to Uncategorized. Feeds in other folders remain there. Article history, stars and reading positions stay saved.' : 'This stops new articles from this feed. Saved article history, stars and reading positions stay available.'}</p>}
      {feedback && <p role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
      {needsReload && <button type="button" disabled={busy} onClick={onReload}>Reload organization</button>}
      <div className="organization-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className={action.type === 'remove' || action.type === 'unsubscribe' ? 'danger' : 'primary'} disabled={!writable || ((action.type === 'rename' || action.type === 'create') && !title.trim()) || (action.type === 'merge' && !destination)}>{busy ? 'Saving...' : action.type === 'unsubscribe' ? 'Confirm unsubscribe' : action.type === 'remove' ? action.target.kind === 'feed' ? 'Confirm unsubscribe' : 'Confirm remove folder' : action.type === 'merge' ? 'Confirm merge' : 'Save'}</button></div>
    </form>
  </div></div>
}
