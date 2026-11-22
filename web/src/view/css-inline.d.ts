// Vite's `?inline` CSS import: the stylesheet text as a string (used to inject uPlot's CSS into a shadow root).
declare module '*.css?inline' {
  const css: string;
  export default css;
}
