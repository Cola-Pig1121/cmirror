/* cmirror 前端:Listary 风单框 + 设置页 + 管理后台(令牌/渠道/别名/镜像规则) */
(() => {
  'use strict'

  // ---------- 存储 ----------
  const LS_TOKEN = 'cmirror_token'
  const LS_ENGINE = 'cmirror_engine'
  const LS_MODE = 'cmirror_mode'
  const getMode = () => {
    const m = localStorage.getItem(LS_MODE)
    return m === 'stream' || m === 'rewrite' ? m : 'auto'
  }
  const setMode = (m) => localStorage.setItem(LS_MODE, m)
  const getToken = () => localStorage.getItem(LS_TOKEN) || ''
  const setToken = (t) => {
    if (t) localStorage.setItem(LS_TOKEN, t)
    else localStorage.removeItem(LS_TOKEN)
    // Cookie 让镜像页面跳转自动携带鉴权(浏览器导航不发 Authorization 头)
    document.cookie = t
      ? `cmirror_token=${encodeURIComponent(t)}; path=/; SameSite=Lax`
      : 'cmirror_token=; path=/; Max-Age=0'
  }

  // ---------- 搜索引擎 ----------
  const ENGINES = [
    { id: 'bing', name: 'Bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
    { id: 'google', name: 'Google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
    { id: 'baidu', name: '百度', url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}` },
    { id: 'ddg', name: 'DuckDuckGo', url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
    { id: 'github', name: 'GitHub', url: (q) => `https://github.com/search?q=${encodeURIComponent(q)}` },
  ]
  const getEngine = () => ENGINES.find((e) => e.id === localStorage.getItem(LS_ENGINE)) || ENGINES[0]
  const setEngine = (id) => localStorage.setItem(LS_ENGINE, id)

  const isUrl = (s) => !/\s/.test(s) && /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}([/?#]\S*)?$/i.test(s)
  const normalizeUrl = (s) => (/^https?:\/\//i.test(s) ? s : 'https://' + s)
  const mirrorHref = (u) => '/m/' + (getMode() === 'auto' ? '' : getMode() + '/') + normalizeUrl(u)
  // 启动器习惯:搜索/镜像结果一律新标签页打开,主框留在原地
  const openNew = (url) => window.open(url, '_blank', 'noopener')
  const isGithubUrl = (u) => /^(https?:\/\/)?([\w.-]+\.)?github\.(com|usercontent\.com|io)\b/i.test(u) || /^(https?:\/\/)?(gist|codeload)\.github\.com/i.test(u)

  // ---------- 命令 ----------
  const COMMANDS = [
    {
      cmd: '/mirror',
      args: '<url>',
      desc: '临时代理任意网址',
      run: (v) => { if (v) openNew(mirrorHref(v)) },
    },
    {
      cmd: '/mirror-github',
      args: '<github 链接>',
      desc: '镜像 GitHub 仓库/页面',
      run: (v) => {
        if (!v) return
        if (!isGithubUrl(v)) { alert('不是 GitHub 链接'); return }
        openNew(mirrorHref(v))
      },
    },
    { cmd: '/settings', desc: '打开设置(令牌 / 引擎)', run: () => (location.hash = '#settings') },
    { cmd: '/admin', desc: '管理后台(令牌 / 渠道 / 别名 / 规则)', run: () => (location.hash = '#admin') },
    {
      cmd: '/engine',
      args: '<' + ENGINES.map((e) => e.id).join('|') + '>',
      desc: '切换默认搜索引擎',
      run: (v) => {
        const e = ENGINES.find((x) => x.id === v.trim().toLowerCase())
        if (e) { setEngine(e.id); syncEngine() } else alert('未知引擎:' + v)
      },
    },
    { cmd: '/help', desc: '查看全部命令', run: () => {} },
  ]

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id)
  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    n.textContent = text ?? ''
    return n
  }
  const splitCsv = (s) => {
    const a = s.split(',').map((x) => x.trim()).filter(Boolean)
    return a.length ? a : undefined
  }
  const num = (s) => {
    const n = parseInt(s, 10)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const input = $('q')
  const list = $('list')
  const engineBtn = $('engine')
  let sel = -1
  let matched = []

  const syncEngine = () => { engineBtn.textContent = getEngine().name }
  engineBtn.addEventListener('click', () => {
    const i = ENGINES.findIndex((e) => e.id === getEngine().id)
    setEngine(ENGINES[(i + 1) % ENGINES.length].id)
    syncEngine()
  })

  function renderList(items) {
    matched = items
    sel = items.length ? 0 : -1
    list.innerHTML = ''
    items.forEach((it, i) => {
      const li = document.createElement('li')
      li.innerHTML = `<span class="cmd"></span><span class="args"></span><span class="desc"></span>`
      li.children[0].textContent = it.cmd
      li.children[1].textContent = it.args || ''
      li.children[2].textContent = it.desc || ''
      li.className = i === sel ? 'sel' : ''
      li.addEventListener('mousedown', (e) => { e.preventDefault(); activate(i) })
      list.appendChild(li)
    })
    list.hidden = !items.length
  }

  // ---------- URL 镜像操作条(任意 URL 显示;GitHub 链接附加快捷操作) ----------
  const ghbar = $('ghbar')
  const GH_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(\/\S*)?$/i

  function renderUrlBar(v) {
    ghbar.innerHTML = ''
    const trimmed = v.trim()
    if (!isUrl(trimmed)) { ghbar.hidden = true; return }
    ghbar.hidden = false

    const mk = (label, fn, cls) => {
      const b = document.createElement('button')
      b.textContent = label
      if (cls) b.className = cls
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', fn)
      ghbar.appendChild(b)
      return b
    }

    // 模式三选:auto 按响应类型猜;rewrite 强制改写;stream 强制原样透传
    const seg = document.createElement('div')
    seg.className = 'seg'
    for (const m of ['auto', 'rewrite', 'stream']) {
      const b = document.createElement('button')
      b.textContent = m
      if (getMode() === m) b.className = 'on'
      b.title = m === 'auto' ? '按 Content-Type 自动选择' : m === 'rewrite' ? '强制 HTML/CSS 改写' : '强制原样透传(不注入不改写)'
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => {
        setMode(m)
        renderUrlBar(input.value)
        input.focus()
      })
      seg.appendChild(b)
    }
    ghbar.appendChild(seg)

    mk('镜像浏览', () => openNew(mirrorHref(trimmed)), 'primary')

    const g = GH_RE.exec(trimmed)
    if (g) {
      const owner = g[1]
      const repo = g[2].replace(/\.git$/i, '')
      const rest = g[3] || ''
      const base = `https://github.com/${owner}/${repo}`
      mk('复制 clone 命令', () => {
        const token = getToken()
        const proto = location.protocol === 'https:' ? 'https' : 'http'
        const auth = token ? `cmirror:${encodeURIComponent(token)}@` : ''
        copyText(`git clone ${proto}://${auth}${location.host}/m/${base}.git`, '已复制 ✓')
      })
      if (!rest || /^\/(tree|blob|releases|tags)/i.test(rest)) {
        mk('Releases', () => openNew(mirrorHref(base + '/releases')))
      }
      const blob = /^\/blob\/([^/]+)\/(.+)$/i.exec(rest)
      if (blob) {
        mk('Raw 镜像', () => openNew(mirrorHref(`https://raw.githubusercontent.com/${owner}/${repo}/${blob[1]}/${blob[2]}`)))
      }
    }
    if (!getToken()) {
      ghbar.appendChild(el('span', 'note', '提示:在 /settings 配置令牌后可直接访问镜像'))
    }
  }

  function copyText(text, okLabel) {
    const done = () => {
      const btn = [...ghbar.children].find((b) => b.tagName === 'BUTTON' && /clone/.test(b.textContent))
      if (btn) {
        const old = btn.textContent
        btn.textContent = okLabel
        setTimeout(() => (btn.textContent = old), 1400)
      }
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done)
    else {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      done()
    }
  }

  function refresh() {
    const v = input.value
    renderUrlBar(v)
    if (!v.startsWith('/')) { renderList([]); return }
    const head = v.split(' ')[0]
    const hasArg = v.includes(' ')
    if (hasArg) { renderList([]); return }
    renderList(COMMANDS.filter((c) => c.cmd.startsWith(head)))
  }

  /** Tab:仅补全命令文本(带参数命令留空格等待输入) */
  function complete(i) {
    const it = matched[i]
    if (!it) return
    input.value = it.cmd + (it.args ? ' ' : '')
    list.hidden = true
    input.focus()
  }

  /** Enter/点击:无参数命令直接执行;带参数命令先补全等待输入 */
  function activate(i) {
    const it = matched[i]
    if (!it) return
    if (it.args) { complete(i); return }
    list.hidden = true
    it.run('')
  }

  function submit() {
    const v = input.value.trim()
    if (!v) return
    if (v.startsWith('/')) {
      const sp = v.indexOf(' ')
      const name = sp === -1 ? v : v.slice(0, sp)
      const arg = sp === -1 ? '' : v.slice(sp + 1).trim()
      const cmd = COMMANDS.find((c) => c.cmd === name)
      if (cmd) {
        if (cmd.args && !arg) { input.value = cmd.cmd + ' '; return }
        cmd.run(arg)
        input.value = ''
        refresh()
        return
      }
      alert('未知命令:' + name + ' —— 输入 / 查看列表')
      return
    }
    if (isUrl(v)) { openNew(mirrorHref(v)); return }
    openNew(getEngine().url(v))
  }

  input.addEventListener('input', refresh)
  input.addEventListener('keydown', (e) => {
    const listOpen = !list.hidden && matched.length
    if (e.key === 'Tab' && listOpen) { e.preventDefault(); complete(sel); return }
    if (e.key === 'Enter' && listOpen && sel >= 0 && !input.value.includes(' ')) {
      e.preventDefault()
      activate(sel)
      return
    }
    if (listOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      sel = (sel + (e.key === 'ArrowDown' ? 1 : matched.length - 1)) % matched.length
      mark()
      return
    }
    if (e.key === 'Escape') { list.hidden = true; return }
    if (e.key === 'Enter') { e.preventDefault(); submit() }
  })
  function mark() {
    [...list.children].forEach((li, i) => li.classList.toggle('sel', i === sel))
  }

  // ---------- 视图路由:home / settings / admin(hash 与 path 双入口) ----------
  const home = $('home')
  const settings = $('settings')
  const admin = $('admin')
  const tokenInput = $('token')
  const engineSel = $('engineSel')

  for (const e of ENGINES) {
    engineSel.appendChild(new Option(e.name, e.id))
  }

  async function api(path, opts = {}) {
    const t = getToken()
    return fetch(path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}), ...(opts.headers || {}) },
    })
  }

  const currentView = () => {
    if (location.pathname === '/admin' || location.hash === '#admin') return 'admin'
    if (location.pathname === '/settings' || location.hash === '#settings') return 'settings'
    return 'home'
  }

  function showView(v) {
    home.hidden = v !== 'home'
    settings.hidden = v !== 'settings'
    admin.hidden = v !== 'admin'
    if (v === 'settings') initSettings()
    if (v === 'admin') initAdmin()
    if (v === 'home') input.focus()
  }

  // ---------- 设置页 ----------
  function initSettings() {
    tokenInput.value = getToken()
    $('tokenState').textContent = getToken()
      ? '已保存 ✓(Cookie 已写入,镜像跳转自动携带)'
      : '保存在本浏览器(localStorage + Cookie),镜像页面跳转自动携带。'
    engineSel.value = getEngine().id
  }
  function saveToken() {
    const v = tokenInput.value.trim()
    setToken(v)
    $('tokenState').textContent = v ? '已保存 ✓(Cookie 已写入,镜像跳转自动携带)' : '已清除'
  }
  tokenInput.addEventListener('change', saveToken)
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveToken()
    }
  })
  engineSel.addEventListener('change', () => { setEngine(engineSel.value); syncEngine() })

  // ---------- 管理后台 ----------
  const adminTabs = $('adminTabs')
  let curTab = 'tokens'

  function initAdmin() {
    $('adminWho').textContent = getToken() ? '' : '⚠ 未设置令牌 — 先在 /settings 填入管理员令牌'
    switchTab(curTab)
  }
  function switchTab(name) {
    curTab = name
    for (const b of adminTabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === name)
    for (const id of ['tokens', 'channels', 'aliases', 'rules']) $('tab-' + id).hidden = id !== name
    if (name === 'tokens') loadTokens()
    if (name === 'channels') loadChannels()
    if (name === 'aliases') loadAliases()
    if (name === 'rules') loadRules()
  }
  adminTabs.addEventListener('click', (e) => {
    const t = e.target?.dataset?.tab
    if (t) switchTab(t)
  })

  function denied(hint, res) {
    hint.textContent = res.status === 401 || res.status === 403 ? '需要管理员令牌(当前令牌无管理权限)' : '请求失败(HTTP ' + res.status + ')'
  }

  // —— 令牌 ——
  async function loadTokens() {
    const hint = $('tkHint')
    const ul = $('tkList')
    ul.innerHTML = ''
    try {
      const res = await api('/admin/tokens')
      if (!res.ok) return denied(hint, res)
      const items = await res.json()
      hint.textContent = '用户令牌 ' + items.length + ' 个(管理员令牌来自服务端 secret,不在此列)'
      for (const it of items) {
        const r = it.record || {}
        const li = document.createElement('li')
        const meta =
          (r.scopes || []).join('/') +
          (r.models?.length ? ' · ' + r.models.join(',') : '') +
          (r.rpm ? ' · ' + r.rpm + '/min' : '') +
          ' · 已用 ' + (r.usedRequests ?? 0) + ' req / ' + (r.usedTokens ?? 0) + ' tok' +
          (r.maxRequests ? '(上限 ' + r.maxRequests + ')' : '') +
          (r.expiresAt ? ' · ' + new Date(r.expiresAt).toLocaleDateString() + ' 过期' : '')
        li.append(el('span', 'name', r.name || it.key.slice(-8)), el('span', 'mode', meta))
        const del = el('button', 'del', '删除')
        del.onclick = async () => {
          await api('/admin/tokens/' + it.key.replace('token:', ''), { method: 'DELETE' })
          loadTokens()
        }
        li.appendChild(del)
        ul.appendChild(li)
      }
    } catch {
      hint.textContent = '网络错误'
    }
  }

  $('tkCreate').onclick = async () => {
    const scopes = [$('tkMirror').checked && 'mirror', $('tkAi').checked && 'ai'].filter(Boolean)
    const body = {
      name: $('tkName').value.trim() || 'unnamed',
      scopes,
      models: splitCsv($('tkModels').value),
      rpm: num($('tkRpm').value),
      maxRequests: num($('tkMaxReq').value),
      maxTokens: num($('tkMaxTok').value),
      expiresDays: num($('tkDays').value),
    }
    const box = $('tkNew')
    const res = await api('/admin/tokens', { method: 'POST', body: JSON.stringify(body) })
    box.hidden = false
    box.innerHTML = ''
    if (!res.ok) {
      box.textContent = '签发失败(HTTP ' + res.status + '),需要管理员令牌'
      return
    }
    const { token } = await res.json()
    box.append(el('span', '', '新令牌(仅显示这一次,请立即保存):'))
    box.append(el('code', 'tokval', token))
    const cp = el('button', 'go', '复制')
    cp.onclick = () => navigator.clipboard?.writeText(token).then(() => (cp.textContent = '已复制 ✓'))
    box.appendChild(cp)
  }

  // —— AI 渠道 ——
  async function loadChannels() {
    const hint = $('chHint')
    const ul = $('chList')
    ul.innerHTML = ''
    const res = await api('/admin/channels')
    if (!res.ok) return denied(hint, res)
    const { user } = await res.json()
    hint.textContent = '用户渠道 ' + user.length + ' 个;同渠道多 key 轮询 + 失败熔断,429/5xx 按权重降级到备用渠道'
    for (const c of user) {
      const li = document.createElement('li')
      const meta = c.provider + ' · ' + c.baseUrl + ' · ' + (c.models || []).join(',') + ' · w' + (c.weight ?? 1) + ' · ' + (c.keys?.length || 0) + ' keys' + (c.enabled === false ? ' · 已停用' : '')
      li.append(el('span', 'name', c.id), el('span', 'mode', meta))
      const edit = el('button', '', '编辑')
      edit.onclick = () => fillChannelForm(c)
      const del = el('button', 'del', '删除')
      del.onclick = async () => {
        await api('/admin/channels/' + encodeURIComponent(c.id), { method: 'DELETE' })
        loadChannels()
      }
      li.append(edit, del)
      ul.appendChild(li)
    }
  }
  function fillChannelForm(c) {
    $('chId').value = c.id
    $('chProvider').value = c.provider
    $('chBase').value = c.baseUrl
    $('chKeys').value = ''
    $('chKeys').placeholder = '留空 = 保留原有 ' + (c.keys?.length || 0) + ' 个 key 不变'
    $('chModels').value = (c.models || []).join(', ')
    $('chWeight').value = c.weight ?? 1
    $('chEnabled').checked = c.enabled !== false
  }
  $('chSave').onclick = async () => {
    const id = $('chId').value.trim()
    if (!id) { $('chHint').textContent = '渠道 id 必填'; return }
    const keys = $('chKeys').value.split('\n').map((s) => s.trim()).filter(Boolean)
    const body = {
      provider: $('chProvider').value.trim(),
      baseUrl: $('chBase').value.trim(),
      keys,
      models: splitCsv($('chModels').value) || [],
      weight: num($('chWeight').value) ?? 1,
      enabled: $('chEnabled').checked,
    }
    if (!keys.length) {
      // 编辑时留空表示保留原 key,从当前列表合并
      const cur = await api('/admin/channels')
      if (cur.ok) {
        const { user } = await cur.json()
        const old = user.find((x) => x.id === id)
        if (old?.keys?.length) body.keys = old.keys
      }
    }
    const res = await api('/admin/channels/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) })
    if (res.ok) {
      $('chHint').textContent = '已保存渠道 ' + id
      $('chId').value = ''; $('chProvider').value = ''; $('chBase').value = ''; $('chKeys').value = ''; $('chModels').value = ''
      loadChannels()
    } else {
      const j = await res.json().catch(() => null)
      $('chHint').textContent = '保存失败:' + (j?.error?.message || 'HTTP ' + res.status)
    }
  }

  // —— 模型别名 ——
  async function loadAliases() {
    const hint = $('alHint')
    const ul = $('alList')
    ul.innerHTML = ''
    const res = await api('/admin/aliases')
    if (!res.ok) return denied(hint, res)
    const items = await res.json()
    hint.textContent = '别名让客户端写固定模型名,后端随时切换实际模型/渠道'
    for (const { name, alias } of items) {
      const li = document.createElement('li')
      li.append(el('span', 'name', name), el('span', 'mode', '→ ' + alias.model + (alias.channel ? '(渠道 ' + alias.channel + ')' : '')))
      const del = el('button', 'del', '删除')
      del.onclick = async () => {
        await api('/admin/aliases/' + encodeURIComponent(name), { method: 'DELETE' })
        loadAliases()
      }
      li.appendChild(del)
      ul.appendChild(li)
    }
  }
  $('alSave').onclick = async () => {
    const name = $('alName').value.trim()
    const model = $('alModel').value.trim()
    if (!name || !model) { $('alHint').textContent = '别名和目标模型必填'; return }
    const body = { model, channel: $('alChannel').value.trim() || undefined }
    const res = await api('/admin/aliases/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify(body) })
    if (res.ok) {
      $('alHint').textContent = '已保存别名 ' + name
      $('alName').value = ''; $('alModel').value = ''; $('alChannel').value = ''
      loadAliases()
    } else denied($('alHint'), res)
  }

  // —— 镜像规则(自定义长期配置) ——
  let rules = []
  async function loadRules() {
    const hint = $('customHint')
    try {
      const res = await api('/admin/mirror-rules')
      if (res.ok) {
        rules = await res.json()
        hint.textContent = '共 ' + rules.length + ' 条。未登记的站点也可临时代理,规则用于固定模式/防盗链 referer'
      } else {
        rules = []
        denied(hint, res)
      }
    } catch {
      hint.textContent = '读取规则失败'
      rules = []
    }
    renderRules()
  }
  function renderRules() {
    const ul = $('customList')
    ul.innerHTML = ''
    for (const r of rules) {
      const li = document.createElement('li')
      li.append(el('span', 'name', r.host), el('span', 'mode', r.mode + (r.referer ? ' · referer 已配置' : '')))
      const del = el('button', 'del', '移除')
      del.onclick = async () => {
        rules = rules.filter((x) => x !== r)
        await saveRules()
      }
      li.appendChild(del)
      ul.appendChild(li)
    }
  }
  async function saveRules() {
    renderRules()
    const res = await api('/admin/mirror-rules', { method: 'PUT', body: JSON.stringify(rules) })
    $('customHint').textContent = res.ok ? '已保存 ' + rules.length + ' 条' : '保存失败,需要管理员令牌'
  }
  $('customAdd').onclick = () => {
    const host = $('customHost').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!host) return
    if (rules.some((r) => r.host === host)) { $('customHint').textContent = host + ' 已存在'; return }
    rules = [...rules, { host, mode: $('customMode').value }]
    $('customHost').value = ''
    saveRules()
  }

  window.addEventListener('hashchange', () => showView(currentView()))

  // ---------- 启动 ----------
  syncEngine()
  showView(currentView())
})()
