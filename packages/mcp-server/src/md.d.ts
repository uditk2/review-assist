// esbuild inlines these with `--loader:.md=text`; tsc needs the shape.
declare module "*.md" {
  const content: string;
  export default content;
}
