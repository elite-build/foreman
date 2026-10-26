// The command's own version: the app's, because the command ships inside it. The bundler inlines the one field.
import { version } from '../../package.json'

export const CLI_VERSION: string = version
