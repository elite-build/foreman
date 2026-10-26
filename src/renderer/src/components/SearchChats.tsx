import { Eye, Search } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { snippetParts } from '../../../shared/chatIndex'
import { compactModelLabel } from '../../../shared/handOff'
import type { ChatHit, NoteHit } from '../../../shared/types'
import { api, attempt, openChatHit, openNoteHit, timeAgo } from '../store'
import { useT } from '../i18n'
import { Checkbox, Combobox, Kbd, Tag } from '../ui'

/** The matched words of a snippet marked, so they stand out in the result. */
function Snippet({ text }: { text: string }) {
  return (
    <span className="chat-hit-text">
      {snippetParts(text).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </span>
  )
}

/** Search every chat in every workspace (⌘⇧F, Chats). Enter opens the tab at the message. */
export function SearchChats({ scopeSwitch }: { scopeSwitch: ReactNode }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [tools, setTools] = useState(false)
  const [hits, setHits] = useState<ChatHit[]>([])
  const [notes, setNotes] = useState<NoteHit[]>([])
  const [searching, setSearching] = useState(false)
  const latest = useRef(0)

  useEffect(() => {
    if (!query.trim()) {
      setHits([])
      setNotes([])
      return
    }
    const id = ++latest.current
    const timer = setTimeout(async () => {
      setSearching(true)
      const [found, foundNotes] = await Promise.all([attempt(() => api.searchChats(query, { includeToolOutput: tools })), attempt(() => api.searchNotes(query))])
      if (id === latest.current) {
        setHits(found ?? [])
        setNotes(foundNotes ?? [])
        setSearching(false)
      }
    }, 150)
    return () => clearTimeout(timer)
  }, [query, tools])

  const total = hits.length + notes.length
  const readOnly = (
    <Tag tone="outline" className="open-ro">
      <Eye size={10} aria-hidden /> {t('archivedView.search.tag')}
    </Tag>
  )
  // One list for both kinds: notes first, then chat messages (the old order). Each result is named by where it is;
  // the snippet, with the matched words marked, is its description.
  const options = [
    ...notes.map((hit) => ({
      value: `note:${hit.workspaceId}`,
      label: [hit.workspaceName, t('searchChats.noteRevision', { revision: hit.revision }), hit.archived && t('searchChats.archived')].filter(Boolean).join(' · '),
      description: (
        <>
          <Tag>{t('searchChats.noteTag')}</Tag> <Snippet text={hit.snippet} />
        </>
      ),
      trailing: hit.archived ? readOnly : undefined
    })),
    ...hits.map((hit) => ({
      value: `chat:${hit.sessionId}:${hit.itemId}`,
      label: [hit.workspaceName, hit.tabTitle || t('searchChats.untitled'), compactModelLabel(hit.agent, hit.model), timeAgo(hit.at), hit.archived && t('searchChats.archived'), hit.closed && t('searchChats.closedTab'), hit.cleared && t('searchChats.cleared')]
        .filter(Boolean)
        .join(' · '),
      description: (
        <>
          {hit.kind === 'tool' && <Tag>{t('searchChats.toolTag')}</Tag>} {hit.kind === 'user' && <span>{t('searchChats.you')} </span>}
          <Snippet text={hit.snippet} />
        </>
      ),
      trailing: hit.archived ? readOnly : undefined
    }))
  ]
  const open = (value: string) => {
    if (value.startsWith('note:')) {
      const hit = notes.find((n) => `note:${n.workspaceId}` === value)
      if (hit) void openNoteHit(hit)
      return
    }
    const hit = hits.find((h) => `chat:${h.sessionId}:${h.itemId}` === value)
    if (hit) void openChatHit(hit)
  }

  return (
    <>
      <div className="overlay-options faint small">
        <span>{t('searchChats.scope')}</span>
        <Checkbox checked={tools} onChange={(e) => setTools(e.target.checked)}>
          {t('searchChats.includeTools')}
        </Checkbox>
      </div>
      <Combobox
        className="overlay-combo"
        label={t('searchChats.placeholder')}
        placeholder={t('searchChats.placeholder')}
        autoFocus
        inline
        open
        leading={<Search size={15} aria-hidden />}
        trailing={scopeSwitch}
        query={query}
        onQueryChange={setQuery}
        empty={searching && total === 0 ? t('overlays.searching') : !searching && query.trim() && total === 0 ? t('overlays.noMatches') : undefined}
        options={options}
        // #13: said once here rather than on every row.
        footer={
          [...notes, ...hits].some((hit) => hit.archived) ? (
            <div className="overlay-foot">
              <span>
                <Kbd>↵</Kbd> {t('archivedView.search.open')}
              </span>
              <span>{t('archivedView.search.foot')}</span>
            </div>
          ) : undefined
        }
        onChange={open}
      />
    </>
  )
}
