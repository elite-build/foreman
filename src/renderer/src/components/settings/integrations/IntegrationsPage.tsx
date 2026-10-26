// Settings → Integrations: GitHub, Linear and Slack connections (several accounts per service, one
// default each), Slack rules, and People. Secrets are write-only from here: a connection shows who
// it is and the last four characters of its key, never the key.
import { useEffect, useState } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../store'
import { Tab, TabList, Tabs } from '../../../ui'
import { Page, rowDomId } from '../controls'
import { ConnectionsTab } from './ConnectionsTab'
import { PeopleTab } from './PeopleTab'
import { SlackRulesTab } from './SlackRulesTab'
import './integrations.css'

type TabKey = 'connections' | 'rules' | 'people'

export function IntegrationsPage() {
  const t = useT()
  const [tab, setTab] = useState<TabKey>('connections')
  const page = useStore((s) => s.settingsPage)
  useEffect(() => {
    setTab(page?.scrollTo === 'slack-rules' ? 'rules' : page?.scrollTo === 'slack-people' ? 'people' : 'connections')
  }, [page])
  return (
    <Page title={t('settings.page.integrations')} description={t('integrations.page.desc')}>
      <Tabs className="set-tabs" value={tab} onChange={(next) => setTab(next as TabKey)}>
        <TabList label={t('settings.page.integrations')}>
          <Tab value="connections">{t('integrations.connections.title')}</Tab>
          <Tab value="rules">{t('integrations.rules.title')}</Tab>
          <Tab value="people">{t('integrations.people.title')}</Tab>
        </TabList>
      </Tabs>
      <div className="int-tab">
        {tab === 'connections' && (
          <div id={rowDomId('integrations-connections')}>
            <ConnectionsTab />
          </div>
        )}
        {tab === 'rules' && (
          <div id={rowDomId('slack-rules')}>
            <SlackRulesTab />
          </div>
        )}
        {tab === 'people' && (
          <div id={rowDomId('slack-people')}>
            <PeopleTab />
          </div>
        )}
      </div>
    </Page>
  )
}
