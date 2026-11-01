// Supabase Edge Function: system-check
//
// The Studio's "System check" page (admins only) calls this. It checks, in plain words, whether every
// connection the newsroom depends on is working: the website, GitHub publishing, LinkedIn / Facebook / X
// (through Buffer), Telegram, the AI, email, and the automatic jobs.
//
// The normal check is READ-ONLY: it never posts anything publicly. Two actions do something on purpose:
//   { action: 'telegram-test' }  posts one short test message to your Telegram channel
//   { action: 'email-test' }     sends one test email to the admin who asked
//
// It never reveals a secret: every answer is scrubbed of the keys before it leaves.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SITE = 'https://kmvtechug.app/media'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type Status = 'ok' | 'warn' | 'fail' | 'skip'
interface Check {
  group: string
  id: string
  label: string
  status: Status
  detail: string
}

const GROUPS = ['Website', 'Publishing', 'Social posting', 'AI and email', 'Automatic jobs']

const env = (name: string) => Deno.env.get(name) || ''
const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
const timeoutMs = () => Number(env('CHECK_TIMEOUT_MS')) || 9000

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

const mk = (group: string, id: string, label: string, status: Status, detail: string): Check => ({ group, id, label, status, detail })

// Anything that looks like one of our secrets is replaced before an answer leaves this function.
function scrub(text: string) {
  let out = text
  for (const name of [
    'TELEGRAM_BOT_TOKEN',
    'BUFFER_ACCESS_TOKEN',
    'GEMINI_API_KEY',
    'RESEND_API_KEY',
    'GITHUB_TOKEN',
    'SUPABASE_SERVICE_ROLE_KEY',
    'CRON_SECRET',
  ]) {
    const value = env(name)
    if (value.length >= 6) out = out.split(value).join('[hidden]')
  }
  return out
}

async function http(url: string, init: RequestInit = {}) {
  const started = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs()) })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text, headers: res.headers, ms: Date.now() - started, error: '' }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return {
      ok: false,
      status: 0,
      text: '',
      headers: new Headers(),
      ms: Date.now() - started,
      error: timedOut ? 'it did not answer in time' : err instanceof Error ? err.message : String(err),
    }
  }
}

function ago(ms: number) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hours ago`
  return `${Math.round(hours / 24)} days ago`
}

function size(bytes: number) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`
}

function parseJson(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- Website
async function checkWebsite(): Promise<Check[]> {
  const G = 'Website'
  const out: Check[] = []

  const home = await http(`${SITE}/`)
  out.push(
    home.status === 200
      ? mk(G, 'site-home', 'The website is online', 'ok', `The home page opened in ${home.ms} ms.`)
      : mk(G, 'site-home', 'The website is online', 'fail', home.error ? `Could not open it: ${home.error}.` : `The home page answered with status ${home.status}.`)
  )

  const map = await http(`${SITE}/sitemap.xml`)
  const count = (map.text.match(/<loc>/g) || []).length
  out.push(
    map.status === 200 && map.text.includes('<urlset') && count > 0
      ? mk(G, 'site-sitemap', 'The sitemap Google reads is working', 'ok', `${count} addresses are listed.`)
      : mk(G, 'site-sitemap', 'The sitemap Google reads is working', 'fail', map.error ? `Could not open it: ${map.error}.` : `It answered with status ${map.status}, or has no addresses in it.`)
  )

  const index = await http(`${SITE}/search-index.json`)
  const list = parseJson(index.text)
  if (index.status !== 200 || !Array.isArray(list) || list.length === 0) {
    out.push(mk(G, 'site-newest', 'The newest story is live', 'skip', 'Could not read the story list, so this was not checked.'))
  } else {
    const newest = list[0]
    const page = await http(`${SITE}/${newest.u}`)
    if (page.status === 200) out.push(mk(G, 'site-newest', 'The newest story is live', 'ok', `"${newest.t}" opens correctly.`))
    else if (page.status === 404) out.push(mk(G, 'site-newest', 'The newest story is live', 'warn', `"${newest.t}" is not on the website yet. If you published it in the last few minutes this is normal. If it stays like this, check the site build below.`))
    else out.push(mk(G, 'site-newest', 'The newest story is live', 'fail', page.error ? `Could not open it: ${page.error}.` : `It answered with status ${page.status}.`))
  }
  return out
}

// ---------------------------------------------------------------- Publishing (GitHub)
async function checkGithub(): Promise<Check[]> {
  const G = 'Publishing'
  const token = env('GITHUB_TOKEN')
  const owner = env('GITHUB_OWNER')
  const repo = env('GITHUB_REPO')
  const branch = env('GITHUB_BRANCH') || 'main'
  const path = env('GITHUB_ARTICLES_PATH') || 'media/data/articles.json'
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }

  if (!token || !owner || !repo) {
    return [mk(G, 'gh-access', 'GitHub publishing access works', 'fail', 'One of the secrets GITHUB_TOKEN, GITHUB_OWNER or GITHUB_REPO is missing.')]
  }

  const out: Check[] = []
  const file = await http(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers })

  if (file.status === 200) {
    const info = parseJson(file.text) || {}
    out.push(mk(G, 'gh-access', 'GitHub publishing access works', 'ok', 'The stories file can be read.'))

    const bytes = Number(info.size) || 0
    out.push(
      bytes >= 3 * 1048576
        ? mk(G, 'gh-size', 'The stories file size', 'warn', `It is ${size(bytes)}. Publishing still works, but it is getting large. Time to plan yearly archives.`)
        : mk(G, 'gh-size', 'The stories file size', 'ok', `It is ${size(bytes)}.`)
    )

    const expiry = file.headers.get('github-authentication-token-expiration')
    if (!expiry) {
      out.push(mk(G, 'gh-expiry', 'The GitHub key does not expire soon', 'ok', 'GitHub reports no expiry date for this key.'))
    } else {
      const when = new Date(expiry.replace(' UTC', 'Z').replace(' ', 'T'))
      const days = Math.floor((when.getTime() - Date.now()) / 86400000)
      const on = isNaN(when.getTime()) ? expiry : when.toISOString().slice(0, 10)
      if (isNaN(when.getTime())) out.push(mk(G, 'gh-expiry', 'The GitHub key does not expire soon', 'ok', `GitHub reports an expiry of ${expiry}.`))
      else if (days < 0) out.push(mk(G, 'gh-expiry', 'The GitHub key does not expire soon', 'fail', `The key expired on ${on}. Publishing will fail until you make a new one.`))
      else if (days <= 21) out.push(mk(G, 'gh-expiry', 'The GitHub key does not expire soon', 'warn', `The key expires on ${on}, in ${days} days. Make a new one before then, or publishing will stop.`))
      else out.push(mk(G, 'gh-expiry', 'The GitHub key does not expire soon', 'ok', `It expires on ${on}, in ${days} days.`))
    }
  } else if (file.status === 401) {
    out.push(mk(G, 'gh-access', 'GitHub publishing access works', 'fail', 'GitHub refused the key. It has expired or is wrong. Make a new key and replace the secret GITHUB_TOKEN.'))
  } else if (file.status === 404) {
    out.push(mk(G, 'gh-access', 'GitHub publishing access works', 'fail', 'GitHub cannot find the stories file. Check the secrets GITHUB_OWNER, GITHUB_REPO and GITHUB_ARTICLES_PATH.'))
  } else {
    out.push(mk(G, 'gh-access', 'GitHub publishing access works', 'fail', file.error ? `Could not reach GitHub: ${file.error}.` : `GitHub answered with status ${file.status}.`))
  }

  // Is the website being rebuilt successfully after each publish?
  const runs = await http(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/build-site.yml/runs?per_page=1&branch=${branch}`,
    { headers }
  )
  if (runs.status === 200) {
    const run = (parseJson(runs.text)?.workflow_runs || [])[0]
    if (!run) {
      out.push(mk(G, 'gh-build', 'The website rebuild is working', 'warn', 'The site has not been rebuilt by GitHub yet.'))
    } else {
      const when = ago(Date.now() - new Date(run.created_at).getTime())
      if (run.status !== 'completed') out.push(mk(G, 'gh-build', 'The website rebuild is working', 'ok', `A rebuild is running now (started ${when}).`))
      else if (run.conclusion === 'success') out.push(mk(G, 'gh-build', 'The website rebuild is working', 'ok', `The last rebuild succeeded ${when}.`))
      else out.push(mk(G, 'gh-build', 'The website rebuild is working', 'fail', `The last rebuild FAILED (${when}). New stories will not appear on the website. Open GitHub, then Actions, to see why.`))
    }
  } else {
    out.push(mk(G, 'gh-build', 'The website rebuild is working', 'skip', 'Could not read the rebuild status (the GitHub key may not be allowed to read Actions). Not checked.'))
  }
  return out
}

// ---------------------------------------------------------------- Social posting: Buffer (LinkedIn, Facebook, X)
interface BufferChannel {
  id: string
  name?: string
  service?: string
  isDisconnected?: boolean
  isLocked?: boolean
  isQueuePaused?: boolean
}

async function bufferQuery(query: string, variables?: Record<string, unknown>) {
  const res = await http('https://api.buffer.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('BUFFER_ACCESS_TOKEN')}` },
    body: JSON.stringify({ query, variables }),
  })
  return { res, body: parseJson(res.text) }
}

async function listBufferChannels(): Promise<{ channels: BufferChannel[] } | { error: string }> {
  const fields = 'id name service isDisconnected isLocked isQueuePaused'
  const first = await bufferQuery(`query { account { organizations { id name channels { ${fields} } } } }`)
  if (first.res.status === 0) return { error: `Could not reach Buffer: ${first.res.error}.` }
  const orgs = first.body?.data?.account?.organizations
  if (Array.isArray(orgs)) return { channels: orgs.flatMap((o: { channels?: BufferChannel[] }) => o.channels || []) }

  // Some Buffer accounts need the channels asked for separately.
  const orgList = await bufferQuery('query { account { organizations { id name } } }')
  const ids: string[] = (orgList.body?.data?.account?.organizations || []).map((o: { id: string }) => o.id)
  if (ids.length) {
    const all: BufferChannel[] = []
    for (const id of ids) {
      const ch = await bufferQuery(`query($id: OrganizationId!) { channels(input: { organizationId: $id }) { ${fields} } }`, { id })
      if (Array.isArray(ch.body?.data?.channels)) all.push(...ch.body.data.channels)
    }
    if (all.length) return { channels: all }
  }
  const reason = first.body?.errors?.[0]?.message || (first.res.status === 401 || first.res.status === 403 ? 'the key was refused' : `status ${first.res.status}`)
  return { error: `Buffer would not list your channels (${reason}).` }
}

async function checkBuffer(): Promise<Check[]> {
  const G = 'Social posting'
  const wanted = [
    { id: 'buf-linkedin', name: 'LinkedIn', secret: 'BUFFER_CHANNEL_LINKEDIN', service: /linkedin/i },
    { id: 'buf-facebook', name: 'Facebook', secret: 'BUFFER_CHANNEL_FACEBOOK', service: /facebook/i },
    { id: 'buf-x', name: 'X', secret: 'BUFFER_CHANNEL_X', service: /twitter|^x$/i },
  ]

  if (!env('BUFFER_ACCESS_TOKEN')) {
    return wanted.map((w) => mk(G, w.id, `${w.name} (through Buffer)`, 'fail', 'The secret BUFFER_ACCESS_TOKEN is missing.'))
  }

  const found = await listBufferChannels()
  if ('error' in found) return wanted.map((w) => mk(G, w.id, `${w.name} (through Buffer)`, 'fail', found.error))

  return wanted.map((w) => {
    const channelId = env(w.secret)
    const label = `${w.name} (through Buffer)`
    if (!channelId) return mk(G, w.id, label, 'fail', `The secret ${w.secret} is missing.`)
    const channel = found.channels.find((c) => c.id === channelId)
    if (!channel) return mk(G, w.id, label, 'fail', `Buffer has no channel with the id saved in ${w.secret}. Copy the right id again from Buffer.`)
    if (channel.service && !w.service.test(channel.service))
      return mk(G, w.id, label, 'fail', `The id saved in ${w.secret} belongs to a ${channel.service} channel, not ${w.name}. It looks mixed up.`)
    if (channel.isDisconnected) return mk(G, w.id, label, 'fail', `${w.name} is DISCONNECTED in Buffer. Open Buffer and reconnect it, or nothing will post.`)
    if (channel.isLocked) return mk(G, w.id, label, 'warn', `The ${w.name} channel is locked in Buffer. Open Buffer to see why.`)
    if (channel.isQueuePaused) return mk(G, w.id, label, 'warn', `The ${w.name} posting queue is PAUSED in Buffer, so scheduled posts will wait.`)
    return mk(G, w.id, label, 'ok', `Connected${channel.name ? ` as ${channel.name}` : ''}.`)
  })
}

// ---------------------------------------------------------------- Social posting: Telegram
// deno-lint-ignore no-explicit-any
type TgAnswer = { ok: true; result: any } | { ok: false; error: string }

async function telegramCall(token: string, method: string, payload: Record<string, unknown>): Promise<TgAnswer> {
  const res = await http(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = parseJson(res.text)
  if (res.status === 200 && data?.ok) return { ok: true, result: data.result }
  return { ok: false, error: data?.description || (res.error ? `Could not reach Telegram: ${res.error}` : `Telegram answered with status ${res.status}`) }
}

// Walks through every step. `send` decides whether the final test message is really posted.
async function telegramSteps(send: boolean): Promise<{ ok: boolean; failed?: string; botName?: string; channelTitle?: string }> {
  const token = env('TELEGRAM_BOT_TOKEN')
  const chat = env('TELEGRAM_CHANNEL_ID')
  if (!token && !chat) return { ok: false, failed: 'Telegram is not set up. Add the two secrets TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID.' }
  if (!token) return { ok: false, failed: 'The secret TELEGRAM_BOT_TOKEN is missing. It must hold the long token from @BotFather (it contains a colon). The channel name goes in TELEGRAM_CHANNEL_ID.' }
  if (!chat) return { ok: false, failed: 'The secret TELEGRAM_CHANNEL_ID is missing. It must hold your channel name, for example @yourchannel.' }

  const me = await telegramCall(token, 'getMe', {})
  if (!me.ok) return { ok: false, failed: `The bot token is not accepted (${me.error}). Copy the token again from @BotFather and save it in TELEGRAM_BOT_TOKEN.` }
  const info = await telegramCall(token, 'getChat', { chat_id: chat })
  if (!info.ok) return { ok: false, failed: `The bot cannot find the channel (${info.error}). TELEGRAM_CHANNEL_ID must be the channel name like @yourchannel, and the channel must be public.` }
  const member = await telegramCall(token, 'getChatMember', { chat_id: chat, user_id: me.result.id })
  const role = member.ok ? member.result.status : ''
  if (role !== 'administrator' && role !== 'creator')
    return { ok: false, failed: `The bot is not an administrator of "${info.result.title}" (its role is "${role || 'unknown'}"). In Telegram open the channel, then Administrators, and add the bot.` }
  if (role !== 'creator' && member.result.can_post_messages === false)
    return { ok: false, failed: 'The bot is an administrator but is not allowed to post. In Telegram edit its admin rights and switch on "Post Messages".' }
  if (send) {
    const sent = await telegramCall(token, 'sendMessage', { chat_id: chat, text: 'Test from the King Musah Media Studio. If you can read this, automatic posting works.' })
    if (!sent.ok) return { ok: false, failed: `Everything looks right, but Telegram refused the test message (${sent.error}).` }
  }
  return { ok: true, botName: me.result.username, channelTitle: info.result.title }
}

async function checkTelegram(): Promise<Check[]> {
  const G = 'Social posting'
  const r = await telegramSteps(false)
  if (r.ok) return [mk(G, 'telegram', 'Telegram', 'ok', `The bot @${r.botName} is an administrator of "${r.channelTitle}" and may post.`)]
  // Not used at all is not an error: say so calmly.
  if (!env('TELEGRAM_BOT_TOKEN') && !env('TELEGRAM_CHANNEL_ID')) return [mk(G, 'telegram', 'Telegram', 'skip', r.failed || '')]
  return [mk(G, 'telegram', 'Telegram', 'fail', r.failed || 'Something is wrong.')]
}

// ---------------------------------------------------------------- AI and email
async function checkGemini(): Promise<Check[]> {
  const G = 'AI and email'
  const key = env('GEMINI_API_KEY')
  if (!key) return [mk(G, 'gemini', 'The AI (Gemini) key works', 'fail', 'The secret GEMINI_API_KEY is missing, so AI drafting and automatic news drafts cannot work.')]
  const res = await http('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } })
  if (res.status === 200) return [mk(G, 'gemini', 'The AI (Gemini) key works', 'ok', 'Google accepted the key.')]
  if (res.status === 429) return [mk(G, 'gemini', 'The AI (Gemini) key works', 'warn', 'The key is valid but its free limit has been reached for now. It resets by itself.')]
  if (res.status === 400 || res.status === 401 || res.status === 403)
    return [mk(G, 'gemini', 'The AI (Gemini) key works', 'fail', 'Google rejected the key. Make a new one at Google AI Studio and replace GEMINI_API_KEY.')]
  return [mk(G, 'gemini', 'The AI (Gemini) key works', 'fail', res.error ? `Could not reach Google: ${res.error}.` : `Google answered with status ${res.status}.`)]
}

async function checkResend(): Promise<Check[]> {
  const G = 'AI and email'
  const key = env('RESEND_API_KEY')
  if (!key) return [mk(G, 'resend', 'The email service (Resend) key works', 'fail', 'The secret RESEND_API_KEY is missing, so newsletter confirmation emails cannot be sent.')]
  const res = await http('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${key}` } })
  const data = parseJson(res.text)
  if (res.status === 200) return [mk(G, 'resend', 'The email service (Resend) key works', 'ok', 'Resend accepted the key.')]
  // A send-only key is refused for the domain list, but that proves the key itself is valid.
  if (res.status === 401 && /restricted/i.test(`${data?.name} ${data?.message}`))
    return [mk(G, 'resend', 'The email service (Resend) key works', 'ok', 'Resend accepted the key (it is a send-only key, as it should be).')]
  if (res.status === 401 || res.status === 403 || res.status === 400)
    return [mk(G, 'resend', 'The email service (Resend) key works', 'fail', 'Resend rejected the key. Make a new send-only key and replace RESEND_API_KEY.')]
  return [mk(G, 'resend', 'The email service (Resend) key works', 'fail', res.error ? `Could not reach Resend: ${res.error}.` : `Resend answered with status ${res.status}.`)]
}

// ---------------------------------------------------------------- Automatic jobs
async function checkAutomation(): Promise<Check[]> {
  const G = 'Automatic jobs'
  const out: Check[] = []

  const last = await supabase.from('processed_feed_items').select('created_at').order('created_at', { ascending: false }).limit(1)
  const when = last.data?.[0]?.created_at
  if (last.error) {
    out.push(mk(G, 'auto-news', 'Automatic news drafts are running', 'warn', 'Could not read the automatic news history.'))
  } else if (!when) {
    out.push(mk(G, 'auto-news', 'Automatic news drafts are running', 'warn', 'No automatic drafts have ever been made. Check that the cron job fetch-trending-news is switched on.'))
  } else {
    const ms = Date.now() - new Date(when).getTime()
    const hours = ms / 3600000
    if (hours <= 8) out.push(mk(G, 'auto-news', 'Automatic news drafts are running', 'ok', `The last new headline was picked up ${ago(ms)}.`))
    else if (hours <= 24) out.push(mk(G, 'auto-news', 'Automatic news drafts are running', 'warn', `The last new headline was ${ago(ms)}. It should be every few hours, so look at the cron job.`))
    else out.push(mk(G, 'auto-news', 'Automatic news drafts are running', 'fail', `Nothing new for ${ago(ms)}. The cron job fetch-trending-news is probably switched off or failing.`))
  }

  const active = await supabase.from('newsletter_subscribers').select('id', { count: 'exact', head: true }).eq('status', 'active')
  const pending = await supabase.from('newsletter_subscribers').select('id', { count: 'exact', head: true }).eq('status', 'pending')
  if (active.error || pending.error) out.push(mk(G, 'auto-list', 'The newsletter list is readable', 'warn', 'Could not read the subscriber list.'))
  else out.push(mk(G, 'auto-list', 'The newsletter list is readable', 'ok', `${active.count ?? 0} active subscribers, ${pending.count ?? 0} waiting to confirm.`))
  return out
}

// ---------------------------------------------------------------- put it together
async function safely(label: string, group: string, run: () => Promise<Check[]>): Promise<Check[]> {
  try {
    return await run()
  } catch (err) {
    return [mk(group, `crash-${label}`, label, 'fail', `This check itself broke: ${err instanceof Error ? err.message : String(err)}`)]
  }
}

async function runAll() {
  const parts = await Promise.all([
    safely('Website', 'Website', checkWebsite),
    safely('GitHub', 'Publishing', checkGithub),
    safely('Buffer', 'Social posting', checkBuffer),
    safely('Telegram', 'Social posting', checkTelegram),
    safely('AI', 'AI and email', checkGemini),
    safely('Email', 'AI and email', checkResend),
    safely('Automatic jobs', 'Automatic jobs', checkAutomation),
  ])
  const checks = parts.flat().sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group))
  return checks.map((c) => ({ ...c, label: scrub(c.label), detail: scrub(c.detail) }))
}

const summarize = (checks: Check[]) => ({
  ok: checks.filter((c) => c.status === 'ok').length,
  warn: checks.filter((c) => c.status === 'warn').length,
  fail: checks.filter((c) => c.status === 'fail').length,
  skip: checks.filter((c) => c.status === 'skip').length,
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  try {
    // Admins only.
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '')
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt)
    if (userError || !userData?.user) return json({ error: 'Please sign in again.' }, 401)
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', userData.user.id).single()
    if (!profile || profile.role !== 'admin') return json({ error: 'Only admins can run the system check.' }, 403)

    let body: { action?: string } = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }

    if (body.action === 'telegram-test') {
      const r = await telegramSteps(true)
      const check = r.ok
        ? mk('Social posting', 'telegram-test', 'Test message to Telegram', 'ok', `Posted. Look in "${r.channelTitle}" for the test message.`)
        : mk('Social posting', 'telegram-test', 'Test message to Telegram', 'fail', r.failed || 'Something is wrong.')
      return json({ checks: [{ ...check, detail: scrub(check.detail) }] })
    }

    if (body.action === 'email-test') {
      const key = env('RESEND_API_KEY')
      const to = userData.user.email
      if (!key || !to) {
        return json({ checks: [mk('AI and email', 'email-test', 'Test email', 'fail', !key ? 'The secret RESEND_API_KEY is missing.' : 'Your account has no email address.')] })
      }
      const res = await http('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env('NEWSLETTER_FROM') || 'King Musah Media <newsletter@news.kmvtechug.app>',
          to: [to],
          subject: 'Test from the King Musah Media Studio',
          text: 'If you can read this, newsletter emails can be sent. No action needed.',
        }),
      })
      const detail = res.ok ? `Sent to ${to}. Check your inbox (and spam).` : `Resend refused it (${parseJson(res.text)?.message || res.error || `status ${res.status}`}).`
      return json({ checks: [{ ...mk('AI and email', 'email-test', 'Test email', res.ok ? 'ok' : 'fail', detail), detail: scrub(detail) }] })
    }

    const checks = await runAll()
    return json({ ranAt: new Date().toISOString(), summary: summarize(checks), checks })
  } catch (err) {
    return json({ error: scrub(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`) }, 500)
  }
})
