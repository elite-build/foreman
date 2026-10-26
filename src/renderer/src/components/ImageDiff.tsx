// Image before/after in the workspace diff (#19, G3): a changed picture shows
// side by side, or as a swipe (drag the handle to wipe between the two). The
// before side is the file at the branch point, read from git; the after side
// is the worktree's file. Both are data URLs in <img>, so an SVG never runs.
import { useEffect, useState } from 'react'
import { imageDiffSides, swipePercent, type ImageDiffMode } from '../../../shared/imageDiff'
import { imageMetaLabel, type ImagePreview } from '../../../shared/imageInfo'
import type { DiffFile } from '../../../shared/types'
import { useT } from '../i18n'
import { api } from '../store'
import { Range, Segmented } from '../ui'

const MODE_KEY = 'switchyard:imageDiffMode'

function loadMode(): ImageDiffMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'swipe' ? 'swipe' : 'side'
  } catch {
    return 'side'
  }
}

type Side = { state: 'loading' } | { state: 'ready'; image: ImagePreview } | { state: 'failed'; error: string }

function useImage(load: (() => Promise<ImagePreview>) | null, key: string): Side | null {
  const [side, setSide] = useState<Side | null>(load ? { state: 'loading' } : null)
  useEffect(() => {
    if (!load) return setSide(null)
    let live = true
    setSide({ state: 'loading' })
    load().then(
      (image) => live && setSide({ state: 'ready', image }),
      (err: unknown) => live && setSide({ state: 'failed', error: err instanceof Error ? err.message : String(err) })
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return side
}

/** Whether the diff draws this file as pictures rather than "Binary file". */
export function showsImageDiff(file: DiffFile, mergeBase: string | undefined): boolean {
  return file.binary && imageDiffSides(file, mergeBase) !== null
}

export function ImageDiff({ file, workspaceId, mergeBase }: { file: DiffFile; workspaceId: string; mergeBase?: string }) {
  const t = useT()
  const sides = imageDiffSides(file, mergeBase)
  const [mode, setMode] = useState<ImageDiffMode>(loadMode)
  const [swipe, setSwipe] = useState(50)
  const key = `${workspaceId}:${file.path}:${file.blobId ?? ''}:${mergeBase ?? ''}`
  const before = useImage(sides?.before && mergeBase ? () => api.readImageAt(workspaceId, sides.before!, mergeBase) : null, `b:${key}`)
  const after = useImage(sides?.after ? () => api.readImage(workspaceId, sides.after!) : null, `a:${key}`)
  if (!sides) return null
  const both = Boolean(sides.before && sides.after)
  const pick = (next: ImageDiffMode) => {
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      // Not remembered; fine.
    }
  }
  const ready = (side: Side | null) => (side?.state === 'ready' && !side.image.tooLarge && side.image.dataUrl ? side.image : null)
  const label = (which: 'before' | 'after', side: Side | null) => (
    <div className="image-diff-label">
      <span className={`image-diff-tag ${which}`}>{t(which === 'before' ? 'imageDiff.before' : 'imageDiff.after')}</span>
      <span className="faint">
        {side?.state === 'ready'
          ? imageMetaLabel(side.image, t)
          : side?.state === 'failed'
            ? side.error
            : side?.state === 'loading'
              ? t('imageDiff.loading')
              : t(which === 'before' ? 'imageDiff.none.before' : 'imageDiff.none.after')}
      </span>
    </div>
  )
  const picture = (side: Side | null) => {
    const image = ready(side)
    if (image) return <img src={image.dataUrl} alt="" draggable={false} />
    if (side?.state === 'ready' && side.image.tooLarge) return <span className="faint small">{t('imageDiff.tooLarge')}</span>
    return null
  }
  const swipeable = both && ready(before) && ready(after)
  return (
    <div className="image-diff">
      {both && (
        <div className="image-diff-tools">
          <Segmented
            plain
            small
            label={t('imageDiff.mode')}
            value={mode}
            onChange={pick}
            options={[
              { value: 'side', label: t('imageDiff.side') },
              { value: 'swipe', label: t('imageDiff.swipe') }
            ]}
          />
          <span className="faint small">{t('imageDiff.where')}</span>
        </div>
      )}
      {mode === 'swipe' && swipeable ? (
        <div className="image-diff-swipe">
          <div className="image-diff-swipe-labels">
            {label('before', before)}
            {label('after', after)}
          </div>
          <div className="image-diff-stage preview-checker">
            <img className="swipe-before" src={ready(before)!.dataUrl} alt="" draggable={false} />
            <img className="swipe-after" src={ready(after)!.dataUrl} alt="" draggable={false} style={{ clipPath: `inset(0 0 0 ${swipe}%)` }} />
            <span className="swipe-handle" style={{ left: `${swipe}%` }} aria-hidden />
          </div>
          <Range
            className="image-diff-range"
            min={0}
            max={100}
            value={swipe}
            aria-label={t('imageDiff.swipeLabel')}
            valueText={`${swipe}%`}
            onChange={(e) => setSwipe(swipePercent(Number(e.target.value)))}
          />
        </div>
      ) : (
        <div className="image-diff-side">
          {/* An added picture has no before, a deleted one no after: the empty side says so. */}
          <div className="image-diff-pane">
            {label('before', before)}
            <div className="image-diff-frame preview-checker">{picture(before)}</div>
          </div>
          <div className="image-diff-pane">
            {label('after', after)}
            <div className="image-diff-frame preview-checker">{picture(after)}</div>
          </div>
        </div>
      )}
    </div>
  )
}
