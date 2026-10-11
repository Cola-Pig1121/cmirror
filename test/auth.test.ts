import { describe, expect, it } from 'vitest'
import { extractRawToken } from '../src/middleware/auth'

function req(headers: Record<string, string>) {
  return new Request('https://cm.test/m/x', { headers })
}

describe('extractRawToken', () => {
  it('bearer', () => {
    expect(extractRawToken(req({ authorization: 'Bearer tok-1' }))).toBe('tok-1')
    expect(extractRawToken(req({ authorization: 'bearer  tok-2 ' }))).toBe('tok-2')
    expect(extractRawToken(req({ authorization: 'Bearer ' }))).toBeNull()
  })

  it('basic: token in password slot (git clone convention)', () => {
    const b64 = btoa('cmirror:git-tok-9')
    expect(extractRawToken(req({ authorization: `Basic ${b64}` }))).toBe('git-tok-9')
  })

  it('basic: token in username slot when password empty', () => {
    const b64 = btoa('user-only:')
    expect(extractRawToken(req({ authorization: `Basic ${b64}` }))).toBe('user-only')
  })

  it('basic: invalid base64 ignored', () => {
    expect(extractRawToken(req({ authorization: 'Basic %%%not-base64%%%' }))).toBeNull()
  })

  it('x-token header', () => {
    expect(extractRawToken(req({ 'x-token': 'xt-1' }))).toBe('xt-1')
  })

  it('cookie cmirror_token', () => {
    expect(extractRawToken(req({ cookie: 'other=1; cmirror_token=ck%20tok' }))).toBe('ck tok')
    expect(extractRawToken(req({ cookie: 'other=1' }))).toBeNull()
  })

  it('no auth', () => {
    expect(extractRawToken(req({}))).toBeNull()
  })
})
