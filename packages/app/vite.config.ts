import { defineConfig } from 'vite';

// Relative asset paths: the same build works under GitHub Pages' /webtracker/
// and from any other folder or local preview.
export default defineConfig({
  base: './',
});
