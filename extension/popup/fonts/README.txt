Fontes do popup (OPCIONAIS)
===========================

O popup usa as fontes da identidade chatPro:
  - Paytone One  (títulos)
  - Space Grotesk (textos)

A CSP de extensões do Chrome NÃO permite carregar fontes de CDN (Google
Fonts). Por isso o popup.css referencia arquivos LOCAIS nesta pasta.
Sem eles nada quebra: o navegador cai no fallback system-ui.

Para ativar as fontes, baixe do Google Fonts e coloque AQUI os arquivos
com exatamente estes nomes:

  PaytoneOne-Regular.woff2
  SpaceGrotesk-Regular.woff2
  SpaceGrotesk-Medium.woff2
  SpaceGrotesk-Bold.woff2

Como baixar:
  1. Acesse https://fonts.google.com/specimen/Paytone+One e
     https://fonts.google.com/specimen/Space+Grotesk
  2. Clique em "Get font" > "Download all" (vem um .zip com .ttf).
  3. Converta os .ttf para .woff2 (ex.: https://cloudconvert.com/ttf-to-woff2
     ou a ferramenta `woff2_compress` do pacote google/woff2).
  4. Renomeie conforme a lista acima e salve nesta pasta.
  5. Recarregue a extensão em chrome://extensions.

Dica: se preferir usar os .ttf direto, troque no popup.css a extensão
".woff2" por ".ttf" e o format('woff2') por format('truetype').
