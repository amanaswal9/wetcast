import { Button, MessageBox } from '../../components/retro'
import { HAS_PUBLIC_DATA, HAS_SERVER, NO_SERVER_MESSAGE } from '../../lib/site'

// Shown when model results can't be loaded. On the public copy, a part that needs the server says so;
// a failed download of the exported files is a real error, offered again like any other.
export function BackendNotice({ message, onRetry }: { message?: string; onRetry: () => void }) {
  if (!HAS_SERVER && (!HAS_PUBLIC_DATA || message === NO_SERVER_MESSAGE)) {
    return (
      <MessageBox kind="info" title={HAS_PUBLIC_DATA ? 'This part runs on the full setup' : 'Model results are on the full setup'}>
        <p className="m-0">{NO_SERVER_MESSAGE}</p>
      </MessageBox>
    )
  }
  return (
    <MessageBox kind="warning" role="alert" title="Model results aren't available right now" actions={<Button onClick={onRetry}>Try again</Button>}>
      <p className="m-0">{message}</p>
      {HAS_SERVER && (
        <p className="m-0 mt-2">
          This page reads real evaluation results from the Wetcast backend. If you're running the project locally, start it
          with the command in the README, then try again.
        </p>
      )}
    </MessageBox>
  )
}
