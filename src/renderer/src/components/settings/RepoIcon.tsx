// Repository icons: how one is drawn, and the picker on the Misc page.
import { icons, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PlainKey } from '../../../../shared/i18n'
import type { Repo, RepoIcon } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api } from '../../store'
import { Button, FileInput, IconButton, LinkButton, Popover, Segmented, TextInput } from '../../ui'
import { saveRepo } from './controls'

const ICONS = icons as unknown as Record<string, LucideIcon>

/** A lucide icon by name; accepts PascalCase ("SquareTerminal") and kebab-case ("square-terminal"). */
export function lucideIcon(name: string | undefined): LucideIcon | undefined {
  if (!name) return undefined
  if (ICONS[name]) return ICONS[name]
  const pascal = name
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
  return ICONS[pascal]
}

/** The repo's icon, or its first letter when it has none. */
export function RepoIconView({ icon, name, size = 16 }: { icon?: RepoIcon; name: string; size?: number }) {
  if (icon?.kind === 'lucide') {
    const Icon = lucideIcon(icon.name)
    if (Icon) return <Icon size={size} className="repo-icon-glyph" aria-hidden />
  }
  if (icon?.kind === 'emoji') {
    return (
      <span className="repo-icon-emoji" style={{ fontSize: Math.round(size * 0.95), width: size, height: size }} aria-hidden>
        {icon.value}
      </span>
    )
  }
  if (icon?.kind === 'image') return <img className="repo-icon-image" src={icon.dataUrl} alt="" width={size} height={size} />
  return (
    <span className="repo-icon-letter" style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }} aria-hidden>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

// ---- image helpers ----

const MAX_UPLOAD = 10 * 1024 * 1024
const ICON_PIXELS = 64

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** Scale an image down to icon size (64px on the long side) as a PNG data URL. */
async function toIconDataUrl(src: string): Promise<string> {
  const img = new Image()
  img.src = src
  await img.decode()
  const width = img.naturalWidth || ICON_PIXELS
  const height = img.naturalHeight || ICON_PIXELS
  const scale = Math.min(1, ICON_PIXELS / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

// ---- picker ----

type PickerTab = 'icons' | 'emoji' | 'favicon' | 'upload'

export function RepoIconPicker({ repo }: { repo: Repo }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<PickerTab>(repo.icon?.kind === 'emoji' ? 'emoji' : repo.icon?.kind === 'image' ? 'upload' : 'icons')
  const close = () => setOpen(false)

  const pick = async (icon: RepoIcon | null) => {
    if (await saveRepo(repo.id, { icon })) close()
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      label={t('repoIcon.dialog')}
      panelClassName="repo-icon-popover"
      trigger={(pop) => (
        <IconButton {...pop} variant="framed" className="repo-icon-button" label={t('repoIcon.change')}>
          <RepoIconView icon={repo.icon} name={repo.name} size={18} />
        </IconButton>
      )}
    >
      <div className="repo-icon-tabs">
        <Segmented<PickerTab>
          label={t('repoIcon.source')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'icons', label: t('repoIcon.tab.icons') },
            { value: 'emoji', label: t('repoIcon.tab.emoji') },
            { value: 'favicon', label: t('repoIcon.tab.favicon') },
            { value: 'upload', label: t('repoIcon.tab.upload') }
          ]}
        />
      </div>
      <div className="repo-icon-pane">
        {tab === 'icons' && <IconsTab current={repo.icon} onPick={(name) => void pick({ kind: 'lucide', name })} />}
        {tab === 'emoji' && <EmojiTab current={repo.icon} onPick={(value) => void pick({ kind: 'emoji', value })} />}
        {tab === 'favicon' && <FaviconTab repoId={repo.id} current={repo.icon} onPick={(dataUrl) => void pick({ kind: 'image', dataUrl })} />}
        {tab === 'upload' && <UploadTab current={repo.icon} onPick={(dataUrl) => void pick({ kind: 'image', dataUrl })} />}
      </div>
      {repo.icon && (
        <div className="repo-icon-foot">
          <LinkButton size="sm" onClick={() => void pick(null)}>
            {t('repoIcon.remove')}
          </LinkButton>
        </div>
      )}
    </Popover>
  )
}

// Shown before searching.
const POPULAR_ICONS = [
  'Code', 'Terminal', 'Globe', 'Rocket', 'Package', 'Box', 'Database', 'Server', 'Cloud', 'Cpu', 'Smartphone', 'Monitor',
  'Laptop', 'BookOpen', 'FileCode', 'Folder', 'GitBranch', 'Zap', 'Flame', 'Leaf', 'Star', 'Heart', 'Coffee', 'Puzzle',
  'Layers', 'Shield', 'Lock', 'Bot', 'Brain', 'Gamepad2', 'Music', 'Camera', 'Image', 'Palette', 'Wrench', 'Cog',
  'Atom', 'Sparkles', 'Store', 'ShoppingCart', 'Wallet', 'ChartLine', 'Map', 'Compass', 'Mail', 'MessageSquare',
  'Calendar', 'Users', 'House', 'Truck', 'Plane', 'Anchor', 'Feather', 'PenTool', 'Blocks', 'Container', 'Webhook',
  'Workflow', 'Braces', 'FlaskConical'
].filter((name) => ICONS[name])

const SEARCH_LIMIT = 120

function IconsTab({ current, onPick }: { current?: RepoIcon; onPick: (name: string) => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const names = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/[\s_-]+/g, '')
    if (!q) return POPULAR_ICONS
    const all = Object.keys(ICONS)
    const starts = all.filter((n) => n.toLowerCase().startsWith(q))
    const contains = all.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q))
    return [...starts, ...contains].slice(0, SEARCH_LIMIT)
  }, [query])
  const selected = current?.kind === 'lucide' ? current.name : undefined
  return (
    <>
      <TextInput className="repo-icon-search" type="search" autoFocus placeholder={t('repoIcon.searchIcons')} aria-label={t('repoIcon.searchIcons')} value={query} onChange={(e) => setQuery(e.target.value)} />
      {names.length ? (
        <div className="repo-icon-grid">
          {names.map((name) => {
            const Icon = ICONS[name]
            return (
              <IconButton key={name} className="repo-icon-cell" label={name} pressed={selected === name} onClick={() => onPick(name)}>
                <Icon size={16} />
              </IconButton>
            )
          })}
        </div>
      ) : (
        <p className="repo-icon-hint">{t('repoIcon.noIcons', { query: query.trim() })}</p>
      )}
    </>
  )
}

// Search words (English, matched in every language) and the emoji's name.
const EMOJI: [string, string, PlainKey][] = [
  ['🚀', 'rocket launch', 'repoIcon.emoji.rocket'], ['⚡', 'zap lightning fast', 'repoIcon.emoji.zap'], ['🔥', 'fire hot', 'repoIcon.emoji.fire'], ['✨', 'sparkles magic', 'repoIcon.emoji.sparkles'], ['🌱', 'seedling plant grow', 'repoIcon.emoji.seedling'],
  ['🌊', 'wave water ocean', 'repoIcon.emoji.wave'], ['🌈', 'rainbow', 'repoIcon.emoji.rainbow'], ['⭐', 'star', 'repoIcon.emoji.star'], ['🍀', 'clover luck', 'repoIcon.emoji.clover'], ['🌵', 'cactus desert', 'repoIcon.emoji.cactus'],
  ['🍕', 'pizza food', 'repoIcon.emoji.pizza'], ['☕', 'coffee java', 'repoIcon.emoji.coffee'], ['🍩', 'donut', 'repoIcon.emoji.donut'], ['🍎', 'apple fruit', 'repoIcon.emoji.apple'], ['🐙', 'octopus', 'repoIcon.emoji.octopus'],
  ['🦊', 'fox', 'repoIcon.emoji.fox'], ['🐳', 'whale docker', 'repoIcon.emoji.whale'], ['🐝', 'bee', 'repoIcon.emoji.bee'], ['🦄', 'unicorn', 'repoIcon.emoji.unicorn'], ['🐧', 'penguin linux', 'repoIcon.emoji.penguin'],
  ['🐍', 'snake python', 'repoIcon.emoji.snake'], ['🦀', 'crab rust', 'repoIcon.emoji.crab'], ['🐘', 'elephant php postgres', 'repoIcon.emoji.elephant'], ['🤖', 'robot bot ai', 'repoIcon.emoji.robot'], ['🧠', 'brain ai', 'repoIcon.emoji.brain'],
  ['👾', 'alien game', 'repoIcon.emoji.alien'], ['🎮', 'game controller', 'repoIcon.emoji.game'], ['🎨', 'art palette design', 'repoIcon.emoji.art'], ['🎵', 'music note', 'repoIcon.emoji.music'], ['📦', 'package box', 'repoIcon.emoji.package'],
  ['🧩', 'puzzle piece', 'repoIcon.emoji.puzzle'], ['🛠️', 'tools hammer wrench', 'repoIcon.emoji.tools'], ['⚙️', 'gear settings', 'repoIcon.emoji.gear'], ['🧪', 'test tube lab', 'repoIcon.emoji.test'], ['🔬', 'microscope science', 'repoIcon.emoji.microscope'],
  ['📱', 'phone mobile', 'repoIcon.emoji.phone'], ['💻', 'laptop computer', 'repoIcon.emoji.laptop'], ['🖥️', 'desktop computer monitor', 'repoIcon.emoji.desktop'], ['🌐', 'globe web internet', 'repoIcon.emoji.globe'], ['☁️', 'cloud', 'repoIcon.emoji.cloud'],
  ['🗄️', 'database cabinet storage', 'repoIcon.emoji.database'], ['🔒', 'lock security', 'repoIcon.emoji.lock'], ['🔑', 'key auth', 'repoIcon.emoji.key'], ['💡', 'idea light bulb', 'repoIcon.emoji.idea'], ['📚', 'books docs', 'repoIcon.emoji.books'],
  ['📝', 'memo notes', 'repoIcon.emoji.memo'], ['📊', 'chart data analytics', 'repoIcon.emoji.chart'], ['💰', 'money bag', 'repoIcon.emoji.money'], ['🛒', 'cart shop store', 'repoIcon.emoji.cart'], ['🏠', 'house home', 'repoIcon.emoji.house'],
  ['🏗️', 'construction build', 'repoIcon.emoji.construction'], ['🚗', 'car', 'repoIcon.emoji.car'], ['✈️', 'plane travel', 'repoIcon.emoji.plane'], ['🗺️', 'map', 'repoIcon.emoji.map'], ['🎯', 'target goal', 'repoIcon.emoji.target'],
  ['🏆', 'trophy win', 'repoIcon.emoji.trophy'], ['❤️', 'heart love', 'repoIcon.emoji.heart'], ['💎', 'gem diamond ruby', 'repoIcon.emoji.gem'], ['🔮', 'crystal ball', 'repoIcon.emoji.crystal'], ['🧭', 'compass', 'repoIcon.emoji.compass']
]

const PICTOGRAPH = /\p{Extended_Pictographic}/u

function EmojiTab({ current, onPick }: { current?: RepoIcon; onPick: (emoji: string) => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const typed = query.trim()
  // A pasted or typed emoji can be used directly.
  const literal = PICTOGRAPH.test(typed) ? typed : null
  const q = typed.toLowerCase()
  const list = literal ? [] : EMOJI.filter(([, words, label]) => !q || words.includes(q) || t(label).toLowerCase().includes(q))
  const selected = current?.kind === 'emoji' ? current.value : undefined
  return (
    <>
      <TextInput className="repo-icon-search" type="search" autoFocus placeholder={t('repoIcon.searchEmojiPlaceholder')} aria-label={t('repoIcon.searchEmoji')} value={query} onChange={(e) => setQuery(e.target.value)} />
      {literal ? (
        <div className="repo-emoji-literal">
          <span className="repo-emoji-big">{literal}</span>
          <Button size="sm" onClick={() => onPick(literal)}>
            {t('repoIcon.useEmoji')}
          </Button>
        </div>
      ) : list.length ? (
        <div className="repo-icon-grid">
          {list.map(([emoji, , label]) => (
            <IconButton key={emoji} className="repo-icon-cell" label={t(label)} pressed={selected === emoji} onClick={() => onPick(emoji)}>
              <span className="repo-emoji-cell">{emoji}</span>
            </IconButton>
          ))}
        </div>
      ) : (
        <p className="repo-icon-hint">{t('repoIcon.noEmoji', { query: typed })}</p>
      )}
    </>
  )
}

function FaviconTab({ repoId, current, onPick }: { repoId: string; current?: RepoIcon; onPick: (dataUrl: string) => void }) {
  const t = useT()
  const [state, setState] = useState<{ status: 'loading' } | { status: 'found'; dataUrl: string } | { status: 'none' } | { status: 'error' }>({ status: 'loading' })
  useEffect(() => {
    let live = true
    api
      .detectRepoIcon(repoId)
      .then(async (found) => {
        if (!found) return live && setState({ status: 'none' })
        // Store it at icon size, like an upload.
        const dataUrl = await toIconDataUrl(found).catch(() => found)
        if (live) setState({ status: 'found', dataUrl })
      })
      .catch(() => live && setState({ status: 'error' }))
    return () => {
      live = false
    }
  }, [repoId])

  if (state.status === 'loading') return <p className="repo-icon-hint">{t('repoIcon.favicon.looking')}</p>
  if (state.status === 'error') return <p className="repo-icon-hint">{t('repoIcon.favicon.error')}</p>
  if (state.status === 'none') {
    return (
      <div className="repo-icon-message">
        <div className="repo-icon-message-title">{t('repoIcon.favicon.none')}</div>
        <p className="repo-icon-hint">
          {t.rich('repoIcon.favicon.where', { first: <code>public/favicon.svg</code>, second: <code>apple-touch-icon.png</code> })}
        </p>
      </div>
    )
  }
  const using = current?.kind === 'image' && current.dataUrl === state.dataUrl
  return (
    <div className="repo-icon-message">
      <div className="repo-favicon">
        <img src={state.dataUrl} alt="" width={32} height={32} />
        <span>{t('repoIcon.favicon.detected')}</span>
      </div>
      <Button size="sm" disabled={using} onClick={() => onPick(state.dataUrl)}>
        {using ? t('repoIcon.favicon.using') : t('repoIcon.favicon.use')}
      </Button>
    </div>
  )
}

function UploadTab({ current, onPick }: { current?: RepoIcon; onPick: (dataUrl: string) => void }) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const choose = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (file.size > MAX_UPLOAD) return setError(t('repoIcon.upload.tooLarge'))
    setBusy(true)
    try {
      onPick(await toIconDataUrl(await readAsDataUrl(file)))
    } catch {
      setError(t('repoIcon.upload.unreadable'))
    } finally {
      setBusy(false)
    }
  }

  const label = busy ? t('repoIcon.upload.resizing') : current?.kind === 'image' ? t('repoIcon.upload.replace') : t('repoIcon.upload.choose')
  return (
    <div className="repo-icon-message">
      <p className="repo-icon-hint">{t('repoIcon.upload.hint')}</p>
      <FileInput
        accept="image/*"
        aria-label={label}
        chooseLabel={label}
        noneLabel=""
        showNames={false}
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          void choose(file)
        }}
      />
      {error && (
        <p className="repo-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
