import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { MiniWeather } from './MiniWeather'

// Entry point for Wetcast Mini (mini/index.html), the small widget-style page.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MiniWeather />
  </StrictMode>,
)
