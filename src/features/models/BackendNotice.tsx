import { Button, MessageBox } from '../../components/retro'
import { HAS_SERVER, NO_SERVER_MESSAGE } from '../../lib/site'

// Shown when the FastAPI backend can't be reached. The public copy has none, so it says so instead.
export function BackendNotice({ message, onRetry }: { message?: string; onRetry: () => void }) {
  if (!HAS_SERVER) {
    return (
      <MessageBox kind="info" title="Model results are on the full setup">
        <p className="m-0">{NO_SERVER_MESSAGE}</p>
      </MessageBox>
    )
  }
  return (
    <MessageBox kind="warning" role="alert" title="Model results aren't available right now" actions={<Button onClick={onRetry}>Try again</Button>}>
      <p className="m-0">{message}</p>
      <p className="m-0 mt-2">
        This page reads real evaluation results from the Wetcast backend. If you're running the project locally, start it
        with the command in the README, then try again.
      </p>
    </MessageBox>
  )
}
