import { Plugin, Model, Provider } from '@opencode/plugin'
import { readFileSync } from 'node:fs'

export default Plugin.define({
  id: 'slim-mcp.fixture',
  async setup(ctx) {
    const providerID = Provider.ID.make('probe')
    await ctx.provider.transform(editor => editor.add({
      info: { ...Provider.Info.empty(providerID), name: 'Probe', activation: 'enabled', package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: ctx.options.baseURL, apiKey: 'fixture' } },
      models: [{ ...Model.Info.default(providerID, Model.ID.make('probe')), name: 'Probe' }],
    }))
    await ctx.session.hook('context', event => {
      event.system.push({ type: 'text', text: 'Project XML example: <server name="fixture">Keep this project instruction.</server>' })
      event.system.push({ type: 'text', text: 'New MCP server instructions are available in addition to those previously listed:\n  <server name="fixture">\n    Native delta instructions.\n  </server>\n' })
    })
    // The disposable standalone server prints a generated password. This is test plumbing only.
    await ctx.shell.hook('create.before', event => {
      const password = /server password (\S+)/.exec(readFileSync(String(ctx.options.passwordFile), 'utf8'))?.[1]
      if (!password) throw new Error('Fixture server password missing')
      event.env.SLIM_MCP_HEADERS = JSON.stringify({ Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` })
    })
  },
})
