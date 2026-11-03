// A paired computer asks to take control of this one, and the person here chose to be asked (Settings → Data &
// computers). Shown here whichever computer the window shows; unanswered, the request lapses after two minutes.
import { useT } from '../../i18n'
import { api, attempt, useStore } from '../../store'
import { Button, Dialog } from '../../ui'

export function ControlRequestDialog() {
  const t = useT()
  const request = useStore((s) => s.computers?.requests[0])
  if (!request) return null
  const answer = (allow: boolean) => void attempt(() => api.answerControlRequest(request.id, allow))
  return (
    <Dialog
      key={request.id}
      title={t('computers.request.title', { name: request.name })}
      onClose={() => answer(false)}
      closeOnBackdrop={false}
      footer={
        <>
          <Button onClick={() => answer(false)}>{t('computers.request.deny')}</Button>
          <Button variant="primary" onClick={() => answer(true)}>
            {t('computers.request.allow')}
          </Button>
        </>
      }
    >
      <p>{t('computers.request.body')}</p>
      <p className="small muted">{t('computers.request.lasts')}</p>
    </Dialog>
  )
}
