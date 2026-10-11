import type { MirrorRule } from './rules'

/** git smart HTTP 协议路径:必须原样透传,不做任何改写(改 URL 会破坏协议) */
export function isGitSmartPath(pathname: string): boolean {
  return pathname.endsWith('/info/refs') || pathname.endsWith('/git-upload-pack')
}

export const GIT_SMART_NOTE = 'git clone 走 /m/https://github.com/<user>/<repo>.git;smart HTTP 路径原样透传'

/** 按路径决定实际传输模式:即便站点规则是 rewrite,下载/协议路径也要 stream */
export function resolveMode(rule: MirrorRule, pathname: string): 'rewrite' | 'stream' {
  if (isGitSmartPath(pathname)) return 'stream'
  if (rule.host === 'github.com') {
    if (
      pathname.includes('/releases/download/') ||
      pathname.includes('/releases/assets/') ||
      /\/archive\/.*\.(zip|tar\.gz|tgz|tar)$/i.test(pathname) ||
      pathname.startsWith('/desktop/')
    ) {
      return 'stream'
    }
  }
  return rule.mode
}
