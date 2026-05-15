// =============================================================================
// ENTRÉE REACT — Gantt v1
// =============================================================================
// Bootstrap minimal : monte <App/> dans #root avec StrictMode.
// =============================================================================

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
