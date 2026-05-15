import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["tui.tsx"],
  outdir: "dist",
  target: "node",
  naming: "tui.[ext]",
  external: [
    "@opencode-ai/plugin",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    "solid-js/store",
  ],
  plugins: [createSolidTransformPlugin({ moduleName: "@opentui/solid" })],
})

if (!result.success) {
  console.error("TUI build failed:")
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log("TUI build complete")
