import { describe, expect, it } from 'vitest'
import { wrapMirrorUrl, wrapSrcset, rewriteMetaRefresh, rewriteCSSText } from '../src/mirror/rewrite'
import { isGitSmartPath, resolveMode } from '../src/mirror/github'
import { parseMirrorPath } from '../src/mirror/route'
import { sanitizeUpstreamHeaders, sanitizeResponseHeaders, wrapLocation } from '../src/mirror/headers'
import { matchRule, ruleAllowsPath, validateRules, autoModeFor, DEFAULT_RULES } from '../src/mirror/rules'
import type { MirrorRule } from '../src/mirror/rules'

const page = new URL('https://github.com/user/repo/index.html')
const M = 'https://cm.test/m/'

describe('wrapMirrorUrl', () => {
  it('wraps relative paths against the page URL', () => {
    expect(wrapMirrorUrl('/assets/app.js', page, M)).toBe(M + 'https://github.com/assets/app.js')
    expect(wrapMirrorUrl('./style.css', page, M)).toBe(M + 'https://github.com/user/repo/style.css')
    expect(wrapMirrorUrl('../x.png', page, M)).toBe(M + 'https://github.com/user/x.png')
  })
  it('wraps absolute URLs', () => {
    expect(wrapMirrorUrl('https://api.github.com/foo', page, M)).toBe(M + 'https://api.github.com/foo')
    expect(wrapMirrorUrl('//cdn.example.com/a', page, M)).toBe(M + 'https://cdn.example.com/a')
  })
  it('skips anchors, special protocols, empty, already-wrapped', () => {
    expect(wrapMirrorUrl('#section', page, M)).toBeNull()
    expect(wrapMirrorUrl('javascript:void(0)', page, M)).toBeNull()
    expect(wrapMirrorUrl('mailto:a@b.c', page, M)).toBeNull()
    expect(wrapMirrorUrl('data:image/png;base64,AAA', page, M)).toBeNull()
    expect(wrapMirrorUrl('', page, M)).toBeNull()
    expect(wrapMirrorUrl(M + 'https://github.com/x', page, M)).toBeNull()
  })
  it('preserves spaces via encoding', () => {
    const w = wrapMirrorUrl('/my file.txt', page, M)!
    expect(w).toContain('my%20file.txt')
  })
})

describe('wrapSrcset', () => {
  it('wraps each candidate, keeps descriptors', () => {
    const out = wrapSrcset('small.png 1x, medium.png 2x, big.png 1200w', page, M)
    expect(out).toBe(
      M + 'https://github.com/user/repo/small.png 1x, ' +
      M + 'https://github.com/user/repo/medium.png 2x, ' +
      M + 'https://github.com/user/repo/big.png 1200w',
    )
  })
})

describe('rewriteMetaRefresh', () => {
  it('rewrites refresh url', () => {
    expect(rewriteMetaRefresh('0; url=/login', page, M)).toBe('0; url=' + M + 'https://github.com/login')
    expect(rewriteMetaRefresh('5;URL=https://example.com/x', page, M)).toBe('5; url=' + M + 'https://example.com/x')
  })
})

describe('rewriteCSSText', () => {
  it('rewrites url() with quotes and bare', () => {
    const css = '.a { background: url("img/bg.png") } .b { src: url(/fonts/f.woff2) } .c { u: url(#gradient) } .d { i: url(data:image/svg+xml,<x/>) }'
    const out = rewriteCSSText(css, page, M)
    expect(out).toContain('url("' + M + 'https://github.com/user/repo/img/bg.png")')
    expect(out).toContain('url("' + M + 'https://github.com/fonts/f.woff2")')
    expect(out).toContain('url(#gradient)')
    expect(out).toContain('url(data:image/svg+xml,<x/>)')
  })
})

describe('github smart http', () => {
  it('parseMirrorPath extracts mode segment', () => {
    expect(parseMirrorPath('https://example.com/a')).toEqual({ mode: null, rest: 'https://example.com/a' })
    expect(parseMirrorPath('stream/https://example.com/a')).toEqual({ mode: 'stream', rest: 'https://example.com/a' })
    expect(parseMirrorPath('rewrite/https://example.com/a')).toEqual({ mode: 'rewrite', rest: 'https://example.com/a' })
    // 目标站自身路径含 stream/ 前缀不受影响(仅匹配 /m/ 后第一段)
    expect(parseMirrorPath('https://example.com/stream/x')).toEqual({ mode: null, rest: 'https://example.com/stream/x' })
  })
  it('detects protocol paths', () => {
    expect(isGitSmartPath('/user/repo.git/info/refs')).toBe(true)
    expect(isGitSmartPath('/user/repo.git/git-upload-pack')).toBe(true)
    expect(isGitSmartPath('/user/repo')).toBe(false)
  })
  it('forces stream mode for downloads & git', () => {
    const gh: MirrorRule = { host: 'github.com', mode: 'rewrite' }
    expect(resolveMode(gh, '/u/r.git/info/refs')).toBe('stream')
    expect(resolveMode(gh, '/u/r/releases/download/v1/asset.bin')).toBe('stream')
    expect(resolveMode(gh, '/u/r')).toBe('rewrite')
  })
})

describe('headers', () => {
  it('referer override for anti-hotlink hosts', () => {
    const req = new Request('https://cm.test/m/x')
    const out = sanitizeUpstreamHeaders(req, new URL('https://i.pximg.net/a.png'), 'https://www.pixiv.net/')
    expect(out.get('referer')).toBe('https://www.pixiv.net/')
    expect(out.get('origin')).toBe('https://www.pixiv.net')
    // 非法覆盖值退回目标站
    const out2 = sanitizeUpstreamHeaders(req, new URL('https://i.pximg.net/a.png'), 'not a url')
    expect(out2.get('referer')).toBe('https://i.pximg.net/')
  })

  it('strips gateway/auth/internal headers, keeps sec-fetch-*, sets origin/referer', () => {
    const req = new Request('https://cm.test/m/x', {
      headers: {
        authorization: 'Bearer secret',
        'x-token': 'tok',
        cookie: 'session=abc',
        'cf-connecting-ip': '1.2.3.4',
        'x-forwarded-for': '9.9.9.9',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'accept-encoding': 'gzip',
        'user-agent': 'my-agent',
      },
    })
    const out = sanitizeUpstreamHeaders(req, new URL('https://raw.githubusercontent.com/u/r/main/f'))
    expect(out.get('authorization')).toBeNull()
    expect(out.get('x-token')).toBeNull()
    expect(out.get('cookie')).toBeNull()
    expect(out.get('cf-connecting-ip')).toBeNull()
    expect(out.get('x-forwarded-for')).toBeNull()
    expect(out.get('accept-encoding')).toBeNull()
    expect(out.get('user-agent')).toBe('my-agent')
    // sec-fetch-* 保留(GitHub 据此判断浏览器请求),sec-fetch-site 改写为 cross-site
    expect(out.get('sec-fetch-mode')).toBe('navigate')
    expect(out.get('sec-fetch-site')).toBe('cross-site')
    expect(out.get('origin')).toBe('https://raw.githubusercontent.com')
  })

  it('response: drops CSP/XFO/set-cookie, rewrites location', () => {
    const h = new Headers({
      location: '/next',
      'set-cookie': 'sid=1; Domain=github.com; Path=/docs; HttpOnly; Secure',
      'content-security-policy': "default-src 'self'",
      'x-frame-options': 'DENY',
      server: 'GitHub.com',
      'cf-ray': 'abc',
    })
    const out = sanitizeResponseHeaders(h, { target: page, mirrorBase: M, mode: 'rewrite' })
    expect(out.get('location')).toBe(M + 'https://github.com/next')
    expect(out.get('content-security-policy')).toBeNull()
    expect(out.get('x-frame-options')).toBeNull()
    expect(out.get('server')).toBeNull()
    expect(out.get('cf-ray')).toBeNull()
    // 目标站 cookie 一律丢弃,防止挤占本域 Cookie 配额驱逐 cmirror_token
    expect(out.get('set-cookie')).toBeNull()
    expect(out.get('content-length')).toBeNull()
  })

  it('wrapLocation resolves relative to target', () => {
    expect(wrapLocation('sub/page', page, M)).toBe(M + 'https://github.com/user/repo/sub/page')
    expect(wrapLocation('https://codeload.github.com/x', page, M)).toBe(M + 'https://codeload.github.com/x')
    expect(wrapLocation('javascript:alert(1)', page, M)).toBeNull()
  })
})

describe('rules', () => {
  it('autoModeFor content-type', () => {
    expect(autoModeFor('text/html; charset=utf-8')).toBe('rewrite')
    expect(autoModeFor('text/css')).toBe('rewrite')
    expect(autoModeFor('application/json')).toBe('stream')
    expect(autoModeFor('image/png')).toBe('stream')
    expect(autoModeFor('')).toBe('stream')
  })
  it('pixiv not in defaults (site-wide CF risk control), but referer field still works via custom rules', () => {
    expect(matchRule(DEFAULT_RULES, 'i.pximg.net')).toBeUndefined()
    expect(matchRule(DEFAULT_RULES, 'www.pixiv.net')).toBeUndefined()
    const custom: MirrorRule = { host: 'i.pximg.net', mode: 'stream', referer: 'https://www.pixiv.net/' }
    expect(matchRule([custom], 'i.pximg.net')?.referer).toBe('https://www.pixiv.net/')
  })
  it('matchRule exact host', () => {
    expect(matchRule(DEFAULT_RULES, 'raw.githubusercontent.com')?.mode).toBe('stream')
    expect(matchRule(DEFAULT_RULES, 'evil.example.com')).toBeUndefined()
    expect(matchRule(DEFAULT_RULES, 'GITHUB.COM')?.host).toBe('github.com')
  })
  it('pathPrefixes narrowing', () => {
    const r: MirrorRule = { host: 'x.com', mode: 'stream', pathPrefixes: ['/files/'] }
    expect(ruleAllowsPath(r, '/files/a')).toBe(true)
    expect(ruleAllowsPath(r, '/private/a')).toBe(false)
  })
  it('validateRules rejects unsafe hosts', () => {
    expect(validateRules([{ host: '127.0.0.1', mode: 'stream' }])).toBeTruthy()
    expect(validateRules([{ host: 'localhost', mode: 'rewrite' }])).toBeTruthy()
    expect(validateRules(DEFAULT_RULES)).toBeNull()
  })
})
