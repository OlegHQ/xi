/** `bun build --compile` embeds these as `type: "file"` imports; each resolves to a path string. */
declare module '*.wasm' {
  const path: string;
  export default path;
}

declare module '*.scm' {
  const path: string;
  export default path;
}
