declare global {
  interface Window {
    Plyr?: new (element: HTMLVideoElement, options?: Record<string, unknown>) => { destroy: () => void }
    __plyrReady?: Promise<void>
  }
}

export function ensurePlyr() {
  if (window.Plyr) return Promise.resolve()
  if (window.__plyrReady) return window.__plyrReady

  window.__plyrReady = new Promise<void>((resolve, reject) => {
    if (!document.querySelector('link[data-plyr="true"]')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.css'
      link.dataset.plyr = 'true'
      document.head.appendChild(link)
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-plyr="true"]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Failed to load Plyr')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.min.js'
    script.async = true
    script.dataset.plyr = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Plyr'))
    document.body.appendChild(script)
  })

  return window.__plyrReady
}

export function createPlyr(element: HTMLVideoElement) {
  if (!window.Plyr) return null
  return new window.Plyr(element, { ratio: '16:9', controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'] })
}

export {}
