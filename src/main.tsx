import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './app/App.tsx'
import { readPlace } from './hooks/usePlace'
import { prefetchOpeningWeather } from './lib/prefetch'

prefetchOpeningWeather(readPlace())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
