// The pages an employee made, such as a mock kept in the memory repository: one button each, opening it in the browser,
// where its scripts run and its links reach the pages beside it. A folder's index.html stands for the rest (memoryPages).
import { Globe } from 'lucide-react'
import { memoryPages } from '../../../../shared/memory'
import { useT } from '../../i18n'
import { api, attempt } from '../../store'
import { Button } from '../../ui'

/** Its folder and its name: sidebar-simplify/index.html. */
const pageName = (path: string) => path.split('/').slice(-2).join('/')

export function PageLinks({ orgId, files }: { orgId: string; files: readonly string[] | undefined }) {
  const t = useT()
  const pages = memoryPages(files ?? [])
  if (!pages.length) return null
  return (
    <div className="channel-pages">
      {pages.map((p) => (
        <Button key={p} size="sm" icon={<Globe size={13} />} title={p} onClick={() => void attempt(() => api.memoryOpenFile(orgId, p))}>
          {t('employees.pages.open', { name: pageName(p) })}
        </Button>
      ))}
    </div>
  )
}
