/* =========================================================
   Controle de Estoque & Inventário — App (vanilla JS)
   Salva tudo em localStorage. Sem servidor, sem instalação.
   ========================================================= */

const STORE_KEY = 'estoque_a365_v1';
const DIAS_PARADO = 20; // a partir de quantos dias com técnico um item é considerado "parado"
const STATUS = { estoque:'Em estoque', com_tecnico:'Com técnico', baixado:'RMA' };
const TIPO_CORES = ['#2563eb','#7c3aed','#16a34a','#d97706','#dc2626','#0891b2','#db2777','#65a30d'];
const MOV_LABEL = { entrada:'Entrada', saida:'Saída p/ técnico', transferencia:'Transferência', baixa:'Envio p/ RMA', retorno_rma:'Retorno de RMA', confirmacao:'Confirmação de recebimento', exclusao:'Exclusão definitiva', cancelamento:'Envio cancelado', registro_campo:'Registro em campo' };

/* ---------- Estado ---------- */
let DB = carregar();

function estadoInicial(){
  return {
    tipos: {},          // { "UBI.0001": {nome, cor, min} }  min = estoque mínimo
    filiais: [],        // ["BNU","CAS", ...] — pode existir mesmo sem equipamento ainda
    tecnicos: [],       // { id, nome, regiao, matricula }
    equipamentos: [],   // { serie, tipo, deposito, status, tecnicoId, local, desde, dataEntrada, origem, familia, derivacao, um, obs }
    movimentacoes: [],  // { id, ts, tipo, serie, de, para, tecnicoId, usuario, obs }
    auditorias: [],     // { id, ts, alvoTipo:'tecnico'|'deposito', alvoId, alvoNome, auditor, esperados:[serie], conferidos:[serie], faltando:[serie], sobrando:[serie], obs }
    config: { usuario:'', importadoEm:null, empresa:'A365' }
  };
}
function carregar(){
  try{ const r = localStorage.getItem(STORE_KEY); if(r) return Object.assign(estadoInicial(), JSON.parse(r)); }catch(e){}
  return estadoInicial();
}
function salvarLocal(){ localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }

/* ---------- Login (Firebase Auth) ---------- */
let loginModo = 'entrar'; // ou 'criar'
function loginAlternar(){
  loginModo = loginModo==='entrar' ? 'criar' : 'entrar';
  $('#loginSub').textContent = loginModo==='entrar' ? 'Entre com seu e-mail e senha' : 'Crie sua conta com e-mail e senha';
  $('#loginBtn').textContent = loginModo==='entrar' ? 'Entrar' : 'Criar conta';
  $('#loginAlternarLink').textContent = loginModo==='entrar' ? 'Criar conta' : 'Já tenho conta';
  $('#loginErr').style.display='none';
}
function loginErro(msg){ const e=$('#loginErr'); e.textContent=msg; e.style.display='block'; }
const LOGIN_ERROS = {
  'auth/invalid-email':'E-mail inválido.',
  'auth/missing-password':'Informe a senha.',
  'auth/weak-password':'A senha precisa ter ao menos 6 caracteres.',
  'auth/email-already-in-use':'Já existe uma conta com esse e-mail. Clique em "Já tenho conta".',
  'auth/invalid-credential':'E-mail ou senha incorretos.',
  'auth/wrong-password':'E-mail ou senha incorretos.',
  'auth/user-not-found':'Não existe conta com esse e-mail. Clique em "Criar conta".',
  'auth/too-many-requests':'Muitas tentativas. Aguarde um pouco e tente de novo.'
};
function loginSubmit(){
  const email = $('#loginEmail').value.trim();
  const senha = $('#loginSenha').value;
  if(!email||!senha) return loginErro('Preencha e-mail e senha.');
  $('#loginErr').style.display='none';
  const acao = loginModo==='entrar'
    ? window.firebaseAuth.signInWithEmailAndPassword(email, senha)
    : window.firebaseAuth.createUserWithEmailAndPassword(email, senha);
  acao.catch(err=> loginErro(LOGIN_ERROS[err.code] || ('Erro: '+err.message)));
}
function logout(){ if(confirm('Sair da sua conta?')) window.firebaseAuth.signOut(); }

/* ---------- Perfis / hierarquia (admin, supervisor, técnico) ---------- */
const USERS_REF = window.firestoreDB.collection('usuarios');
let MEU_PERFIL = null; // {uid, email, nome, papel:'pendente'|'admin'|'supervisor'|'tecnico', regioes:[], tecnicoId}
let syncIniciado = false;
let perfilListenerAtivo = null;

function souAdmin(){ return !!MEU_PERFIL && MEU_PERFIL.papel==='admin'; }
function souSupervisor(){ return !!MEU_PERFIL && MEU_PERFIL.papel==='supervisor'; }
function souTecnico(){ return !!MEU_PERFIL && MEU_PERFIL.papel==='tecnico'; }
function nomeUsuarioAtual(){ return (MEU_PERFIL && (MEU_PERFIL.nome||MEU_PERFIL.email)) || 'desconhecido'; }
function regiaoPermitida(dep){
  if(!MEU_PERFIL) return false;
  if(MEU_PERFIL.papel==='admin') return true;
  if(MEU_PERFIL.papel==='supervisor') return (MEU_PERFIL.regioes||[]).includes(dep);
  return false;
}

window.firebaseAuth.onAuthStateChanged(async user=>{
  if(perfilListenerAtivo){ perfilListenerAtivo(); perfilListenerAtivo=null; }
  if(user){
    $('#loginBg').style.display='none';
    $('#pendingBg').style.display='none';
    const ref = USERS_REF.doc(user.uid);
    const snap = await ref.get().catch(()=>null);
    if(snap && !snap.exists){
      await ref.set({ email:user.email, nome:(user.email||'').split('@')[0], papel:'pendente', regioes:[], tecnicoId:null, criadoEm:Date.now() }).catch(()=>{});
    }
    perfilListenerAtivo = ref.onSnapshot(s=>{
      MEU_PERFIL = s.exists ? Object.assign({uid:user.uid}, s.data()) : null;
      aplicarPerfil(user);
    }, ()=>{ MEU_PERFIL=null; aplicarPerfil(user); });
  } else {
    MEU_PERFIL = null; syncIniciado=false;
    $('#loginBg').style.display='flex';
    $('#pendingBg').style.display='none';
    $('#appRoot').style.display='none';
  }
});

function aplicarPerfil(user){
  if(!MEU_PERFIL || MEU_PERFIL.papel==='pendente'){
    $('#appRoot').style.display='none';
    $('#pendingBg').style.display='flex';
    $('#pendingInfo').textContent = 'Conta: '+user.email;
    return;
  }
  $('#pendingBg').style.display='none';
  $('#appRoot').style.display='';
  $('#userEmailLbl').textContent = (MEU_PERFIL.nome||user.email) + ' · ' + PAPEL_LABEL[MEU_PERFIL.papel];
  if(!syncIniciado){ syncIniciado=true; iniciarSyncNuvem(); }
  renderNav();
  goto(PAGE_ATUAL_VALIDA()?PAGE:PAGINA_INICIAL());
}
const PAPEL_LABEL = { admin:'Administrador', supervisor:'Supervisor', tecnico:'Técnico' };
function PAGINA_INICIAL(){ return souTecnico() ? 'meusItens' : 'dashboard'; }
function PAGE_ATUAL_VALIDA(){ return paginasDisponiveis().some(p=>p.id===PAGE); }

/* ---------- Sincronização em nuvem (Firestore) ---------- */
const DOC_REF = window.firestoreDB.collection('estoques').doc('dashboard');
const MOVS_REF = window.firestoreDB.collection('movimentacoes');
let aplicandoRemoto = false;
let salvarTimeout = null;
let movsCarregadas = false;

// O histórico de movimentações fica numa coleção própria (sem o limite de 1MB do doc único
// estoques/dashboard). Cada evento vira 1 documento, gravado na hora em que acontece.
function registrarMovimentacao(m){
  DB.movimentacoes.push(m);
  MOVS_REF.doc(m.id).set(m).catch(e=>flash('⚠️ Falha ao salvar movimentação: '+e.message,'red'));
}

function salvar(){
  salvarLocal();
  if(aplicandoRemoto) return;
  clearTimeout(salvarTimeout);
  salvarTimeout = setTimeout(()=>{
    const { movimentacoes, ...semMovs } = DB;
    DOC_REF.set(semMovs).catch(e=>flash('⚠️ Falha ao sincronizar: '+e.message,'red'));
  }, 400);
}

function iniciarSyncNuvem(){
  const foot = document.getElementById('footSync');
  DOC_REF.onSnapshot(snap=>{
    if(foot) foot.innerHTML = 'Sincronizado com a nuvem ☁️<br>Faça backup em <b>Dados</b>.';
    if(snap.metadata.hasPendingWrites) return; // eco da própria escrita
    const data = snap.data();
    if(data){
      aplicandoRemoto = true;
      const movsAtual = DB.movimentacoes;
      DB = Object.assign(estadoInicial(), data);
      DB.movimentacoes = movsAtual; // histórico é gerenciado pelo listener da coleção própria
      salvarLocal();
      aplicandoRemoto = false;
      renderNav(); render();
    } else {
      const { movimentacoes, ...semMovs } = DB;
      DOC_REF.set(semMovs); // primeira vez: envia os dados locais como base
    }
  }, err=>{
    if(foot) foot.innerHTML = '⚠️ Sem conexão com a nuvem<br>Usando dados locais.';
    flash('⚠️ Erro de sincronização: '+err.message,'red');
  });
  MOVS_REF.orderBy('ts','asc').limitToLast(3000).onSnapshot(snap=>{
    DB.movimentacoes = snap.docs.map(d=>d.data());
    salvarLocal();
    if(movsCarregadas) render();
    movsCarregadas = true;
  }, err=>{ flash('⚠️ Erro ao carregar histórico: '+err.message,'red'); });
}
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
const FILIAL_CORRECOES = { 'SFO':'SOO', 'SF0':'SOO', 'JDA':'JND', 'POA':'PAE', 'RIP':'RBP' };
function todasFiliaisConhecidas(){
  const s = new Set(DB.filiais||[]);
  DB.equipamentos.forEach(e=>{ if(e.deposito) s.add(e.deposito); });
  DB.tecnicos.forEach(t=>{ if(t.regiao) s.add(t.regiao); });
  return [...s].sort();
}
function detectarTipoPorSerie(serie){
  if(!serie) return null;
  const s = String(serie).trim().toUpperCase();
  if(s.startsWith('A453EE20')) return 'Modulo';
  if(s.startsWith('00-')) return 'Controle';
  if(s.startsWith('02-')) return 'Foto';
  if(s.startsWith('04-')) return 'Magnetico';
  if(s.startsWith('05-')) return 'Sirene';
  return null;
}
function limparFilial(s){
  let v = (s==null?'':String(s)).trim().replace(/EPV$/i,'').trim().toUpperCase();
  if(FILIAL_CORRECOES[v]) v = FILIAL_CORRECOES[v];
  return v;
}

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => (s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function tecNome(id){ const t = DB.tecnicos.find(x=>x.id===id); if(!t) return '—'; return (t.regiao?'['+t.regiao+'] ':'')+t.nome; }
function tipoNome(cod){ return (DB.tipos[cod]&&DB.tipos[cod].nome)||cod; }
function tipoCor(cod){ const k=Object.keys(DB.tipos); const i=k.indexOf(cod); return (DB.tipos[cod]&&DB.tipos[cod].cor)||TIPO_CORES[i%TIPO_CORES.length]||'#64748b'; }
function fmtData(d){ if(!d) return '—'; if(d instanceof Date) return d.toLocaleDateString('pt-BR'); return d; }
function fmtTS(ts){ const d=new Date(ts); return d.toLocaleDateString('pt-BR')+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }
function flash(msg, kind=''){ const f=document.createElement('div'); f.className='flash '+kind; f.innerHTML=msg; document.body.appendChild(f); setTimeout(()=>{f.style.opacity='0';f.style.transition='.3s';setTimeout(()=>f.remove(),300);},2400); }
function refTS(e){ return e.desde || DB.config.importadoEm || null; }
function diasEmPosse(e){ const t=refTS(e); if(!t) return null; return Math.floor((Date.now()-t)/86400000); }
function fmtDias(n){ if(n==null) return '—'; if(n===0) return 'hoje'; if(n===1) return '1 dia'; if(n<30) return n+' dias'; const m=Math.floor(n/30); return m+(m===1?' mês':' meses'); }
function ultimaAuditoria(alvoTipo, alvoId){ const a=DB.auditorias.filter(x=>x.alvoTipo===alvoTipo&&x.alvoId===alvoId); return a.length?a[a.length-1]:null; }
function itensDoTecnico(id){ return DB.equipamentos.filter(e=>e.tecnicoId===id && e.status==='com_tecnico'); }
function itensDoDeposito(dep){ return DB.equipamentos.filter(e=>e.status==='estoque' && (e.local||e.deposito||'')===dep); }
function estoqueMinAlertas(lista){ lista=lista||DB.equipamentos; const r=[]; Object.keys(DB.tipos).forEach(t=>{ const min=DB.tipos[t].min||0; if(min>0){ const n=lista.filter(e=>e.tipo===t&&e.status==='estoque').length; if(n<min) r.push({tipo:t,atual:n,min}); } }); return r; }

/* ---------- Modo escuro ---------- */
function toggleDark(){ document.body.classList.toggle('dark'); localStorage.setItem('estoque_dark', document.body.classList.contains('dark')?'1':'0'); }
if(localStorage.getItem('estoque_dark')==='1') document.body.classList.add('dark');

/* ---------- Navegação ---------- */
const PAGES = [
  { id:'dashboard', icon:'📊', titulo:'Visão Geral', sub:'Resumo do inventário', papeis:['admin','supervisor'] },
  { id:'equip',     icon:'📦', titulo:'Equipamentos', sub:'Inventário item a item', papeis:['admin','supervisor'] },
  { id:'mov',       icon:'🔄', titulo:'Movimentar', sub:'Registrar entrada, saída, transferência ou baixa', papeis:['admin','supervisor','tecnico'] },
  { id:'tecnicos',  icon:'👷', titulo:'Técnicos', sub:'Cadastro e equipamentos em posse', papeis:['admin','supervisor'] },
  { id:'parados',   icon:'⏰', titulo:'Itens Parados', sub:`Equipamentos com técnicos há ${DIAS_PARADO}+ dias`, papeis:['admin','supervisor'] },
  { id:'rma',       icon:'♻️', titulo:'Estoque RMA', sub:'Equipamentos enviados para RMA, por filial e técnico', papeis:['admin','supervisor'] },
  { id:'estoquemin', icon:'🎯', titulo:'Estoque Mínimo', sub:'Filiais abaixo do estoque mínimo por tipo de equipamento', papeis:['admin','supervisor'] },
  { id:'auditoria', icon:'🔍', titulo:'Auditoria', sub:'Conferência de estoque por técnico ou depósito', papeis:['admin','supervisor'] },
  { id:'hist',      icon:'🕓', titulo:'Histórico', sub:'Todas as movimentações registradas', papeis:['admin','supervisor'] },
  { id:'tipos',     icon:'🏷️', titulo:'Tipos', sub:'Os 5 tipos de equipamento', papeis:['admin','supervisor'] },
  { id:'filiais',   icon:'🏢', titulo:'Filiais', sub:'Cadastro de filiais e depósitos', papeis:['admin'] },
  { id:'dados',     icon:'💾', titulo:'Dados', sub:'Importar, exportar e backup', papeis:['admin'] },
  { id:'usuarios',  icon:'🔐', titulo:'Usuários', sub:'Aprovar acessos e definir permissões', papeis:['admin'] },
  { id:'meusItens', icon:'📦', titulo:'Meus Equipamentos', sub:'Itens sob sua responsabilidade', papeis:['tecnico'] },
  { id:'meuHistorico', icon:'🕓', titulo:'Meu Histórico', sub:'Movimentações dos seus itens', papeis:['tecnico'] },
  { id:'retiradas', icon:'🔎', titulo:'Consultar Retirada', sub:'Busque pelo código da retirada em campo (ex.: RET-0001)', papeis:['admin','supervisor','tecnico'] },
];
let PAGE = 'dashboard';
function paginasDisponiveis(){ const papel = MEU_PERFIL?MEU_PERFIL.papel:null; return PAGES.filter(p=>p.papeis.includes(papel)); }

function renderNav(){
  $('#nav').innerHTML = paginasDisponiveis().map(p=>`
    <button class="nav-item ${p.id===PAGE?'active':''}" onclick="goto('${p.id}')">
      <span class="ic">${p.icon}</span> ${p.titulo}
    </button>`).join('');
}
function goto(id){
  const p = paginasDisponiveis().find(x=>x.id===id); if(!p) return;
  PAGE=id; $('#pageTitle').textContent=p.titulo; $('#pageSub').textContent=p.sub; renderNav(); render(); window.scrollTo(0,0); toggleSidebar(false);
}
function toggleSidebar(force){
  const open = typeof force==='boolean' ? force : !document.querySelector('.sidebar').classList.contains('open');
  document.querySelector('.sidebar').classList.toggle('open', open);
  $('#sidebarOverlay').classList.toggle('show', open);
}

const RENDERERS = { dashboard:renderDashboard, equip:renderEquip, mov:renderMovPage, tecnicos:renderTecnicos, parados:renderParados, rma:renderRMA, estoquemin:renderEstoqueMinimo, auditoria:renderAuditoria, hist:renderHist, tipos:renderTipos, filiais:renderFiliais, dados:renderDados, usuarios:renderUsuarios, meusItens:renderMeusItens, meuHistorico:renderMeuHistorico, retiradas:renderRetiradas };
function render(){
  const semDados = ['dados','tipos','filiais','usuarios','meusItens','meuHistorico','rma','retiradas','estoquemin'];
  if(DB.equipamentos.length===0 && !semDados.includes(PAGE)){ return renderVazio(); }
  RENDERERS[PAGE]();
}

function renderVazio(){
  $('#content').innerHTML = `
  <div class="panel"><div class="pb">
    <div class="empty">
      <div class="big">📥</div>
      <h2 style="margin-bottom:8px">Nenhum dado ainda</h2>
      <p class="muted" style="margin-bottom:20px;max-width:460px;margin-inline:auto">
        Comece importando seu inventário. Você pode <b>colar</b> os dados copiados da planilha
        ou <b>abrir o arquivo Excel/CSV</b> direto.</p>
      <button class="btn primary" onclick="goto('dados')">Importar dados agora →</button>
    </div>
  </div></div>`;
}

/* =========================================================
   VISÃO GERAL
   ========================================================= */
let dashFiliais = []; // array de depósitos selecionados; vazio = todas
function dashToggleFilial(d){
  const i = dashFiliais.indexOf(d);
  if(i>=0) dashFiliais.splice(i,1); else dashFiliais.push(d);
  renderDashboard();
}
function renderDashboard(){
  let todasFiliais = todasFiliaisConhecidas();
  if(souSupervisor()) todasFiliais = todasFiliais.filter(regiaoPermitida);
  const baseEq = souSupervisor() ? DB.equipamentos.filter(e=>regiaoPermitida(e.deposito)) : DB.equipamentos;
  const eq = dashFiliais.length ? baseEq.filter(e=>dashFiliais.includes(e.deposito)) : baseEq;
  const total = eq.length;
  const emEstoque = eq.filter(e=>e.status==='estoque').length;
  const comTec = eq.filter(e=>e.status==='com_tecnico').length;
  const baixados = eq.filter(e=>e.status==='baixado').length;
  const seriesEq = new Set(eq.map(e=>e.serie));
  const auditoriasFiltradas = dashFiliais.length ? DB.auditorias.filter(a=>a.alvoTipo==='deposito'&&dashFiliais.includes(a.alvoId)) : DB.auditorias;

  // por tipo
  const porTipo = {};
  eq.forEach(e=>{ porTipo[e.tipo]=(porTipo[e.tipo]||0)+1; });
  const tiposArr = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]);
  const maxTipo = Math.max(1,...tiposArr.map(t=>t[1]));

  // painel secundário: por depósito (visão geral) OU por técnico (quando uma ou mais filiais estão selecionadas)
  let painel2Titulo, painel2Arr, painel2Max, painel2Cor='#2563eb', painel2PorTecnico=false;
  if(dashFiliais.length){
    const porTec = {};
    eq.filter(e=>e.status==='com_tecnico').forEach(e=>{ const id=e.tecnicoId; porTec[id]=(porTec[id]||0)+1; });
    painel2Titulo = '👷 Itens com técnicos das filiais selecionadas <span class="muted" style="font-size:11px;font-weight:500">(clique num técnico para ver a ficha completa)</span>';
    painel2Arr = Object.entries(porTec).sort((a,b)=>b[1]-a[1]).slice(0,8);
    painel2Max = Math.max(1,...painel2Arr.map(d=>d[1]));
    painel2Cor='#d97706';
    painel2PorTecnico=true;
  } else {
    const porDep = {};
    eq.filter(e=>e.status!=='baixado').forEach(e=>{ const d=e.local||e.deposito||'—'; porDep[d]=(porDep[d]||0)+1; });
    painel2Titulo = '📍 Itens ativos por depósito/local';
    painel2Arr = Object.entries(porDep).sort((a,b)=>b[1]-a[1]).slice(0,8);
    painel2Max = Math.max(1,...painel2Arr.map(d=>d[1]));
  }

  const ultimas = DB.movimentacoes.filter(m=>seriesEq.has(m.serie)).slice(-8).reverse();

  // alertas
  const alertasMin = estoqueMinAlertas(eq);
  const parados = eq.filter(e=>e.status==='com_tecnico' && (diasEmPosse(e)||0)>=DIAS_PARADO);
  const tecsSemAud = DB.tecnicos.filter(t=>itensDoTecnico(t.id).some(e=>seriesEq.has(e.serie)) && !ultimaAuditoria('tecnico',t.id));

  const alertasMinGeral = alertasEstoqueMinPorFilial();
  $('#content').innerHTML = `
  ${alertasMinGeral.length?`
  <div class="panel" style="margin-bottom:18px;border-left:4px solid var(--red);cursor:pointer" onclick="goto('estoquemin')">
    <div class="pb" style="display:flex;align-items:center;gap:12px">
      <div style="font-size:22px">🎯</div>
      <div style="flex:1"><b>${alertasMinGeral.length} alerta${alertasMinGeral.length>1?'s':''} de estoque mínimo</b> em ${[...new Set(alertasMinGeral.map(a=>a.filial))].length} filial(is) ${souSupervisor()?'da sua área':''}</div>
      <span class="btn sm ghost">Ver detalhes →</span>
    </div>
  </div>`:''}
  <div class="panel" style="margin-bottom:18px"><div class="pb" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span style="font-weight:700;font-size:12.5px;color:var(--txt-soft);white-space:nowrap">🏢 FILIAL / DEPÓSITO ${dashFiliais.length?`<span class="muted" style="font-weight:500">(${dashFiliais.length} selecionada${dashFiliais.length>1?'s':''} · clique para adicionar/remover)</span>`:'<span class="muted" style="font-weight:500">(clique para filtrar, pode escolher várias)</span>'}</span>
    <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0;gap:8px">
      <button class="${!dashFiliais.length?'active':''}" style="background:${!dashFiliais.length?'var(--brand)':'var(--panel-soft)'};color:${!dashFiliais.length?'#fff':'var(--txt)'};border-radius:9px" onclick="dashFiliais=[];renderDashboard()">Todas <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${baseEq.length}</span></button>
      ${todasFiliais.map(d=>{ const n=baseEq.filter(e=>e.deposito===d).length; const on=dashFiliais.includes(d); return `
        <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:9px" onclick="dashToggleFilial('${esc(d)}')">${on?'✓ ':''}${esc(d)} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'#e2e8f0'};color:inherit;margin-left:4px">${n}</span></button>`;}).join('')}
    </div>
    <div class="spacer"></div>
    <button class="btn sm" onclick="relatorioFilial()">🖨️ Gerar relatório</button>
  </div></div>

  <div class="grid kpis" style="margin-bottom:20px">
    ${kpi('b','📦','Total de itens',total)}
    ${kpi('g','✅','Em estoque',emEstoque)}
    ${kpi('a','👷','Com técnicos',comTec)}
    ${kpi('r','♻️','RMA',baixados)}
    ${kpi('v','🔍','Auditorias',auditoriasFiltradas.length)}
  </div>

  ${(alertasMin.length||parados.length||tecsSemAud.length)?`
  <div class="panel" style="margin-bottom:20px;border-left:4px solid var(--amber)">
    <div class="ph"><h3>⚠️ Alertas</h3></div>
    <div class="pb" style="display:flex;flex-wrap:wrap;gap:10px">
      ${alertasMin.map(a=>`<div class="badge baixado" style="padding:8px 12px">Estoque baixo: <b style="margin-left:4px">${esc(tipoNome(a.tipo))}</b> — ${a.atual}/${a.min}</div>`).join('')}
      ${parados.length?`<button class="badge com_tecnico" style="padding:8px 12px;border:0;cursor:pointer" onclick="goto('equip')">${parados.length} ${parados.length===1?'item parado':'itens parados'} ${DIAS_PARADO}+ dias com técnico</button>`:''}
      ${tecsSemAud.length?`<button class="badge gray" style="padding:8px 12px;border:0;cursor:pointer" onclick="goto('auditoria')">${tecsSemAud.length} ${tecsSemAud.length===1?'técnico nunca auditado':'técnicos nunca auditados'}</button>`:''}
    </div>
  </div>`:''}

  <div class="chart-row" style="margin-bottom:20px">
    <div class="panel">
      <div class="ph"><h3>📦 Itens por tipo de equipamento</h3></div>
      <div class="pb">
        ${tiposArr.length?tiposArr.map(([t,n])=>`
          <div class="bar-row">
            <div class="bl"><span style="width:11px;height:11px;border-radius:3px;background:${tipoCor(t)};display:inline-block"></span>${esc(tipoNome(t))}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/maxTipo*100}%;background:${tipoCor(t)}">${n}</div></div>
          </div>`).join(''):'<div class="empty">Sem dados</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="ph"><h3>Distribuição (status)</h3></div>
      <div class="pb"><div class="donut-wrap">
        ${donut([['Em estoque',emEstoque,'#16a34a'],['Com técnico',comTec,'#d97706'],['RMA',baixados,'#dc2626']])}
      </div></div>
    </div>
  </div>

  <div class="chart-row">
    <div class="panel">
      <div class="ph"><h3>${painel2Titulo}</h3></div>
      <div class="pb">
        ${painel2Arr.length?painel2Arr.map(([d,n])=>`
          <div class="bar-row" ${painel2PorTecnico?`style="cursor:pointer" onclick="fichaTecnico('${esc(d)}')"`:''}>
            <div class="bl">${esc(painel2PorTecnico?tecNome(d):d)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/painel2Max*100}%;background:${painel2Cor}">${n}</div></div>
            ${painel2PorTecnico?'<span class="muted" style="font-size:12px">→</span>':''}
          </div>`).join(''):'<div class="empty">Sem dados</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="ph"><h3>🕓 Últimas movimentações</h3><div class="spacer"></div><button class="btn sm ghost" onclick="goto('hist')">Ver tudo →</button></div>
      <div class="pb" style="padding:8px 0">
        ${ultimas.length?ultimas.map(m=>`
          <div style="display:flex;align-items:center;gap:11px;padding:9px 20px;border-bottom:1px solid #f1f5f9">
            ${movBadge(m.tipo)}
            <div style="flex:1;min-width:0">
              <div class="mono" style="font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.serie)}</div>
              <div class="muted" style="font-size:11.5px">${esc(m.de||'—')} → ${esc(m.para||'—')}</div>
            </div>
            <div class="muted" style="font-size:11px;white-space:nowrap">${fmtTS(m.ts)}</div>
          </div>`).join(''):'<div class="empty" style="padding:30px">Nenhuma movimentação ainda.</div>'}
      </div>
    </div>
  </div>`;
}
function kpi(c,ic,lbl,val){ return `<div class="kpi ${c}"><div class="ic">${ic}</div><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`; }
function movBadge(t){ const m={entrada:'badge blue',saida:'badge com_tecnico',transferencia:'badge violet',baixa:'badge baixado',retorno_rma:'badge estoque',confirmacao:'badge estoque',exclusao:'badge baixado',cancelamento:'badge gray',registro_campo:'badge blue'}; return `<span class="${m[t]||'badge gray'}">${MOV_LABEL[t]||t}</span>`; }

function donut(data){
  const total = data.reduce((s,d)=>s+d[1],0)||1;
  let acc=0; const R=58, C=2*Math.PI*R;
  const segs = data.filter(d=>d[1]>0).map(d=>{ const frac=d[1]/total; const dash=frac*C; const seg=`<circle r="${R}" cx="70" cy="70" fill="none" stroke="${d[2]}" stroke-width="22" stroke-dasharray="${dash} ${C-dash}" stroke-dashoffset="${-acc*C}" transform="rotate(-90 70 70)"/>`; acc+=frac; return seg; }).join('');
  return `<svg width="140" height="140" viewBox="0 0 140 140">${segs}
    <text x="70" y="66" text-anchor="middle" font-size="26" font-weight="800" fill="#0f172a">${total}</text>
    <text x="70" y="84" text-anchor="middle" font-size="11" fill="#64748b">itens</text></svg>
  <div class="legend">${data.map(d=>`<div class="li"><span class="sw" style="background:${d[2]}"></span>${d[0]} <b style="margin-left:auto">${d[1]}</b></div>`).join('')}</div>`;
}

/* =========================================================
   EQUIPAMENTOS
   ========================================================= */
let eqFiltro = { q:'', tipo:'', status:'', dep:'', tec:'' };
function renderEquip(){
  const deps = [...new Set(DB.equipamentos.map(e=>e.deposito).filter(Boolean))].sort();
  const lista = filtrarEquip();
  $('#content').innerHTML = `
  <div class="toolbar">
    <div class="search"><span class="si">🔎</span><input id="fq" placeholder="Buscar por nº de série..." value="${esc(eqFiltro.q)}" oninput="eqFiltro.q=this.value;renderEquipTabela()"></div>
    <select class="filter" onchange="eqFiltro.tipo=this.value;renderEquipTabela()">
      <option value="">Todos os tipos</option>
      ${Object.keys(DB.tipos).map(t=>`<option value="${t}" ${eqFiltro.tipo===t?'selected':''}>${esc(tipoNome(t))}</option>`).join('')}
    </select>
    <select class="filter" onchange="eqFiltro.status=this.value;renderEquipTabela()">
      <option value="">Todos os status</option>
      ${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${eqFiltro.status===k?'selected':''}>${v}</option>`).join('')}
    </select>
    <select class="filter" onchange="eqFiltro.dep=this.value;renderEquipTabela()">
      <option value="">Todos os depósitos</option>
      ${deps.map(d=>`<option value="${d}" ${eqFiltro.dep===d?'selected':''}>${esc(d)}</option>`).join('')}
    </select>
    <button class="btn" onclick="exportarEquipCSV()">⬇️ Exportar CSV</button>
    <button class="btn primary" onclick="openEquip()">＋ Equipamento</button>
  </div>
  <div class="panel">
    <div class="ph"><h3>Inventário</h3><span class="count-badge" id="eqCount"></span><div class="spacer"></div></div>
    <div class="tbl-wrap" id="eqTabela"></div>
  </div>`;
  renderEquipTabela();
}
function filtrarEquip(){
  const f=eqFiltro, q=f.q.trim().toLowerCase();
  return DB.equipamentos.filter(e=>
    (!q || e.serie.toLowerCase().includes(q)) &&
    (!f.tipo || e.tipo===f.tipo) &&
    (!f.status || e.status===f.status) &&
    (!f.dep || e.deposito===f.dep) &&
    (!f.tec || e.tecnicoId===f.tec)
  );
}
function renderEquipTabela(){
  const lista = filtrarEquip();
  $('#eqCount') && ($('#eqCount').textContent = lista.length+' itens');
  const rows = lista.slice(0,500).map(e=>`
    <tr>
      <td class="mono"><a href="#" onclick="abrirKardex('${esc(e.serie)}');return false" title="Ver histórico (kardex)"><b>${esc(e.serie)}</b></a></td>
      <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span></td>
      <td><span class="badge ${e.status}">${STATUS[e.status]}</span> ${e.emTransito?`<span class="badge com_tecnico" style="font-size:10px">⏳ em trânsito p/ ${esc(tecNome(e.transitoPara))}</span>`:''}</td>
      <td>${e.status==='com_tecnico'?esc(tecNome(e.tecnicoId)):esc(e.local||e.deposito||'—')}</td>
      <td class="muted">${e.status==='com_tecnico'?'há '+fmtDias(diasEmPosse(e)):fmtData(e.dataEntrada)}</td>
      <td class="right">
        <button class="btn sm" ${e.emTransito?'disabled title="Aguardando confirmação do técnico"':''} onclick="openMov('${esc(e.serie)}')">Mover</button>
        <button class="btn sm ghost" onclick="openEquip('${esc(e.serie)}')">✏️</button>
      </td>
    </tr>`).join('');
  $('#eqTabela').innerHTML = lista.length? `<table>
    <thead><tr><th>Nº Série</th><th>Tipo</th><th>Status</th><th>Local / Técnico</th><th>Entrada / Posse</th><th class="right">Ações</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${lista.length>500?`<div class="muted center" style="padding:14px">Mostrando 500 de ${lista.length}. Use a busca/filtros para refinar.</div>`:''}`
    : `<div class="empty"><div class="big">🔍</div>Nenhum equipamento encontrado com esses filtros.</div>`;
}

/* =========================================================
   ITENS PARADOS (90+ dias com técnico)
   ========================================================= */
function renderParados(){
  const parados = DB.equipamentos.filter(e=>e.status==='com_tecnico' && (diasEmPosse(e)||0)>=DIAS_PARADO)
    .sort((a,b)=>(diasEmPosse(b)||0)-(diasEmPosse(a)||0));
  $('#content').innerHTML = `
  <div class="panel"><div class="ph"><h3>⏰ Itens parados com técnicos (${DIAS_PARADO}+ dias)</h3><span class="count-badge">${parados.length}</span></div>
  <div class="tbl-wrap">${
    parados.length? `<table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Técnico</th><th>Filial</th><th>Há quanto tempo</th><th class="right">Ações</th></tr></thead><tbody>
      ${parados.map(e=>{ const t=DB.tecnicos.find(x=>x.id===e.tecnicoId); return `<tr>
        <td class="mono"><a href="#" onclick="abrirKardex('${esc(e.serie)}');return false"><b>${esc(e.serie)}</b></a></td>
        <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span></td>
        <td>${esc(tecNome(e.tecnicoId))}</td>
        <td>${esc(e.deposito||'—')}</td>
        <td><b style="color:var(--red)">${fmtDias(diasEmPosse(e))}</b></td>
        <td class="right">
          <button class="btn sm" onclick="openMov('${esc(e.serie)}')">Mover</button>
          ${t?`<button class="btn sm ghost" onclick="fichaTecnico('${t.id}')">Ver técnico</button>`:''}
        </td>
      </tr>`;}).join('')}</tbody></table>`
    : `<div class="empty"><div class="big">✅</div>Nenhum item parado há ${DIAS_PARADO}+ dias. Tudo em dia!</div>`
  }</div></div>`;
}

/* =========================================================
   ESTOQUE MÍNIMO POR FILIAL
   ========================================================= */
function alertasEstoqueMinPorFilial(){
  const filiais = todasFiliaisConhecidas();
  const alertas = [];
  filiais.forEach(f=>{
    if(souSupervisor() && !regiaoPermitida(f)) return;
    Object.keys(DB.tipos).forEach(t=>{
      const min = DB.tipos[t].min||0;
      if(min>0){
        const atual = DB.equipamentos.filter(e=>e.deposito===f && e.tipo===t && e.status==='estoque').length;
        if(atual<min) alertas.push({filial:f, tipo:t, atual, min, deficit:min-atual});
      }
    });
  });
  return alertas.sort((a,b)=>b.deficit-a.deficit);
}
function verEstoqueTecnico(tecnicoId){
  const t = DB.tecnicos.find(x=>x.id===tecnicoId); if(!t) return;
  const itens = itensDoTecnico(tecnicoId);
  const porTipo={}; itens.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
  const tiposComMin = Object.keys(DB.tipos).filter(tp=>(DB.tipos[tp].min||0)>0);
  const outrosTipos = Object.keys(porTipo).filter(tp=>!tiposComMin.includes(tp));
  modal('👷 Estoque de '+esc(tecNome(tecnicoId)), `
    <div class="tbl-wrap"><table><thead><tr><th>Tipo</th><th class="center">Atual</th><th class="center">Mínimo</th><th class="center">Faltam</th></tr></thead><tbody>
      ${tiposComMin.length? tiposComMin.map(tp=>{ const atual=porTipo[tp]||0; const min=DB.tipos[tp].min||0; const falta=Math.max(0,min-atual); return `<tr ${falta>0?'style="background:var(--red-soft)"':''}>
        <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(tp)}">${esc(tipoNome(tp))}</span></td>
        <td class="center">${atual}</td>
        <td class="center muted">${min}</td>
        <td class="center">${falta>0?`<b style="color:var(--red)">${falta}</b>`:'<span style="color:var(--green)">✓</span>'}</td>
      </tr>`;}).join('') : '<tr><td class="empty" colspan="4">Nenhum tipo com mínimo configurado.</td></tr>'}
      ${outrosTipos.map(tp=>`<tr>
        <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(tp)}">${esc(tipoNome(tp))}</span></td>
        <td class="center">${porTipo[tp]}</td>
        <td class="center muted">—</td>
        <td class="center muted">—</td>
      </tr>`).join('')}
    </tbody></table></div>`,
    `<button class="btn" onclick="closeModal()">Fechar</button><button class="btn primary" onclick="closeModal();fichaTecnico('${tecnicoId}')">Ver ficha completa →</button>`, 'lg');
}
let estoqueMinFilial = '';
function renderEstoqueMinimo(){
  const todosAlertas = alertasEstoqueMinPorFilial();
  const filiaisAfetadas = [...new Set(todosAlertas.map(a=>a.filial))].sort();
  const alertas = estoqueMinFilial ? todosAlertas.filter(a=>a.filial===estoqueMinFilial) : todosAlertas;
  const temMinConfigurado = Object.values(DB.tipos).some(t=>(t.min||0)>0);
  $('#content').innerHTML = `
  ${!temMinConfigurado?`<div class="panel" style="margin-bottom:18px;border-left:4px solid var(--amber)"><div class="pb">Nenhum tipo tem estoque mínimo configurado ainda. ${souAdmin()?'Vá em <b>Dados</b> e clique em "🎯 Aplicar estoque mínimo oficial", ou defina manualmente em <b>Tipos</b>.':'Peça para um administrador configurar.'}</div></div>`:''}
  <div class="grid kpis" style="margin-bottom:20px">
    ${kpi('r','📦','Total de equipamentos faltando',alertas.reduce((s,a)=>s+a.deficit,0))}
    ${(()=>{ const porTipo={}; alertas.forEach(a=>{ porTipo[a.tipo]=(porTipo[a.tipo]||0)+a.deficit; }); const arr=Object.entries(porTipo).sort((a,b)=>b[1]-a[1]);
      const texto = arr.length? esc(tipoNome(arr[0][0]))+' <span style="font-size:16px;color:var(--txt-soft)">('+arr[0][1]+')</span>' : '—';
      return `<div class="kpi v"><div class="ic">🎯</div><div class="lbl">Tipo mais crítico</div><div class="val" style="font-size:22px">${texto}</div></div>`; })()}
    ${kpi('a','🏢','Filiais afetadas',filiaisAfetadas.length)}
  </div>
  ${filiaisAfetadas.length?`
  <div class="panel" style="margin-bottom:18px"><div class="pb" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="font-weight:700;font-size:12.5px;color:var(--txt-soft)">🏢 FILTRAR POR FILIAL</span>
    <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0;gap:8px">
      <button class="${!estoqueMinFilial?'active':''}" style="background:${!estoqueMinFilial?'var(--brand)':'var(--panel-soft)'};color:${!estoqueMinFilial?'#fff':'var(--txt)'};border-radius:9px" onclick="estoqueMinFilial='';renderEstoqueMinimo()">Todas <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${todosAlertas.length}</span></button>
      ${filiaisAfetadas.map(f=>{ const n=todosAlertas.filter(a=>a.filial===f).length; const on=estoqueMinFilial===f; return `
        <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:9px" onclick="estoqueMinFilial=(estoqueMinFilial==='${esc(f)}')?'':'${esc(f)}';renderEstoqueMinimo()">${esc(f)} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'#e2e8f0'};color:inherit;margin-left:4px">${n}</span></button>`;}).join('')}
    </div>
  </div></div>`:''}
  ${alertas.length?`
  <div class="chart-row" style="margin-bottom:20px">
    <div class="panel">
      <div class="ph"><h3>📊 Necessidade por tipo de equipamento</h3></div>
      <div class="pb">${(()=>{
        const porTipo={}; alertas.forEach(a=>{ porTipo[a.tipo]=(porTipo[a.tipo]||0)+a.deficit; });
        const arr=Object.entries(porTipo).sort((a,b)=>b[1]-a[1]);
        const max=Math.max(1,...arr.map(t=>t[1]));
        return arr.map(([t,n])=>`
          <div class="bar-row">
            <div class="bl"><span style="width:11px;height:11px;border-radius:3px;background:${tipoCor(t)};display:inline-block"></span>${esc(tipoNome(t))}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/max*100}%;background:${tipoCor(t)}">${n}</div></div>
          </div>`).join('');
      })()}</div>
    </div>
    <div class="panel">
      <div class="ph"><h3>Distribuição da necessidade</h3></div>
      <div class="pb"><div class="donut-wrap">${(()=>{
        const porTipo={}; alertas.forEach(a=>{ porTipo[a.tipo]=(porTipo[a.tipo]||0)+a.deficit; });
        const data=Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([t,n])=>[tipoNome(t),n,tipoCor(t)]);
        return donut(data);
      })()}</div></div>
    </div>
  </div>
  <div class="panel" style="margin-bottom:20px">
    <div class="ph"><h3>🏢 Necessidade por filial</h3><span class="muted" style="font-size:11px;font-weight:500;margin-left:6px">(clique para filtrar)</span></div>
    <div class="pb">${(()=>{
      const porFilial={}; todosAlertas.forEach(a=>{ porFilial[a.filial]=(porFilial[a.filial]||0)+a.deficit; });
      const arr=Object.entries(porFilial).sort((a,b)=>b[1]-a[1]);
      const max=Math.max(1,...arr.map(f=>f[1]));
      return arr.map(([f,n])=>{
        const intensidade = n/max; // 0 a 1 — mais crítico = vermelho mais forte/escuro
        const cor = `rgb(${220-Math.round(60*(1-intensidade))},${38+Math.round(90*(1-intensidade))},${38+Math.round(90*(1-intensidade))})`;
        const selecionada = estoqueMinFilial===f;
        return `
        <div class="bar-row" style="cursor:pointer${selecionada?';outline:2px solid var(--brand);border-radius:8px;padding:2px 4px' :''}" onclick="estoqueMinFilial=(estoqueMinFilial==='${esc(f)}')?'':'${esc(f)}';renderEstoqueMinimo()">
          <div class="bl">${esc(f)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${n/max*100}%;background:${cor}">${n}</div></div>
        </div>`;}).join('');
    })()}</div>
  </div>`:''}
  ${estoqueMinFilial?`
  <div class="panel" style="margin-bottom:18px"><div class="ph"><h3>👷 Estoque por técnico em ${esc(estoqueMinFilial)}</h3><span class="muted" style="font-size:11px;font-weight:500;margin-left:6px">(clique para ver a ficha completa)</span></div>
    <div class="pb">
      ${(()=>{ const tecs=DB.tecnicos.filter(t=>t.regiao===estoqueMinFilial); if(!tecs.length) return '<div class="empty">Nenhum técnico cadastrado nessa filial.</div>';
        return `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${tecs.map(t=>{
          const itens = itensDoTecnico(t.id);
          const porTipo={}; itens.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
          return `<div class="panel" style="box-shadow:none;cursor:pointer" onclick="verEstoqueTecnico('${t.id}')"><div class="pb">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><b>${esc(t.nome)}</b><span class="count-badge" style="margin-left:auto">${itens.length}</span></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">${Object.keys(porTipo).length?Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tp,n])=>`<span class="tag-tipo" style="border-left:3px solid ${tipoCor(tp)};font-size:11px">${esc(tipoNome(tp))}: ${n}</span>`).join(''):'<span class="muted" style="font-size:12px">Nenhum item</span>'}</div>
          </div></div>`;}).join('')}</div>`; })()}
    </div>
  </div>`:''}
  <div class="panel"><div class="ph"><h3>⚠️ Abaixo do estoque mínimo</h3><span class="count-badge">${alertas.length}</span></div>
    <div class="tbl-wrap">${
      alertas.length? `<table><thead><tr><th>Filial</th><th>Tipo</th><th class="center">Atual</th><th class="center">Mínimo</th><th class="center">Faltam</th></tr></thead><tbody>
        ${alertas.map(a=>`<tr>
          <td><b>${esc(a.filial)}</b></td>
          <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(a.tipo)}">${esc(tipoNome(a.tipo))}</span></td>
          <td class="center">${a.atual}</td>
          <td class="center muted">${a.min}</td>
          <td class="center"><b style="color:var(--red)">${a.deficit}</b></td>
        </tr>`).join('')}</tbody></table>`
      : `<div class="empty"><div class="big">✅</div>Nenhuma filial abaixo do mínimo. Tudo em dia!</div>`
    }</div></div>`;
}

/* =========================================================
   ESTOQUE RMA
   ========================================================= */
let rmaFiliais = [];
function rmaToggleFilial(d){ const i=rmaFiliais.indexOf(d); if(i>=0) rmaFiliais.splice(i,1); else rmaFiliais.push(d); renderRMA(); }
function renderRMA(){
  let todasFiliais = [...new Set(DB.equipamentos.filter(e=>e.status==='baixado').map(e=>e.rmaDeposito||e.deposito).filter(Boolean))].sort();
  if(souSupervisor()) todasFiliais = todasFiliais.filter(regiaoPermitida);
  const baseRma = DB.equipamentos.filter(e=>e.status==='baixado' && (!souSupervisor()||regiaoPermitida(e.rmaDeposito||e.deposito)));
  const rma = rmaFiliais.length ? baseRma.filter(e=>rmaFiliais.includes(e.rmaDeposito||e.deposito)) : baseRma;

  const porTipo={}; rma.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
  const donutTipo = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([t,n])=>[tipoNome(t),n,tipoCor(t)]);

  const porDep={}; baseRma.forEach(e=>{ const d=e.rmaDeposito||e.deposito||'—'; porDep[d]=(porDep[d]||0)+1; });
  const depArr = Object.entries(porDep).sort((a,b)=>b[1]-a[1]);
  const maxDep = Math.max(1,...depArr.map(d=>d[1]));

  const porTec={}; rma.forEach(e=>{ const id=e.rmaTecnicoId||'__sem__'; porTec[id]=(porTec[id]||0)+1; });
  const tecArr = Object.entries(porTec).sort((a,b)=>b[1]-a[1]);
  const maxTec = Math.max(1,...tecArr.map(d=>d[1]));

  const recentes = [...rma].sort((a,b)=>(b.rmaDesde||0)-(a.rmaDesde||0)).slice(0,8);

  $('#content').innerHTML = `
  <div class="panel" style="margin-bottom:18px"><div class="pb" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span style="font-weight:700;font-size:12.5px;color:var(--txt-soft);white-space:nowrap">🏢 FILIAL ${rmaFiliais.length?`<span class="muted" style="font-weight:500">(${rmaFiliais.length} selecionada${rmaFiliais.length>1?'s':''})</span>`:'<span class="muted" style="font-weight:500">(clique para filtrar)</span>'}</span>
    <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0;gap:8px">
      <button class="${!rmaFiliais.length?'active':''}" style="background:${!rmaFiliais.length?'var(--brand)':'var(--panel-soft)'};color:${!rmaFiliais.length?'#fff':'var(--txt)'};border-radius:9px" onclick="rmaFiliais=[];renderRMA()">Todas <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${baseRma.length}</span></button>
      ${todasFiliais.map(d=>{ const n=baseRma.filter(e=>(e.rmaDeposito||e.deposito)===d).length; const on=rmaFiliais.includes(d); return `
        <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:9px" onclick="rmaToggleFilial('${esc(d)}')">${on?'✓ ':''}${esc(d)} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'#e2e8f0'};color:inherit;margin-left:4px">${n}</span></button>`;}).join('')}
    </div>
  </div></div>

  <div class="grid kpis" style="margin-bottom:20px">
    ${kpi('r','♻️','Total em RMA',rma.length)}
    ${kpi('v','👷','Técnicos envolvidos',new Set(rma.filter(e=>e.rmaTecnicoId).map(e=>e.rmaTecnicoId)).size)}
    ${kpi('a','🏢','Filiais com RMA',todasFiliais.length)}
  </div>

  <div class="chart-row" style="margin-bottom:20px">
    <div class="panel">
      <div class="ph"><h3>📦 RMA por tipo de equipamento</h3></div>
      <div class="pb"><div class="donut-wrap">${donutTipo.length?donut(donutTipo):'<div class="empty">Sem dados</div>'}</div></div>
    </div>
    <div class="panel">
      <div class="ph"><h3>📍 RMA por filial</h3></div>
      <div class="pb">
        ${depArr.length?depArr.map(([d,n])=>`
          <div class="bar-row" style="cursor:pointer" onclick="rmaFiliais=['${esc(d)}'];renderRMA()">
            <div class="bl">${esc(d)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/maxDep*100}%;background:#2563eb">${n}</div></div>
          </div>`).join(''):'<div class="empty">Sem dados</div>'}
      </div>
    </div>
  </div>

  <div class="chart-row">
    <div class="panel">
      <div class="ph"><h3>👷 RMA por técnico <span class="muted" style="font-size:11px;font-weight:500">(clique para ver os itens)</span></h3></div>
      <div class="pb">
        ${tecArr.length?tecArr.map(([id,n])=>`
          <div class="bar-row" style="cursor:pointer" onclick="rmaFichaTecnico('${id==='__sem__'?'':id}')">
            <div class="bl">${id==='__sem__'?'Sem técnico (direto do estoque)':esc(tecNome(id))}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/maxTec*100}%;background:#d97706">${n}</div></div>
          </div>`).join(''):'<div class="empty">Sem dados</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="ph"><h3>🕓 Envios recentes para RMA</h3><div class="spacer"></div><button class="btn sm ghost" onclick="verTodosRMA()">Ver tudo →</button></div>
      <div class="pb" style="padding:8px 0">
        ${recentes.length?recentes.map(e=>`
          <div style="display:flex;align-items:center;gap:11px;padding:9px 20px;border-bottom:1px solid #f1f5f9">
            <span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span>
            <div style="flex:1;min-width:0">
              <div class="mono" style="font-weight:600;font-size:12px">${esc(e.serie)}</div>
              <div class="muted" style="font-size:11.5px">${e.rmaTecnicoId?esc(tecNome(e.rmaTecnicoId)):'—'} · ${esc(e.rmaDeposito||e.deposito||'—')}</div>
            </div>
            ${souAdmin()?`<button class="btn sm ghost" onclick="retornarDoRMA('${esc(e.serie)}')">↩️ Retornar</button>`:''}
          </div>`).join(''):'<div class="empty" style="padding:30px">Nenhum item em RMA.</div>'}
      </div>
    </div>
  </div>`;
}
function verTodosRMA(){
  const rma = DB.equipamentos.filter(e=>e.status==='baixado' && (!souSupervisor()||regiaoPermitida(e.rmaDeposito||e.deposito)) && (!rmaFiliais.length||rmaFiliais.includes(e.rmaDeposito||e.deposito)))
    .sort((a,b)=>(b.rmaDesde||0)-(a.rmaDesde||0));
  modal('♻️ Todos os itens em RMA', `
    <div class="tbl-wrap" style="max-height:480px">${
      rma.length? `<table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Técnico</th><th>Filial</th><th>Data</th>${souAdmin()?'<th></th>':''}</tr></thead><tbody>
        ${rma.map(e=>`<tr>
          <td class="mono"><a href="#" onclick="abrirKardex('${esc(e.serie)}');return false"><b>${esc(e.serie)}</b></a></td>
          <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span></td>
          <td>${e.rmaTecnicoId?esc(tecNome(e.rmaTecnicoId)):'—'}</td>
          <td>${esc(e.rmaDeposito||e.deposito||'—')}</td>
          <td class="muted">${e.rmaDesde?fmtTS(e.rmaDesde):'—'}</td>
          ${souAdmin()?`<td class="right"><button class="btn sm ghost" onclick="retornarDoRMA('${esc(e.serie)}');closeModal();verTodosRMA()">↩️ Retornar</button></td>`:''}
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nenhum item em RMA.</div>'
    }</div>`, `<button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
}
function rmaFichaTecnico(tecnicoId){
  const itens = DB.equipamentos.filter(e=>e.status==='baixado' && (e.rmaTecnicoId||null)===(tecnicoId||null) && (!souSupervisor()||regiaoPermitida(e.rmaDeposito||e.deposito)));
  const titulo = tecnicoId? '♻️ RMA enviado por '+esc(tecNome(tecnicoId)) : '📍 RMA enviado direto do estoque (sem técnico)';

  const porTipo={}; itens.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
  const donutData = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tp,n])=>[tipoNome(tp),n,tipoCor(tp)]);
  const porDep={}; itens.forEach(e=>{ const d=e.rmaDeposito||e.deposito||'—'; porDep[d]=(porDep[d]||0)+1; });
  const depsEnvolvidos = Object.keys(porDep).length;
  const ultimoEnvio = itens.length? Math.max(...itens.map(e=>e.rmaDesde||0)) : null;

  modal(titulo, `
    <div class="chart-row" style="margin-bottom:18px">
      <div class="panel" style="box-shadow:none">
        <div class="ph"><h3>📊 RMA por tipo de equipamento</h3></div>
        <div class="pb"><div class="donut-wrap">${donutData.length?donut(donutData):'<div class="empty">Nenhum item.</div>'}</div></div>
      </div>
      <div class="panel" style="box-shadow:none">
        <div class="ph"><h3>Resumo</h3></div>
        <div class="pb" style="display:flex;flex-direction:column;gap:14px">
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
            <div class="kpi r" style="padding:14px 16px"><div class="lbl" style="font-size:10px">♻️ TOTAL EM RMA</div><div class="val" style="font-size:22px">${itens.length}</div></div>
            <div class="kpi a" style="padding:14px 16px"><div class="lbl" style="font-size:10px">🏢 FILIAIS</div><div class="val" style="font-size:22px">${depsEnvolvidos}</div></div>
          </div>
          ${ultimoEnvio?`<div class="muted" style="font-size:12px">Último envio: ${fmtTS(ultimoEnvio)}</div>`:''}
          ${Object.keys(porTipo).length?`<div style="display:flex;gap:8px;flex-wrap:wrap">${Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tp,n])=>`<span class="tag-tipo" style="border-left:3px solid ${tipoCor(tp)}">${esc(tipoNome(tp))}: ${n}</span>`).join('')}</div>`:''}
        </div>
      </div>
    </div>
    ${souAdmin()&&itens.length?`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <label class="checkbox" style="font-size:12.5px"><input type="checkbox" onchange="document.querySelectorAll('.rmaChk').forEach(c=>c.checked=this.checked)"> Selecionar todos</label>
      <div class="spacer"></div>
      <button class="btn sm green" onclick="retornarSelecionadosRMA('${tecnicoId||''}')">↩️ Retornar selecionados</button>
    </div>`:''}
    <div class="tbl-wrap" style="max-height:320px">${
      itens.length? `<table><thead><tr>${souAdmin()?'<th style="width:30px"></th>':''}<th>Nº Série</th><th>Tipo</th><th>Filial</th><th>Data</th>${souAdmin()?'<th></th>':''}</tr></thead><tbody>
        ${itens.map(e=>`<tr>
          ${souAdmin()?`<td><input type="checkbox" class="rmaChk" value="${esc(e.serie)}"></td>`:''}
          <td class="mono"><a href="#" onclick="abrirKardex('${esc(e.serie)}');return false"><b>${esc(e.serie)}</b></a></td>
          <td><span class="tag-tipo">${esc(tipoNome(e.tipo))}</span></td>
          <td>${esc(e.rmaDeposito||e.deposito||'—')}</td>
          <td class="muted">${e.rmaDesde?fmtTS(e.rmaDesde):'—'}</td>
          ${souAdmin()?`<td class="right"><button class="btn sm ghost" onclick="retornarDoRMA('${esc(e.serie)}');closeModal();rmaFichaTecnico('${tecnicoId||''}')">↩️ Retornar</button></td>`:''}
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nenhum item.</div>'
    }</div>`, `<button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
}
function retornarSelecionadosRMA(tecnicoId){
  if(!souAdmin()) return flash('Somente administradores podem retornar itens do RMA','red');
  const series = Array.from(document.querySelectorAll('.rmaChk:checked')).map(c=>c.value);
  if(!series.length) return flash('Selecione ao menos um equipamento','red');
  if(!confirm('Retornar '+series.length+' equipamento(s) do RMA para o estoque de origem?')) return;
  let n=0;
  series.forEach(serie=>{
    const e=DB.equipamentos.find(x=>x.serie===serie); if(!e||e.status!=='baixado') return;
    const destino = e.rmaDeposito||e.deposito||'estoque';
    e.status='estoque'; e.tecnicoId=null; e.deposito=e.rmaDeposito||e.deposito; e.local=e.deposito; e.confirmado=true; e.desde=Date.now();
    registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'retorno_rma', serie, de:'RMA', para:destino, tecnicoId:null, usuario:nomeUsuarioAtual(), obs:'Retorno do RMA ao estoque (admin, em lote)' });
    n++;
  });
  salvar(); closeModal(); render(); flash(`✅ ${n} equipamento(s) retornado(s) ao estoque`,'green');
}
function retornarDoRMA(serie){
  if(!souAdmin()) return flash('Somente administradores podem retornar itens do RMA','red');
  const e=DB.equipamentos.find(x=>x.serie===serie); if(!e||e.status!=='baixado') return;
  const destino = e.rmaDeposito||e.deposito||'estoque';
  if(!confirm('Retornar o equipamento '+serie+' do RMA para o estoque de '+destino+'?')) return;
  e.status='estoque'; e.tecnicoId=null; e.deposito=e.rmaDeposito||e.deposito; e.local=e.deposito; e.confirmado=true; e.desde=Date.now();
  registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'retorno_rma', serie, de:'RMA', para:destino, tecnicoId:null, usuario:nomeUsuarioAtual(), obs:'Retorno do RMA ao estoque (admin)' });
  salvar(); render(); flash('✅ Equipamento retornado ao estoque','green');
}

/* =========================================================
   MOVIMENTAR
   ========================================================= */
function pendentesConfirmacaoLista(){
  return DB.equipamentos.filter(e=>e.emTransito && (!souSupervisor()||regiaoPermitida(e.deposito)||regiaoPermitida(e.rmaDeposito)));
}
function renderMovPage(){
  if(souTecnico()) return renderMovPageTecnico();
  const pendentes = pendentesConfirmacaoLista();
  $('#content').innerHTML = `
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:18px">
    ${movCard('entrada','📥','Entrada no estoque','Equipamento novo ou que retornou','green')}
    ${movCard('saida','👷','Saída para técnico','Entregar item a um técnico','b')}
    ${movCard('transferencia','🔁','Transferência','Passar item entre técnicos','v')}
    ${movCard('baixa','♻️','Enviar para RMA','Defeito, garantia ou devolução ao fabricante','r')}
  </div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:8px">
    <button class="panel" style="text-align:left;padding:0;border:0;${pendentes.length?'border-left:3px solid var(--amber)':''}" onclick="abrirPendentesConfirmacao()">
      <div class="pb" style="display:flex;gap:14px;align-items:flex-start">
        <div style="font-size:24px;width:50px;height:50px;border-radius:13px;background:#d9770619;display:grid;place-items:center;flex-shrink:0">⏳</div>
        <div style="flex:1"><div style="font-weight:700;font-size:15px;margin-bottom:3px">Aguardando confirmação do técnico ${pendentes.length?`<span class="count-badge" style="margin-left:4px">${pendentes.length}</span>`:''}</div><div class="muted" style="font-size:12.5px">Itens enviados que ainda não foram confirmados</div></div>
      </div></button>
  </div>
  <div class="panel" style="margin-top:18px"><div class="ph"><h3>🕓 Movimentações recentes</h3><div class="spacer"></div><button class="btn sm ghost" onclick="goto('hist')">Ver histórico →</button></div>
    <div class="tbl-wrap">${tabelaMov([...DB.movimentacoes].slice(-12).reverse())}</div>
  </div>`;
}
function renderMovPageTecnico(){
  const t = meuTecnico();
  if(!t) return $('#content').innerHTML = semVinculoHtml();
  const meus = itensDoTecnico(t.id).length;
  const enviadosPorMim = DB.equipamentos.filter(e=>e.emTransito && e.transitoDeTecnicoId===t.id);
  $('#content').innerHTML = `
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:18px">
    ${actionCard('📝','Registrar retirada em campo','Equipamento de manutenção ou desinstalação','b','abrirRegistrarForm()')}
    ${movCard('transferencia','🔁','Transferir para outro técnico','Passar um item seu para outro técnico','v')}
    ${movCard('baixa','♻️','Enviar para RMA','Defeito, garantia ou devolução ao fabricante','r')}
  </div>
  ${enviadosPorMim.length?`
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:18px">
    <button class="panel" style="text-align:left;padding:0;border:0;border-left:3px solid var(--amber)" onclick="verMinhasTransferenciasPendentes()">
      <div class="pb" style="display:flex;gap:14px;align-items:flex-start">
        <div style="font-size:24px;width:50px;height:50px;border-radius:13px;background:#d9770619;display:grid;place-items:center;flex-shrink:0">⏳</div>
        <div style="flex:1"><div style="font-weight:700;font-size:15px;margin-bottom:3px">Transferências enviadas <span class="count-badge" style="margin-left:4px">${enviadosPorMim.length}</span></div><div class="muted" style="font-size:12.5px">Aguardando o outro técnico confirmar</div></div>
      </div></button>
  </div>`:''}
  <div class="panel"><div class="ph"><h3>📦 Meus equipamentos disponíveis</h3><span class="count-badge">${meus}</span></div>
    <div class="pb"><p class="muted">Use os botões acima para transferir ou enviar para RMA. Veja a lista completa em <b>Meus Equipamentos</b>.</p></div>
  </div>`;
}
function verMinhasTransferenciasPendentes(){
  const t = meuTecnico(); if(!t) return;
  const itens = DB.equipamentos.filter(e=>e.emTransito && e.transitoDeTecnicoId===t.id);
  const porDestino = {};
  itens.forEach(e=>{ (porDestino[e.transitoPara]=porDestino[e.transitoPara]||[]).push(e); });
  modal('⏳ Transferências aguardando confirmação', `
    <div style="display:flex;flex-direction:column;gap:14px;max-height:460px;overflow:auto">${
      Object.keys(porDestino).length? Object.entries(porDestino).map(([destId,lista])=>`
        <div class="panel" style="box-shadow:none">
          <div class="ph"><h3 style="font-size:14px">👷 ${esc(tecNome(destId))}</h3><span class="count-badge" style="margin-left:8px">${lista.length}</span><div class="spacer"></div>
            <button class="btn sm red ghost" onclick="cancelarLoteTransferencia('${destId}')">✕ Cancelar tudo deste lote</button>
          </div>
          <div class="pb" style="display:flex;flex-direction:column;gap:8px">
            ${lista.map(e=>`
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 10px;background:var(--panel-soft);border-radius:9px">
                <div style="flex:1;min-width:160px"><span class="mono"><b>${esc(e.serie)}</b></span> <span class="tag-tipo" style="margin-left:6px">${esc(tipoNome(e.tipo))}</span></div>
                <div class="muted" style="font-size:11px">${fmtTS(e.transitoDesde)}</div>
                <button class="btn sm ghost" onclick="cancelarEnvio('${esc(e.serie)}')">✕</button>
              </div>`).join('')}
          </div>
        </div>`).join('') : '<div class="empty"><div class="big">✅</div>Nada pendente no momento.</div>'
    }</div>`, `<button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
}
function cancelarLoteTransferencia(destinoId){
  const t = meuTecnico(); if(!t) return;
  const itens = DB.equipamentos.filter(e=>e.emTransito && e.transitoDeTecnicoId===t.id && e.transitoPara===destinoId);
  if(!itens.length) return;
  if(!confirm('Cancelar o envio de '+itens.length+' equipamento(s) para '+tecNome(destinoId)+'?')) return;
  itens.forEach(e=>{
    e.emTransito=false; e.transitoPara=null; e.transitoDesde=null; e.transitoDe=null; e.transitoUsuario=null; e.transitoDeTecnicoId=null;
    registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'cancelamento', serie:e.serie, de:'Em trânsito', para:tecNome(destinoId)+' (cancelado em lote)', tecnicoId:null, usuario:nomeUsuarioAtual(), obs:'Envio cancelado em lote antes da confirmação' });
  });
  salvar(); closeModal(); render(); flash(`✅ ${itens.length} envio(s) cancelado(s)`,'green');
}
function abrirPendentesConfirmacao(){
  const pendentes = pendentesConfirmacaoLista();
  modal('⏳ Aguardando confirmação do técnico', `
    <div class="tbl-wrap" style="max-height:420px">${
      pendentes.length? pendentes.map(e=>`
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid #f1f5f9">
          <div style="flex:1;min-width:180px">
            <span class="mono"><b>${esc(e.serie)}</b></span> <span class="tag-tipo" style="margin-left:6px">${esc(tipoNome(e.tipo))}</span>
            <div class="muted" style="font-size:11.5px;margin-top:2px">${esc(e.transitoDe||'—')} → ${esc(tecNome(e.transitoPara))} · enviado por ${esc(e.transitoUsuario||'—')} · ${fmtTS(e.transitoDesde)}</div>
          </div>
          ${souAdmin()||souSupervisor()?`<button class="btn sm red ghost" onclick="cancelarEnvio('${esc(e.serie)}')">✕ Cancelar envio</button>`:''}
        </div>`).join('') : '<div class="empty"><div class="big">✅</div>Nada pendente no momento.</div>'
    }</div>`, `<button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
}
function cancelarEnvio(serie){
  const e = DB.equipamentos.find(x=>x.serie===serie); if(!e || !e.emTransito) return;
  const meuId = souTecnico() && meuTecnico() ? meuTecnico().id : null;
  const souOrigem = meuId && e.transitoDeTecnicoId===meuId;
  if(!souAdmin() && !souSupervisor() && !souOrigem) return flash('Você não pode cancelar esse envio','red');
  if(!confirm('Cancelar o envio do equipamento '+serie+' para '+tecNome(e.transitoPara)+'? Ele volta a ficar disponível de onde saiu.')) return;
  const destino = tecNome(e.transitoPara);
  e.emTransito=false; e.transitoPara=null; e.transitoDesde=null; e.transitoDe=null; e.transitoUsuario=null; e.transitoDeTecnicoId=null;
  registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'cancelamento', serie, de:'Em trânsito', para:destino+' (cancelado)', tecnicoId:null, usuario:nomeUsuarioAtual(), obs:'Envio cancelado antes da confirmação' });
  salvar(); render(); if($('#modal')&&document.getElementById('modalBg').classList.contains('show')){ closeModal(); } flash('Envio cancelado','green');
}
function movCard(tipo,ic,titulo,desc,cor){
  return actionCard(ic,titulo,desc,cor,`openMov(null,'${tipo}')`);
}
function actionCard(ic,titulo,desc,cor,onclickJs){
  const cores={green:'var(--green)',b:'var(--brand)',v:'var(--violet)',r:'var(--red)'};
  return `<button class="panel" style="text-align:left;padding:0;border:0" onclick="${onclickJs}">
    <div class="pb" style="display:flex;gap:14px;align-items:flex-start">
      <div style="font-size:24px;width:50px;height:50px;border-radius:13px;background:${cores[cor]}1a;display:grid;place-items:center;flex-shrink:0">${ic}</div>
      <div><div style="font-weight:700;font-size:15px;margin-bottom:3px">${titulo}</div><div class="muted" style="font-size:12.5px">${desc}</div></div>
    </div></button>`;
}

/* =========================================================
   TÉCNICOS
   ========================================================= */
const TECNICOS_PADRAO = [
  {nome:'Thiago Silveira Alvez', regiao:'IAI', matricula:'EPV'},
  {nome:'David Cleiton Silva da Costa', regiao:'SOO', matricula:'EPV'},
  {nome:'Izaque Alves De Jesus', regiao:'CCO', matricula:'EPV'},
  {nome:'Marcos Heleno Barbosa dos Santos', regiao:'CTA', matricula:'EPV'},
  {nome:'Alexandre Henrique Braz Pereira Santos', regiao:'RBP', matricula:'EPV'},
  {nome:'Ygor Da Costa Ferreira', regiao:'SOO', matricula:'EPV'},
  {nome:'Guilherme Nunes Pereira', regiao:'JLE', matricula:'EPV'},
  {nome:'Lucas Borges Navarro', regiao:'SRR', matricula:'EPV'},
  {nome:'Luis Fernando B. Carvalho', regiao:'PAE', matricula:'EPV'},
  {nome:'Robson da Rosa', regiao:'SOO', matricula:'EPV'},
  {nome:'Gilson Cristovão', regiao:'SOO', matricula:'EPV'},
  {nome:'Marlon De Paula', regiao:'PAE', matricula:'EPV'},
  {nome:'Hevertton William Lechernakoski', regiao:'CTA', matricula:'EPV'},
  {nome:'Mauricio Da Silva Fraga', regiao:'SOO', matricula:'EPV'},
  {nome:'Abinadabe Nascimento Piaui', regiao:'GNA', matricula:'EPV'},
  {nome:'Davi Augusto Pagno Dos Santos', regiao:'IAI', matricula:'EPV'},
  {nome:'Bruno Das Neves Feliciano', regiao:'PAE', matricula:'EPV'},
  {nome:'Vitor Jorge de Araujo Pinto', regiao:'CAS', matricula:'EPV'},
  {nome:'Fabiano Pereira De Carvalho', regiao:'BNU', matricula:'EPV'},
  {nome:'Victor Ferraro', regiao:'PAE', matricula:'EPV'},
  {nome:'Diego Platt', regiao:'SOO', matricula:'EPV'},
  {nome:'Mauro Roberto Nascimento Valente', regiao:'SOO', matricula:'EPV'},
  {nome:'Rogerio Alves Junior', regiao:'BQE', matricula:'EPV'},
  {nome:'Douglas Leandro Vital dos Santos', regiao:'JLE', matricula:'EPV'},
  {nome:'Renata Da Silva Souza', regiao:'IAI', matricula:'EPV'},
  {nome:'Roque Gali Vieira', regiao:'CAS', matricula:'EPV'},
  {nome:'Carlos Eduardo Alves De Oliveira', regiao:'CTA', matricula:'EPV'},
  {nome:'Maikon Barbosa Leite', regiao:'JGS', matricula:'EPV'},
  {nome:'Weberth Mesquita Xavier', regiao:'GNA', matricula:'EPV'},
  {nome:'Thayrone Said Silva', regiao:'CAS', matricula:'EPV'},
  {nome:'Ralpho Secco Comisso', regiao:'CAS', matricula:'EPV'},
  {nome:'Leonardo Carlos Batista', regiao:'IAI', matricula:'EPV'},
  {nome:'Willian Ribeiro Medeiros', regiao:'IAI', matricula:'EPV'},
  {nome:'Andre Luiz De Sa', regiao:'IAI', matricula:'EPV'},
  {nome:'Pedro Afonso Vidal de Carvalho', regiao:'IAI', matricula:'EPV'},
  {nome:'Claudio Santos', regiao:'PMJ', matricula:'EPV'},
  {nome:'Gleydson de Jesus Pinto', regiao:'BSB', matricula:'PJ · INST COML'},
  {nome:'Thiago Silva de Matias', regiao:'LGS', matricula:'PJ'},
  {nome:'Talyson Emmanuel de Jesus', regiao:'BSB', matricula:'PJ · INST COML'},
  {nome:'Álvaro Pontes Armando', regiao:'BSB', matricula:'PJ'},
  {nome:'Edson Marcos Marin', regiao:'SRR', matricula:'PJ'},
  {nome:'Leonardo Zuliani Marques Rodrigues', regiao:'RBP', matricula:'PJ'},
  {nome:'Matheus Ferreira Bento', regiao:'RBP', matricula:'PJ'},
  {nome:'Pedro Augusto Furtado', regiao:'GNA', matricula:'PJ'},
  {nome:'Robson da Silva Monteiro', regiao:'CAS', matricula:'PJ'},
  {nome:'Waldemar Leite da Silva Junior', regiao:'SRR', matricula:'PJ'}
];
function importarTecnicosPadrao(){
  if(!confirm('Importar a lista oficial de '+TECNICOS_PADRAO.length+' técnicos? Quem já estiver cadastrado (mesmo nome) não será duplicado.')) return;
  const existentes = new Set(DB.tecnicos.map(t=>t.nome.trim().toLowerCase()));
  let novos=0;
  TECNICOS_PADRAO.forEach(t=>{
    const chave=t.nome.trim().toLowerCase();
    if(!existentes.has(chave)){ DB.tecnicos.push({id:uid(), nome:t.nome, regiao:t.regiao, matricula:t.matricula}); existentes.add(chave); novos++; }
  });
  salvar(); render(); flash(`✅ ${novos} técnico(s) importado(s)${TECNICOS_PADRAO.length-novos>0?', '+(TECNICOS_PADRAO.length-novos)+' já existiam':''}`,'green');
}
function renderTecnicos(){
  const tecnicosLista = souSupervisor() ? DB.tecnicos.filter(t=>regiaoPermitida(t.regiao)) : DB.tecnicos;
  $('#content').innerHTML = `
  <div class="toolbar">
    <div style="flex:1"></div>
    ${souAdmin()?`<button class="btn" onclick="importarTecnicosPadrao()">📋 Importar lista oficial</button>`:''}
    <button class="btn primary" onclick="openTec()">＋ Novo técnico</button>
  </div>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
    ${tecnicosLista.length? tecnicosLista.map(t=>{
      const itens = DB.equipamentos.filter(e=>e.tecnicoId===t.id && e.status==='com_tecnico');
      const aud = ultimaAuditoria('tecnico',t.id);
      return `<div class="panel" style="cursor:pointer" onclick="fichaTecnico('${t.id}')"><div class="pb">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <div style="width:44px;height:44px;border-radius:50%;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;font-weight:800;font-size:17px">${esc((t.nome||'?')[0].toUpperCase())}</div>
          <div style="flex:1"><div style="font-weight:700;font-size:15px">${esc(t.nome)}</div><div class="muted" style="font-size:12px">${esc(t.regiao||'Sem região')} ${t.matricula?'· '+esc(t.matricula):''}</div></div>
          <button class="btn sm ghost" onclick="event.stopPropagation();openTec('${t.id}')">✏️</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--panel-soft);border-radius:10px">
          <span class="badge ${itens.length?'com_tecnico':'gray'}">${itens.length} em posse</span>
          <span class="badge ${aud?'estoque':'gray'}" style="font-size:10.5px">${aud?'auditado '+new Date(aud.ts).toLocaleDateString('pt-BR'):'nunca auditado'}</span>
          <span class="btn sm ghost" style="margin-left:auto">ver ficha →</span>
        </div>
      </div></div>`;
    }).join('') : `<div class="panel" style="grid-column:1/-1"><div class="empty"><div class="big">👷</div>Nenhum técnico cadastrado.<br><button class="btn primary" style="margin-top:14px" onclick="openTec()">＋ Cadastrar primeiro técnico</button></div></div>`}
  </div>`;
}
function verTecItens(id){
  const itens = DB.equipamentos.filter(e=>e.tecnicoId===id && e.status==='com_tecnico');
  modal(`Itens com ${esc(tecNome(id))}`, `<div class="tbl-wrap" style="max-height:420px">${tabelaEquipSimples(itens)}</div>`, '', 'lg');
}

/* =========================================================
   HISTÓRICO
   ========================================================= */
let histFiltro={ tipo:'', q:'' };
function renderHist(){
  $('#content').innerHTML = `
  <div class="toolbar">
    <div class="search"><span class="si">🔎</span><input placeholder="Buscar por nº de série..." value="${esc(histFiltro.q)}" oninput="histFiltro.q=this.value;renderHistTabela()"></div>
    <select class="filter" onchange="histFiltro.tipo=this.value;renderHistTabela()">
      <option value="">Todos os tipos de mov.</option>
      ${Object.entries(MOV_LABEL).map(([k,v])=>`<option value="${k}" ${histFiltro.tipo===k?'selected':''}>${v}</option>`).join('')}
    </select>
    <button class="btn" onclick="exportarHistCSV()">⬇️ Exportar CSV</button>
  </div>
  <div class="panel"><div class="ph"><h3>Histórico de movimentações</h3><span class="count-badge" id="histCount"></span></div>
    <div class="tbl-wrap" id="histTabela"></div></div>`;
  renderHistTabela();
}
function renderHistTabela(){
  const q=histFiltro.q.trim().toLowerCase();
  const lista = DB.movimentacoes.filter(m=>(!histFiltro.tipo||m.tipo===histFiltro.tipo)&&(!q||m.serie.toLowerCase().includes(q))).reverse();
  $('#histCount') && ($('#histCount').textContent = lista.length+' registros');
  $('#histTabela').innerHTML = lista.length? tabelaMov(lista.slice(0,800)) : `<div class="empty"><div class="big">🕓</div>Nenhuma movimentação registrada.</div>`;
}
function tabelaMov(lista){
  if(!lista.length) return `<div class="empty">Nada por aqui ainda.</div>`;
  return `<table><thead><tr><th>Data/Hora</th><th>Tipo</th><th>Nº Série</th><th>De</th><th>Para</th><th>Usuário</th><th>Obs</th></tr></thead><tbody>
    ${lista.map(m=>`<tr>
      <td class="muted" style="white-space:nowrap">${fmtTS(m.ts)}</td>
      <td>${movBadge(m.tipo)}</td>
      <td class="mono"><b>${esc(m.serie)}</b></td>
      <td>${esc(m.de||'—')}</td><td>${esc(m.para||'—')}</td>
      <td class="muted">${esc(m.usuario||'—')}</td>
      <td class="muted">${esc(m.obs||'')}</td>
    </tr>`).join('')}</tbody></table>`;
}
function tabelaEquipSimples(lista){
  if(!lista.length) return `<div class="empty">Nenhum item.</div>`;
  return `<table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Status</th></tr></thead><tbody>
    ${lista.map(e=>`<tr><td class="mono">${esc(e.serie)}</td><td><span class="tag-tipo">${esc(tipoNome(e.tipo))}</span></td><td><span class="badge ${e.status}">${STATUS[e.status]}</span></td></tr>`).join('')}</tbody></table>`;
}

/* =========================================================
   TIPOS
   ========================================================= */
function corrigirTiposDuplicados(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  const contagem = {}; DB.equipamentos.forEach(e=>contagem[e.tipo]=(contagem[e.tipo]||0)+1);
  const porNome = {};
  Object.keys(DB.tipos).forEach(c=>{ const nome=(DB.tipos[c].nome||c).trim().toLowerCase(); (porNome[nome]=porNome[nome]||[]).push(c); });
  const paraRemover = [];
  Object.values(porNome).forEach(codigos=>{
    if(codigos.length>1){
      const comItens = codigos.filter(c=>(contagem[c]||0)>0);
      const semItens = codigos.filter(c=>(contagem[c]||0)===0);
      if(comItens.length>0) paraRemover.push(...semItens);
    }
  });
  Object.keys(DB.tipos).forEach(c=>{
    const nome = (DB.tipos[c].nome||c).trim().toLowerCase();
    if(nome==='central' && (contagem[c]||0)===0 && !paraRemover.includes(c)) paraRemover.push(c);
  });
  if(!paraRemover.length) return flash('Nenhum tipo duplicado sem uso encontrado','green');
  if(!confirm('Remover '+paraRemover.length+' tipo(s) duplicado(s) sem nenhum equipamento (ex.: "'+paraRemover[0]+'")? Os tipos com equipamentos reais não são afetados.')) return;
  paraRemover.forEach(c=>delete DB.tipos[c]);
  salvar(); render(); flash(`✅ ${paraRemover.length} tipo(s) duplicado(s) removido(s)`,'green');
}
function renderTipos(){
  const cods=Object.keys(DB.tipos);
  $('#content').innerHTML = `
  <div class="panel"><div class="ph"><h3>🏷️ Tipos de equipamento</h3><div class="spacer"></div>${souAdmin()?`<button class="btn sm" onclick="corrigirTiposDuplicados()">🧹 Remover duplicados sem uso</button>`:''}<button class="btn sm primary" onclick="openTipo()">＋ Adicionar tipo</button></div>
  <div class="pb">
    <p class="muted" style="margin-bottom:16px">Dê um nome amigável a cada código (ex.: <b>UBI.0001 → "Sirene"</b>). Os nomes aparecem em todo o dashboard.</p>
    ${cods.length? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
      ${cods.map(c=>{ const n=DB.equipamentos.filter(e=>e.tipo===c).length; const emEst=DB.equipamentos.filter(e=>e.tipo===c&&e.status==='estoque').length; const min=DB.tipos[c].min||0; const baixo=min>0&&emEst<min; return `
        <div class="panel" style="box-shadow:none;${baixo?'border-color:var(--red)':''}"><div class="pb" style="display:flex;align-items:center;gap:12px">
          <span style="width:14px;height:14px;border-radius:4px;background:${tipoCor(c)};flex-shrink:0"></span>
          <div style="flex:1"><div style="font-weight:700">${esc(tipoNome(c))}</div><div class="mono muted" style="font-size:12px">${esc(c)} · ${n} itens · ${emEst} em estoque${min>0?` · mín ${min}`:''}</div></div>
          ${baixo?'<span class="badge baixado" style="font-size:10px">baixo</span>':''}
          <button class="btn sm ghost" onclick="openTipo('${esc(c)}')">✏️</button>
        </div></div>`;}).join('')}
    </div>`: `<div class="empty">Nenhum tipo. Importe dados ou adicione manualmente.</div>`}
  </div></div>`;
}

/* =========================================================
   FILIAIS / DEPÓSITOS
   ========================================================= */
function renderFiliais(){
  const filiais = todasFiliaisConhecidas();
  $('#content').innerHTML = `
  <div class="panel"><div class="ph"><h3>🏢 Filiais / Depósitos</h3><div class="spacer"></div><button class="btn sm primary" onclick="openFilial()">＋ Adicionar filial</button></div>
  <div class="pb">
    <p class="muted" style="margin-bottom:16px">Cadastre uma filial mesmo antes dela ter equipamentos ou técnicos — assim ela já aparece nos filtros e telas do sistema.</p>
    ${filiais.length? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
      ${filiais.map(f=>{ const n=DB.equipamentos.filter(e=>e.deposito===f).length; const tecs=DB.tecnicos.filter(t=>t.regiao===f).length; const alertas=alertasEstoqueMinPorFilial().filter(a=>a.filial===f).length; return `
      <div class="panel" style="box-shadow:none;cursor:pointer" onclick="abrirFilial('${esc(f)}')"><div class="pb">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><div style="font-weight:700;font-size:15px">${esc(f)}</div>${alertas?`<span class="badge baixado" style="font-size:10px;margin-left:auto">⚠️ ${alertas}</span>`:''}</div>
        <div class="muted" style="font-size:12px">${n} equipamento(s) · ${tecs} técnico(s)</div>
      </div></div>`;}).join('')}
    </div>` : '<div class="empty">Nenhuma filial cadastrada ainda.</div>'}
  </div></div>`;
}
function abrirFilial(f){
  const eqs = DB.equipamentos.filter(e=>e.deposito===f);
  const emEstoque = eqs.filter(e=>e.status==='estoque').length;
  const comTec = eqs.filter(e=>e.status==='com_tecnico').length;
  const rma = eqs.filter(e=>e.status==='baixado').length;
  const tecs = DB.tecnicos.filter(t=>t.regiao===f);
  const alertasFilial = alertasEstoqueMinPorFilial().filter(a=>a.filial===f);
  const podeExcluir = eqs.length===0 && tecs.length===0;
  modal('🏢 '+esc(f), `
    <div class="grid kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
      ${kpi('b','📦','Total',eqs.length)}
      ${kpi('g','✅','Em estoque',emEstoque)}
      ${kpi('a','👷','Com técnicos',comTec)}
      ${kpi('r','♻️','RMA',rma)}
    </div>
    ${alertasFilial.length?`<div class="badge baixado" style="padding:8px 12px;margin-bottom:16px">⚠️ ${alertasFilial.length} tipo(s) abaixo do estoque mínimo</div>`:''}
    <h4 style="margin-bottom:8px;font-size:13.5px">👷 Técnicos vinculados (${tecs.length})</h4>
    <div class="tbl-wrap" style="max-height:220px">${
      tecs.length? `<table><tbody>${tecs.map(t=>{ const n=itensDoTecnico(t.id).length; return `
        <tr style="cursor:pointer" onclick="closeModal();verEstoqueTecnico('${t.id}')"><td>${esc(t.nome)}</td><td class="right"><span class="count-badge">${n} itens</span></td></tr>`;}).join('')}</tbody></table>`
      : '<div class="empty">Nenhum técnico vinculado a essa filial.</div>'
    }</div>`,
    `${podeExcluir?`<button class="btn red ghost" style="margin-right:auto" onclick="excluirFilial('${esc(f)}')">🗑️ Excluir filial</button>`:`<span class="muted" style="margin-right:auto;font-size:11.5px;max-width:260px">Só é possível excluir filiais sem equipamentos e sem técnicos vinculados.</span>`}
     <button class="btn" onclick="closeModal()">Fechar</button>
     <button class="btn primary" onclick="closeModal();estoqueMinFilial='${esc(f)}';goto('estoquemin')">Ver estoque mínimo →</button>`, 'lg');
}
function openFilial(){
  modal('＋ Nova filial', `<div class="field"><label>Sigla da filial *</label><input id="fl_nome" placeholder="Ex.: NOV" maxlength="6" style="text-transform:uppercase"></div>`,
    `<button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="salvarFilial()">Salvar</button>`);
}
function salvarFilial(){
  const nome = limparFilial($('#fl_nome').value);
  if(!nome) return flash('Informe a sigla da filial','red');
  if(todasFiliaisConhecidas().includes(nome)) return flash('Essa filial já existe','red');
  DB.filiais = DB.filiais||[]; DB.filiais.push(nome);
  salvar(); closeModal(); render(); flash('✅ Filial adicionada','green');
}
function excluirFilial(f){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  if(!confirm('Excluir a filial '+f+'?')) return;
  DB.filiais = (DB.filiais||[]).filter(x=>x!==f);
  salvar(); closeModal(); render(); flash('Filial excluída');
}

/* =========================================================
   DADOS — importar / exportar
   ========================================================= */
function renderDados(){
  const c=DB.config.importadoEm;
  $('#content').innerHTML = `
  <div class="grid" style="grid-template-columns:1fr 1fr">
    <div class="panel"><div class="ph"><h3>📋 Colar dados da planilha</h3></div><div class="pb">
      <p class="muted" style="margin-bottom:12px">Selecione tudo no Excel (com o cabeçalho) → Copiar → cole aqui. Reconhece as colunas <b>Nº Série, Produto, Depósito, Data Entrada</b>.</p>
      <div class="field"><textarea id="pasteArea" rows="8" placeholder="Cole aqui os dados copiados do Excel..." style="font-family:Consolas,monospace;font-size:12px"></textarea></div>
      <label class="checkbox" style="margin-bottom:12px"><input type="checkbox" id="pasteSubstituir"> Substituir todo o inventário (senão, adiciona/atualiza)</label>
      <button class="btn primary" onclick="importarColado()">Importar dados colados</button>
    </div></div>

    <div class="panel"><div class="ph"><h3>📁 Abrir arquivo Excel / CSV</h3></div><div class="pb">
      <p class="muted" style="margin-bottom:12px">Abra direto o arquivo <b>.xlsx</b> ou <b>.csv</b> do seu inventário.</p>
      <div class="field"><input type="file" id="fileInput" accept=".xlsx,.xls,.csv" onchange="importarArquivo(this)"></div>
      ${window.__noXLSX?`<div class="badge baixado" style="margin-bottom:10px">⚠️ Leitura de .xlsx indisponível (sem internet). Use CSV ou cole os dados.</div>`:''}
      <label class="checkbox"><input type="checkbox" id="fileSubstituir" checked> Substituir todo o inventário ao importar</label>
    </div></div>
  </div>

  ${souAdmin()?`<div class="panel" style="margin-top:18px;border-left:4px solid var(--red)"><div class="pb">
    <b>🚑 Correção urgente de sincronização</b>
    <p class="muted" style="margin:6px 0 12px">Se aparecer erro de "documento muito grande" ao movimentar itens, clique aqui uma vez para migrar o histórico de movimentações para um armazenamento sem limite de tamanho.</p>
    <button class="btn red" onclick="migrarHistoricoParaColecao()">🚑 Corrigir armazenamento (migrar histórico)</button>
  </div></div>`:''}
  <div class="panel" style="margin-top:18px"><div class="ph"><h3>💾 Backup & compartilhamento</h3></div><div class="pb">
    <p class="muted" style="margin-bottom:14px">Os dados ficam salvos <b>neste navegador</b>. Para fazer cópia de segurança ou usar em outra máquina/compartilhar via rede, exporte o backup e importe no outro computador.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn green" onclick="exportarBackup()">⬇️ Exportar backup (.json)</button>
      <label class="btn">⬆️ Importar backup<input type="file" accept=".json" style="display:none" onchange="importarBackup(this)"></label>
      ${souAdmin()?`<button class="btn" onclick="limparSiglasFiliais()">🧹 Corrigir siglas de filiais (tirar "EPV")</button>`:''}
      ${souAdmin()?`<button class="btn" onclick="corrigirItensCDO()">🧹 Corrigir itens presos em "CDO"</button>`:''}
      ${souAdmin()?`<button class="btn" onclick="corrigirTiposPorSerie()">🔎 Corrigir tipos pelo padrão do código</button>`:''}
      ${souAdmin()?`<button class="btn" onclick="aplicarMinimosOficiais()">🎯 Aplicar estoque mínimo oficial</button>`:''}
      ${souAdmin()?`<button class="btn" onclick="distribuirEquipamentosTeste()">🧪 Distribuir equipamentos entre técnicos (teste)</button>`:''}
      <button class="btn red" onclick="limparTudo()">🗑️ Apagar tudo</button>
    </div>
    <div class="field" style="margin-top:18px;max-width:340px"><label>Seu nome (registrado nas movimentações)</label>
      <input id="cfgUsuario" value="${esc(DB.config.usuario||'')}" placeholder="Ex.: Cliver" onchange="DB.config.usuario=this.value;salvar()"></div>
    ${c?`<div class="muted" style="font-size:12px;margin-top:8px">Última importação: ${fmtTS(c)} · ${DB.equipamentos.length} itens · ${DB.movimentacoes.length} movimentações</div>`:''}
  </div></div>`;
}

/* =========================================================
   MODAIS — abrir/fechar genérico
   ========================================================= */
function modal(titulo, body, footer='', size=''){
  $('#modal').className = 'modal '+(size||'');
  $('#modal').innerHTML = `
    <div class="mh"><h3>${titulo}</h3><button class="x" onclick="closeModal()">×</button></div>
    <div class="mb">${body}</div>
    ${footer?`<div class="mf">${footer}</div>`:''}`;
  $('#modalBg').classList.add('show');
}
function closeModal(){ $('#modalBg').classList.remove('show'); }
$('#modalBg').addEventListener('click', e=>{ if(e.target.id==='modalBg') closeModal(); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });

/* ---- Equipamento (novo/editar) ---- */
function openEquip(serie){
  const e = serie? DB.equipamentos.find(x=>x.serie===serie) : null;
  const tiposOpt = Object.keys(DB.tipos).map(t=>`<option value="${t}" ${e&&e.tipo===t?'selected':''}>${esc(tipoNome(t))}</option>`).join('');
  modal(e?'Editar equipamento':'Novo equipamento', `
    <div class="field"><label>Nº de série (código único) *</label>
      <input id="e_serie" value="${e?esc(e.serie):''}" ${e?'disabled':''} placeholder="Ex.: 00-124B...-AA" ${e?'':'oninput="autoDetectarTipoEquip()"'}>
      <div class="hint">O tipo é detectado automaticamente pelo prefixo (00-=Controle, 02-=Foto, 04-=Magnetico, 05-=Sirene, A453EE20=Módulo).</div></div>
    <div class="row2">
      <div class="field"><label>Tipo *</label><select id="e_tipo">${tiposOpt||'<option value="">— nenhum tipo —</option>'}</select></div>
      <div class="field"><label>Depósito / Local</label><input id="e_dep" value="${e?esc(e.deposito||''):''}" placeholder="Ex.: CASEPV"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Status</label><select id="e_status">${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${e&&e.status===k?'selected':''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>Data de entrada</label><input id="e_data" value="${e?esc(e.dataEntrada||''):''}" placeholder="dd/mm/aaaa"></div>
    </div>
    <div class="field"><label>Observação</label><input id="e_obs" value="${e?esc(e.obs||''):''}"></div>`,
    `${e&&souAdmin()?`<button class="btn red ghost" style="margin-right:auto" onclick="excluirEquip('${esc(e.serie)}')">🗑️ Excluir definitivamente</button>`:''}
     <button class="btn" onclick="closeModal()">Cancelar</button>
     <button class="btn primary" onclick="salvarEquip(${e?`'${esc(e.serie)}'`:'null'})">Salvar</button>`);
}
function autoDetectarTipoEquip(){
  const serie = $('#e_serie').value;
  const tipo = detectarTipoPorSerie(serie);
  if(tipo && $('#e_tipo')){
    if(!DB.tipos[tipo]) DB.tipos[tipo]={nome:tipo,cor:''};
    if(!Array.from($('#e_tipo').options).some(o=>o.value===tipo)){
      $('#e_tipo').innerHTML += `<option value="${tipo}">${esc(tipoNome(tipo))}</option>`;
    }
    $('#e_tipo').value = tipo;
  }
}
function salvarEquip(serieEdit){
  const serie = serieEdit || $('#e_serie').value.trim();
  if(!serie) return flash('Informe o nº de série','red');
  if(!serieEdit && DB.equipamentos.some(e=>e.serie===serie)) return flash('Já existe um item com esse nº de série','red');
  let e = serieEdit? DB.equipamentos.find(x=>x.serie===serieEdit) : null;
  const dados={ tipo:$('#e_tipo').value, deposito:limparFilial($('#e_dep').value), status:$('#e_status').value, dataEntrada:$('#e_data').value.trim(), obs:$('#e_obs').value.trim() };
  if(e){ Object.assign(e,dados); }
  else { DB.equipamentos.push(Object.assign({serie, local:dados.deposito, tecnicoId:null}, dados)); }
  // garante que o tipo exista
  if(dados.tipo && !DB.tipos[dados.tipo]) DB.tipos[dados.tipo]={nome:dados.tipo,cor:''};
  salvar(); closeModal(); render(); flash('✅ Equipamento salvo','green');
}
function excluirEquip(serie){
  if(!souAdmin()) return flash('Somente administradores podem excluir equipamentos','red');
  const e = DB.equipamentos.find(x=>x.serie===serie); if(!e) return;
  if(!confirm('Excluir DEFINITIVAMENTE o equipamento '+serie+' do sistema?\n\nEle será removido do inventário, mas fica um registro permanente no Histórico de quem excluiu, quando e em que situação estava.')) return;
  const snapshot = `tipo:${tipoNome(e.tipo)} · status:${STATUS[e.status]||e.status} · local:${e.local||e.deposito||'—'}${e.tecnicoId?' · com '+tecNome(e.tecnicoId):''}`;
  registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'exclusao', serie, de:snapshot, para:'Excluído do sistema', tecnicoId:e.tecnicoId||null, usuario:nomeUsuarioAtual(), obs:'Exclusão definitiva por administrador' });
  DB.equipamentos = DB.equipamentos.filter(x=>x.serie!==serie);
  salvar(); closeModal(); render(); flash('Equipamento excluído — registro mantido no Histórico');
}

/* ---- Técnico ---- */
function openTec(id){
  const t = id? DB.tecnicos.find(x=>x.id===id):null;
  modal(t?'Editar técnico':'Novo técnico', `
    <div class="field"><label>Nome *</label><input id="t_nome" value="${t?esc(t.nome):''}" placeholder="Nome do técnico"></div>
    <div class="row2">
      <div class="field"><label>Região / Base</label><input id="t_regiao" value="${t?esc(t.regiao||''):''}" placeholder="Ex.: Blumenau"></div>
      <div class="field"><label>Matrícula</label><input id="t_mat" value="${t?esc(t.matricula||''):''}"></div>
    </div>`,
    `${t?`<button class="btn red ghost" style="margin-right:auto" onclick="excluirTec('${t.id}')">Excluir</button>`:''}
     <button class="btn" onclick="closeModal()">Cancelar</button>
     <button class="btn primary" onclick="salvarTec(${t?`'${t.id}'`:'null'})">Salvar</button>`);
}
function salvarTec(id){
  const nome=$('#t_nome').value.trim(); if(!nome) return flash('Informe o nome','red');
  const dados={nome, regiao:$('#t_regiao').value.trim(), matricula:$('#t_mat').value.trim()};
  if(id){ Object.assign(DB.tecnicos.find(x=>x.id===id),dados); }
  else { DB.tecnicos.push(Object.assign({id:uid()},dados)); }
  salvar(); closeModal(); render(); flash('✅ Técnico salvo','green');
}
function excluirTec(id){
  const n = DB.equipamentos.filter(e=>e.tecnicoId===id && e.status==='com_tecnico').length;
  if(n) return flash('Esse técnico tem '+n+' itens em posse. Mova-os antes de excluir.','red');
  if(!confirm('Excluir técnico?')) return;
  DB.tecnicos=DB.tecnicos.filter(t=>t.id!==id);
  salvar(); closeModal(); render(); flash('Técnico excluído');
}

/* ---- Tipo ---- */
function openTipo(cod){
  const t = cod? DB.tipos[cod]:null;
  modal(cod?'Editar tipo':'Novo tipo', `
    <div class="field"><label>Código *</label><input id="tp_cod" value="${cod?esc(cod):''}" ${cod?'disabled':''} placeholder="Ex.: UBI.0006"></div>
    <div class="field"><label>Nome amigável</label><input id="tp_nome" value="${t?esc(t.nome):''}" placeholder="Ex.: Sirene"></div>
    <div class="row2">
      <div class="field"><label>Cor</label><input type="color" id="tp_cor" value="${(t&&t.cor)||tipoCor(cod||'')}" style="height:42px;padding:4px"></div>
      <div class="field"><label>Estoque mínimo</label><input type="number" id="tp_min" min="0" value="${(t&&t.min)||0}"><div class="hint">Alerta quando o estoque ficar abaixo deste número.</div></div>
    </div>`,
    `<button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="salvarTipo(${cod?`'${esc(cod)}'`:'null'})">Salvar</button>`);
}
function salvarTipo(cod){
  const c = cod || $('#tp_cod').value.trim(); if(!c) return flash('Informe o código','red');
  DB.tipos[c]={ nome:$('#tp_nome').value.trim()||c, cor:$('#tp_cor').value, min:parseInt($('#tp_min').value)||0 };
  salvar(); closeModal(); render(); flash('✅ Tipo salvo','green');
}

/* =========================================================
   MOVIMENTAÇÃO (o coração do app)
   ========================================================= */
let movSel = [];  // séries selecionadas
let movTipo = 'saida';
let movFilialTec = '';
let movTecOrigem = '';
function agruparTecsPorFilialOpt(lista, selecionadoId){
  const porFilial = {};
  lista.forEach(t=>{ const f=t.regiao||'Sem filial'; (porFilial[f]=porFilial[f]||[]).push(t); });
  return Object.keys(porFilial).sort().map(f=>`<optgroup label="${esc(f)}">${porFilial[f].map(t=>`<option value="${t.id}" ${selecionadoId===t.id?'selected':''}>${esc(t.nome)}</option>`).join('')}</optgroup>`).join('');
}
function openMov(serie, tipo){
  movTipo = tipo || (souTecnico() ? 'transferencia' : 'saida');
  movSel = serie? [serie] : [];
  movFilialTec = '';
  movTecOrigem = '';
  desenharMov();
}
function desenharMov(){
  const tiposDisponiveis = souTecnico() ? ['transferencia','baixa'] : ['entrada','saida','transferencia','baixa'];
  if(!tiposDisponiveis.includes(movTipo)) movTipo = tiposDisponiveis[0];
  let regioesTec = [...new Set(DB.tecnicos.map(t=>t.regiao).filter(Boolean))].sort();
  if(souSupervisor()) regioesTec = regioesTec.filter(regiaoPermitida);
  let tecsBase = souSupervisor() ? DB.tecnicos.filter(t=>regiaoPermitida(t.regiao)) : DB.tecnicos;
  if(souTecnico() && meuTecnico()) tecsBase = tecsBase.filter(t=>t.id!==meuTecnico().id);
  const tecsFiltrados = tecsBase.filter(t=>!movFilialTec||t.regiao===movFilialTec);
  const tecsOpt = agruparTecsPorFilialOpt(tecsFiltrados);
  const semTec = tecsBase.length===0;
  const semTecFiltro = tecsFiltrados.length===0 && !semTec;
  // transferência: técnico de origem (filtrado pela filial) e técnico de destino (qualquer filial, exceto o de origem)
  const tecsOrigemOpt = agruparTecsPorFilialOpt(tecsFiltrados, movTecOrigem);
  const tecsDestino = tecsBase.filter(t=>t.id!==movTecOrigem);
  const tecsDestinoOpt = agruparTecsPorFilialOpt(tecsDestino);
  modal('🔄 Registrar movimentação', `
    <div class="field"><label>Tipo de movimentação</label>
      <div class="pill-tabs" style="width:100%">
        ${tiposDisponiveis.map(k=>`<button class="${movTipo===k?'active':''}" style="flex:1" onclick="movTipo='${k}';desenharMov()">${MOV_LABEL[k]}</button>`).join('')}
      </div>
    </div>

    <div class="field"><label>Equipamentos (nº de série)</label>
      <div class="search"><span class="si">🔎</span><input id="movBusca" placeholder="Digite/scan o nº de série e Enter para adicionar..." onkeydown="if(event.key==='Enter'){addMovSerieBusca();event.preventDefault()}" oninput="filtrarPickMov(this.value)"></div>
      <div class="chips" id="movChips"></div>
      <div class="pick-list" id="movPick" style="margin-top:8px"></div>
    </div>

    ${movTipo==='saida'? `
      <div class="row2">
        <div class="field"><label>Filtrar por filial</label>
          <select onchange="movFilialTec=this.value;desenharMov()">
            <option value="">Todas as filiais</option>
            ${regioesTec.map(r=>`<option value="${esc(r)}" ${movFilialTec===r?'selected':''}>${esc(r)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Entregar ao técnico *</label>
          <select id="movTec">${semTec?'<option value="">— cadastre um técnico antes —</option>':(semTecFiltro?'<option value="">— nenhum técnico nessa filial —</option>':tecsOpt)}</select>
        </div>
      </div>
      ${semTec?'<div class="hint">Vá em <b>Técnicos</b> e cadastre ao menos um.</div>':''}
      ${semTecFiltro?'<div class="hint">Nenhum técnico cadastrado na filial selecionada. Escolha outra filial.</div>':''}`:''}
    ${movTipo==='transferencia'&&!souTecnico()? `
      <div class="row3">
        <div class="field"><label>Filtrar por filial de origem</label>
          <select onchange="movFilialTec=this.value;movTecOrigem='';desenharMov()">
            <option value="">Todas as filiais</option>
            ${regioesTec.map(r=>`<option value="${esc(r)}" ${movFilialTec===r?'selected':''}>${esc(r)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Técnico de origem</label>
          <select onchange="movTecOrigem=this.value;desenharMov()">
            <option value="">Todos da filial</option>
            ${tecsOrigemOpt}
          </select>
        </div>
        <div class="field"><label>Transferir PARA o técnico *</label>
          <select id="movTec">${tecsDestino.length?tecsDestinoOpt:'<option value="">— nenhum técnico disponível —</option>'}</select>
        </div>
      </div>
      <div class="hint">O técnico de destino só passa a ter o item quando confirmar o recebimento na tela dele.</div>`:''}
    ${movTipo==='transferencia'&&souTecnico()? `
      <div class="field"><label>Transferir PARA o técnico *</label>
        <select id="movTec">${tecsDestino.length?tecsDestinoOpt:'<option value="">— nenhum técnico disponível —</option>'}</select>
      </div>
      <div class="hint">O técnico de destino só passa a ter o item quando confirmar o recebimento na tela dele.</div>`:''}
    ${movTipo==='baixa'&&!souTecnico()? `
      <div class="row2">
        <div class="field"><label>Filtrar por filial</label>
          <select onchange="movFilialTec=this.value;movTecOrigem='';desenharMov()">
            <option value="">Todas as filiais</option>
            ${regioesTec.map(r=>`<option value="${esc(r)}" ${movFilialTec===r?'selected':''}>${esc(r)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Técnico (opcional)</label>
          <select onchange="movTecOrigem=this.value;desenharMov()">
            <option value="">Todos / estoque da filial</option>
            ${tecsOrigemOpt}
          </select>
        </div>
      </div>`:''}
    ${movTipo==='baixa'? `
      <div class="field"><label>Número da OS (Ordem de Serviço) *</label>
        <input id="movOS" inputmode="numeric" maxlength="6" placeholder="Ex.: 123456" oninput="this.value=this.value.replace(/\\D/g,'').slice(0,6)">
        <div class="hint">Exatamente 6 números.</div>
      </div>`:''}
    ${movTipo==='entrada'? `<div class="field"><label>Depósito de destino</label><input id="movDep" list="listaFiliais" placeholder="Ex.: CAS"><datalist id="listaFiliais">${todasFiliaisConhecidas().map(f=>`<option value="${esc(f)}">`).join('')}</datalist></div>`:''}
    ${movTipo==='baixa'? `<div class="field"><label>Motivo do envio para RMA</label><input id="movMotivo" placeholder="Ex.: Defeito, garantia, devolução ao fabricante..."></div>`:''}

    <div class="field"><label>Observação${movTipo==='transferencia'?' *':''}</label><input id="movObs" placeholder="${movTipo==='transferencia'?'Obrigatório':'Opcional'}"></div>
  `, `<button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="confirmarMov()">Confirmar (<span id="movN">${movSel.length}</span> ${movSel.length===1?'item':'itens'})</button>`, 'lg');
  renderMovChips(); filtrarPickMov('');
}
function filtrarPickMov(q){
  q=(q||'').trim().toLowerCase();
  // candidatos dependem do tipo
  let cand = DB.equipamentos.filter(e=>!movSel.includes(e.serie) && !e.emTransito);
  if(souTecnico()){
    const meuId = meuTecnico()?meuTecnico().id:null;
    cand = cand.filter(e=>e.tecnicoId===meuId && e.status==='com_tecnico');
  }
  else if(movTipo==='saida'){ cand=cand.filter(e=>e.status==='estoque'); if(movFilialTec) cand=cand.filter(e=>e.deposito===movFilialTec); }
  else if(movTipo==='transferencia'){
    cand=cand.filter(e=>e.status==='com_tecnico');
    if(movTecOrigem) cand=cand.filter(e=>e.tecnicoId===movTecOrigem);
    else if(movFilialTec) cand=cand.filter(e=>{ const t=DB.tecnicos.find(x=>x.id===e.tecnicoId); return t&&t.regiao===movFilialTec; });
  }
  else if(movTipo==='entrada') cand=cand.filter(e=>e.status!=='estoque');
  else if(movTipo==='baixa'){
    cand=cand.filter(e=>e.status!=='baixado');
    if(movTecOrigem) cand=cand.filter(e=>e.tecnicoId===movTecOrigem);
    else if(movFilialTec) cand=cand.filter(e=>{ if(e.status==='com_tecnico'){ const t=DB.tecnicos.find(x=>x.id===e.tecnicoId); return t&&t.regiao===movFilialTec; } return e.deposito===movFilialTec; });
  }
  if(q) cand=cand.filter(e=>e.serie.toLowerCase().includes(q));
  cand=cand.slice(0,40);
  $('#movPick').innerHTML = cand.length? cand.map(e=>`
    <div class="pick-item" onclick="addMovSerie('${esc(e.serie)}')">
      <input type="checkbox" style="pointer-events:none">
      <div style="flex:1"><span class="mono"><b>${esc(e.serie)}</b></span> <span class="tag-tipo" style="font-size:11px">${esc(tipoNome(e.tipo))}</span></div>
      <span class="badge ${e.status}" style="font-size:10.5px">${e.status==='com_tecnico'?esc(tecNome(e.tecnicoId)):STATUS[e.status]}</span>
    </div>`).join('') : `<div class="muted center" style="padding:18px">Nenhum item disponível para esta movimentação.</div>`;
}
function addMovSerie(serie){ if(!movSel.includes(serie)){ movSel.push(serie); renderMovChips(); filtrarPickMov($('#movBusca').value);} }
function addMovSerieBusca(){
  const v=$('#movBusca').value.trim(); if(!v) return;
  const e=DB.equipamentos.find(x=>x.serie.toLowerCase()===v.toLowerCase());
  if(!e) return flash('Nº de série não encontrado','red');
  addMovSerie(e.serie); $('#movBusca').value='';
}
function removeMovSerie(serie){ movSel=movSel.filter(s=>s!==serie); renderMovChips(); filtrarPickMov($('#movBusca')?$('#movBusca').value:''); }
function renderMovChips(){
  $('#movChips').innerHTML = movSel.map(s=>`<span class="chip">${esc(s)} <span class="rm" onclick="removeMovSerie('${esc(s)}')">×</span></span>`).join('');
  if($('#movN')) $('#movN').textContent = movSel.length;
}
function confirmarMov(){
  if(!movSel.length) return flash('Selecione ao menos um equipamento','red');
  const usuario = nomeUsuarioAtual();
  const obs = $('#movObs')?$('#movObs').value.trim():'';
  let tecId=null, destinoTxt='';
  if(movTipo==='saida'||movTipo==='transferencia'){
    tecId=$('#movTec')?$('#movTec').value:''; if(!tecId) return flash('Selecione o técnico','red');
    destinoTxt=tecNome(tecId);
  } else if(movTipo==='entrada'){ destinoTxt=($('#movDep')?limparFilial($('#movDep').value):'')||'Estoque'; }
  else if(movTipo==='baixa'){ destinoTxt='RMA'; }

  if(movTipo==='transferencia' && !obs) return flash('Informe a observação para registrar a transferência','red');

  let numeroOS = '';
  if(movTipo==='baixa'){
    numeroOS = $('#movOS')?$('#movOS').value.trim():'';
    if(!/^\d{6}$/.test(numeroOS)) return flash('Informe o número da OS com exatamente 6 números','red');
  }

  let n=0;
  movSel.forEach(serie=>{
    const e=DB.equipamentos.find(x=>x.serie===serie); if(!e || e.emTransito) return;
    const de = e.status==='com_tecnico'? tecNome(e.tecnicoId) : (e.local||e.deposito||'Estoque');
    const tecnicoAnterior = e.tecnicoId;
    if(movTipo==='saida'||movTipo==='transferencia'){
      // fica "em trânsito": só sai do estoque/técnico de origem quando o destinatário confirmar o recebimento
      e.emTransito=true; e.transitoPara=tecId; e.transitoDesde=Date.now(); e.transitoDe=de; e.transitoUsuario=usuario; e.transitoDeTecnicoId=tecnicoAnterior||null;
    }
    else if(movTipo==='entrada'){ e.status='estoque'; e.tecnicoId=null; e.confirmado=true; e.emTransito=false; if($('#movDep')&&$('#movDep').value.trim()){e.deposito=limparFilial($('#movDep').value);} e.local=e.deposito; }
    else if(movTipo==='baixa'){ e.status='baixado'; e.tecnicoId=null; e.local='RMA'; e.confirmado=true; e.emTransito=false; e.rmaTecnicoId=tecnicoAnterior||null; e.rmaDeposito=e.deposito||null; e.rmaDesde=Date.now(); e.rmaOS=numeroOS; }
    e.desde = Date.now();
    const motivo = movTipo==='baixa' && $('#movMotivo')? $('#movMotivo').value.trim() : '';
    const tecIdMov = movTipo==='baixa' ? tecnicoAnterior : tecId;
    const paraTxt = (movTipo==='saida'||movTipo==='transferencia') ? destinoTxt+' (aguardando confirmação)' : destinoTxt;
    const obsFinal = movTipo==='baixa' ? ['OS '+numeroOS,obs,motivo].filter(Boolean).join(' · ') : [obs,motivo].filter(Boolean).join(' · ');
    registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:movTipo, serie, de, para:paraTxt, tecnicoId:tecIdMov, usuario, obs:obsFinal, os:numeroOS });
    n++;
  });
  salvar(); closeModal(); render(); flash(`✅ ${n} ${n===1?'movimentação registrada':'movimentações registradas'}`+((movTipo==='saida'||movTipo==='transferencia')?' — aguardando confirmação do técnico':''),'green');
}

/* =========================================================
   IMPORTAÇÃO
   ========================================================= */
const COL_MAP = {
  serie:['nº série','no série','n° série','numero de serie','nº de série','serie','série','n serie','nº serie'],
  produto:['produto','tipo'],
  deposito:['depósito','deposito','local','armazém','armazem'],
  data:['data entrada','data de entrada','data','entrada'],
  origem:['origem'], familia:['família','familia'], derivacao:['derivação','derivacao'], um:['um','unidade']
};
function acharCol(headers, chaves){
  const norm = h => h.toLowerCase().trim().replace(/\s+/g,' ');
  for(let i=0;i<headers.length;i++){ const h=norm(headers[i]); if(chaves.some(c=>h===c||h.includes(c))) return i; }
  return -1;
}
function parseLinhas(matriz, substituir){
  if(!matriz.length){ flash('Arquivo vazio','red'); return; }
  // acha header
  let hi=0; for(let i=0;i<Math.min(5,matriz.length);i++){ const row=matriz[i].map(c=>String(c).toLowerCase()); if(row.some(c=>c.includes('série')||c.includes('serie'))){ hi=i; break; } }
  const headers=matriz[hi].map(c=>String(c));
  const ci={ serie:acharCol(headers,COL_MAP.serie), produto:acharCol(headers,COL_MAP.produto), deposito:acharCol(headers,COL_MAP.deposito), data:acharCol(headers,COL_MAP.data), origem:acharCol(headers,COL_MAP.origem), familia:acharCol(headers,COL_MAP.familia), derivacao:acharCol(headers,COL_MAP.derivacao), um:acharCol(headers,COL_MAP.um) };
  if(ci.serie<0){ flash('Não encontrei a coluna "Nº Série". Verifique o cabeçalho.','red'); return; }

  if(substituir){ DB.equipamentos=[]; }
  const idx = {}; DB.equipamentos.forEach((e,i)=>idx[e.serie]=i);
  let novos=0, atualizados=0;
  for(let i=hi+1;i<matriz.length;i++){
    const row=matriz[i]; if(!row||!row.length) continue;
    const serie=String(row[ci.serie]==null?'':row[ci.serie]).trim(); if(!serie) continue;
    const tipo = detectarTipoPorSerie(serie) || (ci.produto>=0? String(row[ci.produto]||'').trim() : 'SEM-TIPO');
    const reg = {
      serie, tipo,
      deposito: ci.deposito>=0? limparFilial(row[ci.deposito]):'',
      dataEntrada: ci.data>=0? String(row[ci.data]||'').trim():'',
      origem: ci.origem>=0?String(row[ci.origem]||'').trim():'',
      familia: ci.familia>=0?String(row[ci.familia]||'').trim():'',
      derivacao: ci.derivacao>=0?String(row[ci.derivacao]||'').trim():'',
      um: ci.um>=0?String(row[ci.um]||'').trim():''
    };
    if(tipo && !DB.tipos[tipo]) DB.tipos[tipo]={nome:tipo,cor:''};
    if(serie in idx){
      const e=DB.equipamentos[idx[serie]]; Object.assign(e,reg); atualizados++;
    } else {
      DB.equipamentos.push(Object.assign({status:'estoque',tecnicoId:null,local:reg.deposito,obs:''},reg));
      idx[serie]=DB.equipamentos.length-1; novos++;
    }
  }
  DB.config.importadoEm=Date.now(); salvar();
  flash(`✅ Importado: ${novos} novos, ${atualizados} atualizados`,'green');
  goto('dashboard');
}
function importarColado(){
  const txt=$('#pasteArea').value; if(!txt.trim()) return flash('Cole os dados primeiro','red');
  const delim = txt.includes('\t')?'\t':(txt.split('\n')[0].includes(';')?';':',');
  const matriz = txt.replace(/\r/g,'').split('\n').filter(l=>l.trim()).map(l=>l.split(delim));
  parseLinhas(matriz, $('#pasteSubstituir').checked);
}
function importarArquivo(input){
  const file=input.files[0]; if(!file) return;
  const sub = $('#fileSubstituir').checked;
  const reader=new FileReader();
  if(/\.csv$/i.test(file.name)){
    reader.onload=e=>{ const txt=e.target.result; const delim=txt.includes('\t')?'\t':(txt.split('\n')[0].includes(';')?';':','); const matriz=txt.replace(/\r/g,'').split('\n').filter(l=>l.trim()).map(l=>l.split(delim)); parseLinhas(matriz,sub); };
    reader.readAsText(file,'utf-8');
  } else {
    if(window.__noXLSX||typeof XLSX==='undefined') return flash('Leitura de Excel indisponível (sem internet). Salve como CSV ou cole os dados.','red');
    reader.onload=e=>{ const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'}); const ws=wb.Sheets[wb.SheetNames[0]]; const matriz=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:''}); parseLinhas(matriz,sub); };
    reader.readAsArrayBuffer(file);
  }
  input.value='';
}

/* ---- Exportações ---- */
function baixar(nome, conteudo, mime){ const blob=new Blob([conteudo],{type:mime}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=nome; a.click(); URL.revokeObjectURL(a.href); }
function csvLinha(arr){ return arr.map(c=>{ c=(c==null?'':String(c)); return /[;"\n]/.test(c)?'"'+c.replace(/"/g,'""')+'"':c; }).join(';'); }
function exportarEquipCSV(){
  const head=['Nº Série','Tipo','Cód.Tipo','Status','Local/Técnico','Depósito','Data Entrada','Obs'];
  const linhas=filtrarEquip().map(e=>[e.serie,tipoNome(e.tipo),e.tipo,STATUS[e.status],e.status==='com_tecnico'?tecNome(e.tecnicoId):(e.local||e.deposito||''),e.deposito||'',e.dataEntrada||'',e.obs||'']);
  baixar('equipamentos.csv','﻿'+[csvLinha(head),...linhas.map(csvLinha)].join('\n'),'text/csv');
}
function exportarHistCSV(){
  const head=['Data/Hora','Tipo','Nº Série','De','Para','Usuário','Obs'];
  const linhas=[...DB.movimentacoes].reverse().map(m=>[fmtTS(m.ts),MOV_LABEL[m.tipo],m.serie,m.de,m.para,m.usuario,m.obs]);
  baixar('historico_movimentacoes.csv','﻿'+[csvLinha(head),...linhas.map(csvLinha)].join('\n'),'text/csv');
}
function relatorioFilial(){
  const baseEqRel = souSupervisor() ? DB.equipamentos.filter(e=>regiaoPermitida(e.deposito)) : DB.equipamentos;
  const eq = dashFiliais.length ? baseEqRel.filter(e=>dashFiliais.includes(e.deposito)) : baseEqRel;
  const titulo = dashFiliais.length ? dashFiliais.join(', ') : 'Todas as filiais';
  const total=eq.length, emEstoque=eq.filter(e=>e.status==='estoque').length, comTec=eq.filter(e=>e.status==='com_tecnico').length, baixados=eq.filter(e=>e.status==='baixado').length;
  const porTipo={}; eq.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
  const porTec={}; eq.filter(e=>e.status==='com_tecnico').forEach(e=>{ const n=tecNome(e.tecnicoId); porTec[n]=(porTec[n]||0)+1; });
  const parados = eq.filter(e=>e.status==='com_tecnico'&&(diasEmPosse(e)||0)>=DIAS_PARADO);
  const alertasMin = estoqueMinAlertas(eq);
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const linha=(l,v,cor)=>`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee"><span>${l}</span><b style="color:${cor||'#111'}">${v}</b></div>`;
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório — ${esc(titulo)}</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    h3{font-size:14px;margin:22px 0 8px;border-bottom:2px solid #2563eb;padding-bottom:4px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    .kpis{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0}
    .kpi{flex:1;min-width:120px;border:1px solid #ddd;border-radius:8px;padding:12px 14px}
    .kpi b{display:block;font-size:22px;margin-top:4px}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">🖨️ Imprimir / Salvar PDF</button>
    <h1>Relatório de Estoque — ${esc(titulo)}</h1>
    <h2>${esc(DB.config.empresa||'A365')} · gerado em ${hoje}</h2>
    <div class="kpis">
      <div class="kpi">Total de itens<b>${total}</b></div>
      <div class="kpi">Em estoque<b style="color:#16a34a">${emEstoque}</b></div>
      <div class="kpi">Com técnicos<b style="color:#d97706">${comTec}</b></div>
      <div class="kpi">RMA<b style="color:#dc2626">${baixados}</b></div>
      <div class="kpi">Parados ${DIAS_PARADO}+ dias<b style="color:#dc2626">${parados.length}</b></div>
    </div>
    <h3>Itens por tipo</h3>
    ${Object.keys(porTipo).length?Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([t,n])=>linha(esc(tipoNome(t)),n)).join(''):'<i>Sem dados.</i>'}
    <h3>Itens por técnico (em posse)</h3>
    ${Object.keys(porTec).length?Object.entries(porTec).sort((a,b)=>b[1]-a[1]).map(([t,n])=>linha(esc(t),n)).join(''):'<i>Nenhum item com técnico.</i>'}
    ${alertasMin.length?`<h3>⚠️ Alertas de estoque mínimo</h3>${alertasMin.map(a=>linha(esc(tipoNome(a.tipo)),a.atual+' / mín. '+a.min,'#dc2626')).join('')}`:''}
    ${parados.length?`<h3>⏰ Itens parados (${DIAS_PARADO}+ dias)</h3><table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Técnico</th><th>Dias</th></tr></thead><tbody>
      ${parados.map(e=>`<tr><td>${esc(e.serie)}</td><td>${esc(tipoNome(e.tipo))}</td><td>${esc(tecNome(e.tecnicoId))}</td><td>${diasEmPosse(e)}</td></tr>`).join('')}
    </tbody></table>`:''}
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}
function exportarBackup(){ baixar('backup_estoque_'+new Date().toISOString().slice(0,10)+'.json', JSON.stringify(DB,null,2),'application/json'); flash('✅ Backup exportado','green'); }
function importarBackup(input){
  const f=input.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=async e=>{
    try{
      const d=JSON.parse(e.target.result); if(!d.equipamentos) throw 0;
      if(!confirm('Substituir TODOS os dados atuais pelo backup?')) return;
      const movsBackup = d.movimentacoes||[];
      DB=Object.assign(estadoInicial(),d); salvar(); render(); renderNav();
      flash('Restaurando histórico de movimentações...','green');
      await limparColecaoMovimentacoes();
      await gravarMovimentacoesEmLote(movsBackup);
      flash('✅ Backup restaurado','green');
    }catch(err){ flash('Arquivo de backup inválido: '+err.message,'red'); }
  }; r.readAsText(f); input.value='';
}
async function gravarMovimentacoesEmLote(lista){
  for(let i=0;i<lista.length;i+=400){
    const batch = window.firestoreDB.batch();
    lista.slice(i,i+400).forEach(m=>batch.set(MOVS_REF.doc(m.id), m));
    await batch.commit();
  }
}
async function limparColecaoMovimentacoes(){
  const snap = await MOVS_REF.get();
  const docs = snap.docs;
  for(let i=0;i<docs.length;i+=400){
    const batch = window.firestoreDB.batch();
    docs.slice(i,i+400).forEach(d=>batch.delete(d.ref));
    await batch.commit();
  }
}
async function migrarHistoricoParaColecao(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  if(!confirm('Isso corrige o erro de "documento muito grande": move todo o histórico de movimentações (que está travado no navegador atual) para um armazenamento sem limite de tamanho. Pode levar alguns segundos. Continuar?')) return;
  flash('Migrando histórico, aguarde...','green');
  try{
    await gravarMovimentacoesEmLote(DB.movimentacoes);
    await new Promise(r=>setTimeout(r,500));
    const { movimentacoes, ...semMovs } = DB;
    await DOC_REF.set(semMovs);
    flash(`✅ Migração concluída! ${DB.movimentacoes.length} movimentação(ões) migrada(s). Sincronização corrigida.`,'green');
  }catch(err){
    flash('⚠️ Erro na migração: '+err.message,'red');
  }
}
function corrigirItensCDO(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  const presos = DB.equipamentos.filter(e=>/^CDO/i.test(e.deposito||'') || /^CDO/i.test(e.local||''));
  if(!presos.length) return flash('Nenhum item preso em "CDO" encontrado — tudo certo','green');
  const destino = prompt('Encontrei '+presos.length+' equipamento(s) com depósito "CDO" (sobra de um teste). Pra qual filial devo mover eles? (digite a sigla)');
  if(!destino) return;
  const nome = limparFilial(destino);
  presos.forEach(e=>{ e.deposito=nome; if(e.status==='estoque') e.local=nome; });
  salvar(); render(); flash(`✅ ${presos.length} equipamento(s) movido(s) para ${nome}`,'green');
}
function limparSiglasFiliais(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  if(!confirm('Corrigir os nomes de filial em todo o sistema (tirar "EPV" e corrigir siglas erradas: SFO→SOO, JDA→JND, POA→PAE, RIP→RBP)? Isso ajusta equipamentos, RMA e técnicos.')) return;
  let n=0;
  DB.equipamentos.forEach(e=>{
    if(e.deposito){ const novo=limparFilial(e.deposito); if(novo!==e.deposito){ if(e.status==='estoque'&&e.local===e.deposito) e.local=novo; e.deposito=novo; n++; } }
    if(e.rmaDeposito){ const novoRma=limparFilial(e.rmaDeposito); if(novoRma!==e.rmaDeposito) e.rmaDeposito=novoRma; }
  });
  DB.tecnicos.forEach(t=>{ if(t.regiao){ const novo=limparFilial(t.regiao); if(novo!==t.regiao) t.regiao=novo; } });
  salvar(); render(); flash(`✅ ${n} equipamento(s) corrigido(s)`,'green');
}
function corrigirTiposPorSerie(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  if(!confirm('Corrigir o TIPO de todos os equipamentos com base no padrão do nº de série (00-=Controle, 02-=Foto, 04-=Magnetico, 05-=Sirene, A453EE20=Módulo)? Isso também mescla "Central" em "Modulo" (mesmo tipo) e substitui o tipo atual sempre que o padrão for reconhecido.')) return;
  let n=0;
  DB.equipamentos.forEach(e=>{
    if(e.tipo==='Central'){ e.tipo='Modulo'; n++; }
    const tipo = detectarTipoPorSerie(e.serie);
    if(tipo && e.tipo!==tipo){
      e.tipo = tipo;
      if(!DB.tipos[tipo]) DB.tipos[tipo]={nome:tipo,cor:''};
      n++;
    }
  });
  if(DB.tipos['Central']) delete DB.tipos['Central'];
  if(!DB.tipos['Modulo']) DB.tipos['Modulo']={nome:'Modulo',cor:''};
  salvar(); render(); flash(`✅ ${n} equipamento(s) corrigido(s)`,'green');
}
function distribuirEquipamentosTeste(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  if(!confirm('Isso é só para gerar dados de TESTE: vai pegar cerca de metade dos equipamentos em estoque de cada filial e distribuir entre os técnicos cadastrados naquela região (sem criar histórico de movimentação, sem confirmação pendente). Continuar?')) return;
  const porFilial = {};
  DB.equipamentos.filter(e=>e.status==='estoque' && e.deposito).forEach(e=>{ (porFilial[e.deposito]=porFilial[e.deposito]||[]).push(e); });
  let n=0;
  Object.entries(porFilial).forEach(([filial, itens])=>{
    const tecs = DB.tecnicos.filter(t=>t.regiao===filial);
    if(!tecs.length) return;
    const qtd = Math.floor(itens.length*0.5);
    for(let i=0;i<qtd;i++){
      const e = itens[i];
      const tec = tecs[i % tecs.length];
      e.status='com_tecnico'; e.tecnicoId=tec.id; e.local=tecNome(tec.id); e.confirmado=true; e.emTransito=false; e.desde=Date.now();
      n++;
    }
  });
  salvar(); render(); flash(`✅ ${n} equipamento(s) distribuído(s) entre técnicos (dados de teste)`,'green');
}
function aplicarMinimosOficiais(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  const MINIMOS = { Controle:20, Magnetico:16, Sirene:8, Foto:30, Modulo:8 };
  if(!confirm('Aplicar o estoque mínimo oficial por tipo (Controle=20, Magnetico=16, Sirene=8, Foto=30, Modulo=8) para todas as filiais? Isso substitui o mínimo atual desses tipos.')) return;
  Object.entries(MINIMOS).forEach(([t,min])=>{
    if(!DB.tipos[t]) DB.tipos[t]={nome:t,cor:''};
    DB.tipos[t].min = min;
  });
  salvar(); render(); flash('✅ Estoque mínimo aplicado','green');
}
async function limparTudo(){
  if(!confirm('Apagar TODOS os dados (equipamentos, técnicos, movimentações)? Faça backup antes!')) return;
  if(!confirm('Tem certeza? Esta ação não pode ser desfeita.')) return;
  DB=estadoInicial(); salvar(); goto('dados'); flash('Apagando histórico da nuvem...','green');
  try{ await limparColecaoMovimentacoes(); flash('Todos os dados foram apagados'); }
  catch(err){ flash('⚠️ '+err.message,'red'); }
}

/* =========================================================
   KARDEX — histórico completo de um item
   ========================================================= */
function abrirKardex(serie){
  const e=DB.equipamentos.find(x=>x.serie===serie);
  const movs=DB.movimentacoes.filter(m=>m.serie===serie);
  const ent = e? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span>
      <span class="badge ${e.status}">${STATUS[e.status]}</span>
      <span class="badge gray">${e.status==='com_tecnico'?'Com '+esc(tecNome(e.tecnicoId)):esc(e.local||e.deposito||'—')}</span>
      <span class="badge gray">há ${fmtDias(diasEmPosse(e))} aqui</span>
    </div>`:'';
  const linha = movs.length? movs.slice().reverse().map(m=>`
      <div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #f1f5f9">
        <div style="width:8px;flex-shrink:0;display:flex;justify-content:center"><span style="width:9px;height:9px;border-radius:50%;background:var(--brand);margin-top:5px"></span></div>
        <div style="flex:1">
          <div style="display:flex;gap:8px;align-items:center">${movBadge(m.tipo)}<span class="muted" style="font-size:11.5px">${fmtTS(m.ts)}</span></div>
          <div style="margin-top:3px;font-size:13px">${esc(m.de||'—')} → <b>${esc(m.para||'—')}</b></div>
          ${m.usuario||m.obs?`<div class="muted" style="font-size:11.5px;margin-top:2px">${esc(m.usuario||'')}${m.obs?' · '+esc(m.obs):''}</div>`:''}
          ${m.fotos&&m.fotos.length?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${m.fotos.map(u=>`<a href="${u}" target="_blank"><img src="${u}" style="width:56px;height:56px;object-fit:cover;border-radius:7px;border:1px solid var(--line)"></a>`).join('')}</div>`:''}
        </div>
      </div>`).join('') : '<div class="empty">Nenhuma movimentação registrada para este item.</div>';
  modal('Kardex · <span class="mono">'+esc(serie)+'</span>', ent+`<div style="max-height:380px;overflow:auto">${linha}</div>`, '', 'lg');
}

/* =========================================================
   FICHA DO TÉCNICO + TERMO DE RESPONSABILIDADE
   ========================================================= */
function fichaTecnico(id){
  const t=DB.tecnicos.find(x=>x.id===id); if(!t) return;
  const itens=itensDoTecnico(id);
  const aud=ultimaAuditoria('tecnico',id);
  const porTipo={}; itens.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
  const dias = itens.map(e=>diasEmPosse(e)||0);
  const mediaDias = dias.length? Math.round(dias.reduce((a,b)=>a+b,0)/dias.length) : 0;
  const parados = itens.filter(e=>(diasEmPosse(e)||0)>=DIAS_PARADO).length;
  const donutData = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tp,n])=>[tipoNome(tp),n,tipoCor(tp)]);
  modal('👷 '+(t.regiao?'['+esc(t.regiao)+'] ':'')+esc(t.nome), `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">
      <span class="badge blue" style="padding:8px 12px">${esc(t.regiao||'Sem região')}</span>
      ${t.matricula?`<span class="badge gray" style="padding:8px 12px">${esc(t.matricula)}</span>`:''}
      <span class="badge ${aud?'estoque':'baixado'}" style="padding:8px 12px">${aud?'Auditado '+fmtTS(aud.ts):'Nunca auditado'}</span>
      ${parados?`<span class="badge com_tecnico" style="padding:8px 12px">${parados} parado${parados>1?'s':''} ${DIAS_PARADO}+ dias</span>`:''}
    </div>
    <div class="chart-row" style="margin-bottom:18px">
      <div class="panel" style="box-shadow:none">
        <div class="ph"><h3>📊 Equipamentos por tipo</h3></div>
        <div class="pb"><div class="donut-wrap">
          ${donutData.length? donut(donutData) : '<div class="empty">Nenhum item em posse.</div>'}
        </div></div>
      </div>
      <div class="panel" style="box-shadow:none">
        <div class="ph"><h3>Resumo</h3></div>
        <div class="pb" style="display:flex;flex-direction:column;gap:14px">
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
            <div class="kpi a" style="padding:14px 16px"><div class="lbl" style="font-size:10px;letter-spacing:0">👷 EM POSSE</div><div class="val" style="font-size:22px">${itens.length}</div></div>
            <div class="kpi v" style="padding:14px 16px"><div class="lbl" style="font-size:10px;letter-spacing:0">🕓 MÉDIA POSSE</div><div class="val" style="font-size:22px">${mediaDias}d</div></div>
          </div>
          ${Object.keys(porTipo).length?`<div style="display:flex;gap:8px;flex-wrap:wrap">${Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tp,n])=>`<span class="tag-tipo" style="border-left:3px solid ${tipoCor(tp)}">${esc(tipoNome(tp))}: ${n}</span>`).join('')}</div>`:''}
        </div>
      </div>
    </div>
    <div class="tbl-wrap" style="max-height:320px">${
      itens.length? `<table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Há quanto tempo</th><th></th></tr></thead><tbody>
        ${itens.map(e=>`<tr>
          <td class="mono"><a href="#" onclick="abrirKardex('${esc(e.serie)}');return false">${esc(e.serie)}</a></td>
          <td><span class="tag-tipo">${esc(tipoNome(e.tipo))}</span></td>
          <td>${fmtDias(diasEmPosse(e))} ${(diasEmPosse(e)||0)>=DIAS_PARADO?'<span class="badge com_tecnico" style="font-size:10px">parado</span>':''}</td>
          <td class="right"><button class="btn sm" onclick="closeModal();openMov('${esc(e.serie)}')">Mover</button></td>
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nenhum equipamento em posse.</div>'
    }</div>`,
    `<button class="btn" style="margin-right:auto" onclick="termoResponsabilidade('${id}')">🖨️ Termo de responsabilidade</button>
     <button class="btn primary" onclick="closeModal();iniciarAuditoria('tecnico','${id}')" ${itens.length?'':'disabled'}>🔍 Auditar este técnico</button>`, 'lg');
}
function termoResponsabilidade(id){
  const t=DB.tecnicos.find(x=>x.id===id); const itens=itensDoTecnico(id);
  const hoje=new Date().toLocaleDateString('pt-BR');
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Termo de Responsabilidade</title>
    <style>body{font-family:Arial,sans-serif;max-width:760px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.6}
    h1{font-size:19px;text-align:center;margin-bottom:4px}h2{font-size:13px;text-align:center;font-weight:normal;color:#555;margin-bottom:24px}
    table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border:1px solid #999;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    .ass{margin-top:60px;display:flex;justify-content:space-between;gap:40px}.ass div{flex:1;text-align:center;border-top:1px solid #333;padding-top:6px}
    p{text-align:justify}@media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">🖨️ Imprimir / Salvar PDF</button>
    <h1>TERMO DE RESPONSABILIDADE DE EQUIPAMENTOS</h1>
    <h2>${esc(DB.config.empresa||'')}</h2>
    <p>Eu, <b>${esc(t.nome)}</b>${t.matricula?', matrícula '+esc(t.matricula):''}${t.regiao?', lotado(a) em '+esc(t.regiao):''}, declaro ter recebido os equipamentos relacionados abaixo, comprometendo-me a zelar pela sua guarda e conservação, responsabilizando-me por danos, extravios ou uso indevido, e a devolvê-los quando solicitado.</p>
    <table><thead><tr><th>#</th><th>Nº de Série</th><th>Tipo / Equipamento</th><th>Em posse desde</th></tr></thead><tbody>
      ${itens.map((e,i)=>`<tr><td>${i+1}</td><td>${esc(e.serie)}</td><td>${esc(tipoNome(e.tipo))}</td><td>${refTS(e)?new Date(refTS(e)).toLocaleDateString('pt-BR'):'—'}</td></tr>`).join('')}
    </tbody></table>
    <p>Total de <b>${itens.length}</b> equipamento(s).</p>
    <p style="margin-top:30px">Local e data: __________________________, ${hoje}.</p>
    <div class="ass"><div>${esc(t.nome)}<br><small>Especialista de campo</small></div><div>${esc(DB.config.usuario||'Responsável pelo estoque')}<br><small>Responsável</small></div></div>
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o termo','red'); w.document.write(html); w.document.close();
}

/* =========================================================
   AUDITORIA / CONFERÊNCIA
   ========================================================= */
let AUD = null; // auditoria em andamento { alvoTipo, alvoId, alvoNome, esperados:[], conf:Set, sobra:[] }

function renderAuditoria(){
  if(AUD) return renderAuditoriaEmAndamento();
  const tecsComItens=DB.tecnicos.filter(t=>itensDoTecnico(t.id).length>0);
  const deps=[...new Set(DB.equipamentos.filter(e=>e.status==='estoque').map(e=>e.local||e.deposito).filter(Boolean))].sort();
  $('#content').innerHTML=`
  <div class="grid" style="grid-template-columns:1fr 1fr;margin-bottom:20px">
    <div class="panel"><div class="ph"><h3>🔍 Auditar técnico</h3></div><div class="pb">
      <p class="muted" style="margin-bottom:12px">Confira fisicamente o que cada especialista tem em mãos. O sistema aponta o que <b>falta</b> e o que está <b>a mais</b>.</p>
      ${tecsComItens.length? `<div style="display:flex;flex-direction:column;gap:8px">${tecsComItens.map(t=>{const aud=ultimaAuditoria('tecnico',t.id);return `
        <button class="btn" style="justify-content:space-between;width:100%" onclick="iniciarAuditoria('tecnico','${t.id}')">
          <span>👷 ${esc(t.nome)} <span class="count-badge">${itensDoTecnico(t.id).length}</span></span>
          <span class="muted" style="font-size:11.5px">${aud?'auditado '+new Date(aud.ts).toLocaleDateString('pt-BR'):'nunca auditado'}</span>
        </button>`;}).join('')}</div>` : '<div class="empty">Nenhum técnico com itens em posse.</div>'}
    </div></div>
    <div class="panel"><div class="ph"><h3>📍 Auditar depósito</h3></div><div class="pb">
      <p class="muted" style="margin-bottom:12px">Confira o saldo físico de um depósito contra o sistema.</p>
      ${deps.length? `<div style="display:flex;flex-direction:column;gap:8px">${deps.map(d=>`
        <button class="btn" style="justify-content:space-between;width:100%" onclick="iniciarAuditoria('deposito','${esc(d)}')">
          <span>📍 ${esc(d)} <span class="count-badge">${itensDoDeposito(d).length}</span></span></button>`).join('')}</div>` : '<div class="empty">Nenhum depósito com itens.</div>'}
    </div></div>
  </div>
  ${DB.auditorias.length?`<div class="panel" style="margin-bottom:20px"><div class="ph"><h3>📈 Evolução das divergências</h3><span class="muted" style="font-size:11.5px;margin-left:6px">(clique numa barra para ver o laudo)</span></div>
    <div class="pb">
      ${[...DB.auditorias].sort((a,b)=>a.ts-b.ts).map(a=>{
        const div=a.faltando.length+a.sobrando.length;
        const max=Math.max(1,...DB.auditorias.map(x=>x.faltando.length+x.sobrando.length));
        return `<div class="bar-row" style="cursor:pointer" onclick="verLaudo('${a.id}')">
          <div class="bl" style="width:190px;font-size:12px">${new Date(a.ts).toLocaleDateString('pt-BR')} · ${a.alvoTipo==='tecnico'?'👷':'📍'} ${esc(a.alvoNome)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(6,div/max*100)}%;background:${div?'var(--red)':'var(--green)'}">${div}</div></div>
        </div>`;}).join('')}
    </div>
  </div>`:''}
  <div class="panel"><div class="ph"><h3>📋 Auditorias realizadas</h3><span class="count-badge">${DB.auditorias.length}</span></div>
    <div class="tbl-wrap">${
      DB.auditorias.length? `<table><thead><tr><th>Data</th><th>Alvo</th><th>Auditor</th><th class="center">Esperado</th><th class="center">Conferido</th><th class="center">Faltando</th><th class="center">Sobrando</th><th></th></tr></thead><tbody>
        ${[...DB.auditorias].reverse().map(a=>`<tr>
          <td class="muted">${fmtTS(a.ts)}</td>
          <td>${a.alvoTipo==='tecnico'?'👷':'📍'} ${esc(a.alvoNome)}</td>
          <td class="muted">${esc(a.auditor||'—')}</td>
          <td class="center">${a.esperados.length}</td>
          <td class="center"><b style="color:var(--green)">${a.conferidos.length}</b></td>
          <td class="center">${a.faltando.length?`<b style="color:var(--red)">${a.faltando.length}</b>`:'0'}</td>
          <td class="center">${a.sobrando.length?`<b style="color:var(--amber)">${a.sobrando.length}</b>`:'0'}</td>
          <td class="right"><button class="btn sm ghost" onclick="verLaudo('${a.id}')">Ver laudo</button></td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty"><div class="big">🔍</div>Nenhuma auditoria realizada ainda.</div>'
    }</div></div>`;
}

function iniciarAuditoria(alvoTipo, alvoId){
  const esperados = (alvoTipo==='tecnico'? itensDoTecnico(alvoId) : itensDoDeposito(alvoId)).map(e=>e.serie);
  const alvoNome = alvoTipo==='tecnico'? tecNome(alvoId) : alvoId;
  AUD = { alvoTipo, alvoId, alvoNome, esperados, conf:new Set(), sobra:[] };
  goto('auditoria');
}
function cancelarAuditoria(){ if(confirm('Cancelar auditoria? O progresso será perdido.')){ AUD=null; render(); } }

function renderAuditoriaEmAndamento(){
  const esp=AUD.esperados, conf=AUD.conf;
  const faltando=esp.filter(s=>!conf.has(s));
  $('#content').innerHTML=`
  <div class="panel" style="margin-bottom:18px"><div class="pb" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
    <div style="flex:1;min-width:200px"><div class="muted" style="font-size:12px">Auditando ${AUD.alvoTipo==='tecnico'?'técnico':'depósito'}</div><div style="font-size:20px;font-weight:800">${AUD.alvoTipo==='tecnico'?'👷':'📍'} ${esc(AUD.alvoNome)}</div></div>
    <div class="center"><div style="font-size:26px;font-weight:800">${esp.length}</div><div class="muted" style="font-size:11px">ESPERADO</div></div>
    <div class="center"><div style="font-size:26px;font-weight:800;color:var(--green)">${conf.size}</div><div class="muted" style="font-size:11px">CONFERIDO</div></div>
    <div class="center"><div style="font-size:26px;font-weight:800;color:var(--red)">${faltando.length}</div><div class="muted" style="font-size:11px">FALTANDO</div></div>
    <div class="center"><div style="font-size:26px;font-weight:800;color:var(--amber)">${AUD.sobra.length}</div><div class="muted" style="font-size:11px">SOBRANDO</div></div>
  </div></div>

  <div class="panel" style="margin-bottom:18px"><div class="pb">
    <div class="field" style="margin-bottom:0"><label>Escaneie ou digite o nº de série e tecle Enter</label>
      <div class="search"><span class="si">📷</span><input id="audInput" autofocus placeholder="Bipe o código do equipamento..." onkeydown="if(event.key==='Enter'){audBipar();event.preventDefault()}"></div>
      <div class="hint">Item esperado → marca como conferido. Item não esperado → registrado como "sobrando" (divergência).</div>
    </div>
  </div></div>

  <div class="chart-row">
    <div class="panel"><div class="ph"><h3>Itens esperados</h3><div class="spacer"></div><button class="btn sm ghost" onclick="audMarcarTodos()">Marcar todos</button></div>
      <div class="tbl-wrap" style="max-height:360px"><table><tbody>
        ${esp.length?esp.map(s=>{const e=DB.equipamentos.find(x=>x.serie===s);const ok=conf.has(s);return `
          <tr onclick="audToggle('${esc(s)}')" style="cursor:pointer">
            <td style="width:30px">${ok?'✅':'⬜'}</td>
            <td class="mono"><b>${esc(s)}</b></td>
            <td>${e?`<span class="tag-tipo">${esc(tipoNome(e.tipo))}</span>`:''}</td>
            <td class="right">${ok?'<span class="badge estoque">conferido</span>':'<span class="badge gray">pendente</span>'}</td>
          </tr>`;}).join(''):'<tr><td class="empty">Nada esperado aqui.</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="panel"><div class="ph"><h3>⚠️ Sobrando (não esperado)</h3></div>
      <div class="tbl-wrap" style="max-height:360px"><table><tbody>
        ${AUD.sobra.length?AUD.sobra.map(s=>{const e=DB.equipamentos.find(x=>x.serie===s);return `
          <tr><td class="mono"><b>${esc(s)}</b></td>
          <td>${e?`<span class="badge ${e.status}">${e.status==='com_tecnico'?'com '+esc(tecNome(e.tecnicoId)):STATUS[e.status]}</span>`:'<span class="badge baixado">desconhecido</span>'}</td>
          <td class="right"><button class="btn sm ghost" onclick="audRemSobra('${esc(s)}')">remover</button></td></tr>`;}).join(''):'<tr><td class="empty">Nenhuma divergência.</td></tr>'}
      </tbody></table></div>
    </div>
  </div>

  <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
    <button class="btn" onclick="cancelarAuditoria()">Cancelar</button>
    <button class="btn green" onclick="finalizarAuditoria()">✅ Finalizar e salvar laudo</button>
  </div>`;
  setTimeout(()=>{const i=$('#audInput');if(i)i.focus();},50);
}
function audBipar(){
  const inp=$('#audInput'); const v=inp.value.trim(); if(!v) return;
  const serie=(DB.equipamentos.find(x=>x.serie.toLowerCase()===v.toLowerCase())||{}).serie || v;
  if(AUD.esperados.includes(serie)){ AUD.conf.add(serie); flash('✅ Conferido','green'); }
  else if(!AUD.sobra.includes(serie)){ AUD.sobra.push(serie); flash('⚠️ Item não esperado (sobrando)','red'); }
  inp.value=''; renderAuditoriaEmAndamento();
}
function audToggle(s){ if(AUD.conf.has(s))AUD.conf.delete(s); else AUD.conf.add(s); renderAuditoriaEmAndamento(); }
function audMarcarTodos(){ AUD.esperados.forEach(s=>AUD.conf.add(s)); renderAuditoriaEmAndamento(); }
function audRemSobra(s){ AUD.sobra=AUD.sobra.filter(x=>x!==s); renderAuditoriaEmAndamento(); }
function finalizarAuditoria(){
  const conferidos=[...AUD.conf]; const faltando=AUD.esperados.filter(s=>!AUD.conf.has(s));
  const reg={ id:uid(), ts:Date.now(), alvoTipo:AUD.alvoTipo, alvoId:AUD.alvoId, alvoNome:AUD.alvoNome, auditor:nomeUsuarioAtual(), esperados:AUD.esperados.slice(), conferidos, faltando, sobrando:AUD.sobra.slice(), obs:'' };
  DB.auditorias.push(reg); salvar();
  const divergencias=faltando.length+AUD.sobra.length;
  AUD=null; goto('auditoria');
  flash(divergencias? `Auditoria salva — ${divergencias} divergência(s)`:'✅ Auditoria salva — tudo conferido!', divergencias?'red':'green');
  verLaudo(reg.id);
}
function verLaudo(id){
  const a=DB.auditorias.find(x=>x.id===id); if(!a) return;
  const sec=(titulo,arr,cor,vazio)=>`<div style="margin-bottom:12px"><div style="font-weight:700;margin-bottom:6px;color:${cor}">${titulo} (${arr.length})</div>${arr.length?`<div style="display:flex;flex-wrap:wrap;gap:6px">${arr.map(s=>`<span class="mono" style="background:#f1f5f9;padding:3px 8px;border-radius:6px;font-size:11.5px">${esc(s)}</span>`).join('')}</div>`:`<div class="muted" style="font-size:12.5px">${vazio}</div>`}</div>`;
  modal('📋 Laudo de auditoria', `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <span class="badge blue" style="padding:8px 12px">${a.alvoTipo==='tecnico'?'👷':'📍'} ${esc(a.alvoNome)}</span>
      <span class="badge gray" style="padding:8px 12px">${fmtTS(a.ts)}</span>
      <span class="badge gray" style="padding:8px 12px">Auditor: ${esc(a.auditor||'—')}</span>
      <span class="badge ${(a.faltando.length+a.sobrando.length)?'baixado':'estoque'}" style="padding:8px 12px">${(a.faltando.length+a.sobrando.length)?(a.faltando.length+a.sobrando.length)+' divergência(s)':'Sem divergências'}</span>
    </div>
    ${sec('✅ Conferidos',a.conferidos,'var(--green)','—')}
    ${sec('❌ Faltando (esperado, não encontrado)',a.faltando,'var(--red)','Nenhum item faltando.')}
    ${sec('⚠️ Sobrando (encontrado, não esperado)',a.sobrando,'var(--amber)','Nenhum item a mais.')}`,
    `<button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
}

/* =========================================================
   ÁREA DO TÉCNICO (visão simplificada, mobile)
   ========================================================= */
function meuTecnico(){ return MEU_PERFIL && MEU_PERFIL.tecnicoId ? DB.tecnicos.find(t=>t.id===MEU_PERFIL.tecnicoId) : null; }
function semVinculoHtml(){
  return `<div class="panel"><div class="pb"><div class="empty"><div class="big">🔗</div>
    <h2 style="margin-bottom:8px">Seu acesso ainda não foi vinculado</h2>
    <p class="muted" style="max-width:420px;margin:0 auto">Peça para o administrador vincular seu login a um técnico cadastrado, na página <b>Usuários</b>.</p>
  </div></div></div>`;
}
function renderMeusItens(){
  const t = meuTecnico();
  if(!t) return $('#content').innerHTML = semVinculoHtml();
  const pendentes = DB.equipamentos.filter(e=>e.emTransito && e.transitoPara===t.id);
  const confirmados = itensDoTecnico(t.id);
  $('#content').innerHTML = `
  <div class="grid kpis" style="margin-bottom:20px">
    ${kpi('a','📦','Itens em posse',confirmados.length)}
    ${kpi('r','⏳','Aguardando confirmação',pendentes.length)}
  </div>
  <div class="panel" style="margin-bottom:20px;${pendentes.length?'border-left:4px solid var(--amber)':''}">
    <div class="ph"><h3>📥 Recebimento de equipamentos</h3><span class="count-badge">${pendentes.length} pendente${pendentes.length===1?'':'s'}</span></div>
    <div class="pb">
      ${pendentes.length?`
      <div class="field" style="margin-bottom:16px"><label>Bipe ou digite o nº de série e Enter para confirmar</label>
        <div class="search"><span class="si">📷</span><input id="recInput" autofocus placeholder="Bipe o código do equipamento..." onkeydown="if(event.key==='Enter'){recBipar();event.preventDefault()}"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${pendentes.map(e=>`
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;background:var(--amber-soft);border-radius:10px">
            <div style="flex:1;min-width:160px"><span class="mono"><b>${esc(e.serie)}</b></span> <span class="tag-tipo" style="margin-left:6px">${esc(tipoNome(e.tipo))}</span> <span class="muted" style="font-size:11.5px">de ${esc(e.transitoDe||'—')}</span></div>
            <button class="btn green sm" onclick="confirmarRecebimento('${esc(e.serie)}')">✅ Confirmar</button>
          </div>`).join('')}
      </div>` : '<div class="empty">Nenhum equipamento aguardando confirmação no momento.</div>'}
    </div>
  </div>
  <div class="panel"><div class="ph"><h3>📦 Meus equipamentos</h3><span class="count-badge">${confirmados.length}</span></div>
    <div class="tbl-wrap">${
      confirmados.length? `<table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Há quanto tempo</th></tr></thead><tbody>
        ${confirmados.map(e=>`<tr>
          <td class="mono"><b>${esc(e.serie)}</b></td>
          <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span></td>
          <td>${fmtDias(diasEmPosse(e))} ${(diasEmPosse(e)||0)>=DIAS_PARADO?`<span class="badge com_tecnico" style="font-size:10px">parado</span>`:''}</td>
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nenhum equipamento confirmado ainda.</div>'
    }</div></div>`;
  const i=$('#recInput'); if(i) i.focus();
}
function recBipar(){
  const inp=$('#recInput'); const v=(inp.value||'').trim(); if(!v) return;
  const t = meuTecnico(); if(!t) return;
  const e = DB.equipamentos.find(x=>x.serie.toLowerCase()===v.toLowerCase() && x.emTransito && x.transitoPara===t.id);
  if(!e){ flash('⚠️ Esse nº de série não está na sua lista de pendentes','red'); inp.value=''; return; }
  confirmarRecebimento(e.serie, true);
  inp.value='';
}
/* ---- Registro de retirada em campo (manutenção/desinstalação) ---- */
let formSel = [];
let formFotos = []; // { file, url } - url é local (blob) até o envio
function abrirRegistrarForm(){
  if(!meuTecnico()) return flash('Seu acesso ainda não foi vinculado a um técnico','red');
  formSel = []; formFotos = [];
  desenharRegistrarForm();
}
function desenharRegistrarForm(){
  const tiposOpt = Object.keys(DB.tipos).map(cod=>`<option value="${cod}">${esc(tipoNome(cod))}</option>`).join('');
  const novos = formSel.filter(s=>!DB.equipamentos.find(e=>e.serie===s));
  const novosSemDeteccao = novos.filter(s=>!detectarTipoPorSerie(s));
  modal('📝 Registrar retirada em campo', `
    <div class="field"><label>Bipe ou digite o nº de série e Enter</label>
      <div class="search"><span class="si">📷</span><input id="formBusca" autofocus placeholder="Nº de série do equipamento..." onkeydown="if(event.key==='Enter'){formAddSerieBusca();event.preventDefault()}"></div>
      <div class="chips" id="formChips" style="margin-top:8px"></div>
      <div class="hint">Equipamentos novos têm o tipo detectado automaticamente pelo padrão do código.</div>
    </div>
    ${novosSemDeteccao.length?`<div class="field"><label>Tipo do(s) equipamento(s) novo(s) sem padrão reconhecido *</label><select id="formTipo"><option value="">— selecione —</option>${tiposOpt}</select>
      <div class="hint">Aplica-se a: ${novosSemDeteccao.map(esc).join(', ')}</div></div>`:''}
    <div class="field"><label>Tipo de atendimento *</label>
      <select id="formServico"><option value="manutencao">Manutenção</option><option value="desinstalacao">Desinstalação</option></select>
    </div>
    <div class="field"><label>Foto(s) de comprovação</label>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <label class="btn" style="cursor:pointer">📷 Tirar foto<input type="file" accept="image/*" capture="environment" multiple style="display:none" onchange="formAddFotos(this)"></label>
        <label class="btn" style="cursor:pointer">🖼️ Anexar da galeria<input type="file" accept="image/*" multiple style="display:none" onchange="formAddFotos(this)"></label>
      </div>
      <div id="formFotosPreview" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px"></div>
    </div>
    <div class="field"><label>Observação</label><textarea id="formObs" rows="3" placeholder="Opcional"></textarea></div>
  `, `<button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" id="formBtnRegistrar" onclick="confirmarRegistrarForm()">Registrar (<span id="formN">${formSel.length}</span>)</button>`, 'lg');
  renderFormChips();
  renderFormFotosPreview();
  const i=$('#formBusca'); if(i) i.focus();
}
function formAddFotos(input){
  Array.from(input.files||[]).forEach(file=>{ formFotos.push({ file, url:URL.createObjectURL(file) }); });
  input.value='';
  renderFormFotosPreview();
}
function formRemoveFoto(i){ URL.revokeObjectURL(formFotos[i].url); formFotos.splice(i,1); renderFormFotosPreview(); }
function renderFormFotosPreview(){
  const el = $('#formFotosPreview'); if(!el) return;
  el.innerHTML = formFotos.map((f,i)=>`
    <div style="position:relative;width:72px;height:72px">
      <img src="${f.url}" style="width:100%;height:100%;object-fit:cover;border-radius:9px;border:1px solid var(--line)">
      <button onclick="formRemoveFoto(${i})" style="position:absolute;top:-7px;right:-7px;width:22px;height:22px;border-radius:50%;background:var(--red);color:#fff;font-weight:700;font-size:13px;line-height:1;cursor:pointer">×</button>
    </div>`).join('');
}
function formAddSerieBusca(){
  const v=$('#formBusca').value.trim(); if(!v) return;
  if(formSel.includes(v)) return flash('Esse item já foi bipado','red');
  formSel.push(v); desenharRegistrarForm();
}
function formRemoveSerie(s){ formSel=formSel.filter(x=>x!==s); desenharRegistrarForm(); }
function renderFormChips(){
  $('#formChips').innerHTML = formSel.map(s=>{
    const existe = DB.equipamentos.find(e=>e.serie===s);
    return `<span class="chip" style="${existe?'':'background:var(--amber-soft);color:var(--amber)'}">${esc(s)}${existe?'':' · novo'} <span class="rm" onclick="formRemoveSerie('${esc(s)}')">×</span></span>`;
  }).join('');
  if($('#formN')) $('#formN').textContent = formSel.length;
}
async function proximoCodigoRetirada(){
  const ref = window.firestoreDB.collection('contadores').doc('retiradas');
  const novo = await window.firestoreDB.runTransaction(async tx=>{
    const snap = await tx.get(ref);
    const atual = (snap.exists && snap.data().valor) || 0;
    const val = atual+1;
    tx.set(ref, {valor:val});
    return val;
  });
  return 'RET-'+String(novo).padStart(4,'0');
}
async function confirmarRegistrarForm(){
  if(!formSel.length) return flash('Bipe ao menos um equipamento','red');
  const t = meuTecnico(); if(!t) return;
  const servico = $('#formServico').value;
  const servicoLabel = servico==='manutencao'?'Manutenção':'Desinstalação';
  const obs = $('#formObs').value.trim();
  const novos = formSel.filter(s=>!DB.equipamentos.find(e=>e.serie===s));
  const novosSemDeteccao = novos.filter(s=>!detectarTipoPorSerie(s));
  let tipoManual = '';
  if(novosSemDeteccao.length){
    tipoManual = $('#formTipo')?$('#formTipo').value:'';
    if(!tipoManual) return flash('Selecione o tipo para os equipamentos sem padrão reconhecido','red');
  }

  const btn = $('#formBtnRegistrar');
  const temFotosLocais = formFotos.length>0;
  if(btn){ btn.disabled=true; btn.textContent='Gerando código...'; }
  let codigoRetirada;
  try{ codigoRetirada = await proximoCodigoRetirada(); }
  catch(err){ if(btn){ btn.disabled=false; btn.textContent='Registrar ('+formSel.length+')'; } return flash('⚠️ Falha ao gerar código: '+err.message,'red'); }

  let n=0;
  formSel.forEach(serie=>{
    let e = DB.equipamentos.find(x=>x.serie===serie);
    const de = e ? (e.status==='com_tecnico'?tecNome(e.tecnicoId):(e.local||e.deposito||'Estoque')) : 'Campo (novo no sistema)';
    if(!e){
      const tipoNovo = detectarTipoPorSerie(serie) || tipoManual;
      e = { serie, tipo:tipoNovo, deposito:t.regiao||'', local:tecNome(t.id), status:'com_tecnico', tecnicoId:t.id, dataEntrada:'', origem:'campo', familia:'', derivacao:'', um:'', obs:'', confirmado:true };
      DB.equipamentos.push(e);
      if(!DB.tipos[tipoNovo]) DB.tipos[tipoNovo]={nome:tipoNovo,cor:''};
    } else {
      e.status='com_tecnico'; e.tecnicoId=t.id; e.local=tecNome(t.id); e.confirmado=true; e.emTransito=false; e.transitoPara=null; e.transitoDesde=null; e.transitoDe=null;
    }
    e.desde = Date.now();
    registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'registro_campo', serie, de, para:tecNome(t.id), tecnicoId:t.id, usuario:nomeUsuarioAtual(), obs:[servicoLabel, obs].filter(Boolean).join(' · '), fotos:[], retiradaId:codigoRetirada, temFotosLocais });
    n++;
  });
  formFotos.forEach(f=>URL.revokeObjectURL(f.url)); formFotos=[];
  salvar(); render();
  modal('✅ Retirada registrada', `
    <div style="text-align:center;padding:10px 0">
      <div class="muted" style="font-size:12.5px;margin-bottom:6px">Código desta retirada</div>
      <div style="font-size:32px;font-weight:800;color:var(--brand);letter-spacing:1px;margin-bottom:14px">${codigoRetirada}</div>
      <p class="muted" style="max-width:380px;margin:0 auto 6px">${n} equipamento(s) registrado(s).${temFotosLocais?' Salve as fotos no seu celular usando esse código no nome do arquivo (ex.: '+codigoRetirada+'-1.jpg) para conseguir encontrá-las depois.':''}</p>
    </div>`, `<button class="btn primary" style="width:100%;justify-content:center" onclick="closeModal()">Entendi</button>`, '');
}
function confirmarRecebimento(serie, semConfirm){
  const e = DB.equipamentos.find(x=>x.serie===serie); if(!e || !e.emTransito) return;
  if(!semConfirm && !confirm('Confirmar o recebimento do equipamento '+serie+'?')) return;
  const destinoId = e.transitoPara;
  e.status='com_tecnico'; e.tecnicoId=destinoId; e.local=tecNome(destinoId); e.confirmado=true; e.desde=Date.now();
  e.emTransito=false; e.transitoPara=null; e.transitoDesde=null; e.transitoDe=null; e.transitoUsuario=null; e.transitoDeTecnicoId=null;
  registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'confirmacao', serie, de:'Em trânsito', para:tecNome(destinoId), tecnicoId:destinoId, usuario:nomeUsuarioAtual(), obs:'Recebimento confirmado pelo técnico' });
  salvar(); render(); flash('✅ Recebimento de '+serie+' confirmado','green');
}
function renderMeuHistorico(){
  const t = meuTecnico();
  if(!t) return $('#content').innerHTML = semVinculoHtml();
  const movs = DB.movimentacoes.filter(m=>m.tecnicoId===t.id).slice().reverse();
  $('#content').innerHTML = `
  <div class="panel"><div class="ph"><h3>🕓 Meu histórico</h3><span class="count-badge">${movs.length}</span></div>
    <div class="tbl-wrap">${movs.length?tabelaMov(movs.slice(0,300)):'<div class="empty">Nenhuma movimentação ainda.</div>'}</div>
  </div>`;
}

/* =========================================================
   CONSULTAR RETIRADA (busca por código RET-XXXX)
   ========================================================= */
function listaRetiradas(){
  const porId = {};
  DB.movimentacoes.filter(m=>m.tipo==='registro_campo' && m.retiradaId).forEach(m=>{
    if(!porId[m.retiradaId]) porId[m.retiradaId] = { codigo:m.retiradaId, ts:m.ts, tecnicoId:m.tecnicoId, usuario:m.usuario, obs:m.obs, temFotosLocais:m.temFotosLocais, itens:[] };
    porId[m.retiradaId].itens.push(m.serie);
  });
  let lista = Object.values(porId).sort((a,b)=>b.ts-a.ts);
  if(souTecnico() && meuTecnico()) lista = lista.filter(r=>r.tecnicoId===meuTecnico().id);
  else if(souSupervisor()) lista = lista.filter(r=>{ const tc=DB.tecnicos.find(x=>x.id===r.tecnicoId); return tc && regiaoPermitida(tc.regiao); });
  return lista;
}
let retiradaBusca = '';
function renderRetiradas(){
  $('#content').innerHTML = `
  <div class="toolbar">
    <div class="search"><span class="si">🔎</span><input placeholder="Buscar por código (ex.: RET-0001)..." value="${esc(retiradaBusca)}" oninput="retiradaBusca=this.value;renderRetiradasLista()"></div>
  </div>
  <div class="panel"><div class="ph"><h3>🔎 Retiradas em campo</h3><span class="count-badge" id="retiradasCount"></span></div>
    <div class="pb" style="display:flex;flex-direction:column;gap:10px" id="retiradasLista"></div>
  </div>`;
  renderRetiradasLista();
}
function renderRetiradasLista(){
  const todas = listaRetiradas();
  const q = retiradaBusca.trim().toLowerCase();
  const filtradas = q ? todas.filter(r=>r.codigo.toLowerCase().includes(q)) : todas;
  $('#retiradasCount') && ($('#retiradasCount').textContent = filtradas.length);
  $('#retiradasLista').innerHTML = filtradas.length? filtradas.map(r=>`
        <div class="panel" style="box-shadow:none;cursor:pointer" onclick="verRetirada('${esc(r.codigo)}')"><div class="pb" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <div style="font-weight:800;color:var(--brand);font-size:15px;min-width:90px">${esc(r.codigo)}</div>
          <div style="flex:1;min-width:200px">
            <div style="font-weight:600">${esc(tecNome(r.tecnicoId))}</div>
            <div class="muted" style="font-size:12px">${esc(r.obs||'—')} · ${r.itens.length} item(ns)</div>
          </div>
          <div class="muted" style="font-size:11.5px">${fmtTS(r.ts)}</div>
          ${r.temFotosLocais?'<span class="badge" style="background:var(--amber-soft);color:var(--amber)">📷 tem foto local</span>':''}
        </div></div>`).join('') : '<div class="empty"><div class="big">🔎</div>Nenhuma retirada encontrada.</div>';
}
function verRetirada(codigo){
  const r = listaRetiradas().find(x=>x.codigo===codigo); if(!r) return;
  modal('🔎 Retirada '+esc(codigo), `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <span class="badge blue" style="padding:8px 12px">👷 ${esc(tecNome(r.tecnicoId))}</span>
      <span class="badge gray" style="padding:8px 12px">${fmtTS(r.ts)}</span>
      <span class="badge gray" style="padding:8px 12px">Registrado por ${esc(r.usuario||'—')}</span>
    </div>
    <p class="muted" style="margin-bottom:14px">${esc(r.obs||'Sem observação.')}</p>
    ${r.temFotosLocais?`<div class="badge com_tecnico" style="padding:8px 12px;margin-bottom:14px">📷 Fotos foram tiradas no momento do registro e ficam salvas no celular do técnico, organizadas pelo código ${esc(codigo)}</div>`:''}
    <div class="tbl-wrap" style="max-height:320px"><table><thead><tr><th>Nº Série</th><th>Tipo</th></tr></thead><tbody>
      ${r.itens.map(serie=>{ const e=DB.equipamentos.find(x=>x.serie===serie); return `<tr>
        <td class="mono"><a href="#" onclick="abrirKardex('${esc(serie)}');return false"><b>${esc(serie)}</b></a></td>
        <td>${e?`<span class="tag-tipo">${esc(tipoNome(e.tipo))}</span>`:'<span class="muted">—</span>'}</td>
      </tr>`;}).join('')}
    </tbody></table></div>`, `<button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
}

/* =========================================================
   ADMINISTRAÇÃO DE USUÁRIOS (só admin)
   ========================================================= */
let USUARIOS_LISTA = [];
let usuariosListenerAtivo = null;
function renderUsuarios(){
  if(!souAdmin()){ $('#content').innerHTML='<div class="empty">Acesso restrito.</div>'; return; }
  if(!usuariosListenerAtivo){
    usuariosListenerAtivo = USERS_REF.onSnapshot(snap=>{
      USUARIOS_LISTA = snap.docs.map(d=>Object.assign({uid:d.id}, d.data()));
      if(PAGE==='usuarios') renderUsuarios();
    });
    return; // vai re-renderizar assim que o snapshot chegar
  }
  const regioesConhecidas = [...new Set(DB.tecnicos.map(t=>t.regiao).filter(Boolean))].sort();
  const ordenados = [...USUARIOS_LISTA].sort((a,b)=>(a.papel==='pendente'?0:1)-(b.papel==='pendente'?0:1) || (a.criadoEm||0)-(b.criadoEm||0));
  $('#content').innerHTML = `
  <div class="panel"><div class="ph"><h3>🔐 Usuários e permissões</h3><span class="count-badge">${USUARIOS_LISTA.length}</span></div>
    <div class="pb" style="display:flex;flex-direction:column;gap:12px">
      ${ordenados.map(u=>`
        <div class="panel" style="box-shadow:none;${u.papel==='pendente'?'border-color:var(--amber)':''}"><div class="pb" style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">
          <div style="min-width:180px;flex:1">
            <div style="font-weight:700">${esc(u.nome||u.email)}</div>
            <div class="muted" style="font-size:12px">${esc(u.email)}</div>
            ${u.papel==='pendente'?'<span class="badge baixado" style="margin-top:4px">Aguardando aprovação</span>':''}
          </div>
          <div class="field" style="margin:0;min-width:150px"><label>Permissão</label>
            <select onchange="usuarioAtualizarCampo('${u.uid}','papel',this.value)">
              <option value="pendente" ${u.papel==='pendente'?'selected':''}>Pendente</option>
              <option value="tecnico" ${u.papel==='tecnico'?'selected':''}>Técnico (operador)</option>
              <option value="supervisor" ${u.papel==='supervisor'?'selected':''}>Supervisor (regional)</option>
              <option value="admin" ${u.papel==='admin'?'selected':''}>Administrador</option>
            </select>
          </div>
          ${u.papel==='supervisor'?`
          <div class="field" style="margin:0;min-width:220px"><label>Filiais permitidas</label>
            <select multiple size="4" style="min-height:80px" onchange="usuarioAtualizarRegioes('${u.uid}',this)">
              ${regioesConhecidas.map(r=>`<option value="${esc(r)}" ${(u.regioes||[]).includes(r)?'selected':''}>${esc(r)}</option>`).join('')}
            </select>
          </div>`:''}
          ${u.papel==='tecnico'?`
          <div class="field" style="margin:0;min-width:220px"><label>Vincular ao técnico cadastrado</label>
            <select onchange="usuarioAtualizarCampo('${u.uid}','tecnicoId',this.value||null)">
              <option value="">— nenhum —</option>
              ${DB.tecnicos.map(t=>`<option value="${t.id}" ${u.tecnicoId===t.id?'selected':''}>${t.regiao?'['+esc(t.regiao)+'] ':''}${esc(t.nome)}</option>`).join('')}
            </select>
          </div>`:''}
          <button class="btn sm red ghost" onclick="usuarioRemover('${u.uid}','${esc(u.email)}')">Remover</button>
        </div></div>`).join('')}
    </div>
  </div>`;
}
function usuarioAtualizarCampo(uid, campo, valor){
  USERS_REF.doc(uid).update({[campo]:valor}).then(()=>flash('✅ Atualizado','green')).catch(e=>flash('⚠️ '+e.message,'red'));
}
function usuarioAtualizarRegioes(uid, select){
  const vals = Array.from(select.selectedOptions).map(o=>o.value);
  USERS_REF.doc(uid).update({regioes:vals}).then(()=>flash('✅ Filiais atualizadas','green')).catch(e=>flash('⚠️ '+e.message,'red'));
}
function usuarioRemover(uid, email){
  if(!confirm('Remover o acesso de '+email+'? A pessoa poderá criar uma conta nova, mas terá que ser aprovada de novo.')) return;
  USERS_REF.doc(uid).delete().then(()=>flash('Usuário removido')).catch(e=>flash('⚠️ '+e.message,'red'));
}

/* ---------- Boot ---------- */
renderNav();
