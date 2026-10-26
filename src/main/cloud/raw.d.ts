// Vite's `?raw` imports (a file's text, bundled): the Docker sandbox's Dockerfile (dockerProvider.ts).
declare module '*?raw' {
  const text: string
  export default text
}
