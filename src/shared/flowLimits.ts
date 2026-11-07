// A flow document's size limit, apart from the flow model so code that only checks a size (the assistant's tool schema,
// bundled into the sandbox host) doesn't pull in the TOML parser.
export const MAX_FLOW_BYTES = 64 * 1024
