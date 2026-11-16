const sensitiveControls = 'input[type="password"],input[autocomplete="one-time-code"],iframe[src*="idmsa.apple.com"],iframe[src*="appleid.apple.com"]';
const challenge = /captcha|verify (?:you are|your identity)|access denied|unusual traffic|アクセスが拒否|ロボットではない/i;

// Limit this performance change to the public, unauthenticated stock landing
// page. Network/security scripts and their timers remain active.
export function createStockIdleMedia({ context, page, enabled = true, emit = () => {} }) {
  let phase = enabled ? 'active' : 'disabled';
  return {
    async quiet() {
      if (phase === 'disabled') return;
      try {
        const url = new URL(page.url());
        if (url.origin !== 'https://www.apple.com' || !['/jp/','/jp/shop/'].includes(url.pathname) || context.pages().length !== 1) return;
        if (await page.locator(sensitiveControls).count() !== 0 ||
            (await page.locator('h1,h2,[role="alert"]').allTextContents()).some(text => challenge.test(text))) return;
        await page.evaluate(() => {
          for (const media of document.querySelectorAll('video,audio')) { media.pause(); media.autoplay = false; }
          for (const animation of document.getAnimations()) if (animation.playState === 'running') animation.pause();
        });
        phase = 'quiet';
      } catch {
        phase = 'disabled';
        try { emit({ stage:'stock-idle-media-unavailable' }); } catch {}
      }
    },
    snapshot() { return phase; },
  };
}
