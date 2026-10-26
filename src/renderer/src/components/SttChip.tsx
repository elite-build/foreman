// Phase G2: what push-to-talk dictation is doing, in the sidebar next to the keep-awake chip. It is shown only while a
// session runs, as words and a shape (never colour alone), with the text heard so far. It is a status region that
// the screen reader is not made to read twice: the announcer already says "Listening" and "Heard: ..." (stt.ts), so
// this one is `aria-live="off"` and is there to be looked at, or read in browse mode.
import { useT } from '../i18n'
import { stt, useStt } from '../stt'
import { Button, Spinner, Status } from '../ui'
import './stt.css'

// The newest words are the ones that matter in a narrow sidebar.
const TAIL = 90
const tail = (text: string) => (text.length > TAIL ? `…${text.slice(-TAIL).trimStart()}` : text)

export function SttChip() {
  const t = useT()
  const { state, partial } = useStt()
  if (state === 'idle') return null
  const listening = state === 'listening'
  return (
    <div className="stt-chip" role="status" aria-live="off">
      <div className="stt-chip-line">
        <Status tone="info" label={listening ? t('stt.chip.listening') : t('stt.chip.transcribing')}>
          {!listening && <Spinner size={12} />}
        </Status>
        {listening && (
          <Button size="sm" variant="ghost" onClick={() => void stt.stop()} aria-label={t('stt.chip.stopLabel')}>
            {t('stt.chip.stop')}
          </Button>
        )}
      </div>
      {partial && <span className="stt-chip-partial faint small">{tail(partial)}</span>}
    </div>
  )
}
