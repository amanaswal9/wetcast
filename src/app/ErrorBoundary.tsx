import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, MessageBox } from '../components/retro'
import { log } from '../lib/log'

interface Props {
  /** Changing this (for example the page id) clears a previous error. */
  resetKey: string
  children: ReactNode
}

interface State {
  error: Error | null
  key: string
}

/** Keeps one broken page from taking down the whole window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error('page crashed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="r-group">
        <MessageBox
          kind="error"
          role="alert"
          title="This page stopped working"
          actions={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}
        >
          <p className="m-0">Something on this page failed to display. The other pages still work.</p>
        </MessageBox>
      </div>
    )
  }
}
