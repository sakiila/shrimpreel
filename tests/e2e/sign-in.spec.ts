import { expect, test } from '@playwright/test'
import { ORIGIN, content, uniqueEmail } from './helpers'

const en = content.en

// 浏览器把 \ 当 /、丢掉 tab 和换行，/.. 规范化后留下 //：这几种 redirect 都会被解析成 https://evil.example/
const OFFSITE = ['/\\evil.example', '/\t/evil.example', '/\\/evil.example', '/..//evil.example']

test('登录后的跳转只落在站内：恶意 redirect 回退到个人中心，站内地址连同查询串和锚点保留', async ({ page }, testInfo) => {
  const offsite: string[] = []
  await page.route(/^https?:\/\/evil\.example\//, (route) => {
    offsite.push(route.request().url())
    return route.fulfill({ contentType: 'text/html', body: 'offsite' })
  })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // 未登录：在登录页提交后跳转
  await page.goto(`/sign-in?redirect=${encodeURIComponent(OFFSITE[0]!)}`)
  await page.getByTestId('dev-email').fill(uniqueEmail('redirect'))
  await page.getByTestId('dev-login').click()
  await expect(page).toHaveURL(`${ORIGIN}/dashboard`)

  // 已登录：打开登录链接会立即跳转，攻击者只要发一个链接
  for (const redirect of OFFSITE) {
    await page.goto(`/sign-in?redirect=${encodeURIComponent(redirect)}`)
    await expect(page).toHaveURL(`${ORIGIN}/dashboard`)
  }

  await page.goto(`/sign-in?redirect=${encodeURIComponent('/zh/pricing?ref=sign-in#faq')}`)
  await expect(page).toHaveURL(`${ORIGIN}/zh/pricing?ref=sign-in#faq`)

  await testInfo.attach('offsite-and-errors', { body: JSON.stringify({ offsite, pageErrors }, null, 2), contentType: 'application/json' })
  expect(offsite).toEqual([])
  expect(pageErrors).toEqual([])
})

test('登录页只显示已知错误码的文案：__proto__ 等原型属性名显示通用错误，页面不崩溃', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  for (const code of ['__proto__', 'constructor', 'toString']) {
    const res = await page.goto(`/sign-in?error=${code}`)
    expect(res?.status(), code).toBe(200)
    await expect(page.getByRole('alert')).toHaveText(en.errors.internal_error)
  }
  await page.goto('/sign-in?error=oauth_state')
  await expect(page.getByRole('alert')).toHaveText(en.errors.oauth_state)
  expect(pageErrors).toEqual([])
})

test('退出后 One Tap 使用退出响应的 nonce，在同一页面重新登录', async ({ page }) => {
  const email = uniqueEmail('one-tap')
  const signedIn = await page.request.post('/api/auth/dev-login', { headers: { origin: ORIGIN }, data: { email } })
  expect(signedIn.ok()).toBe(true)
  const nonce = 'a'.repeat(24)
  let fallbackRequests = 0
  let documentLoads = 0
  page.on('load', () => { documentLoads++ })

  // 真实站内退出与会话接口，Google SDK 和 ID token 交换用本地替身。
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.config.googleClientId = 'test-google-client'
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/auth/logout', async (route) => {
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    await route.fulfill({ response, json: { ok: true, oneTapNonce: nonce } })
  })
  await page.route('**/api/auth/google/nonce', async (route) => {
    fallbackRequests++
    await route.fulfill({ json: { nonce: 'unexpected-fallback' } })
  })
  await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `
      let options;
      window.google = { accounts: { id: {
        initialize(config) { options = config; },
        prompt() {
          const button = document.createElement('button');
          button.textContent = 'Test One Tap';
          button.style.cssText = 'position:fixed;right:16px;top:80px;z-index:9999';
          button.onclick = () => options.callback({ credential: options.nonce });
          document.body.prepend(button);
        },
        cancel() { [...document.querySelectorAll('button')].find((button) => button.textContent === 'Test One Tap')?.remove(); }
      } } };
    `,
  }))
  await page.route('**/api/auth/google/one-tap', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ credential: nonce })
    const response = await route.fetch({ url: `${ORIGIN}/api/auth/dev-login`, postData: { email } })
    expect(response.ok()).toBe(true)
    await route.fulfill({ response })
  })
  await page.goto('/')
  const account = page.getByTestId('account-menu')
  await account.click()
  await page.getByRole('button', { name: en.nav.signOut }).click()
  await expect(account).toHaveCount(0)
  const oneTap = page.getByRole('button', { name: 'Test One Tap' })
  await expect(oneTap).toBeVisible()
  await oneTap.click()
  await expect(account).toBeVisible()
  await account.click()
  await expect(page.getByText(email, { exact: true })).toBeVisible()
  expect(fallbackRequests).toBe(0)
  expect(documentLoads).toBe(1)
})
