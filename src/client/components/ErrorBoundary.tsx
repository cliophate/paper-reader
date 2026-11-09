import { Component, type ErrorInfo, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Paper interface error', error, info)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <main className="fatal-error">
      <img src="/brand/paper-logo.svg" alt="" />
      <h1>Paper hit an error</h1>
      <p>Your reading state is safe. Reload Paper to continue.</p>
      <button onClick={() => window.location.reload()}>Reload Paper</button>
    </main>
  }
}
