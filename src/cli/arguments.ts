export interface Arguments {
  command: 'status' | 'list' | 'schema' | 'call'
  server?: string
  tool?: string
  json?: string
  stdin: boolean
  url?: string
  directory?: string
}

export function parseArguments(argv: string[]): Arguments {
  const positional: string[] = []
  const options: Record<string, string> = {}
  let stdin = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--stdin') {
      if (stdin) throw new Error('Duplicate --stdin')
      stdin = true
    } else if (['--json', '--url', '--directory'].includes(arg)) {
      if (options[arg] !== undefined || argv[i + 1] === undefined) throw new Error(`Invalid ${arg}`)
      options[arg] = argv[++i]
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else positional.push(arg)
  }
  const [command, server, tool] = positional
  if (!['status', 'list', 'schema', 'call'].includes(command)) throw new Error('Expected status, list, schema, or call')
  const length = command === 'status' ? 1 : command === 'list' ? 2 : 3
  if (positional.length !== length) throw new Error('Invalid number of arguments')
  if (command === 'call') {
    if (stdin === (options['--json'] !== undefined)) throw new Error('Choose exactly one of --json or --stdin')
  } else if (stdin || options['--json'] !== undefined) throw new Error('JSON arguments are only accepted by call')
  return { command: command as Arguments['command'], server, tool, json: options['--json'], stdin, url: options['--url'], directory: options['--directory'] }
}

export function parseJson(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > 1_048_576) throw new Error('JSON arguments exceed 1 MiB')
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Arguments must be a JSON object')
  return value
}
