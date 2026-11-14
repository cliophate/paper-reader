import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/literata'
import '@fontsource/source-sans-3/400.css'
import '@fontsource/source-sans-3/600.css'
import '@fontsource-variable/jetbrains-mono'
import App from './App'
import { AuthBoundary } from './components/AccessSettings'
import { installAuthHandling } from './auth'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

installAuthHandling()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ErrorBoundary><AuthBoundary><App /></AuthBoundary></ErrorBoundary></React.StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'))
}
