// The build (build.mjs) inlines these with esbuild's text loader; tsc needs the shape.
declare module "*.md" {
  const content: string;
  export default content;
}
declare module "*.toml" {
  const content: string;
  export default content;
}
