// esbuild inlines these with `--loader:.md=text --loader:.toml=text`; tsc needs the shape.
declare module "*.md" {
  const content: string;
  export default content;
}
declare module "*.toml" {
  const content: string;
  export default content;
}
