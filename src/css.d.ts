// esbuild loads .css as text; this tells the type checker the same thing.
declare module "*.css" {
  const content: string;
  export default content;
}
