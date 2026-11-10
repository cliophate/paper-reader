import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
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
type Drag = { kind: 'feed'; member: Member } | { kind: 'folder'; folder: Folder }
const memberKey = (member: Member) => JSON.stringify([member.folderId, member.feed.id])
const targetTitle = (target: Target) => target.kind === 'feed' ? target.member.feed.title : target.folder.title

export function OrganizationSidebar({ snapshot, navigation, active, unreadOnly, online, onSnapshot, onOpen, onMarkFeed, onMarkFolder, onManage }: {
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
}) {
  const [expanded, setExpanded] = useState(new Set<string | null>())
  const [organizing, setOrganizing] = useState(false)
  const [selected, setSelected] = useState<Member[]>([])
  const [menu, setMenu] = useState<{ target: Target; left: number; top: number } | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const editRevision = useRef<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const focusAfterClose = useRef(false)
  const toolbar = useRef<HTMLButtonElement>(null)
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
    if (menu || action || !focusAfterClose.current) return
    focusAfterClose.current = false
    if (returnFocus.current?.isConnected) returnFocus.current.focus()
    else toolbar.current?.focus()
  }, [menu, action, snapshot])
  const closeMenu = () => { setMenu(null); restoreFocus() }
  const closeAction = () => { setAction(null); restoreFocus() }
  const begin = (next: Action) => { if (!menu) editRevision.current = snapshot?.revision ?? null; setMenu(null); setFeedback(null); setAction(next) }
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
  const startDrag = (event: DragEvent, item: Drag) => {
    if (!writable) { event.preventDefault(); return }
    editRevision.current = snapshot?.revision ?? null
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', item.kind === 'feed' ? item.member.feed.id : item.folder.id)
    setDrag(item); setMenu(null)
  }
  const dropTarget = (label: string, run: () => void) => <DropTarget label={label} onDrop={() => { setDrag(null); run() }} />
  const renderFeeds = (folderId: string | null) => <div className="feed-list">
    {feedsIn(folderId).filter(feed => organizing || drag !== null || !unreadOnly || feed.unread > 0).map(feed => {
      const member = { feed, folderId }, target: Target = { kind: 'feed', member }
      return <div key={feed.id}>
        {drag?.kind === 'feed' && drag.member.folderId === folderId && drag.member.feed.id !== feed.id && capabilities?.orderFeeds && dropTarget(`Place before ${feed.title}`, () => reorderFeed(drag.member, feed.id))}
        <div className="feed-row-wrapper">
          {organizing && <input type="checkbox" aria-label={`Select ${feed.title} in ${folders.find(folder => folder.id === folderId)?.title || 'Uncategorized'}`} checked={selectedNow.some(item => memberKey(item) === memberKey(member))} onChange={event => setSelected(current => event.target.checked ? [...current, member] : current.filter(item => memberKey(item) !== memberKey(member)))} />}
          <button className={`feed-row ${active?.kind === 'feed' && active.id === feed.id ? 'active' : ''}`} draggable={writable && (capabilities?.moveFeed || capabilities?.orderFeeds)} onDragStart={event => startDrag(event, { kind: 'feed', member })} onDragEnd={() => setDrag(null)} onClick={() => onOpen({ kind: 'feed', id: feed.id, title: feed.title })} onContextMenu={event => { event.preventDefault(); showMenu(target, event.currentTarget, { x: event.clientX, y: event.clientY }) }} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); showMenu(target, event.currentTarget) } }}>
            <FeedMark title={feed.title} url={feed.siteUrl || feed.url} iconUrl={feed.iconUrl} /><span className="source-label">{feed.title}</span>{feed.unread > 0 && <span className="source-count">{feed.unread}</span>}
          </button>
          <button className="row-options" aria-label={`Options for ${feed.title}`} aria-haspopup="menu" onClick={event => showMenu(target, event.currentTarget)}>⋯</button>
        </div>
      </div>
    })}
    {drag?.kind === 'feed' && drag.member.folderId === folderId && capabilities?.orderFeeds && dropTarget('Place at end of feeds', () => reorderFeed(drag.member, null))}
    {feedsIn(folderId).length === 0 && <p className="organization-empty">No feeds</p>}
  </div>
  return <section className="organization-sidebar" aria-label="Feed organization" onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation() }}>
    <div className="organization-toolbar">
      <button ref={toolbar} aria-pressed={organizing} onClick={() => { setOrganizing(value => !value); setSelected([]) }}>{organizing ? 'Done organizing' : 'Organize feeds'}</button>
      {capabilities?.createEmptyFolder && <button disabled={!writable} onClick={event => { returnFocus.current = event.currentTarget; begin({ type: 'create' }) }}>New folder</button>}
    </div>
    {organizing && <p className="organization-note">{capabilities?.conditionalWrites ? 'Select feeds to move them together. Drag to a visible target or use the options menus.' : 'FreshRSS supports feed edits and unsubscribe. Folder management and ordering are unavailable. Bulk changes can partly succeed; concurrent remote edits cannot be revision-checked.'}</p>}
    {drag?.kind === 'feed' && capabilities?.multipleMemberships && <p className="organization-note">Moving removes only the source membership. Other folders keep this feed.</p>}
    {!online && <p className="organization-note">Connect to organize feeds.</p>}
    {feedback && <p className="organization-feedback" role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {(needsReload || !snapshot) && <button disabled={busy || !online} onClick={() => void reload()}>Reload organization</button>}
    {organizing && selectedNow.length > 0 && <div className="organization-bulk"><span>{selectedNow.length} selected</span><button disabled={!writable || !capabilities?.moveFeed || selectedNow.length > 200} onClick={event => { returnFocus.current = event.currentTarget; begin({ type: 'move', members: selectedNow }) }}>Move selected</button>{capabilities?.unsubscribe && <button disabled={!writable || selectedNow.length > 200} onClick={event => { returnFocus.current = event.currentTarget; begin({ type: 'unsubscribe', members: [...new Map(selectedNow.map(member => [member.feed.id, member])).values()] }) }}>Unsubscribe selected</button>}<button onClick={() => setSelected([])}>Clear selection</button></div>}
    {folders.filter(folder => organizing || drag !== null || !unreadOnly || folder.unread > 0).map(folder => {
      const target: Target = { kind: 'folder', folder }
      return <div className="folder" key={folder.id}>
        {drag?.kind === 'folder' && drag.folder.id !== folder.id && capabilities?.orderFolders && dropTarget(`Place before ${folder.title}`, () => void apply([{ type: 'move-folder', folderId: drag.folder.id, beforeId: folder.id }], [drag.folder.title]))}
        <div className="folder-row-wrapper">
          <button className="folder-expand" aria-label={`${expanded.has(folder.id) ? 'Collapse' : 'Expand'} ${folder.title}`} aria-expanded={expanded.has(folder.id)} onClick={() => toggle(folder.id)}><Icon name="chevron" className={expanded.has(folder.id) ? 'rotated' : ''} /></button>
          <button className={`folder-row ${active?.kind === 'category' && active.id === folder.id ? 'active' : ''}`} draggable={writable && capabilities?.orderFolders} onDragStart={event => startDrag(event, { kind: 'folder', folder })} onDragEnd={() => setDrag(null)} onClick={() => onOpen({ kind: 'category', id: folder.id, title: folder.title })} onContextMenu={event => { event.preventDefault(); showMenu(target, event.currentTarget, { x: event.clientX, y: event.clientY }) }} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); showMenu(target, event.currentTarget) } }}><span className="source-label">{folder.title}</span>{folder.unread > 0 && <span className="source-count">{folder.unread}</span>}</button>
          <button className="row-options" aria-label={`Options for ${folder.title}`} aria-haspopup="menu" onClick={event => showMenu(target, event.currentTarget)}>⋯</button>
        </div>
        {drag?.kind === 'feed' && drag.member.folderId !== folder.id && capabilities?.moveFeed && dropTarget(`Move to ${folder.title}`, () => void apply([{ type: 'move-feed', feedId: drag.member.feed.id, fromFolderId: drag.member.folderId, toFolderId: folder.id }], [drag.member.feed.title]))}
        {expanded.has(folder.id) && renderFeeds(folder.id)}
      </div>
    })}
    {drag?.kind === 'folder' && capabilities?.orderFolders && dropTarget('Place at end of folders', () => void apply([{ type: 'move-folder', folderId: drag.folder.id, beforeId: null }], [drag.folder.title]))}
    {((organizing && !namedUncategorized) || (navigation?.uncategorized || []).some(feed => !unreadOnly || feed.unread > 0) || (drag?.kind === 'feed' && !namedUncategorized)) && <div className="folder">
      <button className="folder-row" aria-expanded={expanded.has(null)} onClick={() => toggle(null)}><Icon name="chevron" className={expanded.has(null) ? 'rotated' : ''} /><span className="source-label">Uncategorized</span></button>
      {drag?.kind === 'feed' && drag.member.folderId !== null && capabilities?.moveFeed && dropTarget(capabilities.multipleMemberships ? 'Remove from source folder' : 'Move to Uncategorized', () => void apply([{ type: 'move-feed', feedId: drag.member.feed.id, fromFolderId: drag.member.folderId, toFolderId: null }], [drag.member.feed.title]))}
      {expanded.has(null) && renderFeeds(null)}
    </div>}
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

function DropTarget({ label, onDrop }: { label: string; onDrop: () => void }) {
  const [over, setOver] = useState(false)
  return <div className={`organization-drop ${over ? 'over' : ''}`} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(true) }} onDragLeave={() => setOver(false)} onDrop={event => { event.preventDefault(); setOver(false); onDrop() }}>{label}</div>
}

function OrganizationMenu({ menu, onClose, children }: { menu: { target: Target; left: number; top: number }; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useMenuFocus(ref)
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [onClose])
  return <div ref={ref} className="feed-context-menu organization-menu" role="menu" aria-label={`${targetTitle(menu.target)} options`} style={{ left: menu.left, top: menu.top }} onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onClose() } }}><strong>{targetTitle(menu.target)}</strong>{children}</div>
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
