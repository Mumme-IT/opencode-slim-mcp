// OpenCode loads index.ts first when this repository is configured as a local plugin directory.
// Published packages load the bundled entrypoint through package.json.
export { default } from './dist/server.js'
