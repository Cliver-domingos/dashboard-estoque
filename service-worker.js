// Service worker do Dashboard de Estoque A365 — permite abrir o app (a casca:
// HTML/JS/ícones) mesmo sem internet, complementando a fila de escrita offline
// que já existe em app.js (G.6 do MAPA_DO_SISTEMA.md, que cobre só os DADOS;
// isto aqui cobre o próprio carregamento da página).
//
// ESTRATÉGIA (rede-primeiro, cache só como último recurso): o deploy deste
// projeto é upload manual pro GitHub Pages, e cache de navegador mascarando
// uma correção nova já causou confusão antes (ver MAPA_DO_SISTEMA.md, seção
// E). Por isso, sempre que houver conexão, a versão de rede é usada e
// atualiza o cache sozinha — o cache só entra em ação quando a rede falha de
// verdade. Isso também elimina a necessidade de "lembrar de trocar a versão"
// do cache a cada deploy: ele se mantém atualizado sozinho.
const CACHE_NAME = 'dashboard-estoque-shell-v1';

// Só os arquivos da CASCA do app (nunca dados/API). Os dois scripts de CDN
// (xlsx e supabase-js) precisam estar aqui com a URL EXATA usada no
// index.html — se a versão deles mudar lá, tem que mudar aqui também,
// senão o app não abre offline (o script ficaria de fora do cache).
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(chaves => Promise.all(chaves.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // Nunca intercepta escrita (POST/PUT/PATCH/DELETE) — isso já é tratado pela
  // fila offline do próprio app.js, um service worker no meio só atrapalharia.
  if (req.method !== 'GET') return;

  // Mesma origem (index.html, app.js, manifest, ícones, ou qualquer estático futuro
  // do próprio site) sempre entra no cache-com-fallback — este site não tem nenhuma
  // API própria, só arquivos estáticos, então isso é seguro por construção. Já um
  // pedido de outra origem só entra se for EXATAMENTE um dos CDNs precacheados acima
  // (necessários pro app abrir offline) — qualquer outra origem (Supabase, Google
  // Fonts) passa direto: nunca deve ser cacheada ou servida do cache (dado precisa
  // ser sempre fresco, e Realtime usa WebSocket, que o fetch nem intercepta mesmo).
  const url = new URL(req.url);
  const mesmaOrigem = url.origin === self.location.origin;
  const cdnConhecido = ASSETS.includes(req.url);
  if (!mesmaOrigem && !cdnConhecido) return;

  event.respondWith(
    // cache:'no-store' é essencial aqui: sem isso, o fetch() ainda pode ser
    // respondido pelo cache HTTP comum do navegador/GitHub Pages (Cache-Control
    // do próprio servidor), então "rede-primeiro" na prática virava "cache do
    // navegador primeiro" — o Cache API (linha abaixo) nunca era o problema,
    // era essa camada mais baixa que nem chegava a bater no servidor de novo.
    // Achado ao vivo (20/07/2026): usuário confirmou upload novo do app.js,
    // dado já validado certo no banco, mas o celular seguia servindo a versão
    // antiga — sintoma clássico de resposta HTTP em cache mascarando o deploy.
    fetch(req, { cache: 'no-store' })
      .then(res => {
        const copia = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copia));
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
  );
});
