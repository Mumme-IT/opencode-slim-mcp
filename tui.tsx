import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, createMemo, For, Match, Show, Switch, onMount, onCleanup } from "solid-js"

// ─── Types ───────────────────────────────────────────────────────────────────

interface SlimMcpServer {
  name: string
  status: "connected" | "pending" | "disabled" | "error" | "needs_auth"
  error?: string
}

interface StatusFile {
  servers: SlimMcpServer[]
  updatedAt: number
}

// ─── Status Reader (SDK → works local + remote) ─────────────────────────────

const STATUS_REL_PATH = "slim-mcp/status.json"

async function readStatusViaSDK(api: TuiPluginApi): Promise<SlimMcpServer[]> {
  try {
    const stateDir = (api.state as any).path?.state
    if (!stateDir) return []
    const result = await (api.client.file as any).read({
      path: STATUS_REL_PATH,
      directory: stateDir,
    })
    const content = result?.data?.content
    if (!content || typeof content !== "string") return []
    const data: StatusFile = JSON.parse(content)
    return data.servers ?? []
  } catch {
    return []
  }
}

// ─── View Component ──────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000

function View(props: { api: TuiPluginApi }) {
  const [servers, setServers] = createSignal<SlimMcpServer[]>([])
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current

  const on = createMemo(() => servers().filter((s) => s.status === "connected").length)
  const bad = createMemo(
    () => servers().filter((s) => s.status === "error" || s.status === "needs_auth").length,
  )

  const dot = (status: string) => {
    if (status === "connected") return theme().success
    if (status === "error") return theme().error
    if (status === "disabled") return theme().textMuted
    if (status === "needs_auth") return theme().warning
    return theme().textMuted
  }

  const refresh = async () => {
    const result = await readStatusViaSDK(props.api)
    setServers(result)
  }

  // Initial read + periodic poll
  onMount(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    onCleanup(() => clearInterval(interval))
  })

  // Refresh after MCP tool calls (server plugin writes status.json on state changes)
  onMount(() => {
    const off = props.api.event.on("tool.execute.after" as any, (evt: any) => {
      const toolName = evt?.properties?.tool
      if (toolName === "mcp" || toolName === "mcp-status") {
        // Small delay — let server plugin finish writing
        setTimeout(() => void refresh(), 500)
      }
    })
    onCleanup(off)
  })

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => servers().length > 2 && setOpen((x) => !x)}>
        <Show when={servers().length > 2}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        </Show>
        <text fg={theme().text}>
          <b>Slim MCP</b>
          <Show when={!open() && servers().length > 0}>
            <span style={{ fg: theme().textMuted }}>
              {" "}
              ({on()} active{bad() > 0 ? `, ${bad()} error${bad() > 1 ? "s" : ""}` : ""})
            </span>
          </Show>
        </text>
      </box>
      <Show when={servers().length === 0}>
        <text fg={theme().textMuted}>No slim MCPs available</text>
      </Show>
      <Show when={servers().length > 0 && (servers().length <= 2 || open())}>
        <For each={servers()}>
          {(item) => (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                style={{
                  fg: dot(item.status),
                }}
              >
                •
              </text>
              <text fg={theme().text} wrapMode="word">
                {item.name}{" "}
                <span style={{ fg: theme().textMuted }}>
                  <Switch fallback={item.status}>
                    <Match when={item.status === "connected"}>Connected</Match>
                    <Match when={item.status === "error"}>
                      <i>{item.error || "Error"}</i>
                    </Match>
                    <Match when={item.status === "disabled"}>Disabled</Match>
                    <Match when={item.status === "needs_auth"}>Needs auth</Match>
                    <Match when={item.status === "pending"}>Pending</Match>
                  </Switch>
                </span>
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

// ─── Plugin Registration ─────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 210, // after internal:sidebar-mcp (200)
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "slim-mcp.sidebar",
  tui,
}

export default plugin
