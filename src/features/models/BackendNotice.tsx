import { Button, MessageBox } from '../../components/retro'

/** Shown when the FastAPI backend can't be reached. */
export function BackendNotice({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <MessageBox kind="warning" role="alert" title="Model results aren't available right now" actions={<Button onClick={onRetry}>Try again</Button>}>
      <p className="m-0">{message}</p>
      <p className="m-0 mt-2">
        This page reads real evaluation results from the WeatherAI backend. If you're running the project locally, start it
        with the command in the README, then try again.
      </p>
    </MessageBox>
  )
}
