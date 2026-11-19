import { MessageBox } from '../components/retro'
import type { PageInfo } from './pages'

/** Honest placeholder for pages that are not built yet. No sample data. */
export function PlannedPage({ page }: { page: PageInfo }) {
  return (
    <div className="r-group">
      <h2 className="r-group-title">{page.label}</h2>
      <MessageBox
        kind="info"
        title={`${page.label} is coming in a later stage`}
        actions={
          <a className="r-btn no-underline" href="#/dashboard">
            <span>Open Dashboard</span>
          </a>
        }
      >
        <p className="m-0">{page.plan}</p>
        <p className="m-0 mt-2">Until then, the Dashboard shows live conditions and the next 24 hours.</p>
      </MessageBox>
    </div>
  )
}
