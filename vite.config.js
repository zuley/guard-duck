import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: [
            'three',
            'three/addons/postprocessing/EffectComposer.js',
            'three/addons/postprocessing/RenderPass.js',
            'three/addons/postprocessing/UnrealBloomPass.js',
            'three/addons/postprocessing/ShaderPass.js',
            'three/addons/postprocessing/OutputPass.js',
            'three/addons/shaders/FXAAShader.js',
            'three/addons/utils/BufferGeometryUtils.js',
          ],
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
});
