/**
 * 测试前把 Host 提供的 @deepseek-ai/schemastery 链进本包 node_modules。
 * 发布 tarball 不含 node_modules；真实运行时由 DSH profile 提供该依赖。
 * 找不到时用 DSH_SCHEMASTER_DIR 指一个安装位置。
 */
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const target = join(root, 'node_modules', '@deepseek-ai', 'schemastery')
if (existsSync(join(target, 'package.json'))) process.exit(0)

function profileCopies() {
  const base = join(homedir(), '.dsh', 'profiles')
  try {
    return readdirSync(base).map((name) => join(base, name, 'node_modules', '@deepseek-ai', 'schemastery'))
  } catch {
    return []
  }
}

const source = [process.env.DSH_SCHEMASTER_DIR, ...profileCopies()].find(
  (dir) => typeof dir === 'string' && existsSync(join(dir, 'package.json')),
)

if (source === undefined) {
  console.error('[test] 找不到 @deepseek-ai/schemastery；请设置 DSH_SCHEMASTER_DIR 指向该包目录')
  process.exit(1)
}

mkdirSync(dirname(target), { recursive: true })
symlinkSync(source, target, 'junction')
console.log('[test] linked @deepseek-ai/schemastery -> ' + source)
