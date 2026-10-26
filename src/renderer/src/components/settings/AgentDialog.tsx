// A dialog over the settings page. Escape closes the dialog, not settings.
import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import { Dialog } from '../../ui'

interface AgentDialogProps {
  title: string
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  // Extra controls under the title (e.g. a search box) that don't scroll.
  toolbar?: ReactNode
}

export function AgentDialog({ title, description, onClose, children, footer, toolbar }: AgentDialogProps) {
  const t = useT()
  return (
    <Dialog title={title} description={description} onClose={onClose} closeLabel={t('common.close')} toolbar={toolbar} footer={footer} size="lg" className="ag-dialog">
      {children}
    </Dialog>
  )
}
