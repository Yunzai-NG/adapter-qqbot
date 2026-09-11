import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { defineConfig } from "vitest/config"

/** 定位框架包的源码目录，优先使用显式环境变量。 */
function frameworkSrc(pkg: string): string | undefined {
  const short = pkg.slice("@yunzai-ng/".length)
  const roots: string[] = []
  if (process.env.YZNG_FRAMEWORK) roots.push(resolve(process.env.YZNG_FRAMEWORK, "packages", short))
  try {
    roots.push(dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`)))
  } catch {
    // 未安装或未链接时，继续尝试同仓库 checkout。
  }
  roots.push(resolve(import.meta.dirname, "..", "..", "packages", short))
  for (const root of roots) {
    if (existsSync(resolve(root, "src", "index.ts"))) return resolve(root, "src")
  }
  return undefined
}

const core = frameworkSrc("@yunzai-ng/core")
const types = frameworkSrc("@yunzai-ng/types")

if (!core || !types) {
  throw new Error("未找到框架源码；请设置 YZNG_FRAMEWORK 或先执行 pnpm run link:framework")
}

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@yunzai-ng\/core$/, replacement: resolve(core, "index.ts") },
      { find: /^@yunzai-ng\/types$/, replacement: resolve(types, "index.ts") },
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1.ts" }
    ]
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    pool: "forks"
  }
})
