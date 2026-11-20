import { deflateRawSync } from 'node:zlib';
import { defineConfig } from 'vite';

// 85 个 HTML/JS 安全可见 ASCII 字符（不含 < > & ' " \ `）
const B85 = '!#$%()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_abcdefghijklmnopqrstuvwxyz{|';

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodeBase85(buf) {
  const pad = (4 - (buf.length % 4)) % 4;
  const padded = pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf;
  const out = new Array(padded.length / 4);
  for (let i = 0, k = 0; i < padded.length; i += 4, k++) {
    let v = padded.readUInt32BE(i);
    const c4 = v % 85; v = (v - c4) / 85;
    const c3 = v % 85; v = (v - c3) / 85;
    const c2 = v % 85; v = (v - c2) / 85;
    const c1 = v % 85; const c0 = (v - c1) / 85;
    out[k] = B85[c0] + B85[c1] + B85[c2] + B85[c3] + B85[c4];
  }
  return { encoded: out.join(''), paddedLen: padded.length };
}

/**
 * 将构建产物压缩打包为单个离线自包含 dist/index.html（deflate-raw + Base85 自解压）。
 */
function singleHtmlPlugin() {
  return {
    name: 'single-html',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const htmlAsset = bundle['index.html'];
      if (!htmlAsset || htmlAsset.type !== 'asset') return;

      let html = String(htmlAsset.source);
      const cssParts = [];
      const jsParts = [];

      for (const [fileName, item] of Object.entries(bundle)) {
        const escaped = escapeRegExp(fileName);

        if (item.type === 'asset' && fileName.endsWith('.css')) {
          const cssRe = new RegExp(
            `<link\\b[^>]*?\\bhref=["'][^"']*?${escaped}["'][^>]*?>\\s*`,
            'gi',
          );
          html = html.replace(cssRe, () => '');
          cssParts.push(String(item.source).trim());
          delete bundle[fileName];
        } else if (item.type === 'chunk' && fileName.endsWith('.js')) {
          const scriptRe = new RegExp(
            `<script\\b[^>]*?\\bsrc=["'][^"']*?${escaped}["'][^>]*?>\\s*</script>\\s*`,
            'gi',
          );
          html = html.replace(scriptRe, () => '');
          jsParts.push(item.code.trim().replace(/\n\t+/g, '\n').replace(/\t+/g, ' '));
          delete bundle[fileName];
        }
      }

      html = html.replace(/<link\b[^>]*?\brel=["']modulepreload["'][^>]*?>\s*/gi, '');

      const bootCss = '*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden;background:#0b0e14;color:#fff}#loading{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;gap:18px;align-items:center;justify-content:center;background:#0b0e14}';
      html = html.replace(/<\/head>/i, () => `<style id="s">${bootCss}</style></head>`);

      const payload = Buffer.from(`${cssParts.join('\n')}\0${jsParts.join('\n')}`);
      const compressed = deflateRawSync(payload, { level: 9 });
      const { encoded, paddedLen } = encodeBase85(compressed);

      const bootJs = `const A='${B85}',P='${encoded}',M=new Uint8Array(128),B=new Uint8Array(${paddedLen});`
        + `for(let i=0;i<85;i++)M[A.charCodeAt(i)]=i;`
        + `for(let i=0,j=0;i<P.length;i+=5,j+=4){const v=(((M[P.charCodeAt(i)]*85+M[P.charCodeAt(i+1)])*85+M[P.charCodeAt(i+2)])*85+M[P.charCodeAt(i+3)])*85+M[P.charCodeAt(i+4)];B[j]=v>>>24;B[j+1]=v>>>16;B[j+2]=v>>>8;B[j+3]=v}`
        + `new Response(new Blob([B.subarray(0,${compressed.length})]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text().then(t=>{const i=t.indexOf('\\0');document.getElementById('s').textContent=t.slice(0,i);const s=document.createElement('script');s.type='module';s.textContent=t.slice(i+1);document.body.appendChild(s)}).catch(e=>{const p=document.querySelector('#loading p');if(p)p.textContent='加载失败：'+e.message;console.error(e)});`;

      html = html.replace(/^\s+/gm, '').replace(/\r?\n/g, '');
      html = html.replace(/<\/body>/i, () => `<script type="module">${bootJs}</script></body>`);
      htmlAsset.source = html;
    },
  };
}

export default defineConfig({
  plugins: [singleHtmlPlugin()],
  build: {
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    modulePreload: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
