/* =========================================================
   Controle de Estoque & Inventário — App (vanilla JS)
   Backend: Supabase (Postgres + Auth + Realtime). O localStorage é só
   um cache local para carregar mais rápido / funcionar offline;
   a fonte de verdade é o banco Postgres.
   ========================================================= */

const STORE_KEY_BASE = 'estoque_a365_v1';
let STORE_KEY = STORE_KEY_BASE; // isolado por conta assim que o login resolver (ver onAuthStateChanged)
const DIAS_PARADO = 20; // a partir de quantos dias com técnico um item é considerado "parado"
const STATUS = { estoque:'Em estoque', com_tecnico:'Com técnico', baixado:'RMA', instalado:'Instalado' };
const CHART_VARS = ['--chart-1','--chart-2','--chart-3','--chart-4','--chart-5','--chart-6','--chart-7','--chart-8'];
const MOV_LABEL = { entrada:'Entrada', saida:'Saída p/ técnico', transferencia:'Transferência', baixa:'Envio p/ RMA', retorno_rma:'Retorno de RMA', confirmacao:'Confirmação de recebimento', exclusao:'Exclusão definitiva', cancelamento:'Envio cancelado', registro_campo:'Registro em campo', uso_campo:'Uso em campo' };

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
function salvarLocal(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(DB));
    // Persiste também o rastro de "o que já está no servidor" (ultimoSyncEquip) — sem
    // isso ele começa VAZIO toda vez que o app abre, e offline (PWA) isso fazia o app
    // tratar TODOS os equipamentos como "alterados" e tentar reenviar todos via upsert,
    // inclusive itens em trânsito, que a RLS do técnico rejeita, derrubando o lote
    // inteiro (BUG-043). typeof guarda contra a TDZ do `let ultimoSyncEquip` (declarado
    // mais abaixo) caso salvarLocal rode antes daquela linha executar.
    if(typeof ultimoSyncEquip!=='undefined') localStorage.setItem(STORE_KEY+'_syncequip', JSON.stringify(ultimoSyncEquip));
  }catch(e){ console.warn('Falha ao salvar cache local:', e); }
}
function carregarUltimoSyncEquip(){
  try{ const r = localStorage.getItem(STORE_KEY+'_syncequip'); return r ? JSON.parse(r) : {}; }catch(e){ return {}; }
}

// Cache local do PERFIL do usuário (papel/nome/regiões/técnico), separado do cache de
// dados (DB) acima — usado só pra abrir o app offline com uma sessão já salva, quando a
// consulta de perfil não consegue completar por falta de rede (ver BUG-042).
function chavePerfilCache(uid){ return STORE_KEY_BASE+'_perfil_'+uid; }
function salvarPerfilCache(uid, perfil){ try{ localStorage.setItem(chavePerfilCache(uid), JSON.stringify(perfil)); }catch(e){} }
function lerPerfilCache(uid){ try{ const r = localStorage.getItem(chavePerfilCache(uid)); return r ? JSON.parse(r) : null; }catch(e){ return null; } }

/* ---------- Supabase: cliente e conversão de campos ----------
   Postgres usa snake_case e timestamptz; o resto do app (renderização,
   regras de negócio) continua 100% em camelCase e timestamps em ms
   (Date.now()) como sempre foi — a conversão fica isolada aqui, então
   nenhuma outra função do arquivo precisou mudar por causa disso. */
const sb = window.sb;
function tsToMs(v){ return v==null ? null : new Date(v).getTime(); }
function msToTs(v){ return v==null ? null : new Date(v).toISOString(); }

function equipamentoParaCamel(r){
  return {
    serie:r.serie, tipo:r.tipo, deposito:r.deposito, status:r.status,
    tecnicoId:r.tecnico_id, local:r.local, desde:tsToMs(r.desde),
    dataEntrada:r.data_entrada, origem:r.origem, familia:r.familia,
    derivacao:r.derivacao, um:r.um, obs:r.obs, confirmado:r.confirmado,
    emTransito:r.em_transito, transitoPara:r.transito_para,
    transitoDesde:tsToMs(r.transito_desde), transitoDe:r.transito_de,
    transitoUsuario:r.transito_usuario, transitoDeTecnicoId:r.transito_de_tecnico_id,
    rmaTecnicoId:r.rma_tecnico_id, rmaDeposito:r.rma_deposito,
    rmaDesde:tsToMs(r.rma_desde), rmaOS:r.rma_os, cenarioTeste:r.cenario_teste,
    instaladoTecnicoId:r.instalado_tecnico_id, instaladoOS:r.instalado_os,
    instaladoDesde:tsToMs(r.instalado_desde),
    operadora:r.operadora, numeroLinha:r.numero_linha,
    perdido:r.perdido, perdidoDesde:tsToMs(r.perdido_desde), perdidoFilial:r.perdido_filial,
    perdidoUsuario:r.perdido_usuario, perdidoObs:r.perdido_obs
  };
}
function equipamentoParaSnake(e){
  return {
    serie:e.serie, tipo:e.tipo, deposito:e.deposito||null, status:e.status,
    tecnico_id:e.tecnicoId||null, local:e.local||null, desde:msToTs(e.desde),
    data_entrada:e.dataEntrada||null, origem:e.origem||null, familia:e.familia||null,
    derivacao:e.derivacao||null, um:e.um||null, obs:e.obs||null, confirmado:!!e.confirmado,
    em_transito:!!e.emTransito, transito_para:e.transitoPara||null,
    transito_desde:msToTs(e.transitoDesde), transito_de:e.transitoDe||null,
    transito_usuario:e.transitoUsuario||null, transito_de_tecnico_id:e.transitoDeTecnicoId||null,
    rma_tecnico_id:e.rmaTecnicoId||null, rma_deposito:e.rmaDeposito||null,
    rma_desde:msToTs(e.rmaDesde), rma_os:e.rmaOS||null, cenario_teste:!!e.cenarioTeste,
    instalado_tecnico_id:e.instaladoTecnicoId||null, instalado_os:e.instaladoOS||null,
    instalado_desde:msToTs(e.instaladoDesde),
    operadora:e.operadora||null, numero_linha:e.numeroLinha||null,
    perdido:!!e.perdido, perdido_desde:msToTs(e.perdidoDesde), perdido_filial:e.perdidoFilial||null,
    perdido_usuario:e.perdidoUsuario||null, perdido_obs:e.perdidoObs||null
  };
}
function movimentacaoParaCamel(r){
  return { id:r.id, ts:tsToMs(r.ts), tipo:r.tipo, serie:r.serie, de:r.de, para:r.para,
    tecnicoId:r.tecnico_id, tecnicoIdOrigem:r.tecnico_id_origem, usuario:r.usuario,
    obs:r.obs, os:r.os, retiradaId:r.retirada_id, fotos:r.fotos||[], temFotosLocais:r.tem_fotos_locais };
}
function movimentacaoParaSnake(m){
  return { id:m.id, ts:msToTs(m.ts), tipo:m.tipo, serie:m.serie, de:m.de||null, para:m.para||null,
    tecnico_id:m.tecnicoId||null, tecnico_id_origem:m.tecnicoIdOrigem||null, usuario:m.usuario||null,
    obs:m.obs||null, os:m.os||null, retirada_id:m.retiradaId||null, fotos:m.fotos||[], tem_fotos_locais:!!m.temFotosLocais };
}
function auditoriaParaCamel(r){
  return { id:r.id, ts:tsToMs(r.ts), alvoTipo:r.alvo_tipo, alvoId:r.alvo_id, alvoNome:r.alvo_nome,
    auditor:r.auditor, esperados:r.esperados||[], conferidos:r.conferidos||[], faltando:r.faltando||[],
    sobrando:r.sobrando||[], obs:r.obs };
}
function auditoriaParaSnake(a){
  return { id:a.id, ts:msToTs(a.ts), alvo_tipo:a.alvoTipo, alvo_id:a.alvoId, alvo_nome:a.alvoNome||null,
    auditor:a.auditor||null, esperados:a.esperados||[], conferidos:a.conferidos||[], faltando:a.faltando||[],
    sobrando:a.sobrando||[], obs:a.obs||null };
}
function tecnicoParaSnake(t){ return { id:t.id, nome:t.nome, regiao:t.regiao||null, matricula:t.matricula||null }; }
function tipoParaSnake(codigo, t){ return { codigo, nome:t.nome, cor:t.cor||null, min_por_tecnico:t.min||0 }; }
function tiposArrayParaObjeto(rows){ const o={}; rows.forEach(r=>{ o[r.codigo]={nome:r.nome,cor:r.cor,min:r.min_por_tecnico}; }); return o; }
function configParaCamel(r){ return { usuario:r.usuario||'', importadoEm:tsToMs(r.importado_em), empresa:r.empresa||'A365', ultimoBackup:tsToMs(r.ultimo_backup) }; }
function configParaSnake(c){ return { usuario:c.usuario||null, importado_em:msToTs(c.importadoEm), empresa:c.empresa||'A365', ultimo_backup:msToTs(c.ultimoBackup) }; }
function usuarioParaCamel(r){ return { uid:r.id, email:r.email, nome:r.nome, papel:r.papel, regioes:r.regioes||[], tecnicoId:r.tecnico_id, criadoEm:tsToMs(r.criado_em) }; }

/* ---------- Login (Supabase Auth) ---------- */
let loginModo = 'entrar'; // ou 'criar'
function loginAlternar(){
  loginModo = loginModo==='entrar' ? 'criar' : 'entrar';
  const criar = loginModo==='criar';
  $('#loginSub').textContent = criar ? 'Crie sua conta com e-mail e senha' : 'Entre com seu e-mail e senha';
  $('#loginBtn').textContent = criar ? 'Criar conta' : 'Entrar';
  $('#loginAlternarLink').textContent = criar ? 'Já tenho conta' : 'Criar conta';
  // Só no cadastro mostramos a exigência de senha forte — quem já tem conta antiga
  // (senha de 6 dígitos, criada antes desta regra) não deve ser bloqueado ao entrar.
  const inp = $('#loginSenha'); if(inp) inp.placeholder = criar ? 'Mínimo 8 caracteres, com letras e números' : 'Sua senha';
  const hint = $('#loginSenhaHint'); if(hint) hint.style.display = criar ? 'block' : 'none';
  $('#loginErr').style.display='none';
}
// Força mínima da senha, exigida no CADASTRO (defesa em profundidade junto com a
// política do Supabase Auth no servidor). Não se aplica ao login de contas já existentes.
function validarForcaSenha(senha){
  if((senha||'').length < 8) return 'A senha precisa ter ao menos 8 caracteres.';
  if(!/[A-Za-z]/.test(senha) || !/[0-9]/.test(senha)) return 'A senha precisa ter letras e números.';
  return null;
}
function loginErro(msg){ const e=$('#loginErr'); e.textContent=msg; e.style.display='block'; }
function traduzirErroAuth(err){
  const code = (err&&err.code)||'';
  const msg = ((err&&err.message)||'').toLowerCase();
  if(code==='invalid_credentials'||msg.includes('invalid login credentials')) return 'E-mail ou senha incorretos.';
  if(code==='user_already_exists'||msg.includes('already registered')||msg.includes('already been registered')) return 'Já existe uma conta com esse e-mail. Clique em "Já tenho conta".';
  if(code==='weak_password'||msg.includes('password should be at least')) return 'A senha precisa ter ao menos 6 caracteres.';
  if(code==='validation_failed'||msg.includes('invalid format')||msg.includes('unable to validate email')) return 'E-mail inválido.';
  if(code==='over_email_send_rate_limit'||code==='over_request_rate_limit'||msg.includes('rate limit')) return 'Muitas tentativas. Aguarde um pouco e tente de novo.';
  if(msg.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar (verifique sua caixa de entrada).';
  if(!msg) return 'Erro desconhecido.';
  return 'Erro: '+(err&&err.message);
}
function loginSubmit(){
  const email = $('#loginEmail').value.trim();
  const senha = $('#loginSenha').value;
  if(!email||!senha) return loginErro('Preencha e-mail e senha.');
  if(loginModo==='criar'){
    const fraca = validarForcaSenha(senha);
    if(fraca) return loginErro(fraca);
  }
  $('#loginErr').style.display='none';
  const acao = loginModo==='entrar'
    ? sb.auth.signInWithPassword({ email, password:senha })
    : sb.auth.signUp({ email, password:senha });
  acao.then(({error})=>{ if(error) loginErro(traduzirErroAuth(error)); });
}
function loginEsqueciSenha(){
  const email = $('#loginEmail').value.trim();
  if(!email) return loginErro('Digite seu e-mail no campo acima e clique em "Esqueci minha senha" de novo.');
  $('#loginErr').style.display='none';
  sb.auth.resetPasswordForEmail(email).then(({error})=>{
    if(error) loginErro(traduzirErroAuth(error));
    else flash('Enviamos um link de redefinição de senha para '+email,'green');
  });
}
function logout(){ if(confirm('Sair da sua conta?')) sb.auth.signOut(); }

/* ---------- Perfis / hierarquia (admin, supervisor, técnico) ---------- */
let MEU_PERFIL = null; // {uid, email, nome, papel:'pendente'|'admin'|'supervisor'|'tecnico', regioes:[], tecnicoId}
let syncIniciado = false;
let perfilCanalAtivo = null;

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

async function carregarPerfil(user){
  const { data, error } = await sb.from('usuarios').select('*').eq('id', user.id).maybeSingle();
  if(error){
    // Falha de rede/servidor ao consultar o perfil — MUITO diferente de "o perfil não
    // existe ainda". Achado ao vivo (BUG-033): sem essa checagem, uma instabilidade
    // momentânea de conexão (ex.: wi-fi voltando) fazia até uma conta de ADMIN já
    // aprovada cair na tela "Aguardando aprovação", porque o código tratava "não
    // consegui perguntar ao banco" como "esse usuário é novo". Não mexe no MEU_PERFIL
    // atual (mantém a tela como estava) e só tenta de novo em alguns segundos.
    //
    // BUG-042: se esta é a PRIMEIRA tentativa da sessão (MEU_PERFIL ainda nulo — ex.:
    // app aberto offline, pelo PWA, com uma sessão já salva), nenhuma tela chega a
    // aparecer: onAuthStateChange já escondeu o login esperando aplicarPerfil(), que só
    // roda em caso de sucesso — sem essa consulta nunca completar offline, a tela fica
    // em branco pra sempre (nem login, nem app). Usa o último perfil salvo localmente
    // (se existir) pra abrir o app com os dados já sincronizados, mesmo sem rede.
    if(!MEU_PERFIL){
      const cache = lerPerfilCache(user.id);
      if(cache){ MEU_PERFIL = cache; aplicarPerfil(user); }
    }
    setTimeout(()=>carregarPerfil(user), 3000);
    return;
  }
  let linha = data;
  if(!linha){
    const ins = await sb.from('usuarios').insert({ id:user.id, email:user.email, nome:(user.email||'').split('@')[0], papel:'pendente' }).select().maybeSingle();
    if(ins.error){ setTimeout(()=>carregarPerfil(user), 3000); return; }
    linha = ins.data;
  }
  MEU_PERFIL = linha ? usuarioParaCamel(linha) : MEU_PERFIL;
  salvarPerfilCache(user.id, MEU_PERFIL);
  aplicarPerfil(user);
  if(perfilCanalAtivo) sb.removeChannel(perfilCanalAtivo);
  perfilCanalAtivo = sb.channel('perfil-'+user.id)
    .on('postgres_changes', { event:'*', schema:'public', table:'usuarios', filter:`id=eq.${user.id}` }, payload=>{
      MEU_PERFIL = payload.eventType==='DELETE' ? null : usuarioParaCamel(payload.new);
      aplicarPerfil(user);
    }).subscribe();
}

sb.auth.onAuthStateChange((event, session)=>{
  const user = session && session.user;
  if(user){
    $('#loginBg').style.display='none';
    $('#pendingBg').style.display='none';
    const chaveDoUsuario = STORE_KEY_BASE+'_'+user.id;
    if(STORE_KEY!==chaveDoUsuario){ STORE_KEY=chaveDoUsuario; DB=carregar(); ultimoSyncEquip=carregarUltimoSyncEquip(); invalidarConexaoRetiradasOffline(); }
    carregarPerfil(user);
  } else {
    if(perfilCanalAtivo){ sb.removeChannel(perfilCanalAtivo); perfilCanalAtivo=null; }
    if(cadastrosCanalAtivo){ sb.removeChannel(cadastrosCanalAtivo); cadastrosCanalAtivo=null; }
    MEU_PERFIL = null; syncIniciado=false; STORE_KEY=STORE_KEY_BASE; invalidarConexaoRetiradasOffline();
    equipsCarregados=false; movsCarregadas=false; audsCarregadas=false;
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

/* ---------- Sincronização em nuvem (Supabase: Postgres + Realtime) ---------- */
let aplicandoRemoto = false;
let salvarTimeout = null;
let movsCarregadas = false;
let audsCarregadas = false;
let equipsCarregados = false;
let ultimoSyncEquip = {};   // serie -> JSON string do último estado enviado/recebido da nuvem
let ultimoSyncTipos = {};   // codigo -> JSON string
let ultimoSyncFiliais = new Set();
let ultimoSyncTecnicos = {}; // id -> JSON string
let ultimoSyncConfigJson = null;
let cadastrosCanalAtivo = null; // canal único de tipos/filiais/técnicos/config/movimentações/auditorias/equipamentos

/* ---------- Fila de escrita offline ----------
   O Supabase não tem persistência/fila offline embutida como o
   enablePersistence() do Firestore. Decisão confirmada: fila própria
   no localStorage, só para o que não tem retry automático hoje —
   movimentações e auditorias são um INSERT puro, sem o mecanismo de
   diff que tipos/filiais/técnicos/equipamentos já têm (esses só marcam
   como "sincronizado" depois de confirmar sucesso — se falhar, a
   próxima chamada de salvar() já tenta de novo sozinha, sem precisar
   de fila; por isso não entram nessa fila, só precisam ser cutucados
   de novo quando a conexão voltar, o que já é feito abaixo). */
function filaOfflineKey(){ return STORE_KEY+'_fila_offline'; }
function lerFilaOffline(){
  try{ return JSON.parse(localStorage.getItem(filaOfflineKey())||'[]'); }catch(e){ return []; }
}
function gravarFilaOffline(fila){
  try{ localStorage.setItem(filaOfflineKey(), JSON.stringify(fila)); }catch(e){}
  atualizarIndicadorSincronizacao();
}
function enfileirarOffline(tipo, payload){
  const fila = lerFilaOffline();
  fila.push({ id:uid(), tipo, payload, criadoEm:Date.now() });
  gravarFilaOffline(fila);
}
// Distingue "sem conexão" (vale a pena guardar e tentar de novo depois) de um erro
// real do servidor (RLS, validação, chave estrangeira etc. — não adianta insistir).
// Erro de rede de verdade não vem com {code} do Postgres/PostgREST.
function pareceFalhaDeConexao(error){
  if(!navigator.onLine) return true;
  if(!error) return false;
  if(error.code) return false; // erro estruturado do Postgres/PostgREST — é real, não é rede
  const msg = (error.message||'').toLowerCase();
  return msg.includes('fetch')||msg.includes('network')||msg.includes('load failed')||!msg;
}
// Uma ÚNICA função escrevendo em #footSync, considerando as duas filas offline
// (movimentações/auditorias E retiradas em campo, ver bloco IndexedDB abaixo) — evita
// que uma sobrescreva a mensagem da outra no mesmo ciclo de reconexão (achado no
// planejamento do offline de retiradas, 17/07/2026). Fila de movimentações tem
// prioridade de exibição (é a mais antiga/geral); se ela estiver vazia mas houver
// retirada pendente, mostra a mensagem de retirada; só mostra "sincronizado" quando as
// duas estiverem vazias.
function atualizarIndicadorSincronizacao(){
  const foot = document.getElementById('footSync');
  if(!foot) return;
  const nFila = lerFilaOffline().length;
  const nRetiradas = seriesPendentesRetiradaOffline.size;
  if(nFila>0){
    foot.innerHTML = `${ic('alert-triangle')} ${nFila} alteração${nFila>1?'ões':''} salva${nFila>1?'s':''} só neste aparelho<br>Reconectando automaticamente...`;
  } else if(nRetiradas>0){
    foot.innerHTML = `${ic('alert-triangle')} ${nRetiradas} ite${nRetiradas>1?'ns':'m'} de retirada salvo${nRetiradas>1?'s':''} só neste aparelho<br>Reconectando automaticamente...`;
  } else {
    foot.innerHTML = 'Sincronizado com a nuvem '+ic('cloud')+'<br>Faça backup em <b>Dados</b>.';
  }
}
async function tentarEsvaziarFilaOffline(){
  // Guarda pra não tentar sincronizar nada antes do login resolver, ou com conta
  // ainda pendente — o listener 'online' e o timer rodam o tempo todo, inclusive
  // na tela de login/aguardando aprovação, onde não há sessão válida pra escrever.
  if(!navigator.onLine || !MEU_PERFIL || MEU_PERFIL.papel==='pendente') return;
  const fila = lerFilaOffline();
  if(fila.length){
    const restantes = [];
    for(const item of fila){
      try{
        let error = null;
        if(item.tipo==='movimentacao') ({error} = await sb.from('movimentacoes').insert(item.payload));
        else if(item.tipo==='auditoria') ({error} = await sb.from('auditorias').insert(item.payload));
        if(error){
          if(pareceFalhaDeConexao(error)) restantes.push(item);
          else flash('Um item da fila offline falhou de vez (não é falta de conexão): '+error.message,'red');
        }
      }catch(e){ restantes.push(item); }
    }
    gravarFilaOffline(restantes);
    if(!restantes.length) flash(''+fila.length+' alteração(ões) pendente(s) sincronizada(s)','green');
  }
  // aproveita a conexão de volta pra também re-tentar tipos/filiais/técnicos/config/
  // equipamentos — o próprio mecanismo de diff dessas funções só reenvia o que ainda
  // não foi confirmado, então chamar de novo aqui é seguro mesmo sem nada pendente.
  sincronizarTipos().catch(()=>{});
  sincronizarFiliais().catch(()=>{});
  sincronizarTecnicos().catch(()=>{});
  sincronizarConfig().catch(()=>{});
  persistirEquipamentos();
  // Drena também a fila de "Registrar retirada em campo" (bloco IndexedDB logo abaixo)
  // no mesmo gatilho — evita registrar um segundo listener/timer de polling.
  await tentarEsvaziarFilaRetiradas().catch(()=>{});
  atualizarIndicadorSincronizacao();
}
window.addEventListener('online', tentarEsvaziarFilaOffline);
setInterval(()=>{ if(navigator.onLine) tentarEsvaziarFilaOffline(); }, 30000);

/* =========================================================
   FILA OFFLINE DE "REGISTRAR RETIRADA EM CAMPO" (IndexedDB) — plano offline,
   17/07/2026. A fila acima (localStorage) só serve INSERT simples em
   movimentacoes/auditorias; retirada em campo depende de DUAS RPCs privilegiadas
   (registrar_retirada_campo, e o código agora é gerado localmente — ver
   gerarCodigoRetiradaLocal) e de upload de fotos (binário — localStorage não serve,
   por isso IndexedDB). Banco FISICAMENTE SEPARADO por conta (mesmo espírito do
   BUG-020, levado ao extremo: em vez de filtrar registros por uid dentro de um banco
   compartilhado, cada conta abre o seu próprio banco IndexedDB).
   ========================================================= */
let _dbRetiradasOfflineConn = null;
let _dbRetiradasOfflineStoreKey = null; // detecta troca de conta (ver os 2 pontos que reatribuem STORE_KEY)
function dbRetiradasOfflineNome(){ return STORE_KEY+'_retiradas_offline_db'; }
function invalidarConexaoRetiradasOffline(){ _dbRetiradasOfflineConn = null; _dbRetiradasOfflineStoreKey = null; }
function abrirDbRetiradasOffline(){
  if(_dbRetiradasOfflineConn && _dbRetiradasOfflineStoreKey===STORE_KEY) return Promise.resolve(_dbRetiradasOfflineConn);
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(dbRetiradasOfflineNome(), 1);
    req.onupgradeneeded = ()=>{ if(!req.result.objectStoreNames.contains('pendentes')) req.result.createObjectStore('pendentes', {keyPath:'codigo'}); };
    req.onsuccess = ()=>{ _dbRetiradasOfflineConn = req.result; _dbRetiradasOfflineStoreKey = STORE_KEY; resolve(req.result); };
    req.onerror = ()=>reject(req.error);
  });
}
async function salvarRetiradaOffline(registro){
  const db = await abrirDbRetiradasOffline();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('pendentes','readwrite');
    tx.objectStore('pendentes').put(registro);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  });
}
async function listarRetiradasOffline(){
  const db = await abrirDbRetiradasOffline();
  return new Promise((resolve, reject)=>{
    const req = db.transaction('pendentes','readonly').objectStore('pendentes').getAll();
    req.onsuccess = ()=>resolve(req.result||[]);
    req.onerror = ()=>reject(req.error);
  });
}
// Read-modify-write — evita corrida entre a drenagem (rodando em background) e um
// registro novo sendo criado ao mesmo tempo. `mutador(atual)` devolve o registro
// atualizado, ou null/undefined pra remover o registro inteiro (todos os itens já
// concluídos/descartados).
async function atualizarRetiradaOffline(codigo, mutador){
  const db = await abrirDbRetiradasOffline();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('pendentes','readwrite');
    const store = tx.objectStore('pendentes');
    const req = store.get(codigo);
    req.onsuccess = ()=>{
      const atual = req.result;
      if(!atual){ resolve(null); return; }
      const novo = mutador(atual);
      if(novo) store.put(novo); else store.delete(codigo);
      tx.oncomplete = ()=>resolve(novo||null);
      tx.onerror = ()=>reject(tx.error);
    };
    req.onerror = ()=>reject(req.error);
  });
}
async function removerRetiradaOffline(codigo){
  const db = await abrirDbRetiradasOffline();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('pendentes','readwrite');
    tx.objectStore('pendentes').delete(codigo);
    tx.oncomplete = ()=>resolve();
    tx.onerror = ()=>reject(tx.error);
  });
}

// Conjunto de séries com retirada pendente de sincronizar — consultado de forma
// SÍNCRONA dentro de sincronizarEquipamentos() (não dá pra esperar o IndexedDB abrir
// no meio do diff-sync), por isso vive em memória com espelho em localStorage (mesma
// convenção de filaOfflineKey), reconstruído a partir do IndexedDB (fonte da verdade)
// uma vez no boot via carregarRetiradasOfflinePendentes().
let seriesPendentesRetiradaOffline = new Set();
function chaveSeriesPendentesRetirada(){ return STORE_KEY+'_series_pendentes_retirada'; }
function salvarSeriesPendentesRetiradaLocalStorage(){
  try{ localStorage.setItem(chaveSeriesPendentesRetirada(), JSON.stringify([...seriesPendentesRetiradaOffline])); }catch(e){}
}
function carregarSeriesPendentesRetiradaLocalStorage(){
  try{ const r = localStorage.getItem(chaveSeriesPendentesRetirada()); return r? new Set(JSON.parse(r)) : new Set(); }catch(e){ return new Set(); }
}
function marcarSeriePendenteRetiradaOffline(serie){ seriesPendentesRetiradaOffline.add(serie); salvarSeriesPendentesRetiradaLocalStorage(); }
function desmarcarSeriePendenteRetiradaOffline(serie){ seriesPendentesRetiradaOffline.delete(serie); salvarSeriesPendentesRetiradaLocalStorage(); }
function serieEstaPendenteRetiradaOffline(serie){ return seriesPendentesRetiradaOffline.has(serie); }

// Chamada uma vez no boot (iniciarSyncNuvem) — recupera do localStorage na hora
// (síncrono, disponível de imediato) e depois reconstrói com precisão total a partir
// do IndexedDB (que é a fonte da verdade; localStorage é só um cache rápido dele).
async function carregarRetiradasOfflinePendentes(){
  seriesPendentesRetiradaOffline = carregarSeriesPendentesRetiradaLocalStorage();
  try{
    const registros = await listarRetiradasOffline();
    const seriesReal = new Set();
    registros.forEach(r=> (r.itens||[]).forEach(it=>{ if(it.status==='pendente'||it.status==='erro'||it.status==='conflito') seriesReal.add(it.serie); }));
    seriesPendentesRetiradaOffline = seriesReal;
    salvarSeriesPendentesRetiradaLocalStorage();
  }catch(e){ /* IndexedDB pode falhar (modo privado, quota etc.) — mantém o que veio do localStorage */ }
  atualizarIndicadorSincronizacao();
}

// Compara o estado do equipamento no momento em que o técnico registrou a retirada
// OFFLINE (snapshotAntes, capturado localmente na hora) contra o estado REAL atual do
// servidor — se algo relevante mudou por causa de OUTRA PESSOA nesse meio tempo, é
// conflito e não deve ser aplicado silenciosamente (decisão explícita do usuário: nunca
// aplicar sem confirmação). meuTecnicoId identifica "eu mesmo" pra não acusar conflito
// quando o dono atual já sou eu (ex.: outra sessão/aba já sincronizou esse item).
function detectarConflitoRetiradaOffline(snapshotAntes, atual, meuTecnicoId){
  if(atual && atual.tecnicoId===meuTecnicoId && atual.status==='com_tecnico') return null; // já é meu, sem conflito
  if(!snapshotAntes){
    // Técnico achou que era item NOVO (nunca visto antes, offline) — se o servidor já
    // tem esse item, é porque OUTRO técnico também o registrou enquanto os dois
    // estavam offline (o cenário de "dois técnicos offline ao mesmo tempo" aplicado à
    // reivindicação do equipamento, não só ao código).
    return atual ? { motivo:'item_novo_ja_existe', atual } : null;
  }
  if(!atual) return { motivo:'item_sumiu_do_servidor', atual:null }; // excluído por alguém nesse meio tempo
  const mudouDono = atual.tecnicoId !== snapshotAntes.tecnicoId;
  const mudouStatus = atual.status !== snapshotAntes.status;
  if(mudouDono || mudouStatus) return { motivo:'estado_mudou', atual };
  return null;
}

// Drenagem da fila de retiradas — chamada de dentro de tentarEsvaziarFilaOffline()
// (mesmo gatilho: evento 'online' + timer de 30s), sem registrar um segundo listener.
// Por item PENDENTE (nunca mexe em item já 'conflito' — esses só avançam pela tela de
// revisão, ver abrirRetiradasOfflinePendentes): busca o estado autoritativo do
// servidor, checa conflito, e só chama a RPC de verdade se não houver conflito.
async function tentarEsvaziarFilaRetiradas(){
  if(!navigator.onLine || !MEU_PERFIL || MEU_PERFIL.papel==='pendente') return;
  let registros;
  try{ registros = await listarRetiradasOffline(); }catch(e){ return; } // IndexedDB indisponível — desiste silenciosamente, tenta no próximo ciclo
  for(const registro of registros){
    let mudou = false;
    for(const item of registro.itens){
      if(item.status!=='pendente' && item.status!=='erro') continue; // 'conflito'/'concluido' não avançam aqui
      let atual = null;
      try{ const { data } = await sb.from('equipamentos').select('*').eq('serie', item.serie).maybeSingle(); atual = data ? equipamentoParaCamel(data) : null; }
      catch(e){ continue; } // sem conexão de verdade agora — tenta de novo no próximo ciclo
      const conflito = detectarConflitoRetiradaOffline(item.snapshotAntes, atual, registro.tecnicoId);
      if(conflito){ item.status='conflito'; item.conflito=conflito; mudou=true; continue; }
      // Sobe fotos do registro ainda pendentes (se houver) antes de tentar a RPC —
      // mesmo array de caminhos é repassado pra cada item do lote, como no caminho online.
      if(registro.fotos && registro.fotos.some(f=>f.status==='pendente')){
        const pendentesAgora = registro.fotos.filter(f=>f.status==='pendente');
        const resultadoFotos = await enviarFotosPreparadas(registro.tecnicoId, registro.codigo, pendentesAgora);
        registro.fotosCaminhosEnviados = [...(registro.fotosCaminhosEnviados||[]), ...resultadoFotos.caminhos];
        const idsSobra = new Set(resultadoFotos.sobra.map(f=>f.idLocal));
        const idsFalha = new Set(resultadoFotos.falhas||[]);
        registro.fotos = registro.fotos.map(f=>{
          if(f.status!=='pendente') return f;
          if(idsSobra.has(f.idLocal)) return f; // segue pendente, tenta de novo no próximo ciclo
          if(idsFalha.has(f.idLocal)) return {...f, status:'erro'}; // falha real, desiste dessa foto
          return {...f, status:'enviada'};
        });
        mudou = true;
      }
      const t = DB.tecnicos.find(x=>x.id===registro.tecnicoId) || { id:registro.tecnicoId, nome:registro.tecnicoNome, regiao:'' };
      const para = tecNome(registro.tecnicoId);
      const resultado = await registrarItemRetiradaNoServidor({
        serie:item.serie, tipoNovo:item.tipoNovo, de:item.de, para,
        obsCombinada:registro.obs, codigoRetirada:registro.codigo,
        fotosCaminhos: registro.fotosCaminhosEnviados||[], tecnicoObj:t,
        idLocalMovimentacao:item.idLocalMovimentacao
      });
      if(resultado.ok){ item.status='concluido'; item.movimentacaoIdServidor=resultado.movimentacaoIdServidor; mudou=true; }
      else if(!resultado.conexao){ item.status='erro'; mudou=true; }
      // se foi falha de conexão, deixa 'pendente' — tenta de novo no próximo ciclo
    }
    if(mudou){
      const todosItensResolvidos = registro.itens.every(it=>it.status==='concluido');
      const todasFotosResolvidas = !registro.fotos || registro.fotos.every(f=>f.status==='enviada'||f.status==='erro');
      await atualizarRetiradaOffline(registro.codigo, ()=> (todosItensResolvidos&&todasFotosResolvidas) ? null : registro);
      salvar(); render();
    }
  }
}

/* =========================================================
   TELEMETRIA DE ERROS — window.onerror/unhandledrejection gravam num log
   no Supabase (tabela erros, só admin lê). Existe porque um técnico em campo,
   ao ver um erro, normalmente só fecha o app e tenta de novo — sem isso, o
   problema fica invisível pra quem mantém o sistema.
   ========================================================= */
const ERROS_JA_ENVIADOS = new Set(); // mesma mensagem+origem só é enviada 1x por sessão (evita floodar em loop)
const ERROS_LIMITE_POR_SESSAO = 20;  // teto de segurança pra sessão que erra em massa não virar spam de INSERT
let errosEnviadosNestaSessao = 0;
function registrarErroCliente(mensagem, origem, stack){
  try{
    if(!window.sb || errosEnviadosNestaSessao>=ERROS_LIMITE_POR_SESSAO) return;
    const chave = (mensagem||'')+'|'+(origem||'');
    if(ERROS_JA_ENVIADOS.has(chave)) return;
    ERROS_JA_ENVIADOS.add(chave); errosEnviadosNestaSessao++;
    sb.from('erros').insert({
      mensagem: String(mensagem||'').slice(0,2000),
      origem: origem? String(origem).slice(0,500) : null,
      stack: stack? String(stack).slice(0,4000) : null,
      tela: typeof PAGE!=='undefined'? PAGE : null,
      usuario_id: MEU_PERFIL? MEU_PERFIL.uid : null,
      usuario_email: MEU_PERFIL? MEU_PERFIL.email : null,
      papel: MEU_PERFIL? MEU_PERFIL.papel : null,
      tecnico_id: MEU_PERFIL? (MEU_PERFIL.tecnicoId||null) : null,
      user_agent: navigator.userAgent,
    }).then(()=>{}).catch(()=>{}); // best-effort — sem fila offline aqui, é telemetria, não dado de negócio
  }catch(e){ /* telemetria nunca pode gerar outro erro nem quebrar o app */ }
}
window.addEventListener('error', e=>{
  registrarErroCliente(e.message, (e.filename||'')+':'+(e.lineno||'')+':'+(e.colno||''), e.error&&e.error.stack);
});
window.addEventListener('unhandledrejection', e=>{
  const r = e.reason;
  registrarErroCliente(r&&r.message? r.message : String(r), 'promise', r&&r.stack);
});

function registrarMovimentacao(m){
  DB.movimentacoes.push(m);
  const payload = movimentacaoParaSnake(m);
  sb.from('movimentacoes').insert(payload).then(({error})=>{
    if(!error) return;
    if(pareceFalhaDeConexao(error)) enfileirarOffline('movimentacao', payload);
    else flash('Falha ao salvar movimentação: '+error.message,'red');
  }).catch(()=>{ enfileirarOffline('movimentacao', payload); });
}
function registrarAuditoria(a){
  DB.auditorias.push(a);
  const payload = auditoriaParaSnake(a);
  sb.from('auditorias').insert(payload).then(({error})=>{
    if(!error) return;
    if(pareceFalhaDeConexao(error)) enfileirarOffline('auditoria', payload);
    else flash('Falha ao salvar auditoria: '+error.message,'red');
  }).catch(()=>{ enfileirarOffline('auditoria', payload); });
}

// IMPORTANTE (endurecimento pós-BUG-034): esta função NUNCA apaga linha no banco.
// A versão anterior tratava "série sumiu do array local" como "usuário excluiu de
// propósito" e mandava DELETE da diferença — foi exatamente esse mecanismo que, com
// um array truncado pelo limite de 1000 linhas do PostgREST, apagou ~1000 equipamentos
// reais em silêncio (BUG-034). A paginação corrigiu aquele gatilho, mas o mecanismo em
// si continuava armado: QUALQUER bug futuro que encurtasse o array local viraria
// exclusão em massa no banco. Agora exclusão só acontece por ação explícita
// (excluirEquipamentosNoBanco, chamada por excluirEquip/importação com substituição/
// restauração de backup) — a sincronização só grava criações e alterações.
async function sincronizarEquipamentos(){
  let alterados = DB.equipamentos.filter(e=>ultimoSyncEquip[e.serie]!==JSON.stringify(e));
  // Defense-in-depth (BUG-043): o técnico só pode GRAVAR equipamentos que já são dele
  // (tecnico_id=meu) ou que ele mesmo mandou pra RMA (baixado + rma_tecnico_id=meu) — a
  // política de INSERT do banco rejeita qualquer outro caso. Um item apenas EM TRÂNSITO
  // pra ele (transito_para=meu, mas ainda não confirmado) NÃO é gravável pelo técnico
  // (o item ainda "pertence" ao remetente até a confirmação, que é um UPDATE legítimo à
  // parte). Sem este filtro, se um item em trânsito entrasse no lote (ex.: ultimoSyncEquip
  // vazio ao abrir offline), o upsert do lote inteiro violava a RLS e NADA era salvo.
  if(souTecnico()){
    const meuId = MEU_PERFIL.tecnicoId;
    // As 3 exceções espelham exatamente a política de INSERT/UPDATE do banco:
    // meu, baixado-por-mim (RMA), ou instalado-por-mim (uso em campo).
    alterados = alterados.filter(e=> e.tecnicoId===meuId
      || (e.status==='baixado' && e.rmaTecnicoId===meuId)
      || (e.status==='instalado' && e.instaladoTecnicoId===meuId));
  }
  // Plano offline de retiradas (17/07/2026): um item com retirada offline PENDENTE já
  // foi mutado localmente pra tecnicoId=meu (otimista, antes da RPC ter rodado de
  // verdade) — sem esta exclusão, este mesmo diff-sync tentaria um upsert direto que a
  // RLS rejeitaria (só a RPC privilegiada pode reivindicar item que ainda não é meu no
  // servidor). Quando a RPC concluir de verdade no drain, a série sai do Set e o
  // próximo diff-sync (se rodar de novo) já encontra tecnico_id real — idempotente.
  alterados = alterados.filter(e=> !serieEstaPendenteRetiradaOffline(e.serie));
  if(!alterados.length) return;
  try{
    for(let i=0;i<alterados.length;i+=500){
      const lote = alterados.slice(i,i+500).map(equipamentoParaSnake);
      const { error } = await sb.from('equipamentos').upsert(lote, { onConflict:'serie' });
      if(error) throw error;
    }
    alterados.forEach(e=>{ ultimoSyncEquip[e.serie]=JSON.stringify(e); });
    salvarLocal(); // persiste o rastro atualizado (ver salvarLocal/BUG-043)
  }catch(e){
    // Não marcamos nada como sincronizado acima quando falha, então a própria
    // próxima chamada (por ação do usuário, pelo listener 'online' ou pelo timer
    // de 30s) já tenta reenviar sozinha — não precisa de fila explícita aqui.
    if(pareceFalhaDeConexao(e)) atualizarIndicadorSincronizacao();
    else flash('Falha ao sincronizar equipamentos: '+e.message,'red');
  }
}
// Exclusão EXPLÍCITA de equipamentos no banco — o único caminho que apaga linhas.
// Usada por: excluirEquip() (1 item), importação com "substituir" (lote) e
// importarBackup() (substituição total usa delete direto). Remove também do
// rastro de sincronização (ultimoSyncEquip) pra não deixar entrada órfã.
async function excluirEquipamentosNoBanco(series){
  for(let i=0;i<series.length;i+=500){
    const { error } = await sb.from('equipamentos').delete().in('serie', series.slice(i,i+500));
    if(error) throw error;
  }
  series.forEach(s=>{ delete ultimoSyncEquip[s]; });
}
function persistirEquipamentos(){
  // Nunca sincroniza antes da carga inicial de equipamentos terminar de verdade —
  // sem essa guarda, um salvar() disparado logo no início (ex.: verificarBackupAutomatico())
  // usaria o DB.equipamentos ainda desatualizado do localStorage (de antes da página
  // carregar) contra um ultimoSyncEquip vazio, e trataria tudo como "alterado", causando
  // um upsert em massa desnecessário logo na carga da página (risco irmão do BUG-034).
  // (A antiga sincronizarEquipamentosTecnico() foi fundida na sincronizarEquipamentos():
  // as duas ficaram idênticas quando a versão geral também deixou de inferir exclusões.)
  if(!equipsCarregados) return;
  sincronizarEquipamentos();
}
async function acharEquipPorSerieAsync(serie){
  const local = acharEquipPorSerie(serie);
  if(local) return local;
  try{
    const { data } = await sb.from('equipamentos').select('*').eq('serie', serie).maybeSingle();
    return data ? equipamentoParaCamel(data) : null;
  }catch(e){ return null; }
}
// O PostgREST limita a 1000 linhas por padrão numa única resposta — uma consulta
// "select tudo" sem paginação vinha TRUNCADA em silêncio (sem erro, sem aviso),
// e pra equipamentos isso é catastrófico: sincronizarEquipamentos() trata "sumiu
// do array local" como "foi excluído de propósito" e apaga a diferença no banco de
// verdade. Achado ao vivo com ~5 mil equipamentos de teste — apagou ~1000 itens
// reais sem nenhum erro visível (ver BUG-034). Toda consulta que pode passar de
// 1000 linhas tem que usar esta função, nunca um select('*') direto.
async function selecionarTudo(tabela, configurar){
  // Achado ao vivo (10/07/2026): sem checagem de conexão, um técnico totalmente
  // offline (modo avião) esperava o fetch() de verdade FALHAR (~7s por chamada) antes
  // de cair no cache local — e como o app.js chama isso várias vezes em sequência
  // (tipos/filiais/técnicos, depois movimentações, depois auditorias, depois
  // equipamentos), o total passava de 25-30s parado na tela de "Carregando...", tempo
  // suficiente pra parecer travado de vez. navigator.onLine é confiável especificamente
  // pra "não existe nenhuma interface de rede" (avião, sem SIM, wi-fi desligado) — não
  // garante que a internet FUNCIONA (podia estar conectado num wi-fi sem saída), mas
  // cobre exatamente o cenário mais comum de técnico em campo sem sinal.
  if(!navigator.onLine) throw new Error('Sem conexão (offline)');
  // Usa count:'exact' (o total real, via Content-Range do PostgREST) pra decidir
  // quando parar — em vez de só comparar "voltou menos que 1000 = acabou", que
  // seria frágil se o servidor um dia limitar menos que 1000 por página: nesse
  // caso uma página parcial NÃO significa "isso é tudo", e comparar só o tamanho
  // reintroduziria exatamente o mesmo risco do BUG-034.
  const PAGINA = 1000;
  let todos = [];
  let offset = 0;
  while(true){
    let q = sb.from(tabela).select('*', { count:'exact' });
    if(configurar) q = configurar(q);
    const { data, error, count } = await q.range(offset, offset+PAGINA-1);
    if(error) throw error;
    if(!data || !data.length) break;
    todos = todos.concat(data);
    offset += data.length;
    if(count!=null && todos.length>=count) break;
  }
  return todos;
}

// IMPORTANTE (BUG-052, mesmo endurecimento pós-BUG-034 já aplicado em
// sincronizarEquipamentos()): as 3 funções abaixo NUNCA apagam linha no banco. Elas
// tratavam "código/sigla/id sumiu do array local" como "usuário excluiu de propósito" e
// mandavam DELETE da diferença — exatamente o mecanismo que, numa importação pesada de
// equipamentos (que dispara muitos eventos de tempo real na mesma conexão), causou uma
// tentativa de apagar um técnico que ainda tinha movimentação no histórico (nunca foi
// excluído de propósito) e travou com "violates foreign key constraint
// movimentacoes_tecnico_id_fkey" — o Postgres protegeu o dado corretamente, mas o
// cliente nem deveria ter tentado apagar. Agora a sincronização só grava criações e
// alterações; exclusão só acontece por ação explícita (excluirTec()/excluirFilial()/
// corrigirTiposDuplicados(), cada uma chamando o delete direto e com guarda própria).
async function sincronizarTipos(){
  const codigos = Object.keys(DB.tipos);
  const alterados = [];
  codigos.forEach(cod=>{
    const row = tipoParaSnake(cod, DB.tipos[cod]);
    const json = JSON.stringify(row);
    if(ultimoSyncTipos[cod]!==json) alterados.push(row);
  });
  if(alterados.length){
    const { error } = await sb.from('tipos').upsert(alterados, { onConflict:'codigo' });
    if(error) throw error;
  }
  alterados.forEach(r=>{ ultimoSyncTipos[r.codigo]=JSON.stringify(r); });
}
async function sincronizarFiliais(){
  // Usa todasFiliaisConhecidas() (DB.filiais + deposito de equipamentos + regiao de
  // técnicos), não só DB.filiais — o app sempre permitiu referenciar uma filial só por
  // ela aparecer num equipamento/técnico importado, sem precisar "cadastrar" antes.
  // Sem isso, importar equipamento com depósito novo falha por causa da FK (ver BUG-030).
  const atuais = new Set(todasFiliaisConhecidas());
  const novas = [...atuais].filter(f=>!ultimoSyncFiliais.has(f));
  if(novas.length){
    const { error } = await sb.from('filiais').upsert(novas.map(sigla=>({sigla})), { onConflict:'sigla' });
    if(error) throw error;
  }
  ultimoSyncFiliais = new Set([...ultimoSyncFiliais, ...atuais]); // só cresce — nunca esquece uma filial já sincronizada
}
async function sincronizarTecnicos(){
  const alterados = DB.tecnicos.filter(t=>ultimoSyncTecnicos[t.id]!==JSON.stringify(t));
  if(alterados.length){
    const { error } = await sb.from('tecnicos').upsert(alterados.map(tecnicoParaSnake), { onConflict:'id' });
    if(error) throw error;
  }
  alterados.forEach(t=>{ ultimoSyncTecnicos[t.id]=JSON.stringify(t); });
}
async function sincronizarConfig(){
  const json = JSON.stringify(DB.config);
  if(ultimoSyncConfigJson===json) return;
  const { error } = await sb.from('config').update(configParaSnake(DB.config)).eq('id', true);
  if(error) throw error;
  ultimoSyncConfigJson = json;
}

function salvar(){
  salvarLocal();
  if(aplicandoRemoto) return;
  clearTimeout(salvarTimeout);
  salvarTimeout = setTimeout(async ()=>{
    // tipos/filiais/tecnicos precisam terminar ANTES de mexer em equipamentos: a tabela
    // equipamentos tem chave estrangeira pra tipos.codigo/filiais.sigla/tecnicos.id, então
    // gravar um equipamento com um tipo/filial/técnico novo antes desses existirem no banco
    // falha com "violates foreign key constraint" (achado ao vivo, ver BUG-030).
    const resultados = await Promise.allSettled([
      sincronizarTipos(), sincronizarFiliais(), sincronizarTecnicos(), sincronizarConfig()
    ]);
    let semConexao = false;
    resultados.forEach(r=>{
      if(r.status!=='rejected') return;
      if(pareceFalhaDeConexao(r.reason)) semConexao = true;
      else flash('Falha ao sincronizar: '+r.reason.message,'red');
    });
    if(semConexao) atualizarIndicadorSincronizacao(); // sem fila explícita aqui — a próxima chamada (ação, 'online' ou timer) já reenvia sozinha
    persistirEquipamentos();
  }, 400);
}

async function iniciarSyncNuvem(){
  const foot = document.getElementById('footSync');
  try{
    const [tiposLista, filiaisLista, tecnicosLista, configRes] = await Promise.all([
      selecionarTudo('tipos'),
      selecionarTudo('filiais'),
      selecionarTudo('tecnicos'),
      sb.from('config').select('*').eq('id', true).maybeSingle()
    ]);
    aplicandoRemoto = true;
    DB.tipos = tiposArrayParaObjeto(tiposLista);
    DB.filiais = filiaisLista.map(r=>r.sigla);
    DB.tecnicos = tecnicosLista.map(r=>({ id:r.id, nome:r.nome, regiao:r.regiao, matricula:r.matricula }));
    DB.config = configRes.data ? configParaCamel(configRes.data) : DB.config;
    ultimoSyncTipos = {}; tiposLista.forEach(r=>{ ultimoSyncTipos[r.codigo]=JSON.stringify(r); });
    ultimoSyncFiliais = new Set(DB.filiais);
    ultimoSyncTecnicos = {}; DB.tecnicos.forEach(t=>{ ultimoSyncTecnicos[t.id]=JSON.stringify(t); });
    ultimoSyncConfigJson = JSON.stringify(DB.config);
    salvarLocal();
    aplicandoRemoto = false;
    if(foot) foot.innerHTML = 'Sincronizado com a nuvem '+ic('cloud')+'<br>Faça backup em <b>Dados</b>.';
    renderNav(); render();
    verificarBackupAutomatico();
  }catch(err){
    if(foot) foot.innerHTML = ic('alert-triangle')+' Sem conexão com a nuvem<br>Usando dados locais.';
    flash('Erro de sincronização: '+err.message,'red');
  }
  // mostra na hora se sobrou algo da fila offline de uma sessão anterior, e já tenta
  // esvaziar (não faz nada se ainda estiver sem conexão).
  atualizarIndicadorSincronizacao();
  carregarRetiradasOfflinePendentes().catch(()=>{});
  tentarEsvaziarFilaOffline();

  // movimentações/auditorias: log append-only — carga inicial ordenada + só acrescenta no INSERT.
  // BUG-042 (continuação): cada uma tem seu próprio try/catch — sem isso, uma falha aqui
  // (ex.: offline) derrubava a função inteira sem tratamento, e nem chegava a chamar
  // iniciarListenerEquipamentos() logo abaixo, deixando a tela presa em "Carregando..."
  // mesmo com a correção feita lá (o código nunca era alcançado).
  try{
    DB.movimentacoes = (await selecionarTudo('movimentacoes', q=>q.order('ts',{ascending:true}))).map(movimentacaoParaCamel);
    salvarLocal();
  }catch(err){ /* offline: mantém o que já tinha no cache local (carregado no início do arquivo) */ }
  movsCarregadas = true; render();
  try{
    DB.auditorias = (await selecionarTudo('auditorias', q=>q.order('ts',{ascending:true}))).map(auditoriaParaCamel);
    salvarLocal();
  }catch(err){ /* offline: mantém o que já tinha no cache local */ }
  audsCarregadas = true; render();

  // Tempo real: tipos/filiais/técnicos/config/movimentações/auditorias iam cada um num
  // canal (WebSocket) próprio — com 63 usuários isso sozinho já chegava perto do limite
  // de 200 conexões simultâneas do plano gratuito do Supabase. Um único canal aceita
  // vários `.on('postgres_changes', ...)` encadeados (cada um com seu próprio filtro de
  // tabela/evento), então as 6 assinaturas abaixo agora dividem 1 conexão só.
  if(cadastrosCanalAtivo) sb.removeChannel(cadastrosCanalAtivo);
  cadastrosCanalAtivo = sb.channel('cadastros-rt')
    .on('postgres_changes', {event:'*',schema:'public',table:'tipos'}, async()=>{
      const data = await selecionarTudo('tipos');
      DB.tipos = tiposArrayParaObjeto(data);
      ultimoSyncTipos = {}; data.forEach(r=>{ ultimoSyncTipos[r.codigo]=JSON.stringify(r); });
      salvarLocal(); render();
    })
    .on('postgres_changes', {event:'*',schema:'public',table:'filiais'}, async()=>{
      const data = await selecionarTudo('filiais');
      DB.filiais = data.map(r=>r.sigla);
      ultimoSyncFiliais = new Set(DB.filiais);
      salvarLocal(); render();
    })
    .on('postgres_changes', {event:'*',schema:'public',table:'tecnicos'}, async()=>{
      const data = await selecionarTudo('tecnicos');
      DB.tecnicos = data.map(r=>({ id:r.id, nome:r.nome, regiao:r.regiao, matricula:r.matricula }));
      ultimoSyncTecnicos = {}; DB.tecnicos.forEach(t=>{ ultimoSyncTecnicos[t.id]=JSON.stringify(t); });
      salvarLocal(); render();
    })
    .on('postgres_changes', {event:'*',schema:'public',table:'config'}, async()=>{
      const { data } = await sb.from('config').select('*').eq('id', true).maybeSingle();
      if(data){ DB.config = configParaCamel(data); ultimoSyncConfigJson = JSON.stringify(DB.config); salvarLocal(); render(); }
    })
    .on('postgres_changes', {event:'INSERT',schema:'public',table:'movimentacoes'}, payload=>{
      const m = movimentacaoParaCamel(payload.new);
      if(!DB.movimentacoes.some(x=>x.id===m.id)){ DB.movimentacoes.push(m); salvarLocal(); if(movsCarregadas) render(); }
    })
    .on('postgres_changes', {event:'INSERT',schema:'public',table:'auditorias'}, payload=>{
      const a = auditoriaParaCamel(payload.new);
      if(!DB.auditorias.some(x=>x.id===a.id)){ DB.auditorias.push(a); salvarLocal(); if(audsCarregadas) render(); }
    });
  // BUG-047: empurra ANTES de puxar. Se o usuário mexeu em equipamentos offline (RMA,
  // uso em campo) e fechou o app antes de reconectar, o diff pendente fica só no cache
  // local (ultimoSyncEquip carregado do localStorage já reflete isso). Sem este push,
  // iniciarListenerEquipamentos() logo abaixo busca a lista FRESCA do servidor e
  // SOBRESCREVE DB.equipamentos + reconstrói ultimoSyncEquip a partir dela — como o
  // servidor ainda tem o estado antigo, a mudança pendente é descartada em silêncio
  // (o item "volta" pro estoque do técnico) mesmo já tendo sido feita de verdade.
  // sincronizarEquipamentos() nunca lança (tem try/catch próprio), e é sempre seguro
  // chamar aqui mesmo sem nada pendente (upsert vazio ou não faz nada).
  await sincronizarEquipamentos();
  // iniciarListenerEquipamentos() encadeia mais 1-2 .on() no MESMO cadastrosCanalAtivo
  // (equipamentos também divide essa conexão) — por isso o .subscribe() só acontece
  // depois dela, nunca antes: todo listener precisa estar registrado antes de assinar.
  iniciarListenerEquipamentos(cadastrosCanalAtivo);
  cadastrosCanalAtivo.subscribe();
}
let equipsOwnMap = {}, equipsIncomingMap = {};
function mesclarEquipamentosTecnico(){
  const combinados = Object.assign({}, equipsOwnMap, equipsIncomingMap);
  const lista = Object.values(combinados);
  ultimoSyncEquip = {};
  lista.forEach(e=>{ ultimoSyncEquip[e.serie]=JSON.stringify(e); });
  DB.equipamentos = lista; salvarLocal();
  // Sempre atualiza equipsCarregados ANTES de render() e sempre renderiza (mesmo na
  // primeira carga) — a versão anterior só renderizava a partir da SEGUNDA chamada,
  // então um técnico sem nenhum evento de tempo real logo após o login ficava vendo
  // a tela desatualizada indefinidamente (achado ao preparar a tela de "carregando").
  equipsCarregados = true;
  render();
}
function aplicarEventoEquipTecnico(payload, mapa){
  if(payload.eventType==='DELETE'){ delete mapa[payload.old.serie]; }
  else { const e = equipamentoParaCamel(payload.new); mapa[e.serie]=e; }
  mesclarEquipamentosTecnico();
}
function aplicarEventoEquipGeral(payload){
  if(payload.eventType==='DELETE'){
    const serie = payload.old.serie;
    DB.equipamentos = DB.equipamentos.filter(e=>e.serie!==serie);
    delete ultimoSyncEquip[serie];
  } else {
    const e = equipamentoParaCamel(payload.new);
    const idx = DB.equipamentos.findIndex(x=>x.serie===e.serie);
    if(idx>=0) DB.equipamentos[idx]=e; else DB.equipamentos.push(e);
    ultimoSyncEquip[e.serie]=JSON.stringify(e);
  }
  salvarLocal();
  if(equipsCarregados) render();
}
function iniciarListenerEquipamentos(canal){
  // Técnico só precisa dos itens que já são dele + os que estão a caminho pra ele —
  // isso evita que cada um dos ~50 técnicos baixe o inventário inteiro da empresa
  // toda vez que abre o app (o que já estourou a cota gratuita do Firestore num dia de testes).
  // Admin e supervisor continuam vendo a tabela inteira (é o papel deles).
  // Os listeners de equipamentos entram no MESMO canal recebido por parâmetro (mais .on()
  // encadeados) em vez de abrir canal próprio — só o .subscribe() final (chamado por
  // quem chama esta função) é que efetivamente abre a conexão.
  if(souTecnico()){
    const meuId = MEU_PERFIL.tecnicoId;
    if(!meuId){ equipsCarregados=true; render(); return; }
    Promise.all([
      selecionarTudo('equipamentos', q=>q.eq('tecnico_id', meuId)),
      selecionarTudo('equipamentos', q=>q.eq('transito_para', meuId))
    ]).then(([ownData, incData])=>{
      equipsOwnMap = {}; ownData.forEach(r=>{ const e=equipamentoParaCamel(r); equipsOwnMap[e.serie]=e; });
      equipsIncomingMap = {}; incData.forEach(r=>{ const e=equipamentoParaCamel(r); equipsIncomingMap[e.serie]=e; });
      mesclarEquipamentosTecnico();
    }).catch(err=>{
      flash('Erro ao carregar equipamentos: '+err.message,'red');
      // BUG-042 (continuação): sem isso, uma falha aqui (ex.: offline) deixava
      // equipsCarregados sempre false, e a tela ficava presa em "Carregando..." pra
      // sempre — mesmo já havendo dados da última sincronização salvos localmente
      // (DB.equipamentos já veio do localStorage no carregar() do topo do arquivo).
      if(!equipsCarregados){ equipsCarregados=true; render(); }
    });
    canal
      .on('postgres_changes',
        {event:'*',schema:'public',table:'equipamentos',filter:`tecnico_id=eq.${meuId}`},
        payload=>aplicarEventoEquipTecnico(payload, equipsOwnMap))
      .on('postgres_changes',
        {event:'*',schema:'public',table:'equipamentos',filter:`transito_para=eq.${meuId}`},
        payload=>aplicarEventoEquipTecnico(payload, equipsIncomingMap));
  } else {
    selecionarTudo('equipamentos').then(data=>{
      const lista = data.map(equipamentoParaCamel);
      ultimoSyncEquip = {}; lista.forEach(e=>{ ultimoSyncEquip[e.serie]=JSON.stringify(e); });
      DB.equipamentos = lista; salvarLocal();
      equipsCarregados = true; render();
    }).catch(err=>{
      flash('Erro ao carregar equipamentos: '+err.message,'red');
      // BUG-042 (continuação): mesmo raciocínio do ramo do técnico acima — sem isso,
      // a tela ficava presa em "Carregando..." pra sempre quando offline, apesar de
      // DB.equipamentos já ter os dados da última sincronização (vindos do localStorage).
      if(!equipsCarregados){ equipsCarregados=true; render(); }
    });
    canal.on('postgres_changes',
      {event:'*',schema:'public',table:'equipamentos'}, aplicarEventoEquipGeral);
  }
}
// Gera um UUID de verdade — movimentacoes.id, auditorias.id e tecnicos.id são colunas
// uuid no Postgres; o formato curto antigo (base36) era aceito pelo Firestore (documento
// sem tipo fixo de chave) mas o Postgres rejeita como "invalid input syntax for type uuid"
// (achado ao vivo, ver BUG-031).
function uid(){
  if(typeof crypto!=='undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8);
    return v.toString(16);
  });
}
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
  if(s.startsWith('8955')) return 'Chip'; // ICCID brasileiro (89=telecom, 55=Brasil) — cartão SIM de operadora
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
function tipoCor(cod){ const k=Object.keys(DB.tipos); const i=k.indexOf(cod); const cores=tipoCores(); return (DB.tipos[cod]&&DB.tipos[cod].cor)||cores[i%cores.length]||'#5b6672'; }
function fmtData(d){ if(!d) return '—'; if(d instanceof Date) return d.toLocaleDateString('pt-BR'); return d; }
function fmtTS(ts){ const d=new Date(ts); return d.toLocaleDateString('pt-BR')+' '+d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }
/* ---------- Ícones (SVG inline, estilo Lucide — sem emoji, funciona offline) ---------- */
const ICONS = {
  check:'<path d="M20 6 9 17l-5-5"/>',
  'alert-triangle':'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  'hard-hat':'<path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1 8 8 0 0 0-8-8h-4a8 8 0 0 0-8 8Z"/><path d="M10 10V4"/><path d="M14 10V4"/><path d="M6 18v-3"/><path d="M18 18v-3"/>',
  printer:'<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  'building-2':'<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  'bar-chart-3':'<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  package:'<path d="M16.5 9.4 7.5 4.21"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  'map-pin':'<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  recycle:'<path d="M7 19H4.815a1.83 1.83 0 0 1-1.57-.881 1.785 1.785 0 0 1-.004-1.784L7.196 9.5"/><path d="M11 19h8.203a1.83 1.83 0 0 0 1.556-.89 1.784 1.784 0 0 0 0-1.775l-1.226-2.12"/><path d="m14 16-3 3 3 3"/><path d="M8.293 13.596 7.196 9.5 3.1 10.598"/><path d="m9.344 5.811 1.093-1.892A1.83 1.83 0 0 1 11.985 3a1.784 1.784 0 0 1 1.546.888l3.943 6.843"/><path d="m13.378 9.633 4.096 1.098 1.097-4.096"/>',
  clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  hourglass:'<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  'alarm-clock':'<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/><path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/>',
  target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  'clipboard-list':'<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/>',
  pencil:'<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  'trash-2':'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  eraser:'<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  save:'<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  'file-text':'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  wrench:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  lock:'<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  cloud:'<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  tag:'<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  'refresh-cw':'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  repeat:'<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  'trending-up':'<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  square:'<rect x="3" y="3" width="18" height="18" rx="2"/>',
  link:'<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'x-circle':'<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  'list-checks':'<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  flame:'<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5"/>',
  'folder-open':'<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  shuffle:'<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>',
  'flask-conical':'<path d="M10 2v6.29a2 2 0 0 1-.5 1.33L4.24 15.7A2 2 0 0 0 6 19h12a2 2 0 0 0 1.76-3.3l-5.26-6.08A2 2 0 0 1 14 8.29V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  'undo-2':'<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  camera:'<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13" r="3"/>',
};
function ic(nome){ return '<svg class="ic-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(ICONS[nome]||'')+'</svg>'; }
/* Referencia o token de cor (--brand, --green, --chart-1, ...) como var() ao vivo
   em vez de resolver o valor agora — assim gráficos gerados em SVG/inline continuam
   acompanhando a troca de tema sem precisar re-renderizar. */
function corVar(nome){ return 'var('+nome+')'; }
function tipoCores(){ return CHART_VARS.map(corVar); }
function flash(msg, kind=''){ const iconeSvg = kind==='green'?ic('check'):kind==='red'?ic('alert-triangle'):ic('info'); const f=document.createElement('div'); f.className='flash '+kind; f.innerHTML=iconeSvg+'<span>'+msg+'</span>'; document.body.appendChild(f); setTimeout(()=>{f.style.opacity='0';f.style.transition='.3s';setTimeout(()=>f.remove(),300);},2400); }
function refTS(e){ return e.desde || DB.config.importadoEm || null; }
function diasEmPosse(e){ const t=refTS(e); if(!t) return null; return Math.floor((Date.now()-t)/86400000); }
function fmtDias(n){ if(n==null) return '—'; if(n===0) return 'hoje'; if(n===1) return '1 dia'; if(n<30) return n+' dias'; const m=Math.floor(n/30); return m+(m===1?' mês':' meses'); }
function ultimaAuditoria(alvoTipo, alvoId){ const a=DB.auditorias.filter(x=>x.alvoTipo===alvoTipo&&x.alvoId===alvoId); return a.length?a[a.length-1]:null; }
function auditoriasPermitidas(){
  if(!souSupervisor()) return DB.auditorias;
  return DB.auditorias.filter(a=>{
    if(a.alvoTipo==='deposito') return regiaoPermitida(a.alvoId);
    const t=DB.tecnicos.find(x=>x.id===a.alvoId);
    return t && regiaoPermitida(t.regiao);
  });
}
// Mais recente primeiro (por refTS — desde, ou data de importação se nunca foi
// movimentado), pra listas como "Meus equipamentos"/"Ficha do técnico" ficarem
// organizadas por quem mexeu por último, não na ordem de importação da planilha.
// Não conta item marcado como perdido (20/07/2026, a pedido do usuário) — um item
// "em posse" que na prática está pendente de localização não deveria aparecer como
// estoque disponível em nenhuma tela normal (ficha do técnico, Estoque Mínimo por
// técnico, Meus Equipamentos, Auditoria, etc. — todas cascateiam a partir daqui). Em
// Movimentar ele continua aparecendo normalmente (filtrarPickMov não usa esta função) —
// é o único jeito de resolvê-lo.
function itensDoTecnico(id){ return DB.equipamentos.filter(e=>e.tecnicoId===id && e.status==='com_tecnico' && !e.perdido).sort((a,b)=>(refTS(b)||0)-(refTS(a)||0)); }
function itensDoDeposito(dep){ return DB.equipamentos.filter(e=>e.status==='estoque' && (e.local||e.deposito||'')===dep); }
function acharEquipPorSerie(serie){ const s=(serie||'').toLowerCase(); return DB.equipamentos.find(e=>e.serie.toLowerCase()===s); }

/* ---------- Modo escuro ---------- */
/* O tema inicial (localStorage > prefers-color-scheme) já é resolvido por um
   script inline no <head> do index.html, antes da primeira pintura, pra não
   piscar o tema errado. Aqui só cuidamos da alternância manual. */
function toggleDark(){
  const atual = document.documentElement.getAttribute('data-theme');
  const novo = atual==='dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', novo);
  localStorage.setItem('estoque_tema', novo);
}

/* ---------- Navegação ---------- */
const PAGES = [
  { id:'dashboard', icon:'bar-chart-3', titulo:'Visão Geral', sub:'Resumo do inventário', papeis:['admin','supervisor'] },
  { id:'equip',     icon:'package', titulo:'Equipamentos', sub:'Inventário item a item', papeis:['admin','supervisor'] },
  { id:'mov',       icon:'refresh-cw', titulo:'Movimentar', sub:'Registrar entrada, saída, transferência ou baixa', papeis:['admin','supervisor','tecnico'] },
  { id:'tecnicos',  icon:'hard-hat', titulo:'Técnicos', sub:'Cadastro e equipamentos em posse', papeis:['admin','supervisor'] },
  { id:'parados',   icon:'alarm-clock', titulo:'Itens Parados', sub:`Equipamentos com técnicos há ${DIAS_PARADO}+ dias`, papeis:['admin','supervisor'] },
  { id:'rma',       icon:'recycle', titulo:'Estoque RMA', sub:'Equipamentos enviados para RMA, por filial e técnico', papeis:['admin','supervisor'] },
  { id:'estoquemin', icon:'target', titulo:'Estoque Mínimo', sub:'Filiais abaixo do estoque mínimo por tipo de equipamento', papeis:['admin','supervisor'] },
  { id:'auditoria', icon:'search', titulo:'Auditoria', sub:'Conferência de estoque por técnico ou depósito', papeis:['admin','supervisor'] },
  { id:'perdidos',  icon:'alert-triangle', titulo:'Inventário Pendente', sub:'Equipamentos não localizados, por filial', papeis:['admin','supervisor'] },
  { id:'hist',      icon:'clock', titulo:'Histórico', sub:'Todas as movimentações registradas', papeis:['admin','supervisor'] },
  { id:'tipos',     icon:'tag', titulo:'Tipos', sub:'Os 5 tipos de equipamento', papeis:['admin','supervisor'] },
  { id:'filiais',   icon:'building-2', titulo:'Filiais', sub:'Cadastro de filiais e depósitos', papeis:['admin'] },
  { id:'dados',     icon:'save', titulo:'Dados', sub:'Importar, exportar e backup', papeis:['admin'] },
  { id:'usuarios',  icon:'lock', titulo:'Usuários', sub:'Aprovar acessos e definir permissões', papeis:['admin'] },
  { id:'meusItens', icon:'package', titulo:'Meus Equipamentos', sub:'Itens sob sua responsabilidade', papeis:['tecnico'] },
  { id:'meuHistorico', icon:'clock', titulo:'Meu Histórico', sub:'Movimentações dos seus itens', papeis:['tecnico'] },
  { id:'retiradas', icon:'search', titulo:'Consultar Retirada', sub:'Busque pelo código da retirada em campo (ex.: RET-0001)', papeis:['admin','supervisor','tecnico'] },
];
let PAGE = 'dashboard';
function paginasDisponiveis(){ const papel = MEU_PERFIL?MEU_PERFIL.papel:null; return PAGES.filter(p=>p.papeis.includes(papel)); }

function renderNav(){
  $('#nav').innerHTML = paginasDisponiveis().map(p=>`
    <button class="nav-item ${p.id===PAGE?'active':''}" onclick="goto('${p.id}')">
      <span class="ic">${ic(p.icon)}</span> ${p.titulo}
    </button>`).join('');
}
// Sinaliza pra renderMeusItens() que ESTA é uma navegação de verdade (usuário entrando
// na tela agora), não um re-render provocado por um filtro ou por um evento de tempo
// real — só nesse caso o campo de bipar deve ganhar foco automaticamente. Em celular,
// dar foco sempre abre o teclado (mesmo com preventScroll), o que parecia com o antigo
// bug de "rolar pro topo" sempre que o técnico só clicava num filtro de tipo.
let veioDeNavegacao = false;
function goto(id){
  const p = paginasDisponiveis().find(x=>x.id===id); if(!p) return;
  PAGE=id; veioDeNavegacao = true; $('#pageTitle').textContent=p.titulo; $('#pageSub').textContent=p.sub; renderNav(); render(); window.scrollTo(0,0); toggleSidebar(false);
}
function toggleSidebar(force){
  const open = typeof force==='boolean' ? force : !document.querySelector('.sidebar').classList.contains('open');
  document.querySelector('.sidebar').classList.toggle('open', open);
  $('#sidebarOverlay').classList.toggle('show', open);
}

const RENDERERS = { dashboard:renderDashboard, equip:renderEquip, mov:renderMovPage, tecnicos:renderTecnicos, parados:renderParados, rma:renderRMA, estoquemin:renderEstoqueMinimo, auditoria:renderAuditoria, perdidos:renderInventarioPendente, hist:renderHist, tipos:renderTipos, filiais:renderFiliais, dados:renderDados, usuarios:renderUsuarios, meusItens:renderMeusItens, meuHistorico:renderMeuHistorico, retiradas:renderRetiradas };
function render(){
  // Enquanto a carga inicial de equipamentos ainda não terminou de verdade (ex.: logo
  // depois de um F5), mostra "carregando" em vez de renderizar com o que sobrou no
  // localStorage de uma sessão anterior — evita o "flash" de números desatualizados.
  if(!equipsCarregados) return renderCarregando();
  const semDados = ['dados','tipos','filiais','usuarios','meusItens','meuHistorico','rma','retiradas','estoquemin'];
  if(DB.equipamentos.length===0 && !semDados.includes(PAGE)){ return renderVazio(); }
  RENDERERS[PAGE]();
}

function renderCarregando(){
  // Skeleton no formato da tela real (KPIs + tabela fantasma), em vez de spinner
  // genérico — a estrutura "aparece" antes dos dados e a carga parece mais rápida.
  const kpiGhost = `<div class="panel"><div class="skel-kpi"><div class="skel skel-line" style="width:55%"></div><div class="skel skel-line lg" style="width:38%"></div></div></div>`;
  const larguras = [100,92,97,88,95,90]; // variação sutil pra parecer conteúdo de verdade, não blocos idênticos
  $('#content').innerHTML = `
  <div class="grid kpis" style="margin-bottom:20px">${kpiGhost.repeat(4)}</div>
  <div class="panel">
    <div class="ph"><div class="skel skel-line" style="width:170px"></div></div>
    <div class="pb">${larguras.map(w=>`<div class="skel skel-row" style="width:${w}%"></div>`).join('')}</div>
  </div>
  <p class="muted" style="text-align:center;margin-top:16px;font-size:var(--text-sm)">Buscando os dados mais recentes da nuvem...</p>`;
}

function renderVazio(){
  $('#content').innerHTML = `
  <div class="panel"><div class="pb">
    <div class="empty">
      <div class="big">${ic('inbox')}</div>
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
let dashTecnicoFiltro = ''; // id do técnico selecionado no dropdown; vazio = todos
let dashStatusFiltro = ''; // 'estoque'|'com_tecnico'|'instalado'|'baixado'; vazio = todos
function dashToggleFilial(d){
  const i = dashFiliais.indexOf(d);
  if(i>=0) dashFiliais.splice(i,1); else dashFiliais.push(d);
  renderDashboard();
}
function dashToggleStatus(status){
  dashStatusFiltro = dashStatusFiltro===status ? '' : status;
  renderDashboard();
}
// Aplica os filtros de filial + técnico atuais — reaproveitado tanto pela tela quanto
// pela exportação (Excel/relatório), pra exportar sempre bater com o que está na tela
// (mesmo princípio de paradosFiltrados() em Itens Parados).
// "Ampliado": um técnico não tem mais tecnicoId depois que o item vai pra RMA ou é
// instalado (esses estados guardam o dono em rma_tecnico_id/instalado_tecnico_id, não
// em tecnico_id) — sem isso, filtrar por técnico + status RMA/Instalado sempre dava 0
// resultados, mesmo quando o item era mesmo desse técnico. Olha o campo certo conforme
// o status ATUAL do item, então funciona em qualquer combinação com o filtro de status.
function dashItemBateTecnico(e, tecId){
  if(e.status==='com_tecnico') return e.tecnicoId===tecId;
  if(e.status==='baixado') return e.rmaTecnicoId===tecId;
  if(e.status==='instalado') return e.instaladoTecnicoId===tecId;
  return false; // 'estoque' não tem técnico associado
}
function dashboardFiltrado(){
  // Item marcado como perdido não conta como estoque "normal" em nenhuma visão da
  // Visão Geral (20/07/2026, a pedido do usuário) — fica só no Inventário Pendente até
  // ser resolvido (qualquer movimentação, feita normalmente em Movimentar, resolve).
  const baseEq = (souSupervisor() ? DB.equipamentos.filter(e=>regiaoPermitida(e.deposito)) : DB.equipamentos).filter(e=>!e.perdido);
  const eqPorFilial = dashFiliais.length ? baseEq.filter(e=>dashFiliais.includes(e.deposito)) : baseEq;
  let eq = dashTecnicoFiltro ? eqPorFilial.filter(e=>dashItemBateTecnico(e, dashTecnicoFiltro)) : eqPorFilial;
  if(dashStatusFiltro) eq = eq.filter(e=>e.status===dashStatusFiltro);
  return eq;
}
function renderDashboard(){
  let todasFiliais = todasFiliaisConhecidas();
  if(souSupervisor()) todasFiliais = todasFiliais.filter(regiaoPermitida);
  // Item marcado como perdido não conta como estoque "normal" em nenhuma visão da
  // Visão Geral (20/07/2026, a pedido do usuário) — fica só no Inventário Pendente até
  // ser resolvido (qualquer movimentação, feita normalmente em Movimentar, resolve).
  const baseEq = (souSupervisor() ? DB.equipamentos.filter(e=>regiaoPermitida(e.deposito)) : DB.equipamentos).filter(e=>!e.perdido);
  const eqPorFilial = dashFiliais.length ? baseEq.filter(e=>dashFiliais.includes(e.deposito)) : baseEq;
  // Considera os 3 campos de "dono" (tecnico_id/rma_tecnico_id/instalado_tecnico_id) —
  // um técnico que só tem itens em RMA ou instalados nesta filial também deve aparecer
  // na lista, senão o dropdown "esconde" ele assim que o item muda de status.
  const tecnicosDisponiveis = [...new Set(eqPorFilial.flatMap(e=>[e.tecnicoId,e.rmaTecnicoId,e.instaladoTecnicoId]).filter(Boolean))]
    .map(id=>DB.tecnicos.find(t=>t.id===id)).filter(Boolean).sort((a,b)=>a.nome.localeCompare(b.nome));
  if(dashTecnicoFiltro && !tecnicosDisponiveis.some(t=>t.id===dashTecnicoFiltro)) dashTecnicoFiltro='';
  const eqPorTecnico = dashTecnicoFiltro ? eqPorFilial.filter(e=>dashItemBateTecnico(e, dashTecnicoFiltro)) : eqPorFilial;
  // Contagens do filtro de status (pílulas) — refletem filial + técnico já aplicados,
  // mas ANTES do próprio filtro de status (pra pílula mostrar "quantos teria se eu
  // escolhesse essa opção", mesmo princípio das pílulas de filial/tipo já existentes).
  const statusContagem = {
    estoque: eqPorTecnico.filter(e=>e.status==='estoque').length,
    com_tecnico: eqPorTecnico.filter(e=>e.status==='com_tecnico').length,
    instalado: eqPorTecnico.filter(e=>e.status==='instalado').length,
    baixado: eqPorTecnico.filter(e=>e.status==='baixado').length,
  };
  // (Sem auto-reset aqui: diferente do técnico — que pode deixar de existir como opção
  // válida — os 4 status são categorias fixas; contagem 0 é um resultado legítimo, não
  // motivo pra descartar a escolha do usuário.)
  const eq = dashStatusFiltro ? eqPorTecnico.filter(e=>e.status===dashStatusFiltro) : eqPorTecnico;
  const total = eq.length;
  const emEstoque = eq.filter(e=>e.status==='estoque').length;
  const comTec = eq.filter(e=>e.status==='com_tecnico').length;
  const baixados = eq.filter(e=>e.status==='baixado').length;
  const instalados = eq.filter(e=>e.status==='instalado').length;
  const seriesEq = new Set(eq.map(e=>e.serie));
  const auditoriasFiltradas = (dashFiliais.length ? auditoriasPermitidas().filter(a=>a.alvoTipo==='deposito'&&dashFiliais.includes(a.alvoId)) : auditoriasPermitidas());

  // por tipo
  const porTipo = {};
  eq.forEach(e=>{ porTipo[e.tipo]=(porTipo[e.tipo]||0)+1; });
  const tiposArr = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]);
  const maxTipo = Math.max(1,...tiposArr.map(t=>t[1]));

  // painel secundário: por depósito (visão geral) OU por técnico (quando uma ou mais filiais estão selecionadas)
  let painel2Titulo, painel2Arr, painel2Max, painel2Cor=corVar('--brand'), painel2PorTecnico=false;
  if(dashFiliais.length){
    const porTec = {};
    eq.filter(e=>e.status==='com_tecnico').forEach(e=>{ const id=e.tecnicoId; porTec[id]=(porTec[id]||0)+1; });
    painel2Titulo = ic('hard-hat')+' Itens com técnicos das filiais selecionadas <span class="muted" style="font-size:11px;font-weight:500">(clique num técnico para ver a ficha completa)</span>';
    painel2Arr = Object.entries(porTec).sort((a,b)=>b[1]-a[1]).slice(0,8);
    painel2Max = Math.max(1,...painel2Arr.map(d=>d[1]));
    painel2Cor=corVar('--amber');
    painel2PorTecnico=true;
  } else {
    const porDep = {};
    // instalado não conta como "ativo no depósito": o item está fisicamente no cliente
    eq.filter(e=>e.status!=='baixado'&&e.status!=='instalado').forEach(e=>{ const d=e.local||e.deposito||'—'; porDep[d]=(porDep[d]||0)+1; });
    painel2Titulo = ic('map-pin')+' Itens ativos por depósito/local';
    painel2Arr = Object.entries(porDep).sort((a,b)=>b[1]-a[1]).slice(0,8);
    painel2Max = Math.max(1,...painel2Arr.map(d=>d[1]));
  }

  const ultimas = DB.movimentacoes.filter(m=>seriesEq.has(m.serie)).slice(-8).reverse();

  // alertas
  const parados = eq.filter(e=>e.status==='com_tecnico' && (diasEmPosse(e)||0)>=DIAS_PARADO);
  const tecsSemAud = DB.tecnicos.filter(t=>itensDoTecnico(t.id).some(e=>seriesEq.has(e.serie)) && !ultimaAuditoria('tecnico',t.id));
  const pendentesConf = pendentesConfirmacaoLista().filter(e=>seriesEq.has(e.serie));

  const alertasMinGeral = alertasEstoqueMinPorFilial();
  const perdidosGeral = souSupervisor() ? DB.equipamentos.filter(e=>e.perdido && regiaoPermitida(e.perdidoFilial)) : DB.equipamentos.filter(e=>e.perdido);
  $('#content').innerHTML = `
  ${(alertasMinGeral.length||parados.length||tecsSemAud.length||pendentesConf.length||perdidosGeral.length)?`
  <div class="panel" style="margin-bottom:18px;border-left:4px solid var(--amber)">
    <div class="ph"><h3>${ic('list-checks')} Resumo do dia — o que precisa de ação</h3></div>
    <div class="pb" style="display:flex;flex-wrap:wrap;gap:10px">
      ${pendentesConf.length?`<button class="badge blue" style="padding:8px 12px;border:0;cursor:pointer" onclick="abrirPendentesConfirmacao()">${ic('inbox')} ${pendentesConf.length} ${pendentesConf.length===1?'item aguardando confirmação':'itens aguardando confirmação'}</button>`:''}
      ${alertasMinGeral.length?`<button class="badge baixado" style="padding:8px 12px;border:0;cursor:pointer" onclick="goto('estoquemin')">${ic('target')} ${alertasMinGeral.length} ${alertasMinGeral.length===1?'alerta de estoque mínimo':'alertas de estoque mínimo'}</button>`:''}
      ${parados.length?`<button class="badge com_tecnico" style="padding:8px 12px;border:0;cursor:pointer" onclick="goto('parados')">${parados.length} ${parados.length===1?'item parado':'itens parados'} ${DIAS_PARADO}+ dias com técnico</button>`:''}
      ${tecsSemAud.length?`<button class="badge gray" style="padding:8px 12px;border:0;cursor:pointer" onclick="goto('auditoria')">${tecsSemAud.length} ${tecsSemAud.length===1?'técnico nunca auditado':'técnicos nunca auditados'}</button>`:''}
      ${perdidosGeral.length?`<button class="badge baixado" style="padding:8px 12px;border:0;cursor:pointer" onclick="goto('perdidos')">${ic('alert-triangle')} ${perdidosGeral.length} ${perdidosGeral.length===1?'item no Inventário Pendente':'itens no Inventário Pendente'}</button>`:''}
    </div>
  </div>`:''}
  <div class="panel" style="margin-bottom:18px"><div class="pb" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span style="font-weight:700;font-size:12.5px;color:var(--txt-soft);white-space:nowrap">${ic('building-2')} FILIAL / DEPÓSITO ${dashFiliais.length?`<span class="muted" style="font-weight:500">(${dashFiliais.length} selecionada${dashFiliais.length>1?'s':''} · clique para adicionar/remover)</span>`:'<span class="muted" style="font-weight:500">(clique para filtrar, pode escolher várias)</span>'}</span>
    <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0;gap:8px">
      <button class="${!dashFiliais.length?'active':''}" style="background:${!dashFiliais.length?'var(--brand)':'var(--panel-soft)'};color:${!dashFiliais.length?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="dashFiliais=[];renderDashboard()">Todas <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${baseEq.length}</span></button>
      ${todasFiliais.map(d=>{ const n=baseEq.filter(e=>e.deposito===d).length; const on=dashFiliais.includes(d); return `
        <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="dashToggleFilial('${esc(d)}')">${on?ic('check')+' ':''}${esc(d)} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'var(--surface-2)'};color:inherit;margin-left:4px">${n}</span></button>`;}).join('')}
    </div>
    <div class="spacer"></div>
    <div class="field" style="margin:0;min-width:200px"><label style="font-size:11px">${ic('hard-hat')} Filtrar por técnico</label>
      <select onchange="dashTecnicoFiltro=this.value;renderDashboard()">
        <option value="">Todos os técnicos (${tecnicosDisponiveis.length})</option>
        ${tecnicosDisponiveis.map(t=>`<option value="${t.id}" ${dashTecnicoFiltro===t.id?'selected':''}>${t.regiao?'['+esc(t.regiao)+'] ':''}${esc(t.nome)}</option>`).join('')}
      </select>
    </div>
    <span style="font-weight:700;font-size:12.5px;color:var(--txt-soft);white-space:nowrap">${ic('list-checks')} STATUS</span>
    <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0;gap:8px">
      <button class="${!dashStatusFiltro?'active':''}" style="background:${!dashStatusFiltro?'var(--brand)':'var(--panel-soft)'};color:${!dashStatusFiltro?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="dashStatusFiltro='';renderDashboard()">Todos <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${eqPorTecnico.length}</span></button>
      ${[['estoque','Em estoque'],['com_tecnico','Com técnico'],['instalado','Instalados'],['baixado','RMA']].map(([st,label])=>{ const on=dashStatusFiltro===st; return `
        <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="dashToggleStatus('${st}')">${on?ic('check')+' ':''}${label} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'var(--surface-2)'};color:inherit;margin-left:4px">${statusContagem[st]}</span></button>`;}).join('')}
    </div>
    <button class="btn sm" onclick="exportarFilialExcel()">${ic('bar-chart-3')} Exportar Excel</button>
    <button class="btn sm" onclick="relatorioFilial()">${ic('printer')} Gerar relatório</button>
  </div></div>

  <div class="grid kpis" style="margin-bottom:20px">
    ${kpi('b','package','Total de itens',total)}
    ${kpi('g','check','Em estoque',emEstoque)}
    ${kpi('a','hard-hat','Com técnicos',comTec)}
    ${kpi('v','wrench','Instalados',instalados)}
    ${kpi('r','recycle','RMA',baixados)}
    ${kpi('b','search','Auditorias',auditoriasFiltradas.length)}
  </div>

  <div class="chart-row" style="margin-bottom:20px">
    <div class="panel">
      <div class="ph"><h3>${ic('package')} Itens por tipo de equipamento</h3></div>
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
        ${donut([['Em estoque',emEstoque,corVar('--green')],['Com técnico',comTec,corVar('--amber')],['Instalados',instalados,corVar('--violet')],['RMA',baixados,corVar('--red')]])}
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
      <div class="ph"><h3>${ic('clock')} Últimas movimentações</h3><div class="spacer"></div><button class="btn sm ghost" onclick="goto('hist')">Ver tudo →</button></div>
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
function kpi(c,icone,lbl,val){ return `<div class="kpi ${c}"><div class="ic">${ic(icone)}</div><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`; }
function movBadge(t){ const m={entrada:'badge blue',saida:'badge com_tecnico',transferencia:'badge violet',baixa:'badge baixado',retorno_rma:'badge estoque',confirmacao:'badge estoque',exclusao:'badge baixado',cancelamento:'badge gray',registro_campo:'badge blue'}; return `<span class="${m[t]||'badge gray'}">${MOV_LABEL[t]||t}</span>`; }

function donut(data){
  const total = data.reduce((s,d)=>s+d[1],0)||1;
  let acc=0; const R=100, C=2*Math.PI*R;
  const segs = data.filter(d=>d[1]>0).map(d=>{ const frac=d[1]/total; const dash=Math.max(0,frac*C-3); const seg=`<circle r="${R}" cx="120" cy="120" fill="none" stroke="${d[2]}" stroke-width="34" stroke-linecap="round" stroke-dasharray="${dash} ${C-dash}" stroke-dashoffset="${-acc*C}" transform="rotate(-90 120 120)"/>`; acc+=frac; return seg; }).join('');
  return `<svg width="240" height="240" viewBox="0 0 240 240" style="flex-shrink:0">${segs}
    <text x="120" y="115" text-anchor="middle" font-size="40" font-weight="800" fill="var(--txt)">${total}</text>
    <text x="120" y="140" text-anchor="middle" font-size="15" fill="var(--txt-soft)">itens</text></svg>
  <div class="legend">${data.map(d=>`<div class="li"><span class="sw" style="background:${d[2]}"></span><span>${d[0]}</span><b style="margin-left:auto">${d[1]}</b><span class="muted" style="width:50px;text-align:right;font-weight:500;font-size:13.5px">${Math.round(d[1]/total*100)}%</span></div>`).join('')}</div>`;
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
    <div class="search"><span class="si">${ic('search')}</span><input id="fq" placeholder="Buscar por nº de série..." value="${esc(eqFiltro.q)}" oninput="eqFiltro.q=this.value;renderEquipTabela()"></div>
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
    <button class="btn" onclick="exportarEquipCSV()">${ic('download')} Exportar CSV</button>
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
      <td><span class="badge ${e.status}">${STATUS[e.status]}</span> ${e.emTransito?`<span class="badge com_tecnico" style="font-size:10px">${ic('hourglass')} em trânsito p/ ${esc(tecNome(e.transitoPara))}</span>`:''} ${e.perdido?`<span class="badge baixado" style="font-size:10px">${ic('alert-triangle')} Inventário Pendente</span>`:''}</td>
      <td>${e.status==='com_tecnico'?esc(tecNome(e.tecnicoId)):esc(e.local||e.deposito||'—')}</td>
      <td class="muted">${e.status==='com_tecnico'?'há '+fmtDias(diasEmPosse(e)):fmtData(e.dataEntrada)}</td>
      <td class="right">
        <button class="btn sm" ${e.emTransito?'disabled title="Aguardando confirmação do técnico"':''} onclick="openMov('${esc(e.serie)}')">Mover</button>
        <button class="btn sm ghost" onclick="openEquip('${esc(e.serie)}')" aria-label="Editar equipamento">${ic('pencil')}</button>
      </td>
    </tr>`).join('');
  $('#eqTabela').innerHTML = lista.length? `<table>
    <thead><tr><th>Nº Série</th><th>Tipo</th><th>Status</th><th>Local / Técnico</th><th>Entrada / Posse</th><th class="right">Ações</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${lista.length>500?`<div class="muted center" style="padding:14px">Mostrando 500 de ${lista.length}. Use a busca/filtros para refinar.</div>`:''}`
    : `<div class="empty"><div class="big">${ic('search')}</div>Nenhum equipamento encontrado com esses filtros.</div>`;
}

/* =========================================================
   ITENS PARADOS (90+ dias com técnico)
   ========================================================= */
let paradosFiliais = []; // array de depósitos selecionados; vazio = todas
let paradosTecnicoFiltro = ''; // id do técnico selecionado no dropdown; vazio = todos
function paradosToggleFilial(d){
  const i = paradosFiliais.indexOf(d);
  if(i>=0) paradosFiliais.splice(i,1); else paradosFiliais.push(d);
  renderParados();
}
function paradosLista(){
  // Item marcado como perdido não conta como "parado" (20/07/2026, a pedido do
  // usuário) — já está sinalizado no Inventário Pendente, sinalizar de novo aqui
  // seria redundante/confuso.
  return DB.equipamentos.filter(e=>e.status==='com_tecnico' && !e.perdido && (diasEmPosse(e)||0)>=DIAS_PARADO)
    .sort((a,b)=>(diasEmPosse(b)||0)-(diasEmPosse(a)||0));
}
// Aplica os filtros de filial + técnico atuais — reaproveitado tanto pela tela quanto
// pela exportação (Excel/relatório), pra exportar sempre bater com o que está na tela.
function paradosFiltrados(){
  const todosParados = souSupervisor() ? paradosLista().filter(e=>regiaoPermitida(e.deposito)) : paradosLista();
  let parados = paradosFiliais.length ? todosParados.filter(e=>paradosFiliais.includes(e.deposito)) : todosParados;
  if(paradosTecnicoFiltro) parados = parados.filter(e=>e.tecnicoId===paradosTecnicoFiltro);
  return parados;
}
function renderParados(){
  const todosParados = souSupervisor() ? paradosLista().filter(e=>regiaoPermitida(e.deposito)) : paradosLista();
  let todasFiliais = [...new Set(todosParados.map(e=>e.deposito).filter(Boolean))].sort();
  const paradosPorFilial = paradosFiliais.length ? todosParados.filter(e=>paradosFiliais.includes(e.deposito)) : todosParados;
  const tecnicosDisponiveis = [...new Map(paradosPorFilial.filter(e=>e.tecnicoId).map(e=>[e.tecnicoId, e.tecnicoId])).keys()]
    .map(id=>DB.tecnicos.find(t=>t.id===id)).filter(Boolean).sort((a,b)=>a.nome.localeCompare(b.nome));
  if(paradosTecnicoFiltro && !tecnicosDisponiveis.some(t=>t.id===paradosTecnicoFiltro)) paradosTecnicoFiltro='';
  const parados = paradosFiltrados();

  const dias = parados.map(e=>diasEmPosse(e)||0);
  const media = dias.length ? Math.round(dias.reduce((s,d)=>s+d,0)/dias.length) : 0;
  const maisCritico = parados[0];
  const filiaisAfetadas = new Set(parados.map(e=>e.deposito).filter(Boolean)).size;
  const tecnicosAfetados = new Set(parados.map(e=>e.tecnicoId).filter(Boolean)).size;

  const porTipo = {}; parados.forEach(e=>{ porTipo[e.tipo]=(porTipo[e.tipo]||0)+1; });
  const tiposArr = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]);
  const maxTipo = Math.max(1,...tiposArr.map(t=>t[1]));

  const faixas = [
    { label:`${DIAS_PARADO}-30 dias`, min:DIAS_PARADO, max:30, cor:corVar('--amber') },
    { label:'31-60 dias', min:31, max:60, cor:corVar('--red') },
    { label:'61-90 dias', min:61, max:90, cor:corVar('--red-2') },
    { label:'90+ dias', min:91, max:Infinity, cor:corVar('--red-3') }
  ];
  const porFaixa = faixas.map(f=>[f.label, parados.filter(e=>{ const d=diasEmPosse(e)||0; return d>=f.min && d<=f.max; }).length, f.cor]);

  const porFilial = {}; todosParados.forEach(e=>{ const d=e.deposito||'—'; porFilial[d]=(porFilial[d]||0)+1; });
  const filialArr = Object.entries(porFilial).sort((a,b)=>b[1]-a[1]);
  const maxFilial = Math.max(1,...filialArr.map(f=>f[1]));

  const porTec = {}; parados.forEach(e=>{ if(e.tecnicoId) porTec[e.tecnicoId]=(porTec[e.tecnicoId]||0)+1; });
  const tecArr = Object.entries(porTec).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxTec = Math.max(1,...tecArr.map(t=>t[1]));

  $('#content').innerHTML = `
  ${todasFiliais.length?`
  <div class="panel" style="margin-bottom:18px"><div class="pb" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span style="font-weight:700;font-size:12.5px;color:var(--txt-soft);white-space:nowrap">${ic('building-2')} FILIAL ${paradosFiliais.length?`<span class="muted" style="font-weight:500">(${paradosFiliais.length} selecionada${paradosFiliais.length>1?'s':''} · clique pra adicionar/remover)</span>`:'<span class="muted" style="font-weight:500">(clique pra filtrar, pode escolher várias)</span>'}</span>
    <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0;gap:8px">
      <button class="${!paradosFiliais.length?'active':''}" style="background:${!paradosFiliais.length?'var(--brand)':'var(--panel-soft)'};color:${!paradosFiliais.length?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="paradosFiliais=[];renderParados()">Todas <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${todosParados.length}</span></button>
      ${todasFiliais.map(d=>{ const n=todosParados.filter(e=>e.deposito===d).length; const on=paradosFiliais.includes(d); return `
        <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="paradosToggleFilial('${esc(d)}')">${on?ic('check')+' ':''}${esc(d)} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'var(--surface-2)'};color:inherit;margin-left:4px">${n}</span></button>`;}).join('')}
    </div>
    <div class="spacer"></div>
    <div class="field" style="margin:0;min-width:200px"><label style="font-size:11px">${ic('hard-hat')} Filtrar por técnico</label>
      <select onchange="paradosTecnicoFiltro=this.value;renderParados()">
        <option value="">Todos os técnicos (${tecnicosDisponiveis.length})</option>
        ${tecnicosDisponiveis.map(t=>`<option value="${t.id}" ${paradosTecnicoFiltro===t.id?'selected':''}>${t.regiao?'['+esc(t.regiao)+'] ':''}${esc(t.nome)}</option>`).join('')}
      </select>
    </div>
  </div></div>`:''}

  <div class="grid kpis" style="margin-bottom:20px">
    ${kpi('r','alarm-clock','Itens parados',parados.length)}
    ${kpi('a','bar-chart-3','Média de dias parado',media)}
    ${kpi('v','flame','Mais crítico',maisCritico?fmtDias(diasEmPosse(maisCritico)):'—')}
    ${kpi('b','building-2','Filiais afetadas',filiaisAfetadas)}
    ${kpi('g','hard-hat','Técnicos afetados',tecnicosAfetados)}
  </div>

  ${parados.length?`
  <div class="chart-row" style="margin-bottom:20px">
    <div class="panel">
      <div class="ph"><h3>${ic('package')} Itens parados por tipo de equipamento</h3></div>
      <div class="pb">
        ${tiposArr.length?tiposArr.map(([t,n])=>`
          <div class="bar-row">
            <div class="bl"><span style="width:11px;height:11px;border-radius:3px;background:${tipoCor(t)};display:inline-block"></span>${esc(tipoNome(t))}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/maxTipo*100}%;background:${tipoCor(t)}">${n}</div></div>
          </div>`).join(''):'<div class="empty">Sem dados</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="ph"><h3>${ic('alarm-clock')} Distribuição por tempo parado</h3></div>
      <div class="pb"><div class="donut-wrap">${donut(porFaixa)}</div></div>
    </div>
  </div>

  <div class="chart-row">
    <div class="panel">
      <div class="ph"><h3>${ic('building-2')} Itens parados por filial</h3><span class="muted" style="font-size:11px;font-weight:500;margin-left:6px">(clique para filtrar)</span></div>
      <div class="pb">
        ${filialArr.length?filialArr.map(([f,n])=>{
          const intensidade = n/maxFilial; // 0 a 1 — mais itens parados = vermelho mais forte/escuro
          const cor = `rgb(${220-Math.round(60*(1-intensidade))},${38+Math.round(90*(1-intensidade))},${38+Math.round(90*(1-intensidade))})`;
          return `
          <div class="bar-row" style="cursor:pointer" onclick="paradosToggleFilial('${esc(f)}')">
            <div class="bl">${esc(f)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/maxFilial*100}%;background:${cor}">${n}</div></div>
          </div>`;}).join(''):'<div class="empty">Sem dados</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="ph"><h3>${ic('hard-hat')} Técnicos com mais itens parados</h3><span class="muted" style="font-size:11px;font-weight:500;margin-left:6px">(clique para ver os itens)</span></div>
      <div class="pb">
        ${tecArr.length?tecArr.map(([id,n])=>`
          <div class="bar-row" style="cursor:pointer" onclick="paradosFichaTecnico('${id}')">
            <div class="bl">${esc(tecNome(id))}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/maxTec*100}%;background:${corVar('--amber')}">${n}</div></div>
            <span class="muted" style="font-size:12px">→</span>
          </div>`).join(''):'<div class="empty">Nenhum técnico com item parado</div>'}
      </div>
    </div>
  </div>`:''}

  ${(()=>{
    // agrupado por técnico (a lista de itens de cada um abre num modal ao clicar)
    const porTecnicoGrupo = {};
    parados.forEach(e=>{ if(e.tecnicoId) (porTecnicoGrupo[e.tecnicoId]=porTecnicoGrupo[e.tecnicoId]||[]).push(e); });
    const grupos = Object.entries(porTecnicoGrupo).map(([id,itens])=>({ id, itens }))
      .sort((a,b)=>b.itens.length-a.itens.length);
    return `
  <div class="panel" style="margin-top:20px"><div class="ph"><h3>${ic('alarm-clock')} Itens parados agrupados por técnico</h3><span class="count-badge">${parados.length}</span><div class="spacer"></div>${parados.length?`<button class="btn sm" onclick="exportarParadosExcel()">${ic('bar-chart-3')} Exportar Excel</button><button class="btn sm" onclick="gerarRelatorioParados()">${ic('printer')} Gerar relatório</button>`:''}</div>
  <div class="tbl-wrap">${
    grupos.length? `<table><thead><tr><th>Técnico</th><th>Filial</th><th class="center">Itens parados</th><th>Mais crítico</th><th class="right">Ações</th></tr></thead><tbody>
      ${grupos.map(g=>{ const t=DB.tecnicos.find(x=>x.id===g.id); const critico=g.itens[0]; return `<tr style="cursor:pointer" onclick="paradosFichaTecnico('${g.id}')">
        <td><b>${esc(tecNome(g.id))}</b></td>
        <td>${esc(t&&t.regiao||'—')}</td>
        <td class="center"><span class="count-badge">${g.itens.length}</span></td>
        <td><b style="color:var(--red)">${fmtDias(diasEmPosse(critico))}</b> <span class="muted" style="font-size:11.5px">(${esc(critico.serie)})</span></td>
        <td class="right"><button class="btn sm ghost" onclick="event.stopPropagation();paradosFichaTecnico('${g.id}')">Ver itens →</button></td>
      </tr>`;}).join('')}</tbody></table>`
    : `<div class="empty"><div class="big">${ic('check')}</div>Nenhum item parado há ${DIAS_PARADO}+ dias. Tudo em dia!</div>`
  }</div></div>`;
  })()}`;
}
function paradosFichaTecnico(tecnicoId){
  const itens = paradosLista().filter(e=>e.tecnicoId===tecnicoId && (!souSupervisor()||regiaoPermitida(e.deposito)));
  const t = DB.tecnicos.find(x=>x.id===tecnicoId);
  modal(ic('alarm-clock')+' Itens parados de '+esc(tecNome(tecnicoId)), `
    <div class="tbl-wrap" style="max-height:400px">${
      itens.length? `<table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Filial</th><th>Há quanto tempo</th><th class="right">Ações</th></tr></thead><tbody>
        ${itens.map(e=>`<tr>
          <td class="mono"><a href="#" onclick="abrirKardex('${esc(e.serie)}');return false"><b>${esc(e.serie)}</b></a></td>
          <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span></td>
          <td>${esc(e.deposito||'—')}</td>
          <td><b style="color:var(--red)">${fmtDias(diasEmPosse(e))}</b></td>
          <td class="right"><button class="btn sm" onclick="closeModal();openMov('${esc(e.serie)}')">Mover</button></td>
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nenhum item parado.</div>'
    }</div>`,
    `<button class="btn" onclick="exportarParadosTecnicoExcel('${tecnicoId}')">${ic('bar-chart-3')} Exportar Excel</button><button class="btn" onclick="gerarRelatorioParadosTecnico('${tecnicoId}')">${ic('printer')} Gerar relatório</button><button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
}
function exportarParadosTecnicoExcel(tecnicoId){
  const itens = paradosLista().filter(e=>e.tecnicoId===tecnicoId);
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const linhas = itens.map(e=>({ 'Nº Série':e.serie, 'Tipo':tipoNome(e.tipo), 'Filial':e.deposito||'—', 'Dias parado':diasEmPosse(e)||0 }));
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Nº Série':'','Tipo':'','Filial':'','Dias parado':'Nenhum item'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Itens Parados');
  XLSX.writeFile(wb, 'itens_parados_'+(tecNome(tecnicoId)||'tecnico').replace(/[^\w-]+/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
function gerarRelatorioParadosTecnico(tecnicoId){
  const itens = paradosLista().filter(e=>e.tecnicoId===tecnicoId);
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Itens Parados</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Relatório de Itens Parados</h1>
    <h2>${esc(tecNome(tecnicoId))} · ${DIAS_PARADO}+ dias sem movimentação · ${itens.length} item(ns) · gerado em ${hoje}</h2>
    <table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Filial</th><th>Dias parado</th></tr></thead><tbody>
      ${itens.length? itens.map(e=>`<tr><td>${esc(e.serie)}</td><td>${esc(tipoNome(e.tipo))}</td><td>${esc(e.deposito||'—')}</td><td>${diasEmPosse(e)||0}</td></tr>`).join('') : '<tr><td colspan="4">Nenhum item parado.</td></tr>'}
    </tbody></table>
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}
function exportarParadosExcel(){
  const parados = paradosFiltrados();
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const linhas = parados.map(e=>({ 'Nº Série':e.serie, 'Tipo':tipoNome(e.tipo), 'Técnico':tecNome(e.tecnicoId), 'Filial':e.deposito||'—', 'Dias parado':diasEmPosse(e)||0 }));
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Nº Série':'','Tipo':'','Técnico':'','Filial':'','Dias parado':'Nenhum item'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Itens Parados');
  XLSX.writeFile(wb, 'itens_parados_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
function gerarRelatorioParados(){
  const parados = paradosFiltrados();
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Itens Parados</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Relatório de Itens Parados com Técnicos</h1>
    <h2>${DIAS_PARADO}+ dias sem movimentação · ${parados.length} item(ns) · gerado em ${hoje}</h2>
    <table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Técnico</th><th>Filial</th><th>Dias parado</th></tr></thead><tbody>
      ${parados.length? parados.map(e=>`<tr><td>${esc(e.serie)}</td><td>${esc(tipoNome(e.tipo))}</td><td>${esc(tecNome(e.tecnicoId))}</td><td>${esc(e.deposito||'—')}</td><td>${diasEmPosse(e)||0}</td></tr>`).join('') : '<tr><td colspan="5">Nenhum item parado.</td></tr>'}
    </tbody></table>
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}

/* =========================================================
   ESTOQUE MÍNIMO POR FILIAL
   ========================================================= */
function alertasEstoqueMinPorFilial(){
  const filiais = todasFiliaisConhecidas();
  const alertas = [];
  filiais.forEach(f=>{
    if(souSupervisor() && !regiaoPermitida(f)) return;
    const idsTecs = DB.tecnicos.filter(t=>t.regiao===f).map(t=>t.id);
    const nTecs = idsTecs.length;
    if(!nTecs) return;
    Object.keys(DB.tipos).forEach(t=>{
      const minPorTecnico = DB.tipos[t].min||0;
      if(minPorTecnico>0){
        const min = minPorTecnico*nTecs;
        // Item marcado como perdido não conta como estoque atual (20/07/2026, a pedido
        // do usuário) — na prática não está disponível, então deixa a filial/técnico
        // mais perto (ou abaixo) do mínimo de verdade.
        const noDeposito = DB.equipamentos.filter(e=>e.deposito===f && e.tipo===t && e.status==='estoque' && !e.perdido).length;
        const comTecnicos = DB.equipamentos.filter(e=>e.tipo===t && e.status==='com_tecnico' && !e.perdido && idsTecs.includes(e.tecnicoId)).length;
        const atual = noDeposito+comTecnicos;
        if(atual<min) alertas.push({filial:f, tipo:t, atual, min, deficit:min-atual});
      }
    });
  });
  return alertas.sort((a,b)=>b.deficit-a.deficit);
}
function alertasEstoqueMinPorTecnico(){
  const alertas = [];
  DB.tecnicos.forEach(t=>{
    if(souSupervisor() && !regiaoPermitida(t.regiao)) return;
    const itens = itensDoTecnico(t.id);
    const porTipo={}; itens.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
    Object.keys(DB.tipos).forEach(tp=>{
      const min = DB.tipos[tp].min||0;
      if(min>0){
        const atual = porTipo[tp]||0;
        if(atual<min) alertas.push({tecnico:t, tipo:tp, atual, min, deficit:min-atual});
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
  modal(ic('hard-hat')+' Estoque de '+esc(tecNome(tecnicoId)), `
    <div class="tbl-wrap"><table><thead><tr><th>Tipo</th><th class="center">Atual</th><th class="center">Mínimo</th><th class="center">Faltam</th></tr></thead><tbody>
      ${tiposComMin.length? tiposComMin.map(tp=>{ const atual=porTipo[tp]||0; const min=DB.tipos[tp].min||0; const falta=Math.max(0,min-atual); return `<tr ${falta>0?'style="background:var(--red-soft)"':''}>
        <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(tp)}">${esc(tipoNome(tp))}</span></td>
        <td class="center">${atual}</td>
        <td class="center muted">${min}</td>
        <td class="center">${falta>0?`<b style="color:var(--red)">${falta}</b>`:`<span style="color:var(--green)">${ic('check')}</span>`}</td>
      </tr>`;}).join('') : '<tr><td class="empty" colspan="4">Nenhum tipo com mínimo configurado.</td></tr>'}
      ${outrosTipos.map(tp=>`<tr>
        <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(tp)}">${esc(tipoNome(tp))}</span></td>
        <td class="center">${porTipo[tp]}</td>
        <td class="center muted">—</td>
        <td class="center muted">—</td>
      </tr>`).join('')}
    </tbody></table></div>`,
    `<button class="btn" onclick="exportarEstoqueMinTecnicoExcel('${tecnicoId}')">${ic('bar-chart-3')} Exportar Excel</button><button class="btn" onclick="gerarRelatorioEstoqueMinTecnico('${tecnicoId}')">${ic('printer')} Gerar relatório</button><button class="btn" onclick="closeModal()">Fechar</button><button class="btn primary" onclick="closeModal();fichaTecnico('${tecnicoId}')">Ver ficha completa →</button>`, 'lg');
}
function exportarEstoqueMinTecnicoExcel(tecnicoId){
  const t = DB.tecnicos.find(x=>x.id===tecnicoId); if(!t) return;
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const itens = itensDoTecnico(tecnicoId);
  const porTipo={}; itens.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
  const tiposComMin = Object.keys(DB.tipos).filter(tp=>(DB.tipos[tp].min||0)>0);
  const linhas = tiposComMin.map(tp=>{ const atual=porTipo[tp]||0; const min=DB.tipos[tp].min||0; return { 'Tipo':tipoNome(tp), 'Atual':atual, 'Mínimo':min, 'Faltam':Math.max(0,min-atual) }; });
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Tipo':'','Atual':'','Mínimo':'','Faltam':'Nenhum tipo com mínimo configurado'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Estoque do Técnico');
  XLSX.writeFile(wb, 'estoque_'+(t.nome||'tecnico').replace(/[^\w-]+/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
function gerarRelatorioEstoqueMinTecnico(tecnicoId){
  const t = DB.tecnicos.find(x=>x.id===tecnicoId); if(!t) return;
  const itens = itensDoTecnico(tecnicoId);
  const porTipo={}; itens.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
  const tiposComMin = Object.keys(DB.tipos).filter(tp=>(DB.tipos[tp].min||0)>0);
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Estoque do Técnico</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Relatório de Estoque Mínimo por Técnico</h1>
    <h2>${esc(t.nome)} · ${esc(t.regiao||'—')} · gerado em ${hoje}</h2>
    <table><thead><tr><th>Tipo</th><th>Atual</th><th>Mínimo</th><th>Faltam</th></tr></thead><tbody>
      ${tiposComMin.length? tiposComMin.map(tp=>{ const atual=porTipo[tp]||0; const min=DB.tipos[tp].min||0; const falta=Math.max(0,min-atual); return `<tr><td>${esc(tipoNome(tp))}</td><td>${atual}</td><td>${min}</td><td>${falta>0?falta:'OK'}</td></tr>`; }).join('') : '<tr><td colspan="4">Nenhum tipo com mínimo configurado.</td></tr>'}
    </tbody></table>
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}
let estoqueMinFilial = '';
let estoqueMinFilialTec = '';
function renderEstoqueMinimo(){
  const todosAlertas = alertasEstoqueMinPorFilial();
  const filiaisAfetadas = [...new Set(todosAlertas.map(a=>a.filial))].sort();
  const alertas = estoqueMinFilial ? todosAlertas.filter(a=>a.filial===estoqueMinFilial) : todosAlertas;
  const temMinConfigurado = Object.values(DB.tipos).some(t=>(t.min||0)>0);
  const todosAlertasTec = alertasEstoqueMinPorTecnico();
  const filiaisAfetadasTec = [...new Set(todosAlertasTec.map(a=>a.tecnico.regiao).filter(Boolean))].sort();
  if(estoqueMinFilialTec && !filiaisAfetadasTec.includes(estoqueMinFilialTec)) estoqueMinFilialTec='';
  const alertasTec = estoqueMinFilialTec ? todosAlertasTec.filter(a=>a.tecnico.regiao===estoqueMinFilialTec) : todosAlertasTec;
  const tecsComDeficit = new Set(todosAlertasTec.map(a=>a.tecnico.id));
  $('#content').innerHTML = `
  ${!temMinConfigurado?`<div class="panel" style="margin-bottom:18px;border-left:4px solid var(--amber)"><div class="pb">Nenhum tipo tem estoque mínimo configurado ainda. ${souAdmin()?'Vá em <b>Dados</b> e clique em "'+ic('target')+' Aplicar estoque mínimo oficial", ou defina manualmente em <b>Tipos</b>.':'Peça para um administrador configurar.'}</div></div>`:''}
  <div class="grid kpis" style="margin-bottom:20px">
    ${kpi('r','package','Total de equipamentos faltando',alertas.reduce((s,a)=>s+a.deficit,0))}
    ${(()=>{ const porTipo={}; alertas.forEach(a=>{ porTipo[a.tipo]=(porTipo[a.tipo]||0)+a.deficit; }); const arr=Object.entries(porTipo).sort((a,b)=>b[1]-a[1]);
      const texto = arr.length? esc(tipoNome(arr[0][0]))+' <span style="font-size:16px;color:var(--txt-soft)">('+arr[0][1]+')</span>' : '—';
      return `<div class="kpi v"><div class="ic">${ic('target')}</div><div class="lbl">Tipo mais crítico</div><div class="val" style="font-size:22px">${texto}</div></div>`; })()}
    ${kpi('a','building-2','Filiais afetadas',filiaisAfetadas.length)}
  </div>
  ${filiaisAfetadas.length?`
  <div class="panel" style="margin-bottom:18px"><div class="pb" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="font-weight:700;font-size:12.5px;color:var(--txt-soft)">${ic('building-2')} FILTRAR POR FILIAL</span>
    <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0;gap:8px">
      <button class="${!estoqueMinFilial?'active':''}" style="background:${!estoqueMinFilial?'var(--brand)':'var(--panel-soft)'};color:${!estoqueMinFilial?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="estoqueMinFilial='';renderEstoqueMinimo()">Todas <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${todosAlertas.length}</span></button>
      ${filiaisAfetadas.map(f=>{ const n=todosAlertas.filter(a=>a.filial===f).length; const on=estoqueMinFilial===f; return `
        <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="estoqueMinFilial=(estoqueMinFilial==='${esc(f)}')?'':'${esc(f)}';renderEstoqueMinimo()">${esc(f)} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'var(--surface-2)'};color:inherit;margin-left:4px">${n}</span></button>`;}).join('')}
    </div>
    <div class="spacer"></div>
    <button class="btn sm" onclick="exportarEstoqueMinExcel()">${ic('bar-chart-3')} Exportar Excel</button><button class="btn sm" onclick="gerarRelatorioEstoqueMin()">${ic('printer')} Gerar relatório</button>
  </div></div>`:''}
  ${alertas.length?`
  <div class="chart-row" style="margin-bottom:20px">
    <div class="panel">
      <div class="ph"><h3>${ic('bar-chart-3')} Necessidade por tipo de equipamento</h3></div>
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
    <div class="ph"><h3>${ic('building-2')} Necessidade por filial</h3><span class="muted" style="font-size:11px;font-weight:500;margin-left:6px">(clique para filtrar)</span></div>
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
  <div class="panel" style="margin-bottom:18px"><div class="ph"><h3>${ic('hard-hat')} Estoque por técnico em ${esc(estoqueMinFilial)}</h3><span class="muted" style="font-size:11px;font-weight:500;margin-left:6px">(clique para ver a ficha completa)</span></div>
    <div class="pb">
      ${(()=>{ const tecs=DB.tecnicos.filter(t=>t.regiao===estoqueMinFilial); if(!tecs.length) return '<div class="empty">Nenhum técnico cadastrado nessa filial.</div>';
        return `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${tecs.map(t=>{
          const itens = itensDoTecnico(t.id);
          const porTipo={}; itens.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
          const abaixoDoMin = tecsComDeficit.has(t.id);
          return `<div class="panel" style="box-shadow:none;cursor:pointer${abaixoDoMin?';border-color:var(--red)':''}" onclick="verEstoqueTecnico('${t.id}')"><div class="pb">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><b>${esc(t.nome)}</b>${abaixoDoMin?`<span class="badge baixado" style="font-size:10px">${ic('alert-triangle')} pessoal baixo</span>`:''}<span class="count-badge" style="margin-left:auto">${itens.length}</span></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">${Object.keys(porTipo).length?Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tp,n])=>`<span class="tag-tipo" style="border-left:3px solid ${tipoCor(tp)};font-size:11px">${esc(tipoNome(tp))}: ${n}</span>`).join(''):'<span class="muted" style="font-size:12px">Nenhum item</span>'}</div>
          </div></div>`;}).join('')}</div>`; })()}
    </div>
  </div>`:''}
  ${todosAlertasTec.length?`
  <div class="panel" style="margin-bottom:18px;border-left:4px solid var(--red)"><div class="ph"><h3>${ic('hard-hat')}${ic('alert-triangle')} Técnicos abaixo do mínimo pessoal</h3><span class="count-badge">${new Set(alertasTec.map(a=>a.tecnico.id)).size}</span><div class="spacer"></div>${alertasTec.length?`<button class="btn sm" onclick="exportarEstoqueMinTecExcel()">${ic('bar-chart-3')} Exportar Excel</button><button class="btn sm" onclick="gerarRelatorioEstoqueMinTec()">${ic('printer')} Gerar relatório</button>`:''}</div>
    <p class="muted" style="margin:0 12px 8px">Mesmo quando a filial no total está OK, um técnico específico pode estar com menos do que devia carregar.</p>
    <div class="pb" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:0">
      <span style="font-weight:700;font-size:12.5px;color:var(--txt-soft)">${ic('building-2')} FILTRAR POR FILIAL</span>
      <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0;gap:8px">
        <button class="${!estoqueMinFilialTec?'active':''}" style="background:${!estoqueMinFilialTec?'var(--brand)':'var(--panel-soft)'};color:${!estoqueMinFilialTec?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="estoqueMinFilialTec='';renderEstoqueMinimo()">Todas <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${new Set(todosAlertasTec.map(a=>a.tecnico.id)).size}</span></button>
        ${filiaisAfetadasTec.map(f=>{ const n=new Set(todosAlertasTec.filter(a=>a.tecnico.regiao===f).map(a=>a.tecnico.id)).size; const on=estoqueMinFilialTec===f; return `
          <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="estoqueMinFilialTec=(estoqueMinFilialTec==='${esc(f)}')?'':'${esc(f)}';renderEstoqueMinimo()">${esc(f)} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'var(--surface-2)'};color:inherit;margin-left:4px">${n}</span></button>`;}).join('')}
      </div>
    </div>
    <div class="tbl-wrap"><table><thead><tr><th>Técnico</th><th>Filial</th><th>O que falta</th><th class="center">Itens faltando</th></tr></thead><tbody>${(()=>{
      const porTec = {};
      alertasTec.forEach(a=>{ (porTec[a.tecnico.id]=porTec[a.tecnico.id]||{tecnico:a.tecnico, itens:[]}).itens.push(a); });
      const linhas = Object.values(porTec).sort((a,b)=>b.itens.reduce((s,i)=>s+i.deficit,0)-a.itens.reduce((s,i)=>s+i.deficit,0));
      return linhas.map(l=>`<tr style="cursor:pointer" onclick="verEstoqueTecnico('${l.tecnico.id}')">
        <td><b>${esc(l.tecnico.nome)}</b></td>
        <td>${esc(l.tecnico.regiao||'—')}</td>
        <td><div style="display:flex;gap:6px;flex-wrap:wrap">${l.itens.map(a=>`<span class="tag-tipo" style="border-left:3px solid ${tipoCor(a.tipo)}">${esc(tipoNome(a.tipo))}: faltam ${a.deficit}</span>`).join('')}</div></td>
        <td class="center"><b style="color:var(--red)">${l.itens.reduce((s,i)=>s+i.deficit,0)}</b></td>
      </tr>`).join('');
    })()}</tbody></table></div>
  </div>`:''}`;
}
function exportarEstoqueMinExcel(){
  const todosAlertas = alertasEstoqueMinPorFilial();
  const alertas = estoqueMinFilial ? todosAlertas.filter(a=>a.filial===estoqueMinFilial) : todosAlertas;
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const linhas = alertas.map(a=>({ 'Filial':a.filial, 'Tipo':tipoNome(a.tipo), 'Atual':a.atual, 'Mínimo':a.min, 'Faltam':a.deficit }));
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Filial':'','Tipo':'','Atual':'','Mínimo':'','Faltam':'Nenhum item'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Estoque Mínimo');
  XLSX.writeFile(wb, 'estoque_minimo_'+(estoqueMinFilial||'todas_filiais').replace(/[^\w-]+/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
function gerarRelatorioEstoqueMin(){
  const todosAlertas = alertasEstoqueMinPorFilial();
  const alertas = estoqueMinFilial ? todosAlertas.filter(a=>a.filial===estoqueMinFilial) : todosAlertas;
  const titulo = estoqueMinFilial ? 'Filial '+estoqueMinFilial : 'Todas as filiais afetadas';
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Estoque Mínimo</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Relatório de Estoque Mínimo por Filial</h1>
    <h2>${esc(titulo)} · ${alertas.length} item(ns) em falta · gerado em ${hoje}</h2>
    <table><thead><tr><th>Filial</th><th>Tipo</th><th>Atual</th><th>Mínimo</th><th>Faltam</th></tr></thead><tbody>
      ${alertas.length? alertas.map(a=>`<tr><td>${esc(a.filial)}</td><td>${esc(tipoNome(a.tipo))}</td><td>${a.atual}</td><td>${a.min}</td><td>${a.deficit}</td></tr>`).join('') : '<tr><td colspan="5">Nenhuma filial abaixo do mínimo.</td></tr>'}
    </tbody></table>
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}
function exportarEstoqueMinTecExcel(){
  const todosAlertasTec = alertasEstoqueMinPorTecnico();
  const alertasTec = estoqueMinFilialTec ? todosAlertasTec.filter(a=>a.tecnico.regiao===estoqueMinFilialTec) : todosAlertasTec;
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const linhas = alertasTec.map(a=>({ 'Técnico':a.tecnico.nome, 'Filial':a.tecnico.regiao||'—', 'Tipo':tipoNome(a.tipo), 'Atual':a.atual, 'Mínimo':a.min, 'Faltam':a.deficit }));
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Técnico':'','Filial':'','Tipo':'','Atual':'','Mínimo':'','Faltam':'Nenhum item'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Mínimo por Técnico');
  XLSX.writeFile(wb, 'estoque_minimo_tecnicos_'+(estoqueMinFilialTec||'todas_filiais').replace(/[^\w-]+/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
function gerarRelatorioEstoqueMinTec(){
  const todosAlertasTec = alertasEstoqueMinPorTecnico();
  const alertasTec = estoqueMinFilialTec ? todosAlertasTec.filter(a=>a.tecnico.regiao===estoqueMinFilialTec) : todosAlertasTec;
  const titulo = estoqueMinFilialTec ? 'Filial '+estoqueMinFilialTec : 'Todas as filiais afetadas';
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const porTec = {}; alertasTec.forEach(a=>{ (porTec[a.tecnico.id]=porTec[a.tecnico.id]||{tecnico:a.tecnico, itens:[]}).itens.push(a); });
  const linhas = Object.values(porTec).sort((a,b)=>b.itens.reduce((s,i)=>s+i.deficit,0)-a.itens.reduce((s,i)=>s+i.deficit,0));
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Técnicos Abaixo do Mínimo</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    h3{font-size:14px;margin:22px 0 8px;border-bottom:2px solid #dc2626;padding-bottom:4px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Relatório de Técnicos Abaixo do Mínimo Pessoal</h1>
    <h2>${esc(titulo)} · ${linhas.length} técnico(s) · gerado em ${hoje}</h2>
    ${linhas.length? linhas.map(l=>`
      <h3>${esc(l.tecnico.nome)} — ${esc(l.tecnico.regiao||'—')}</h3>
      <table><thead><tr><th>Tipo</th><th>Atual</th><th>Mínimo</th><th>Faltam</th></tr></thead><tbody>
        ${l.itens.map(a=>`<tr><td>${esc(tipoNome(a.tipo))}</td><td>${a.atual}</td><td>${a.min}</td><td>${a.deficit}</td></tr>`).join('')}
      </tbody></table>`).join('') : '<p>Nenhum técnico abaixo do mínimo.</p>'}
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}

/* =========================================================
   ESTOQUE RMA
   ========================================================= */
let rmaFiliais = [];
let rmaTecnicoFiltro = ''; // id do técnico selecionado no dropdown; vazio = todos
function rmaToggleFilial(d){ const i=rmaFiliais.indexOf(d); if(i>=0) rmaFiliais.splice(i,1); else rmaFiliais.push(d); renderRMA(); }
// Aplica os filtros de filial + técnico atuais — reaproveitado pela tela e pelas
// exportações (Excel/relatório/modal "ver tudo"), mesmo princípio de dashboardFiltrado().
function rmaFiltrado(){
  const baseRma = DB.equipamentos.filter(e=>e.status==='baixado' && !e.perdido && (!souSupervisor()||regiaoPermitida(e.rmaDeposito||e.deposito)));
  const rma = rmaFiliais.length ? baseRma.filter(e=>rmaFiliais.includes(e.rmaDeposito||e.deposito)) : baseRma;
  return rmaTecnicoFiltro ? rma.filter(e=>e.rmaTecnicoId===rmaTecnicoFiltro) : rma;
}
function renderRMA(){
  let todasFiliais = [...new Set(DB.equipamentos.filter(e=>e.status==='baixado' && !e.perdido).map(e=>e.rmaDeposito||e.deposito).filter(Boolean))].sort();
  if(souSupervisor()) todasFiliais = todasFiliais.filter(regiaoPermitida);
  const baseRma = DB.equipamentos.filter(e=>e.status==='baixado' && !e.perdido && (!souSupervisor()||regiaoPermitida(e.rmaDeposito||e.deposito)));
  const rmaPorFilial = rmaFiliais.length ? baseRma.filter(e=>rmaFiliais.includes(e.rmaDeposito||e.deposito)) : baseRma;
  const tecnicosDisponiveis = [...new Map(rmaPorFilial.filter(e=>e.rmaTecnicoId).map(e=>[e.rmaTecnicoId, e.rmaTecnicoId])).keys()]
    .map(id=>DB.tecnicos.find(t=>t.id===id)).filter(Boolean).sort((a,b)=>a.nome.localeCompare(b.nome));
  if(rmaTecnicoFiltro && !tecnicosDisponiveis.some(t=>t.id===rmaTecnicoFiltro)) rmaTecnicoFiltro='';
  const rma = rmaTecnicoFiltro ? rmaPorFilial.filter(e=>e.rmaTecnicoId===rmaTecnicoFiltro) : rmaPorFilial;

  const porTipo={}; rma.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
  const donutTipo = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([t,n])=>[tipoNome(t),n,tipoCor(t)]);

  // "RMA por filial" tem a filial no próprio eixo, então ignora o filtro de filial (pra
  // continuar servindo de seletor clicável) mas RESPEITA o filtro de técnico, se ativo.
  const baseRmaParaDep = rmaTecnicoFiltro ? baseRma.filter(e=>e.rmaTecnicoId===rmaTecnicoFiltro) : baseRma;
  const porDep={}; baseRmaParaDep.forEach(e=>{ const d=e.rmaDeposito||e.deposito||'—'; porDep[d]=(porDep[d]||0)+1; });
  const depArr = Object.entries(porDep).sort((a,b)=>b[1]-a[1]);
  const maxDep = Math.max(1,...depArr.map(d=>d[1]));

  // "RMA por técnico" tem o técnico no próprio eixo — ignora o filtro de técnico (senão
  // colapsaria pra 1 barra só quando um já está selecionado), mas respeita o de filial.
  const porTec={}; rmaPorFilial.forEach(e=>{ const id=e.rmaTecnicoId||'__sem__'; porTec[id]=(porTec[id]||0)+1; });
  const tecArr = Object.entries(porTec).sort((a,b)=>b[1]-a[1]);
  const maxTec = Math.max(1,...tecArr.map(d=>d[1]));

  const recentes = [...rma].sort((a,b)=>(b.rmaDesde||0)-(a.rmaDesde||0)).slice(0,8);

  $('#content').innerHTML = `
  <div class="panel" style="margin-bottom:18px"><div class="pb" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span style="font-weight:700;font-size:12.5px;color:var(--txt-soft);white-space:nowrap">${ic('building-2')} FILIAL ${rmaFiliais.length?`<span class="muted" style="font-weight:500">(${rmaFiliais.length} selecionada${rmaFiliais.length>1?'s':''})</span>`:'<span class="muted" style="font-weight:500">(clique para filtrar)</span>'}</span>
    <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0;gap:8px">
      <button class="${!rmaFiliais.length?'active':''}" style="background:${!rmaFiliais.length?'var(--brand)':'var(--panel-soft)'};color:${!rmaFiliais.length?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="rmaFiliais=[];renderRMA()">Todas <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${baseRma.length}</span></button>
      ${todasFiliais.map(d=>{ const n=baseRma.filter(e=>(e.rmaDeposito||e.deposito)===d).length; const on=rmaFiliais.includes(d); return `
        <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="rmaToggleFilial('${esc(d)}')">${on?ic('check')+' ':''}${esc(d)} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'var(--surface-2)'};color:inherit;margin-left:4px">${n}</span></button>`;}).join('')}
    </div>
    <div class="spacer"></div>
    <div class="field" style="margin:0;min-width:200px"><label style="font-size:11px">${ic('hard-hat')} Filtrar por técnico</label>
      <select onchange="rmaTecnicoFiltro=this.value;renderRMA()">
        <option value="">Todos os técnicos (${tecnicosDisponiveis.length})</option>
        ${tecnicosDisponiveis.map(t=>`<option value="${t.id}" ${rmaTecnicoFiltro===t.id?'selected':''}>${t.regiao?'['+esc(t.regiao)+'] ':''}${esc(t.nome)}</option>`).join('')}
      </select>
    </div>
    ${rma.length?`<button class="btn sm" onclick="exportarRMAExcel()">${ic('bar-chart-3')} Exportar Excel</button><button class="btn sm" onclick="gerarRelatorioRMA()">${ic('printer')} Gerar relatório</button>`:''}
  </div></div>

  <div class="grid kpis" style="margin-bottom:20px">
    ${kpi('r','recycle','Total em RMA',rma.length)}
    ${kpi('v','hard-hat','Técnicos envolvidos',new Set(rma.filter(e=>e.rmaTecnicoId).map(e=>e.rmaTecnicoId)).size)}
    ${kpi('a','building-2','Filiais com RMA',todasFiliais.length)}
  </div>

  <div class="chart-row" style="margin-bottom:20px">
    <div class="panel">
      <div class="ph"><h3>${ic('package')} RMA por tipo de equipamento</h3></div>
      <div class="pb"><div class="donut-wrap">${donutTipo.length?donut(donutTipo):'<div class="empty">Sem dados</div>'}</div></div>
    </div>
    <div class="panel">
      <div class="ph"><h3>${ic('map-pin')} RMA por filial</h3></div>
      <div class="pb">
        ${depArr.length?depArr.map(([d,n])=>{
          const intensidade = n/maxDep; // 0 a 1 — mais itens em RMA = vermelho mais forte/escuro
          const cor = `rgb(${220-Math.round(60*(1-intensidade))},${38+Math.round(90*(1-intensidade))},${38+Math.round(90*(1-intensidade))})`;
          return `
          <div class="bar-row" style="cursor:pointer" onclick="rmaFiliais=['${esc(d)}'];renderRMA()">
            <div class="bl">${esc(d)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/maxDep*100}%;background:${cor}">${n}</div></div>
          </div>`;}).join(''):'<div class="empty">Sem dados</div>'}
      </div>
    </div>
  </div>

  <div class="chart-row">
    <div class="panel">
      <div class="ph"><h3>${ic('hard-hat')} RMA por técnico <span class="muted" style="font-size:11px;font-weight:500">(clique para ver os itens)</span></h3></div>
      <div class="pb">
        ${tecArr.length?tecArr.map(([id,n])=>`
          <div class="bar-row" style="cursor:pointer" onclick="rmaFichaTecnico('${id==='__sem__'?'':id}')">
            <div class="bl">${id==='__sem__'?'Sem técnico (direto do estoque)':esc(tecNome(id))}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/maxTec*100}%;background:${corVar('--amber')}">${n}</div></div>
          </div>`).join(''):'<div class="empty">Sem dados</div>'}
      </div>
    </div>
    <div class="panel">
      <div class="ph"><h3>${ic('clock')} Envios recentes para RMA</h3><div class="spacer"></div><button class="btn sm ghost" onclick="verTodosRMA()">Ver tudo →</button></div>
      <div class="pb" style="padding:8px 0">
        ${recentes.length?recentes.map(e=>`
          <div style="display:flex;align-items:center;gap:11px;padding:9px 20px;border-bottom:1px solid #f1f5f9">
            <span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span>
            <div style="flex:1;min-width:0">
              <div class="mono" style="font-weight:600;font-size:12px">${esc(e.serie)}</div>
              <div class="muted" style="font-size:11.5px">${e.rmaTecnicoId?esc(tecNome(e.rmaTecnicoId)):'—'} · ${esc(e.rmaDeposito||e.deposito||'—')}</div>
            </div>
            ${souAdmin()?`<button class="btn sm ghost" onclick="retornarDoRMA('${esc(e.serie)}')">${ic('undo-2')} Retornar</button>`:''}
          </div>`).join(''):'<div class="empty" style="padding:30px">Nenhum item em RMA.</div>'}
      </div>
    </div>
  </div>`;
}
function exportarRMAExcel(){
  const rma = rmaFiltrado();
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const linhas = rma.map(e=>({ 'Nº Série':e.serie, 'Tipo':tipoNome(e.tipo), 'Filial':e.rmaDeposito||e.deposito||'—', 'Técnico':e.rmaTecnicoId?tecNome(e.rmaTecnicoId):'—', 'Desde':e.rmaDesde?fmtTS(e.rmaDesde):'—' }));
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Nº Série':'','Tipo':'','Filial':'','Técnico':'','Desde':'Nenhum item'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Estoque RMA');
  const sufixoTec = rmaTecnicoFiltro ? '_'+tecNome(rmaTecnicoFiltro) : '';
  XLSX.writeFile(wb, 'estoque_rma_'+(rmaFiliais.length?rmaFiliais.join('_'):'todas_filiais').replace(/[^\w-]+/g,'_')+sufixoTec.replace(/[^\w-]+/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
function gerarRelatorioRMA(){
  const rma = rmaFiltrado();
  const titulo = (rmaFiliais.length ? rmaFiliais.join(', ') : 'Todas as filiais') + (rmaTecnicoFiltro ? ' — '+tecNome(rmaTecnicoFiltro) : '');
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Estoque RMA</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Relatório de Estoque RMA</h1>
    <h2>${esc(titulo)} · ${rma.length} item(ns) · gerado em ${hoje}</h2>
    <table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Filial</th><th>Técnico</th><th>Desde</th></tr></thead><tbody>
      ${rma.length? rma.map(e=>`<tr><td>${esc(e.serie)}</td><td>${esc(tipoNome(e.tipo))}</td><td>${esc(e.rmaDeposito||e.deposito||'—')}</td><td>${e.rmaTecnicoId?esc(tecNome(e.rmaTecnicoId)):'—'}</td><td>${e.rmaDesde?fmtTS(e.rmaDesde):'—'}</td></tr>`).join('') : '<tr><td colspan="5">Nenhum item em RMA.</td></tr>'}
    </tbody></table>
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}
function verTodosRMA(){
  const rma = rmaFiltrado().sort((a,b)=>(b.rmaDesde||0)-(a.rmaDesde||0));
  modal(ic('recycle')+' Todos os itens em RMA', `
    <div class="tbl-wrap" style="max-height:480px">${
      rma.length? `<table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Técnico</th><th>Filial</th><th>Data</th>${souAdmin()?'<th></th>':''}</tr></thead><tbody>
        ${rma.map(e=>`<tr>
          <td class="mono"><a href="#" onclick="abrirKardex('${esc(e.serie)}');return false"><b>${esc(e.serie)}</b></a></td>
          <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span></td>
          <td>${e.rmaTecnicoId?esc(tecNome(e.rmaTecnicoId)):'—'}</td>
          <td>${esc(e.rmaDeposito||e.deposito||'—')}</td>
          <td class="muted">${e.rmaDesde?fmtTS(e.rmaDesde):'—'}</td>
          ${souAdmin()?`<td class="right"><button class="btn sm ghost" onclick="retornarDoRMA('${esc(e.serie)}');closeModal();verTodosRMA()">${ic('undo-2')} Retornar</button></td>`:''}
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nenhum item em RMA.</div>'
    }</div>`, `<button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
}
function rmaFichaTecnico(tecnicoId){
  const itens = DB.equipamentos.filter(e=>e.status==='baixado' && !e.perdido && (e.rmaTecnicoId||null)===(tecnicoId||null) && (!souSupervisor()||regiaoPermitida(e.rmaDeposito||e.deposito)));
  const titulo = tecnicoId? ic('recycle')+' RMA enviado por '+esc(tecNome(tecnicoId)) : ic('map-pin')+' RMA enviado direto do estoque (sem técnico)';

  const porTipo={}; itens.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
  const donutData = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tp,n])=>[tipoNome(tp),n,tipoCor(tp)]);
  const porDep={}; itens.forEach(e=>{ const d=e.rmaDeposito||e.deposito||'—'; porDep[d]=(porDep[d]||0)+1; });
  const depsEnvolvidos = Object.keys(porDep).length;
  const ultimoEnvio = itens.length? Math.max(...itens.map(e=>e.rmaDesde||0)) : null;

  modal(titulo, `
    <div class="chart-row" style="margin-bottom:18px">
      <div class="panel" style="box-shadow:none">
        <div class="ph"><h3>${ic('bar-chart-3')} RMA por tipo de equipamento</h3></div>
        <div class="pb"><div class="donut-wrap">${donutData.length?donut(donutData):'<div class="empty">Nenhum item.</div>'}</div></div>
      </div>
      <div class="panel" style="box-shadow:none">
        <div class="ph"><h3>Resumo</h3></div>
        <div class="pb" style="display:flex;flex-direction:column;gap:14px">
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
            <div class="kpi r" style="padding:14px 16px"><div class="lbl" style="font-size:10px">${ic('recycle')} TOTAL EM RMA</div><div class="val" style="font-size:22px">${itens.length}</div></div>
            <div class="kpi a" style="padding:14px 16px"><div class="lbl" style="font-size:10px">${ic('building-2')} FILIAIS</div><div class="val" style="font-size:22px">${depsEnvolvidos}</div></div>
          </div>
          ${ultimoEnvio?`<div class="muted" style="font-size:12px">Último envio: ${fmtTS(ultimoEnvio)}</div>`:''}
          ${Object.keys(porTipo).length?`<div style="display:flex;gap:8px;flex-wrap:wrap">${Object.entries(porTipo).sort((a,b)=>b[1]-a[1]).map(([tp,n])=>`<span class="tag-tipo" style="border-left:3px solid ${tipoCor(tp)}">${esc(tipoNome(tp))}: ${n}</span>`).join('')}</div>`:''}
        </div>
      </div>
    </div>
    ${souAdmin()&&itens.length?`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <label class="checkbox" style="font-size:12.5px"><input type="checkbox" onchange="document.querySelectorAll('.rmaChk').forEach(c=>c.checked=this.checked)"> Selecionar todos</label>
      <div class="spacer"></div>
      <button class="btn sm green" onclick="retornarSelecionadosRMA('${tecnicoId||''}')">${ic('undo-2')} Retornar selecionados</button>
    </div>`:''}
    <div class="tbl-wrap" style="max-height:320px">${
      itens.length? `<table><thead><tr>${souAdmin()?'<th style="width:30px"></th>':''}<th>Nº Série</th><th>Tipo</th><th>Filial</th><th>Data</th>${souAdmin()?'<th></th>':''}</tr></thead><tbody>
        ${itens.map(e=>`<tr>
          ${souAdmin()?`<td><input type="checkbox" class="rmaChk" value="${esc(e.serie)}"></td>`:''}
          <td class="mono"><a href="#" onclick="abrirKardex('${esc(e.serie)}');return false"><b>${esc(e.serie)}</b></a></td>
          <td><span class="tag-tipo">${esc(tipoNome(e.tipo))}</span></td>
          <td>${esc(e.rmaDeposito||e.deposito||'—')}</td>
          <td class="muted">${e.rmaDesde?fmtTS(e.rmaDesde):'—'}</td>
          ${souAdmin()?`<td class="right"><button class="btn sm ghost" onclick="retornarDoRMA('${esc(e.serie)}');closeModal();rmaFichaTecnico('${tecnicoId||''}')">${ic('undo-2')} Retornar</button></td>`:''}
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nenhum item.</div>'
    }</div>`, `<button class="btn" onclick="exportarRMATecnicoExcel('${tecnicoId||''}')">${ic('bar-chart-3')} Exportar Excel</button><button class="btn" onclick="gerarRelatorioRMATecnico('${tecnicoId||''}')">${ic('printer')} Gerar relatório</button><button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
}
function exportarRMATecnicoExcel(tecnicoId){
  const itens = DB.equipamentos.filter(e=>e.status==='baixado' && !e.perdido && (e.rmaTecnicoId||null)===(tecnicoId||null) && (!souSupervisor()||regiaoPermitida(e.rmaDeposito||e.deposito)));
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const nomeRef = tecnicoId? tecNome(tecnicoId) : 'sem_tecnico';
  const linhas = itens.map(e=>({ 'Nº Série':e.serie, 'Tipo':tipoNome(e.tipo), 'Filial':e.rmaDeposito||e.deposito||'—', 'Desde':e.rmaDesde?fmtTS(e.rmaDesde):'—' }));
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Nº Série':'','Tipo':'','Filial':'','Desde':'Nenhum item'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'RMA');
  XLSX.writeFile(wb, 'rma_'+nomeRef.replace(/[^\w-]+/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
function gerarRelatorioRMATecnico(tecnicoId){
  const itens = DB.equipamentos.filter(e=>e.status==='baixado' && !e.perdido && (e.rmaTecnicoId||null)===(tecnicoId||null) && (!souSupervisor()||regiaoPermitida(e.rmaDeposito||e.deposito)));
  const titulo = tecnicoId? 'RMA enviado por '+tecNome(tecnicoId) : 'RMA enviado direto do estoque (sem técnico)';
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de RMA</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Relatório de RMA</h1>
    <h2>${esc(titulo)} · ${itens.length} item(ns) · gerado em ${hoje}</h2>
    <table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Filial</th><th>Desde</th></tr></thead><tbody>
      ${itens.length? itens.map(e=>`<tr><td>${esc(e.serie)}</td><td>${esc(tipoNome(e.tipo))}</td><td>${esc(e.rmaDeposito||e.deposito||'—')}</td><td>${e.rmaDesde?fmtTS(e.rmaDesde):'—'}</td></tr>`).join('') : '<tr><td colspan="4">Nenhum item.</td></tr>'}
    </tbody></table>
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
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
    resolverPerdidoSeNecessario(e, 'Retorno do RMA para '+destino);
    e.status='estoque'; e.tecnicoId=null; e.deposito=e.rmaDeposito||e.deposito; e.local=e.deposito; e.confirmado=true; e.desde=Date.now();
    registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'retorno_rma', serie, de:'RMA', para:destino, tecnicoId:null, usuario:nomeUsuarioAtual(), obs:'Retorno do RMA ao estoque (admin, em lote)' });
    n++;
  });
  salvar(); closeModal(); render(); flash(`${n} equipamento(s) retornado(s) ao estoque`,'green');
}
function retornarDoRMA(serie){
  if(!souAdmin()) return flash('Somente administradores podem retornar itens do RMA','red');
  const e=DB.equipamentos.find(x=>x.serie===serie); if(!e||e.status!=='baixado') return;
  const destino = e.rmaDeposito||e.deposito||'estoque';
  if(!confirm('Retornar o equipamento '+serie+' do RMA para o estoque de '+destino+'?')) return;
  resolverPerdidoSeNecessario(e, 'Retorno do RMA para '+destino);
  e.status='estoque'; e.tecnicoId=null; e.deposito=e.rmaDeposito||e.deposito; e.local=e.deposito; e.confirmado=true; e.desde=Date.now();
  registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'retorno_rma', serie, de:'RMA', para:destino, tecnicoId:null, usuario:nomeUsuarioAtual(), obs:'Retorno do RMA ao estoque (admin)' });
  salvar(); render(); flash('Equipamento retornado ao estoque','green');
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
    ${movCard('entrada','inbox','Entrada no estoque','Equipamento novo ou que retornou','green')}
    ${movCard('saida','hard-hat','Saída para técnico','Entregar item a um técnico','b')}
    ${movCard('transferencia','repeat','Transferência','Passar item entre técnicos','v')}
    ${movCard('baixa','recycle','Enviar para RMA','Defeito, garantia ou devolução ao fabricante','r')}
  </div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:8px">
    <button class="panel" style="text-align:left;padding:0;border:0;${pendentes.length?'border-left:3px solid var(--amber)':''}" onclick="abrirPendentesConfirmacao()">
      <div class="pb" style="display:flex;gap:14px;align-items:flex-start">
        <div style="font-size:24px;width:50px;height:50px;border-radius:13px;background:var(--amber-soft);color:var(--amber);display:grid;place-items:center;flex-shrink:0">${ic('hourglass')}</div>
        <div style="flex:1"><div style="font-weight:700;font-size:15px;margin-bottom:3px">Aguardando confirmação do técnico ${pendentes.length?`<span class="count-badge" style="margin-left:4px">${pendentes.length}</span>`:''}</div><div class="muted" style="font-size:12.5px">Itens enviados que ainda não foram confirmados</div></div>
      </div></button>
  </div>
  <div class="panel" style="margin-top:18px"><div class="ph"><h3>${ic('clock')} Movimentações recentes</h3><div class="spacer"></div><button class="btn sm ghost" onclick="goto('hist')">Ver histórico →</button></div>
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
    ${movCard('uso_campo','wrench','Registrar uso em campo','Equipamento aplicado no cliente — dá baixa do seu estoque','green')}
    ${actionCard('file-text','Registrar retirada em campo','Equipamento de manutenção ou desinstalação','b','abrirRegistrarForm()')}
    ${movCard('transferencia','repeat','Transferir para outro técnico','Passar um item seu para outro técnico','v')}
    ${movCard('baixa','recycle','Enviar para RMA','Defeito, garantia ou devolução ao fabricante','r')}
  </div>
  ${enviadosPorMim.length?`
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:18px">
    <button class="panel" style="text-align:left;padding:0;border:0;border-left:3px solid var(--amber)" onclick="verMinhasTransferenciasPendentes()">
      <div class="pb" style="display:flex;gap:14px;align-items:flex-start">
        <div style="font-size:24px;width:50px;height:50px;border-radius:13px;background:var(--amber-soft);color:var(--amber);display:grid;place-items:center;flex-shrink:0">${ic('hourglass')}</div>
        <div style="flex:1"><div style="font-weight:700;font-size:15px;margin-bottom:3px">Transferências enviadas <span class="count-badge" style="margin-left:4px">${enviadosPorMim.length}</span></div><div class="muted" style="font-size:12.5px">Aguardando o outro técnico confirmar</div></div>
      </div></button>
  </div>`:''}
  <div class="panel"><div class="ph"><h3>${ic('package')} Meus equipamentos disponíveis</h3><span class="count-badge">${meus}</span></div>
    <div class="pb"><p class="muted">Use os botões acima para transferir ou enviar para RMA. Veja a lista completa em <b>Meus Equipamentos</b>.</p></div>
  </div>`;
}
function verMinhasTransferenciasPendentes(){
  const t = meuTecnico(); if(!t) return;
  const itens = DB.equipamentos.filter(e=>e.emTransito && e.transitoDeTecnicoId===t.id);
  const porDestino = {};
  itens.forEach(e=>{ (porDestino[e.transitoPara]=porDestino[e.transitoPara]||[]).push(e); });
  modal(ic('hourglass')+' Transferências aguardando confirmação', `
    <div style="display:flex;flex-direction:column;gap:14px;max-height:460px;overflow:auto">${
      Object.keys(porDestino).length? Object.entries(porDestino).map(([destId,lista])=>`
        <div class="panel" style="box-shadow:none">
          <div class="ph"><h3 style="font-size:14px">${ic('hard-hat')} ${esc(tecNome(destId))}</h3><span class="count-badge" style="margin-left:8px">${lista.length}</span><div class="spacer"></div>
            <button class="btn sm red ghost" onclick="cancelarLoteTransferencia('${destId}')">${ic('x')} Cancelar tudo deste lote</button>
          </div>
          <div class="pb" style="display:flex;flex-direction:column;gap:8px">
            ${lista.map(e=>`
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 10px;background:var(--panel-soft);border-radius:var(--radius-md)">
                <div style="flex:1;min-width:160px"><span class="mono"><b>${esc(e.serie)}</b></span> <span class="tag-tipo" style="margin-left:6px">${esc(tipoNome(e.tipo))}</span></div>
                <div class="muted" style="font-size:11px">${fmtTS(e.transitoDesde)}</div>
                <button class="btn sm ghost" onclick="cancelarEnvio('${esc(e.serie)}')" aria-label="Cancelar envio">${ic('x')}</button>
              </div>`).join('')}
          </div>
        </div>`).join('') : '<div class="empty"><div class="big">'+ic('check')+'</div>Nada pendente no momento.</div>'
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
  salvar(); closeModal(); render(); flash(`${itens.length} envio(s) cancelado(s)`,'green');
}
let pendConfFilial = '';
let pendConfTec = '';
function abrirPendentesConfirmacao(){
  pendConfFilial=''; pendConfTec='';
  modal(ic('hourglass')+' Aguardando confirmação do técnico', `<div id="pendConfBody"></div>`, `<button class="btn" onclick="gerarRelatorioPendentes()">${ic('printer')} Gerar relatório</button><button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
  renderPendentesConfirmacaoBody();
}
function sincronizarFiltrosPendentes(porDestino){
  const filiaisComPendencia = [...new Set(Object.keys(porDestino).map(id=>{ const t=DB.tecnicos.find(x=>x.id===id); return t?t.regiao:null; }).filter(Boolean))].sort();
  if(pendConfFilial && !filiaisComPendencia.includes(pendConfFilial)) pendConfFilial='';
  const tecsComPendencia = Object.keys(porDestino).map(id=>DB.tecnicos.find(x=>x.id===id)).filter(Boolean)
    .filter(t=>!pendConfFilial||t.regiao===pendConfFilial);
  if(pendConfTec && !tecsComPendencia.some(t=>t.id===pendConfTec)) pendConfTec='';
  return { filiaisComPendencia, tecsComPendencia };
}
function calcularGruposPendentes(){
  const pendentes = pendentesConfirmacaoLista();
  const porDestino = {};
  pendentes.forEach(e=>{ (porDestino[e.transitoPara]=porDestino[e.transitoPara]||[]).push(e); });
  const filiaisComPendencia = [...new Set(Object.keys(porDestino).map(id=>{ const t=DB.tecnicos.find(x=>x.id===id); return t?t.regiao:null; }).filter(Boolean))].sort();
  const tecsComPendencia = Object.keys(porDestino).map(id=>DB.tecnicos.find(x=>x.id===id)).filter(Boolean)
    .filter(t=>!pendConfFilial||t.regiao===pendConfFilial);
  let grupos = Object.entries(porDestino);
  if(pendConfTec) grupos = grupos.filter(([id])=>id===pendConfTec);
  else if(pendConfFilial) grupos = grupos.filter(([id])=>{ const t=DB.tecnicos.find(x=>x.id===id); return t&&t.regiao===pendConfFilial; });
  grupos = grupos.sort((a,b)=>b[1].length-a[1].length);
  return { grupos, porDestino, filiaisComPendencia, tecsComPendencia };
}
// Só a tela de confirmação (dono dos filtros pendConfFilial/pendConfTec) pode corrigi-los;
// outros leitores (ex.: relatório) usam calcularGruposPendentes() sem alterar o filtro global.
function gruposPendentesFiltrados(){
  const { porDestino } = calcularGruposPendentes();
  sincronizarFiltrosPendentes(porDestino);
  return calcularGruposPendentes();
}
function renderPendentesConfirmacaoBody(){
  const { grupos, filiaisComPendencia, tecsComPendencia } = gruposPendentesFiltrados();
  $('#pendConfBody').innerHTML = `
    <div class="row2" style="margin-bottom:14px">
      <div class="field" style="margin:0"><label>Filtrar por filial</label>
        <select onchange="pendConfFilial=this.value;pendConfTec='';renderPendentesConfirmacaoBody()">
          <option value="">Todas (${filiaisComPendencia.length})</option>
          ${filiaisComPendencia.map(f=>`<option value="${esc(f)}" ${pendConfFilial===f?'selected':''}>${esc(f)}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="margin:0"><label>Filtrar por técnico</label>
        <select onchange="pendConfTec=this.value;renderPendentesConfirmacaoBody()">
          <option value="">Todos (${tecsComPendencia.length})</option>
          ${tecsComPendencia.map(t=>`<option value="${t.id}" ${pendConfTec===t.id?'selected':''}>${esc(t.nome)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:14px;max-height:400px;overflow:auto">${
      grupos.length? grupos.map(([destId,lista])=>`
        <div class="panel" style="box-shadow:none">
          <div class="ph"><h3 style="font-size:14px">${ic('hard-hat')} ${esc(tecNome(destId))}</h3><span class="count-badge" style="margin-left:8px">${lista.length}</span><div class="spacer"></div>
            ${souAdmin()||souSupervisor()?`<button class="btn sm red ghost" onclick="cancelarLotePendente('${destId}')">${ic('x')} Cancelar tudo deste lote</button>`:''}
          </div>
          <div class="pb" style="display:flex;flex-direction:column;gap:8px">
            ${lista.map(e=>`
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 10px;background:var(--panel-soft);border-radius:var(--radius-md)">
                <div style="flex:1;min-width:180px">
                  <span class="mono"><b>${esc(e.serie)}</b></span> <span class="tag-tipo" style="margin-left:6px">${esc(tipoNome(e.tipo))}</span>
                  <div class="muted" style="font-size:11px;margin-top:2px">${esc(e.transitoDe||'—')} · enviado por ${esc(e.transitoUsuario||'—')} · ${fmtTS(e.transitoDesde)}</div>
                </div>
                ${souAdmin()||souSupervisor()?`<button class="btn sm ghost" onclick="cancelarEnvio('${esc(e.serie)}')" aria-label="Cancelar envio">${ic('x')}</button>`:''}
              </div>`).join('')}
          </div>
        </div>`).join('') : '<div class="empty"><div class="big">'+ic('check')+'</div>Nada pendente no momento.</div>'
    }</div>`;
}
function gerarRelatorioPendentes(){
  const { grupos } = calcularGruposPendentes();
  const totalItens = grupos.reduce((s,[,l])=>s+l.length,0);
  const titulo = pendConfTec ? tecNome(pendConfTec) : (pendConfFilial ? 'Filial '+pendConfFilial : 'Todas as pendências');
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Pendências</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    h3{font-size:14px;margin:22px 0 8px;border-bottom:2px solid #d97706;padding-bottom:4px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Relatório de Equipamentos Pendentes de Confirmação</h1>
    <h2>${esc(titulo)} · ${totalItens} item(ns) · gerado em ${hoje}</h2>
    ${grupos.length? grupos.map(([destId,lista])=>`
      <h3>${esc(tecNome(destId))} — ${lista.length} item(ns)</h3>
      <table><thead><tr><th>Nº Série</th><th>Tipo</th><th>De</th><th>Para</th><th>Enviado por</th><th>Data</th></tr></thead><tbody>
        ${lista.map(e=>`<tr><td>${esc(e.serie)}</td><td>${esc(tipoNome(e.tipo))}</td><td>${esc(e.transitoDe||'—')}</td><td>${esc(tecNome(destId))}</td><td>${esc(e.transitoUsuario||'—')}</td><td>${fmtTS(e.transitoDesde)}</td></tr>`).join('')}
      </tbody></table>`).join('') : '<p>Nenhuma pendência encontrada.</p>'}
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}
function cancelarLotePendente(destinoId){
  if(!souAdmin() && !souSupervisor()) return flash('Você não pode cancelar esses envios','red');
  const itens = pendentesConfirmacaoLista().filter(e=>e.transitoPara===destinoId);
  if(!itens.length) return;
  if(!confirm('Cancelar o envio de '+itens.length+' equipamento(s) para '+tecNome(destinoId)+'?')) return;
  itens.forEach(e=>{
    const destino = tecNome(e.transitoPara);
    e.emTransito=false; e.transitoPara=null; e.transitoDesde=null; e.transitoDe=null; e.transitoUsuario=null; e.transitoDeTecnicoId=null;
    registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'cancelamento', serie:e.serie, de:'Em trânsito', para:destino+' (cancelado em lote)', tecnicoId:null, usuario:nomeUsuarioAtual(), obs:'Envio cancelado em lote antes da confirmação' });
  });
  salvar(); render();
  if($('#pendConfBody')) renderPendentesConfirmacaoBody(); else closeModal();
  flash(`${itens.length} envio(s) cancelado(s)`,'green');
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
  salvar(); render();
  if($('#pendConfBody')) renderPendentesConfirmacaoBody();
  else if(document.getElementById('modalBg') && document.getElementById('modalBg').classList.contains('show')) closeModal();
  flash('Envio cancelado','green');
}
function movCard(tipo,icone,titulo,desc,cor){
  return actionCard(icone,titulo,desc,cor,`openMov(null,'${tipo}')`);
}
function actionCard(icone,titulo,desc,cor,onclickJs){
  const cores={green:'var(--green)',b:'var(--brand)',v:'var(--violet)',r:'var(--red)'};
  return `<button class="panel" style="text-align:left;padding:0;border:0" onclick="${onclickJs}">
    <div class="pb" style="display:flex;gap:14px;align-items:flex-start">
      <div style="font-size:24px;width:50px;height:50px;border-radius:13px;background:${cores[cor]}1a;color:${cores[cor]};display:grid;place-items:center;flex-shrink:0">${ic(icone)}</div>
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
  salvar(); render(); flash(`${novos} técnico(s) importado(s)${TECNICOS_PADRAO.length-novos>0?', '+(TECNICOS_PADRAO.length-novos)+' já existiam':''}`,'green');
}
function renderTecnicos(){
  const tecnicosLista = souSupervisor() ? DB.tecnicos.filter(t=>regiaoPermitida(t.regiao)) : DB.tecnicos;
  $('#content').innerHTML = `
  <div class="toolbar">
    <div style="flex:1"></div>
    ${souAdmin()?`<button class="btn" onclick="importarTecnicosPadrao()">${ic('clipboard-list')} Importar lista oficial</button>`:''}
    <button class="btn primary" onclick="openTec()">＋ Novo técnico</button>
  </div>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
    ${tecnicosLista.length? tecnicosLista.map(t=>{
      const itens = itensDoTecnico(t.id);
      const aud = ultimaAuditoria('tecnico',t.id);
      return `<div class="panel" style="cursor:pointer" onclick="fichaTecnico('${t.id}')"><div class="pb">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <div style="width:44px;height:44px;border-radius:50%;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;font-weight:800;font-size:17px">${esc((t.nome||'?')[0].toUpperCase())}</div>
          <div style="flex:1"><div style="font-weight:700;font-size:15px">${esc(t.nome)}</div><div class="muted" style="font-size:12px">${esc(t.regiao||'Sem região')} ${t.matricula?'· '+esc(t.matricula):''}</div></div>
          <button class="btn sm ghost" onclick="event.stopPropagation();openTec('${t.id}')" aria-label="Editar técnico">${ic('pencil')}</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--panel-soft);border-radius:10px">
          <span class="badge ${itens.length?'com_tecnico':'gray'}">${itens.length} em posse</span>
          <span class="badge ${aud?'estoque':'gray'}" style="font-size:10.5px">${aud?'auditado '+new Date(aud.ts).toLocaleDateString('pt-BR'):'nunca auditado'}</span>
          <span class="btn sm ghost" style="margin-left:auto">ver ficha →</span>
        </div>
      </div></div>`;
    }).join('') : `<div class="panel" style="grid-column:1/-1"><div class="empty"><div class="big">${ic('hard-hat')}</div>Nenhum técnico cadastrado.<br><button class="btn primary" style="margin-top:14px" onclick="openTec()">＋ Cadastrar primeiro técnico</button></div></div>`}
  </div>`;
}
function verTecItens(id){
  const itens = DB.equipamentos.filter(e=>e.tecnicoId===id && e.status==='com_tecnico');
  modal(`Itens com ${esc(tecNome(id))}`, `<div class="tbl-wrap" style="max-height:420px">${tabelaEquipSimples(itens)}</div>`, '', 'lg');
}

/* =========================================================
   HISTÓRICO
   ========================================================= */
// eqTipo/eqStatus/eqDep filtram pelo estado ATUAL do equipamento (resolvido pela série —
// movimentações não guardam tipo/status/depósito próprios, só o snapshot de "de"/"para"
// em texto). tec filtra pelo técnico envolvido na movimentação (tecnicoId OU tecnicoIdOrigem
// — mesmo critério de "meu" usado na política de RLS de movimentacoes).
let histFiltro={ tipo:'', q:'', eqTipo:'', eqStatus:'', eqDep:'', tec:'' };
function renderHist(){
  const deps = [...new Set(DB.equipamentos.map(e=>e.deposito).filter(Boolean))].sort();
  const tecsOpt = agruparTecsPorFilialOpt([...DB.tecnicos].sort((a,b)=>a.nome.localeCompare(b.nome)), histFiltro.tec);
  $('#content').innerHTML = `
  <div class="toolbar">
    <div class="search"><span class="si">${ic('search')}</span><input placeholder="Buscar por nº de série..." value="${esc(histFiltro.q)}" oninput="histFiltro.q=this.value;renderHistTabela()"></div>
    <select class="filter" onchange="histFiltro.tipo=this.value;renderHistTabela()">
      <option value="">Todos os tipos de mov.</option>
      ${Object.entries(MOV_LABEL).map(([k,v])=>`<option value="${k}" ${histFiltro.tipo===k?'selected':''}>${v}</option>`).join('')}
    </select>
    <select class="filter" onchange="histFiltro.eqTipo=this.value;renderHistTabela()">
      <option value="">Todos os tipos</option>
      ${Object.keys(DB.tipos).map(t=>`<option value="${t}" ${histFiltro.eqTipo===t?'selected':''}>${esc(tipoNome(t))}</option>`).join('')}
    </select>
    <select class="filter" onchange="histFiltro.eqStatus=this.value;renderHistTabela()">
      <option value="">Todos os status</option>
      ${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${histFiltro.eqStatus===k?'selected':''}>${v}</option>`).join('')}
    </select>
    <select class="filter" onchange="histFiltro.eqDep=this.value;renderHistTabela()">
      <option value="">Todos os depósitos</option>
      ${deps.map(d=>`<option value="${d}" ${histFiltro.eqDep===d?'selected':''}>${esc(d)}</option>`).join('')}
    </select>
    <select class="filter" onchange="histFiltro.tec=this.value;renderHistTabela()">
      <option value="">Todos os técnicos</option>
      ${tecsOpt}
    </select>
    <button class="btn" onclick="exportarHistCSV()">${ic('download')} Exportar CSV</button>
  </div>
  <div class="panel"><div class="ph"><h3>Histórico de movimentações</h3><span class="count-badge" id="histCount"></span></div>
    <div class="tbl-wrap" id="histTabela"></div></div>`;
  renderHistTabela();
}
// Mapeia o TIPO da movimentação pro status que ELA PRÓPRIA produziu no equipamento —
// usado pelo filtro de status do Histórico (BUG-049). 'saida'/'transferencia' ficam de
// fora do mapa de propósito: são um estado PENDENTE (aguardando confirmação) — o campo
// status do equipamento nem chega a mudar nessa hora (só muda quando confirmado, via
// 'confirmacao'/'registro_campo'), então não corresponde de verdade a nenhum dos 4
// status fixos; o mesmo vale pra 'cancelamento' (reverte o trânsito, não define um
// status novo) e 'exclusao' (o item deixou de existir, não tem status). Essas ficam
// visíveis só em "Todos os status", nunca num filtro de status específico.
function movStatusResultante(m){
  const MAPA = { entrada:'estoque', retorno_rma:'estoque', confirmacao:'com_tecnico', registro_campo:'com_tecnico', baixa:'baixado', uso_campo:'instalado' };
  return MAPA[m.tipo] || null;
}
// Aplica todos os filtros de Histórico atuais — reaproveitado pela tela e pela
// exportação CSV, pra exportar sempre bater com o que está na tela.
function historicoFiltrado(){
  const q=histFiltro.q.trim().toLowerCase();
  // eqTipo/eqDep olham o estado ATUAL do equipamento (achado pela série) — são
  // propriedades que não mudam a cada movimentação (tipo nunca muda; depósito raramente).
  // eqStatus é diferente: olha o status que A PRÓPRIA movimentação produziu (ver
  // movStatusResultante), não o status atual do equipamento — senão filtrar por status
  // trazia a VIDA INTEIRA do item (toda idas a campo/RMA de meses atrás de um item que
  // hoje só por acaso está "Em estoque"), em vez de só as movimentações daquele status
  // (achado ao vivo pelo usuário, BUG-049).
  return DB.movimentacoes.filter(m=>{
    if(histFiltro.tipo && m.tipo!==histFiltro.tipo) return false;
    if(q && !m.serie.toLowerCase().includes(q)) return false;
    if(histFiltro.tec && m.tecnicoId!==histFiltro.tec && m.tecnicoIdOrigem!==histFiltro.tec) return false;
    if(histFiltro.eqStatus && movStatusResultante(m)!==histFiltro.eqStatus) return false;
    if(histFiltro.eqTipo || histFiltro.eqDep){
      const e = acharEquipPorSerie(m.serie);
      if(!e) return false;
      if(histFiltro.eqTipo && e.tipo!==histFiltro.eqTipo) return false;
      if(histFiltro.eqDep && e.deposito!==histFiltro.eqDep) return false;
    }
    return true;
  }).reverse();
}
function renderHistTabela(){
  const lista = historicoFiltrado();
  $('#histCount') && ($('#histCount').textContent = lista.length+' registros');
  $('#histTabela').innerHTML = lista.length? tabelaMov(lista.slice(0,800)) : `<div class="empty"><div class="big">${ic('clock')}</div>Nenhuma movimentação registrada.</div>`;
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
  paraRemover.forEach(c=>{ delete DB.tipos[c]; delete ultimoSyncTipos[c]; });
  salvar(); render(); flash(`${paraRemover.length} tipo(s) duplicado(s) removido(s)`,'green');
  // Exclusão no banco é EXPLÍCITA (ver BUG-052) — a sincronização não infere mais
  // exclusões pela diferença do array local.
  excluirTiposNoBanco(paraRemover).catch(err=>{
    flash('A remoção dos '+paraRemover.length+' tipo(s) NÃO foi aplicada na nuvem ('+err.message+') — eles vão reaparecer. Tente de novo com conexão.','red');
  });
}
async function excluirTiposNoBanco(codigos){
  const { error } = await sb.from('tipos').delete().in('codigo', codigos);
  if(error) throw error;
}
function renderTipos(){
  const cods=Object.keys(DB.tipos);
  $('#content').innerHTML = `
  <div class="panel"><div class="ph"><h3>${ic('tag')} Tipos de equipamento</h3><div class="spacer"></div>${souAdmin()?`<button class="btn sm" onclick="corrigirTiposDuplicados()">${ic('eraser')} Remover duplicados sem uso</button>`:''}<button class="btn sm primary" onclick="openTipo()">＋ Adicionar tipo</button></div>
  <div class="pb">
    <p class="muted" style="margin-bottom:16px">Dê um nome amigável a cada código (ex.: <b>UBI.0001 → "Sirene"</b>). Os nomes aparecem em todo o dashboard.</p>
    ${cods.length? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
      ${cods.map(c=>{ const n=DB.equipamentos.filter(e=>e.tipo===c).length; const emEst=DB.equipamentos.filter(e=>e.tipo===c&&e.status==='estoque').length; const min=DB.tipos[c].min||0; return `
        <div class="panel" style="box-shadow:none"><div class="pb" style="display:flex;align-items:center;gap:12px">
          <span style="width:14px;height:14px;border-radius:4px;background:${tipoCor(c)};flex-shrink:0"></span>
          <div style="flex:1"><div style="font-weight:700">${esc(tipoNome(c))}</div><div class="mono muted" style="font-size:12px">${esc(c)} · ${n} itens · ${emEst} em estoque${min>0?` · mín/técnico ${min}`:''}</div></div>
          <button class="btn sm ghost" onclick="openTipo('${esc(c)}')" aria-label="Editar tipo">${ic('pencil')}</button>
        </div></div>`;}).join('')}
    </div>`: `<div class="empty">Nenhum tipo. Importe dados ou adicione manualmente.</div>`}
  </div></div>`;
}

/* =========================================================
   FILIAIS / DEPÓSITOS
   ========================================================= */
function renderFiliais(){
  const filiais = todasFiliaisConhecidas();
  const todosAlertasMin = alertasEstoqueMinPorFilial();
  const alertasPorFilial = {};
  todosAlertasMin.forEach(a=>{ alertasPorFilial[a.filial]=(alertasPorFilial[a.filial]||0)+1; });
  $('#content').innerHTML = `
  <div class="panel"><div class="ph"><h3>${ic('building-2')} Filiais / Depósitos</h3><div class="spacer"></div><button class="btn sm primary" onclick="openFilial()">＋ Adicionar filial</button></div>
  <div class="pb">
    <p class="muted" style="margin-bottom:16px">Cadastre uma filial mesmo antes dela ter equipamentos ou técnicos — assim ela já aparece nos filtros e telas do sistema.</p>
    ${filiais.length? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
      ${filiais.map(f=>{ const n=DB.equipamentos.filter(e=>e.deposito===f).length; const tecs=DB.tecnicos.filter(t=>t.regiao===f).length; const alertas=alertasPorFilial[f]||0; return `
      <div class="panel" style="box-shadow:none;cursor:pointer" onclick="abrirFilial('${esc(f)}')"><div class="pb">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><div style="font-weight:700;font-size:15px">${esc(f)}</div>${alertas?`<span class="badge baixado" style="font-size:10px;margin-left:auto">${ic('alert-triangle')} ${alertas}</span>`:''}</div>
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
  modal(ic('building-2')+' '+esc(f), `
    <div class="grid kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
      ${kpi('b','package','Total',eqs.length)}
      ${kpi('g','check','Em estoque',emEstoque)}
      ${kpi('a','hard-hat','Com técnicos',comTec)}
      ${kpi('r','recycle','RMA',rma)}
    </div>
    ${alertasFilial.length?`<div class="badge baixado" style="padding:8px 12px;margin-bottom:16px">${ic('alert-triangle')} ${alertasFilial.length} tipo(s) abaixo do estoque mínimo</div>`:''}
    <h4 style="margin-bottom:8px;font-size:13.5px">${ic('hard-hat')} Técnicos vinculados (${tecs.length})</h4>
    <div class="tbl-wrap" style="max-height:220px">${
      tecs.length? `<table><tbody>${tecs.map(t=>{ const n=itensDoTecnico(t.id).length; return `
        <tr style="cursor:pointer" onclick="closeModal();verEstoqueTecnico('${t.id}')"><td>${esc(t.nome)}</td><td class="right"><span class="count-badge">${n} itens</span></td></tr>`;}).join('')}</tbody></table>`
      : '<div class="empty">Nenhum técnico vinculado a essa filial.</div>'
    }</div>`,
    `${podeExcluir?`<button class="btn red ghost" style="margin-right:auto" onclick="excluirFilial('${esc(f)}')">${ic('trash-2')} Excluir filial</button>`:`<span class="muted" style="margin-right:auto;font-size:11.5px;max-width:260px">Só é possível excluir filiais sem equipamentos e sem técnicos vinculados.</span>`}
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
  salvar(); closeModal(); render(); flash('Filial adicionada','green');
}
function excluirFilial(f){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  // BUG-052: equipamentos.deposito/rma_deposito e tecnicos.regiao têm FK pra
  // filiais.sigla — excluir uma filial ainda em uso falharia no banco (corretamente).
  // Checar aqui evita o erro só aparecer depois, escondido numa sincronização.
  const emUso = DB.equipamentos.some(e=>e.deposito===f || e.rmaDeposito===f) || DB.tecnicos.some(t=>t.regiao===f);
  if(emUso) return flash('Essa filial ainda está em uso (equipamento ou técnico) — mova tudo antes de excluir.','red');
  if(!confirm('Excluir a filial '+f+'?')) return;
  DB.filiais = (DB.filiais||[]).filter(x=>x!==f);
  ultimoSyncFiliais.delete(f);
  salvar(); closeModal(); render(); flash('Filial excluída','green');
  // Exclusão no banco é EXPLÍCITA (ver BUG-052) — a sincronização não infere mais
  // exclusões pela diferença do array local.
  excluirFilialNoBanco(f).catch(err=>{
    flash('A exclusão da filial NÃO foi aplicada na nuvem ('+err.message+') — ela vai reaparecer. Tente de novo com conexão.','red');
  });
}
async function excluirFilialNoBanco(sigla){
  const { error } = await sb.from('filiais').delete().eq('sigla', sigla);
  if(error) throw error;
}

/* =========================================================
   DADOS — importar / exportar
   ========================================================= */
function renderDados(){
  const c=DB.config.importadoEm;
  $('#content').innerHTML = `
  <div class="grid" style="grid-template-columns:1fr 1fr">
    <div class="panel"><div class="ph"><h3>${ic('clipboard-list')} Colar dados da planilha</h3></div><div class="pb">
      <p class="muted" style="margin-bottom:12px">Selecione tudo no Excel (com o cabeçalho) → Copiar → cole aqui. Reconhece as colunas <b>Nº Série, Produto, Depósito, Data Entrada</b>.</p>
      <div class="field"><textarea id="pasteArea" rows="8" placeholder="Cole aqui os dados copiados do Excel..." style="font-family:Consolas,monospace;font-size:12px"></textarea></div>
      <label class="checkbox" style="margin-bottom:12px"><input type="checkbox" id="pasteSubstituir"> Substituir todo o inventário (senão, adiciona/atualiza)</label>
      <button class="btn primary" onclick="importarColado()">Importar dados colados</button>
    </div></div>

    <div class="panel"><div class="ph"><h3>${ic('folder-open')} Abrir arquivo Excel / CSV</h3></div><div class="pb">
      <p class="muted" style="margin-bottom:12px">Abra direto o arquivo <b>.xlsx</b> ou <b>.csv</b> do seu inventário.</p>
      <div class="field"><input type="file" id="fileInput" accept=".xlsx,.xls,.csv" onchange="importarArquivo(this)"></div>
      ${window.__noXLSX?`<div class="badge baixado" style="margin-bottom:10px">${ic('alert-triangle')} Leitura de .xlsx indisponível (sem internet). Use CSV ou cole os dados.</div>`:''}
      <label class="checkbox"><input type="checkbox" id="fileSubstituir" checked> Substituir todo o inventário ao importar</label>
    </div></div>
  </div>
  ${souAdmin()?`
  <div class="panel" style="margin-top:18px"><div class="ph"><h3>${ic('inbox')} Importar chips (colar do portal da operadora)</h3></div><div class="pb">
    <p class="muted" style="margin-bottom:12px">Cole aqui o texto copiado direto do portal da operadora (Virtueyes). O sistema reconhece o ICCID de cada chip e a operadora (Claro/TIM) automaticamente — depois você escolhe o técnico e confirma o envio do lote inteiro.</p>
    <div class="field"><textarea id="chipPasteArea" rows="8" placeholder="Cole aqui os dados copiados do portal..." style="font-family:Consolas,monospace;font-size:12px"></textarea></div>
    <button class="btn primary" onclick="reconhecerChipsColados()">${ic('search')} Reconhecer chips</button>
  </div></div>`:''}
  ${souAdmin()?`
  <div class="panel" style="margin-top:18px"><div class="ph"><h3>${ic('inbox')} Importar chips em lote — já em mãos dos técnicos (planilha)</h3></div><div class="pb">
    <p class="muted" style="margin-bottom:12px">Pra dar entrada de uma vez em chips que os técnicos já têm fisicamente, cada um no perfil do técnico certo. Reconhece as colunas <b>IccId</b> (ou Nº Série) e <b>Técnico</b> (obrigatórias), além de <b>Operadora</b>, <b>Linha</b> e <b>Entregue</b> (data em que o técnico recebeu — opcional, mas quando vier é usada como a data real do envio, não a de hoje). O nome do técnico é reconhecido mesmo com prefixo de filial na frente (ex.: "SOO - EPV - A365 - Fulano de Tal" vira "Fulano de Tal"). Antes de confirmar, você revisa linha por linha — cada chip entra em trânsito para o técnico indicado, que confirma o recebimento na tela dele, igual a qualquer outro envio.</p>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="field"><label>Colar dados da planilha</label>
        <textarea id="chipTecPasteArea" rows="6" placeholder="Cole aqui os dados copiados do Excel (com o cabeçalho)..." style="font-family:Consolas,monospace;font-size:12px"></textarea>
        <button class="btn primary" style="margin-top:10px" onclick="importarColadoChipsTecnico()">${ic('search')} Reconhecer chips</button>
      </div>
      <div class="field"><label>Abrir arquivo Excel / CSV</label>
        <input type="file" id="chipTecFileInput" accept=".xlsx,.xls,.csv" onchange="importarArquivoChipsTecnico(this)">
        ${window.__noXLSX?`<div class="badge baixado" style="margin-top:10px">${ic('alert-triangle')} Leitura de .xlsx indisponível (sem internet). Use CSV ou cole os dados.</div>`:''}
      </div>
    </div>
  </div></div>`:''}
  ${souAdmin()?`
  <div class="panel" style="margin-top:18px"><div class="ph"><h3>${ic('alert-triangle')} Marcar equipamento como perdido (Inventário Pendente)</h3></div><div class="pb">
    <p class="muted" style="margin-bottom:12px">Digite ou cole um ou mais nº de série (separados por espaço, vírgula ou linha). Qualquer movimentação normal feita depois nesse item (entrada, saída, confirmação, baixa, uso em campo, retirada em campo) já tira ele da lista de pendentes automaticamente — acompanhe em <button class="btn sm ghost" style="display:inline-flex;padding:2px 8px" onclick="goto('perdidos')">Inventário Pendente →</button></p>
    <div class="field" style="margin-bottom:12px"><label>Nº de série</label>
      <div style="display:flex;gap:8px"><input id="perdidoBusca" placeholder="Bipe ou digite o(s) nº de série..." onkeydown="if(event.key==='Enter'){event.preventDefault();addPerdidoSerieBusca()}" style="flex:1"><button class="btn" onclick="addPerdidoSerieBusca()">+ Adicionar</button></div>
    </div>
    <div id="perdidoChips" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px"></div>
    <div class="field" style="margin-bottom:12px"><label>Motivo (opcional)</label><input id="perdidoMotivo" placeholder="Ex.: não encontrado na auditoria da filial X"></div>
    <button class="btn red" onclick="confirmarMarcarPerdido()">${ic('alert-triangle')} Marcar como perdido</button>
  </div></div>
  <div class="panel" style="margin-top:18px"><div class="ph"><h3>${ic('inbox')} Importar planilha pro Inventário Pendente (várias filiais de uma vez)</h3></div><div class="pb">
    <p class="muted" style="margin-bottom:12px">Pra marcar muitos equipamentos perdidos de uma vez — de filiais diferentes no mesmo lote. Reconhece as mesmas colunas da importação de estoque acima: <b>Nº Série</b> e <b>Depósito</b> (obrigatórias — cada linha usa o depósito dela própria como filial), Produto/Tipo (opcional, senão detecta pelo padrão do nº de série). Nº de série que ainda não existe no sistema é criado na hora, já em Inventário Pendente.</p>
    <div class="field" style="margin-bottom:14px"><label>Motivo (aplicado a todo o lote)</label><input id="perdidoMotivoLote" placeholder="Ex.: Auditoria física de 20/07"></div>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="field"><label>Colar dados da planilha</label>
        <textarea id="perdidoPasteArea" rows="6" placeholder="Cole aqui os dados copiados do Excel (com o cabeçalho)..." style="font-family:Consolas,monospace;font-size:12px"></textarea>
        <button class="btn red" style="margin-top:10px" onclick="importarColadoPerdido()">Reconhecer e marcar como perdido</button>
      </div>
      <div class="field"><label>Abrir arquivo Excel / CSV</label>
        <input type="file" id="perdidoFileInput" accept=".xlsx,.xls,.csv" onchange="importarArquivoPerdido(this)">
        ${window.__noXLSX?`<div class="badge baixado" style="margin-top:10px">${ic('alert-triangle')} Leitura de .xlsx indisponível (sem internet). Use CSV ou cole os dados.</div>`:''}
      </div>
    </div>
  </div></div>`:''}

  <div class="panel" style="margin-top:18px"><div class="ph"><h3>${ic('save')} Backup & compartilhamento</h3></div><div class="pb">
    <p class="muted" style="margin-bottom:14px">Os dados ficam salvos <b>neste navegador</b>. Para fazer cópia de segurança ou usar em outra máquina/compartilhar via rede, exporte o backup e importe no outro computador.</p>
    <p class="muted" style="margin-bottom:14px;font-size:12.5px">${DB.config.ultimoBackup?`Último backup: <b>${fmtTS(DB.config.ultimoBackup)}</b>`:'Nenhum backup feito ainda.'} — o responsável pelo sistema recebe um backup automático a cada 7 dias ao logar, sem precisar clicar em nada.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn green" onclick="exportarBackup()">${ic('download')} Exportar backup (.json)</button>
      <label class="btn">${ic('upload')} Importar backup<input type="file" accept=".json" style="display:none" onchange="importarBackup(this)"></label>
      ${souAdmin()?`<button class="btn" onclick="limparSiglasFiliais()">${ic('eraser')} Corrigir siglas de filiais (tirar "EPV")</button>`:''}
      ${souAdmin()?`<button class="btn" onclick="corrigirItensCDO()">${ic('eraser')} Corrigir itens presos em "CDO"</button>`:''}
      ${souAdmin()?`<button class="btn" onclick="corrigirTiposPorSerie()">${ic('search')} Corrigir tipos pelo padrão do código</button>`:''}
      ${souAdmin()?`<button class="btn" onclick="aplicarMinimosOficiais()">${ic('target')} Aplicar estoque mínimo oficial</button>`:''}
      ${souAdmin()?`<button class="btn" onclick="distribuirEquipamentosTeste()">${ic('flask-conical')} Distribuir equipamentos entre técnicos (teste)</button>`:''}
      ${souAdmin()?`<button class="btn" onclick="gerarCenarioTesteCompleto()">${ic('shuffle')} Gerar cenário de teste completo</button>`:''}
      ${souAdmin()?`<button class="btn" onclick="reverterCenarioTeste()">${ic('undo-2')} Devolver tudo ao estoque</button>`:''}
      <button class="btn red" onclick="limparTudo()">${ic('trash-2')} Apagar tudo</button>
    </div>
    <div class="field" style="margin-top:18px;max-width:340px"><label>Seu nome (registrado nas movimentações)</label>
      <input id="cfgUsuario" value="${esc(DB.config.usuario||'')}" placeholder="Ex.: Cliver" onchange="DB.config.usuario=this.value;salvar()"></div>
    ${c?`<div class="muted" style="font-size:12px;margin-top:8px">Última importação: ${fmtTS(c)} · ${DB.equipamentos.length} itens · ${DB.movimentacoes.length} movimentações</div>`:''}
  </div></div>
  ${souAdmin()?`
  <div class="panel" style="margin-top:18px"><div class="ph"><h3>${ic('alert-triangle')} Erros recentes (diagnóstico)</h3></div><div class="pb">
    <p class="muted" style="margin-bottom:12px">Erros de JavaScript capturados automaticamente no navegador de qualquer usuário aprovado — útil pra ver problemas que ninguém chegou a reportar.</p>
    <button class="btn" onclick="carregarErrosRecentes()">${ic('refresh-cw')} Carregar últimos 50</button>
    <div id="errosRecentesBox" style="margin-top:14px"></div>
  </div></div>`:''}`;
  renderPerdidoChips();
}
async function carregarErrosRecentes(){
  if(!souAdmin()) return;
  const box = $('#errosRecentesBox'); if(!box) return;
  box.innerHTML = '<p class="muted">Carregando...</p>';
  try{
    const { data, error } = await sb.from('erros').select('*').order('ts',{ascending:false}).limit(50);
    if(error) throw error;
    if(!data.length){ box.innerHTML = '<p class="muted">Nenhum erro registrado — ótimo sinal.</p>'; return; }
    box.innerHTML = `<div style="overflow-x:auto"><table><thead><tr><th>Quando</th><th>Usuário</th><th>Tela</th><th>Mensagem</th></tr></thead><tbody>${
      data.map(e=>`<tr><td class="mono">${fmtTS(e.ts)}</td><td>${esc(e.usuario_email||'—')} <span class="muted">(${esc(e.papel||'—')})</span></td><td>${esc(e.tela||'—')}</td><td title="${esc(e.stack||'')}">${esc(e.mensagem)}</td></tr>`).join('')
    }</tbody></table></div>`;
  }catch(err){ box.innerHTML = '<p class="muted">Falha ao carregar: '+esc(err.message)+'</p>'; }
}

/* =========================================================
   MODAIS — abrir/fechar genérico
   ========================================================= */
function modal(titulo, body, footer='', size=''){
  $('#modal').className = 'modal '+(size||'');
  $('#modal').innerHTML = `
    <div class="mh"><h3>${titulo}</h3><button class="x" onclick="closeModal()" aria-label="Fechar">${ic('x')}</button></div>
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
      <div class="hint">O tipo é detectado automaticamente pelo prefixo (00-=Controle, 02-=Foto, 04-=Magnetico, 05-=Sirene, A453EE20=Módulo, 8955=Chip).</div></div>
    <div class="row2">
      <div class="field"><label>Tipo *</label><select id="e_tipo" onchange="toggleCamposChip()">${tiposOpt||'<option value="">— nenhum tipo —</option>'}</select></div>
      <div class="field"><label>Depósito / Local</label><input id="e_dep" value="${e?esc(e.deposito||''):''}" placeholder="Ex.: CASEPV"></div>
    </div>
    <div class="row2" id="e_camposChip" style="${e&&e.tipo==='Chip'?'':'display:none'}">
      <div class="field"><label>Operadora</label><select id="e_operadora">
        <option value="">— selecione —</option>
        <option value="Claro" ${e&&e.operadora==='Claro'?'selected':''}>Claro</option>
        <option value="TIM" ${e&&e.operadora==='TIM'?'selected':''}>TIM</option>
      </select></div>
      <div class="field"><label>Número da linha</label><input id="e_numeroLinha" value="${e?esc(e.numeroLinha||''):''}" placeholder="Ex.: (47) 99999-9999"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Status</label><select id="e_status">${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${e&&e.status===k?'selected':''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>Data de entrada</label><input id="e_data" value="${e?esc(e.dataEntrada||''):''}" placeholder="dd/mm/aaaa"></div>
    </div>
    <div class="field"><label>Observação</label><input id="e_obs" value="${e?esc(e.obs||''):''}"></div>`,
    `${e&&souAdmin()?`<button class="btn red ghost" style="margin-right:auto" onclick="excluirEquip('${esc(e.serie)}')">${ic('trash-2')} Excluir definitivamente</button>`:''}
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
  toggleCamposChip();
}
// Mostra/esconde os campos Operadora/Número da linha — só fazem sentido pra tipo Chip
// (cartão SIM de operadora). Chamado ao trocar o tipo manualmente ou ao autodetectar
// pelo prefixo do nº de série (8955 = Chip, ver detectarTipoPorSerie).
function toggleCamposChip(){
  const el = $('#e_camposChip');
  if(el) el.style.display = ($('#e_tipo')&&$('#e_tipo').value==='Chip') ? '' : 'none';
}
function salvarEquip(serieEdit){
  const serie = serieEdit || $('#e_serie').value.trim();
  if(!serie) return flash('Informe o nº de série','red');
  if(!serieEdit && acharEquipPorSerie(serie)) return flash('Já existe um item com esse nº de série','red');
  let e = serieEdit? DB.equipamentos.find(x=>x.serie===serieEdit) : null;
  const tipoSelecionado = $('#e_tipo').value;
  const dados={ tipo:tipoSelecionado, deposito:limparFilial($('#e_dep').value), status:$('#e_status').value, dataEntrada:$('#e_data').value.trim(), obs:$('#e_obs').value.trim(),
    // Operadora/número da linha só se aplicam a Chip — zera se o tipo foi trocado pra outro.
    operadora: tipoSelecionado==='Chip' ? (($('#e_operadora')&&$('#e_operadora').value)||null) : null,
    numeroLinha: tipoSelecionado==='Chip' ? (($('#e_numeroLinha')&&$('#e_numeroLinha').value.trim())||null) : null };
  if(e){ Object.assign(e,dados); }
  else { DB.equipamentos.push(Object.assign({serie, local:dados.deposito, tecnicoId:null}, dados)); }
  // garante que o tipo exista
  if(dados.tipo && !DB.tipos[dados.tipo]) DB.tipos[dados.tipo]={nome:dados.tipo,cor:''};
  salvar(); closeModal(); render(); flash('Equipamento salvo','green');
}
function excluirEquip(serie){
  if(!souAdmin()) return flash('Somente administradores podem excluir equipamentos','red');
  const e = DB.equipamentos.find(x=>x.serie===serie); if(!e) return;
  if(!confirm('Excluir DEFINITIVAMENTE o equipamento '+serie+' do sistema?\n\nEle será removido do inventário, mas fica um registro permanente no Histórico de quem excluiu, quando e em que situação estava.')) return;
  const snapshot = `tipo:${tipoNome(e.tipo)} · status:${STATUS[e.status]||e.status} · local:${e.local||e.deposito||'—'}${e.tecnicoId?' · com '+tecNome(e.tecnicoId):''}`;
  registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'exclusao', serie, de:snapshot, para:'Excluído do sistema', tecnicoId:e.tecnicoId||null, usuario:nomeUsuarioAtual(), obs:'Exclusão definitiva por administrador' });
  DB.equipamentos = DB.equipamentos.filter(x=>x.serie!==serie);
  // Exclusão no banco é EXPLÍCITA (a sincronização não infere mais exclusões — ver
  // sincronizarEquipamentos/BUG-034). Se falhar, o item volta sozinho no próximo
  // recarregamento (continua existindo no banco) — por isso o aviso claro no erro.
  excluirEquipamentosNoBanco([serie]).catch(err=>{
    flash('A exclusão de '+serie+' NÃO foi aplicada na nuvem ('+err.message+') — o item vai reaparecer. Tente de novo com conexão.','red');
  });
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
  salvar(); closeModal(); render(); flash('Técnico salvo','green');
}
function excluirTec(id){
  const n = DB.equipamentos.filter(e=>e.tecnicoId===id && e.status==='com_tecnico').length;
  if(n) return flash('Esse técnico tem '+n+' itens em posse. Mova-os antes de excluir.','red');
  // BUG-052: o banco tem FK de movimentacoes.tecnico_id/tecnico_id_origem pra
  // tecnicos.id — um técnico com QUALQUER movimentação no histórico nunca pode ser
  // excluído de verdade (o Postgres protege o rastro), mesmo já sem nenhum item em
  // posse hoje. Checar aqui evita o erro só aparecer depois, escondido dentro de uma
  // sincronização em segundo plano.
  const temHistorico = DB.movimentacoes.some(m=>m.tecnicoId===id || m.tecnicoIdOrigem===id);
  if(temHistorico) return flash('Esse técnico já tem movimentações no histórico e não pode ser excluído definitivamente (o banco preserva o rastro) — deixe cadastrado, mesmo sem itens em posse.','red');
  if(!confirm('Excluir técnico?')) return;
  DB.tecnicos=DB.tecnicos.filter(t=>t.id!==id);
  delete ultimoSyncTecnicos[id];
  salvar(); closeModal(); render(); flash('Técnico excluído','green');
  // Exclusão no banco é EXPLÍCITA (ver BUG-052) — a sincronização não infere mais
  // exclusões pela diferença do array local.
  excluirTecnicoNoBanco(id).catch(err=>{
    flash('A exclusão do técnico NÃO foi aplicada na nuvem ('+err.message+') — ele vai reaparecer. Tente de novo com conexão.','red');
  });
}
async function excluirTecnicoNoBanco(id){
  const { error } = await sb.from('tecnicos').delete().eq('id', id);
  if(error) throw error;
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
  salvar(); closeModal(); render(); flash('Tipo salvo','green');
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
  const tiposDisponiveis = souTecnico() ? ['uso_campo','transferencia','baixa'] : ['entrada','saida','transferencia','baixa'];
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
  modal(ic('refresh-cw')+' Registrar movimentação', `
    <div class="field"><label>Tipo de movimentação</label>
      <div class="pill-tabs" style="width:100%">
        ${tiposDisponiveis.map(k=>`<button class="${movTipo===k?'active':''}" style="flex:1" onclick="movTipo='${k}';desenharMov()">${MOV_LABEL[k]}</button>`).join('')}
      </div>
    </div>

    <div class="field"><label>Equipamentos (nº de série)</label>
      <div style="display:flex;gap:8px;align-items:stretch">
        <div class="search" style="flex:1"><span class="si">${ic('search')}</span><input id="movBusca" placeholder="Digite/scan o nº de série e Enter para adicionar..." onkeydown="if(event.key==='Enter'){addMovSerieBusca();event.preventDefault()}" oninput="filtrarPickMov(this.value)"></div>
        <button class="btn primary" onclick="addMovSerieBusca()">+ Adicionar</button>
      </div>
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
    ${movTipo==='uso_campo'? `
      <div class="field"><label>Tipo de atendimento *</label>
        <select id="movAtend">
          <option value="">— selecione —</option>
          <option value="Manutenção">Manutenção</option>
          <option value="Instalação">Instalação</option>
        </select>
      </div>
      <div class="hint" style="margin-top:-6px;margin-bottom:12px">A OS identifica o cliente onde o equipamento foi usado.</div>`:''}
    ${movTipo==='baixa'||movTipo==='uso_campo'? `
      <div class="field"><label>Número da OS (Ordem de Serviço) *</label>
        <input id="movOS" inputmode="numeric" maxlength="6" placeholder="Ex.: 123456" oninput="this.value=this.value.replace(/\\D/g,'').slice(0,6)">
        <div class="hint">Exatamente 6 números.</div>
      </div>`:''}
    ${movTipo==='entrada'? `<div class="field"><label>Depósito de destino</label><input id="movDep" list="listaFiliais" placeholder="Ex.: CAS"><datalist id="listaFiliais">${todasFiliaisConhecidas().map(f=>`<option value="${esc(f)}">`).join('')}</datalist>
      <div class="hint">Só funciona para equipamento que <b>já existe</b> no sistema (com técnico ou baixado, retornando ao estoque). Pra cadastrar um equipamento novo, use <b>Equipamentos → ＋ Adicionar</b>.</div></div>`:''}
    ${movTipo==='baixa'? `<div class="field"><label>Motivo do envio para RMA</label><input id="movMotivo" placeholder="Ex.: Defeito, garantia, devolução ao fabricante..."></div>`:''}

    <div class="field"><label>Observação${movTipo==='transferencia'||movTipo==='uso_campo'?' *':''}</label><input id="movObs" placeholder="${movTipo==='transferencia'||movTipo==='uso_campo'?'Obrigatório':'Opcional'}"></div>
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
    </div>`).join('') : `<div class="muted center" style="padding:18px">${movTipo==='entrada'?'Nenhum equipamento com técnico ou baixado encontrado. Equipamento genuinamente novo deve ser cadastrado em Equipamentos → ＋ Adicionar.':'Nenhum item disponível para esta movimentação.'}</div>`;
}
function addMovSerie(serie){ if(!movSel.includes(serie)){ movSel.push(serie); renderMovChips(); filtrarPickMov($('#movBusca').value);} }
function addMovSerieBusca(){
  const bruto=$('#movBusca').value.trim(); if(!bruto) return;
  const tokens=bruto.split(/[\s,;]+/).map(s=>s.trim()).filter(Boolean);
  if(tokens.length<=1){
    const v=tokens[0]||'';
    const e=DB.equipamentos.find(x=>x.serie.toLowerCase()===v.toLowerCase());
    if(!e) return flash('Nº de série não encontrado','red');
    addMovSerie(e.serie); $('#movBusca').value='';
    return;
  }
  let achados=0, naoAchados=[];
  tokens.forEach(v=>{
    const e=DB.equipamentos.find(x=>x.serie.toLowerCase()===v.toLowerCase());
    if(e){ if(!movSel.includes(e.serie)) movSel.push(e.serie); achados++; }
    else naoAchados.push(v);
  });
  renderMovChips(); filtrarPickMov('');
  $('#movBusca').value='';
  if(achados) flash(`${achados} equipamento(s) adicionado(s)`+(naoAchados.length?` — ${naoAchados.length} não encontrado(s)`:''), naoAchados.length?'red':'green');
  else flash('Nenhum dos códigos colados foi encontrado','red');
}
function removeMovSerie(serie){ movSel=movSel.filter(s=>s!==serie); renderMovChips(); filtrarPickMov($('#movBusca')?$('#movBusca').value:''); }
function renderMovChips(){
  $('#movChips').innerHTML = movSel.map(s=>`<span class="chip">${esc(s)} <span class="rm" role="button" tabindex="0" aria-label="Remover ${esc(s)}" onclick="removeMovSerie('${esc(s)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();removeMovSerie('${esc(s)}')}">×</span></span>`).join('');
  if($('#movN')) $('#movN').textContent = movSel.length;
}
/* =========================================================
   INVENTÁRIO PENDENTE — equipamentos marcados manualmente como "não
   localizados" (20/07/2026). status/tecnicoId NÃO mudam quando isso
   acontece (fica "estoque"/"com_tecnico" normalmente por baixo) — é só um
   flag em cima, no mesmo espírito do bloco de trânsito, o que permite
   qualquer movimentação normal continuar funcionando sem alteração.
   ========================================================= */
// Chamada no início de toda função que já mexe num equipamento e grava uma
// movimentação — se o item estava marcado como perdido, registra UM evento
// de resolução (de:'Inventário Pendente', para:<descrição de onde foi>) e
// limpa o flag. Não faz nada se o item não estava perdido (custo zero nos
// 99% dos casos). Também reaproveitada por desmarcarPerdido() (correção de
// marcação por engano), só com uma descrição diferente.
function resolverPerdidoSeNecessario(e, descricao){
  if(!e.perdido) return;
  registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'perdido', serie:e.serie, de:'Inventário Pendente', para:descricao, tecnicoId:e.tecnicoId||null, usuario:nomeUsuarioAtual(), obs:'Estava pendente desde '+fmtTS(e.perdidoDesde)+' ('+(e.perdidoFilial||'—')+')'+(e.perdidoObs?' — motivo original: '+e.perdidoObs:'') });
  e.perdido=false; e.perdidoDesde=null; e.perdidoFilial=null; e.perdidoUsuario=null; e.perdidoObs=null;
}
// Última localização conhecida do equipamento — mesma lógica já usada em "de"
// nas movimentações (confirmarMov): depósito se estava em estoque, região do
// técnico se estava com ele.
function filialAtualDoEquip(e){
  if(e.status==='com_tecnico'){ const t=DB.tecnicos.find(x=>x.id===e.tecnicoId); return (t&&t.regiao)||''; }
  return e.deposito||'';
}
function marcarComoPerdido(series, motivo){
  // Só admin (20/07/2026, a pedido do usuário): os formulários de marcar/importar
  // mudaram pra tela Dados, que já é admin-only — supervisor continua vendo o
  // dashboard/lista do Inventário Pendente (renderInventarioPendente), só não age mais.
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  const usuario = nomeUsuarioAtual();
  let n=0, ignorados=0;
  series.forEach(serie=>{
    const e = acharEquipPorSerie(serie);
    if(!e || e.perdido){ ignorados++; return; }
    const filial = filialAtualDoEquip(e);
    e.perdido=true; e.perdidoDesde=Date.now(); e.perdidoFilial=filial; e.perdidoUsuario=usuario; e.perdidoObs=motivo||'';
    registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'perdido', serie:e.serie, de:filial||'—', para:'Inventário Pendente', tecnicoId:e.tecnicoId||null, usuario, obs:motivo||'' });
    n++;
  });
  salvar(); render();
  flash(`${n} equipamento(s) marcado(s) como perdido(s)`+(ignorados?`, ${ignorados} ignorado(s) (já perdido ou não encontrado)`:''), n?'green':'red');
}
function desmarcarPerdido(serie){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  const e = acharEquipPorSerie(serie); if(!e || !e.perdido) return;
  if(!confirm('Remover '+serie+' do Inventário Pendente (marcação por engano)?')) return;
  resolverPerdidoSeNecessario(e, 'Removido do painel (marcação cancelada)');
  salvar(); render(); flash('Marcação removida','green');
}

let perdidoSel = [];
function addPerdidoSerieBusca(){
  const bruto = $('#perdidoBusca').value.trim(); if(!bruto) return;
  const tokens = bruto.split(/[\s,;]+/).map(s=>s.trim()).filter(Boolean);
  let achados=0; const ignorados=[];
  tokens.forEach(v=>{
    const e = acharEquipPorSerie(v);
    if(!e){ ignorados.push(v+' (não encontrado)'); return; }
    if(e.perdido){ ignorados.push(v+' (já pendente)'); return; }
    if(!perdidoSel.includes(e.serie)){ perdidoSel.push(e.serie); achados++; }
  });
  $('#perdidoBusca').value='';
  renderPerdidoChips();
  if(ignorados.length) flash((achados?achados+' adicionado(s)':'Nada adicionado')+' — ignorado(s): '+ignorados.join(', '), achados?'':'red');
}
function removePerdidoSerie(serie){ perdidoSel = perdidoSel.filter(s=>s!==serie); renderPerdidoChips(); }
function renderPerdidoChips(){
  const el = $('#perdidoChips'); if(!el) return;
  el.innerHTML = perdidoSel.map(s=>`<span class="chip">${esc(s)} <span class="rm" role="button" tabindex="0" aria-label="Remover ${esc(s)}" onclick="removePerdidoSerie('${esc(s)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();removePerdidoSerie('${esc(s)}')}">×</span></span>`).join('');
}
function confirmarMarcarPerdido(){
  if(!perdidoSel.length) return flash('Adicione ao menos um nº de série','red');
  const motivo = $('#perdidoMotivo')?$('#perdidoMotivo').value.trim():'';
  const series = perdidoSel.slice();
  perdidoSel = [];
  marcarComoPerdido(series, motivo);
}
let perdidosFiliaisFiltro = []; // array de filiais selecionadas no dashboard; vazio = todas
let perdidosBusca = ''; // busca por nº de série, só afeta a tabela "Pendentes de localizar" (não os KPIs/gráficos)
let perdidosTipoFiltro = ''; // tipo de equipamento; vazio = todos
function perdidosToggleFilial(f){
  const i = perdidosFiliaisFiltro.indexOf(f);
  if(i>=0) perdidosFiliaisFiltro.splice(i,1); else perdidosFiliaisFiltro.push(f);
  renderInventarioPendente();
}
// Lista de pendentes já com TODOS os filtros aplicados (região do supervisor, pílula de
// filial, tipo, busca por série) — reaproveitada pela exportação (Excel/relatório) e pela
// tabela "Pendentes de localizar", pra exportar sempre bater exatamente com o que está
// filtrado na tela (mesmo princípio de dashboardFiltrado()/rmaFiltrado() já usado em
// outras telas). Os KPIs/gráficos do topo usam essa mesma função nos renders completos
// (clique de pílula, carregamento da tela), mas a busca por texto só re-renderiza a
// tabela (renderPerdidosTabela(), parcial — evita perder o foco do campo a cada letra
// digitada, mesmo motivo de filtrarEquip()/renderEquipTabela() em Equipamentos), então
// os KPIs podem ficar "uma letra atrasados" em relação à tabela enquanto o usuário digita
// — não é bug, é a mesma concessão já aceita naquela tela.
function perdidosFiltrados(){
  let pendentes = DB.equipamentos.filter(e=>e.perdido);
  if(souSupervisor()) pendentes = pendentes.filter(e=>regiaoPermitida(e.perdidoFilial));
  if(perdidosFiliaisFiltro.length) pendentes = pendentes.filter(e=>perdidosFiliaisFiltro.includes(e.perdidoFilial||'Sem filial'));
  if(perdidosTipoFiltro) pendentes = pendentes.filter(e=>e.tipo===perdidosTipoFiltro);
  const q = perdidosBusca.trim().toLowerCase();
  if(q) pendentes = pendentes.filter(e=>e.serie.toLowerCase().includes(q));
  return pendentes;
}

let resolvidosBusca = ''; // busca por nº de série no histórico de localizados
let resolvidosFilialFiltro = ''; // filial ATUAL do equipamento (filialAtualDoEquip); vazio = todas
let resolvidosTecnicoFiltro = ''; // técnico ATUAL (só considera item hoje com_tecnico); vazio = todos
// Histórico de localizados filtrado — a movimentação de resolução em si só guarda a
// string fixa "Inventário Pendente" em "de" (ver convenção documentada em
// renderInventarioPendente()), sem filial/técnico estruturados, então filial e técnico
// aqui são calculados pela localização ATUAL do equipamento (mesma filialAtualDoEquip()
// usada na marcação) — reflete onde o item está hoje, não necessariamente onde foi no
// exato momento da resolução.
function resolvidosFiltrados(){
  let lista = DB.movimentacoes.filter(m=>m.tipo==='perdido' && m.de==='Inventário Pendente')
    .map(m=>({ mov:m, eq:acharEquipPorSerie(m.serie) }));
  if(resolvidosFilialFiltro) lista = lista.filter(r=>r.eq && filialAtualDoEquip(r.eq)===resolvidosFilialFiltro);
  if(resolvidosTecnicoFiltro) lista = lista.filter(r=>r.eq && r.eq.status==='com_tecnico' && r.eq.tecnicoId===resolvidosTecnicoFiltro);
  const q = resolvidosBusca.trim().toLowerCase();
  if(q) lista = lista.filter(r=>r.mov.serie.toLowerCase().includes(q));
  return lista.sort((a,b)=>b.mov.ts-a.mov.ts).slice(0,200);
}
function renderInventarioPendente(){
  // Marcar/desmarcar/importar em massa viraram ações só de admin (20/07/2026, a pedido do
  // usuário — os formulários mudaram pra tela Dados, junto das outras ferramentas
  // administrativas de dados). Supervisor continua enxergando o dashboard/lista da
  // própria região normalmente, só não vê o botão de ação (checado em renderPerdidosTabela()).
  let pendentesTodos = DB.equipamentos.filter(e=>e.perdido);
  if(souSupervisor()) pendentesTodos = pendentesTodos.filter(e=>regiaoPermitida(e.perdidoFilial));

  // Pílulas de filtro por filial (dashboard) — mesmo padrão de dashFiliais em renderDashboard().
  const porFilialTodos = {};
  pendentesTodos.forEach(e=>{ const f=e.perdidoFilial||'Sem filial'; (porFilialTodos[f]=porFilialTodos[f]||[]).push(e); });
  const filiaisDisponiveis = Object.keys(porFilialTodos).sort();
  perdidosFiliaisFiltro = perdidosFiliaisFiltro.filter(f=>filiaisDisponiveis.includes(f)); // limpa filial que sumiu (item resolvido)
  const pendentes = perdidosFiltrados();
  const maxFilial = Math.max(1, ...filiaisDisponiveis.map(f=>porFilialTodos[f].length));
  // Ordem do gráfico de barras "Pendentes por filial": maior pra menor (mesmo padrão de
  // RMA/Itens Parados/Estoque Mínimo) — diferente da ordem alfabética das pílulas acima.
  const filialArr = Object.entries(porFilialTodos).map(([f,arr])=>[f,arr.length]).sort((a,b)=>b[1]-a[1]);
  // Tipos oferecidos no dropdown: todos os presentes no escopo (região + pílula de
  // filial), sem considerar o próprio filtro de tipo — mesmo princípio das pílulas de
  // status em renderDashboard(), que mostram a contagem "se eu escolhesse essa opção".
  const tiposDisponiveis = [...new Set(pendentesTodos.map(e=>e.tipo))].sort((a,b)=>tipoNome(a).localeCompare(tipoNome(b)));

  const porTipo = {};
  pendentes.forEach(e=>{ porTipo[e.tipo]=(porTipo[e.tipo]||0)+1; });
  const tiposArr = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]);
  // Distribuição por tipo agora é um gráfico de pizza/donut (mesmo componente donut() já
  // usado em renderRMA()/renderDashboard()), reagindo ao filtro de filial das pílulas —
  // pedido explícito do usuário, "igual tem nas outras telas".
  const donutTipo = tiposArr.map(([t,n])=>[tipoNome(t),n,tipoCor(t)]);
  const diasMaisAntigo = pendentes.length ? Math.floor(Math.max(...pendentes.map(e=>Date.now()-(e.perdidoDesde||Date.now())))/86400000) : null;

  // Histórico de resolvidos: qualquer movimentação registrada por resolverPerdidoSeNecessario
  // tem sempre de==='Inventário Pendente' — convenção que separa evento de marcação
  // (para==='Inventário Pendente') de evento de resolução, sem precisar de coluna nova.
  // Não filtrado por filial/região de propósito (é só um log histórico somativo, não uma
  // ação — mesmo tratamento dado a outros logs consolidados do sistema; a movimentação de
  // resolução não guarda a filial de origem em campo próprio, só dentro do texto de obs).
  const resolvidosTodos = DB.movimentacoes.filter(m=>m.tipo==='perdido' && m.de==='Inventário Pendente')
    .map(m=>({ mov:m, eq:acharEquipPorSerie(m.serie) }));
  const resolvidosSemana = resolvidosTodos.filter(r=>r.mov.ts>=Date.now()-7*86400000).length;
  // Opções dos dois dropdowns do histórico: só as filiais/técnicos que de fato aparecem
  // como localização ATUAL de algum item já resolvido (mesmo princípio de
  // tecnicosDisponiveis em renderRMA() — só quem tem item no escopo, não a lista inteira).
  const resolvidosFiliaisDisponiveis = [...new Set(resolvidosTodos.map(r=>r.eq&&filialAtualDoEquip(r.eq)).filter(Boolean))].sort();
  const resolvidosTecnicosDisponiveis = [...new Map(resolvidosTodos.filter(r=>r.eq&&r.eq.status==='com_tecnico'&&r.eq.tecnicoId).map(r=>[r.eq.tecnicoId,r.eq.tecnicoId])).keys()]
    .map(id=>DB.tecnicos.find(t=>t.id===id)).filter(Boolean).sort((a,b)=>a.nome.localeCompare(b.nome));

  $('#content').innerHTML = `
    <div class="panel" style="margin-bottom:18px"><div class="pb" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span style="font-weight:700;font-size:12.5px;color:var(--txt-soft);white-space:nowrap">${ic('map-pin')} FILIAL ${perdidosFiliaisFiltro.length?`<span class="muted" style="font-weight:500">(${perdidosFiliaisFiltro.length} selecionada${perdidosFiliaisFiltro.length>1?'s':''} · clique pra adicionar/remover)</span>`:'<span class="muted" style="font-weight:500">(clique pra filtrar, pode escolher várias)</span>'}</span>
      <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0;gap:8px">
        <button class="${!perdidosFiliaisFiltro.length?'active':''}" style="background:${!perdidosFiliaisFiltro.length?'var(--brand)':'var(--panel-soft)'};color:${!perdidosFiliaisFiltro.length?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="perdidosFiliaisFiltro=[];renderInventarioPendente()">Todas <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${pendentesTodos.length}</span></button>
        ${filiaisDisponiveis.map(f=>{ const on=perdidosFiliaisFiltro.includes(f); return `
          <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="perdidosToggleFilial('${esc(f)}')">${on?ic('check')+' ':''}${esc(f)} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'var(--surface-2)'};color:inherit;margin-left:4px">${porFilialTodos[f].length}</span></button>`;}).join('')}
      </div>
      <div class="spacer"></div>
      ${pendentes.length?`<button class="btn sm" onclick="exportarPerdidosExcel()">${ic('bar-chart-3')} Exportar Excel</button><button class="btn sm" onclick="gerarRelatorioPerdidos()">${ic('printer')} Gerar relatório</button>`:''}
    </div></div>

    <div class="grid kpis" style="margin-bottom:20px">
      ${kpi('r','alert-triangle','Pendentes de localizar',pendentes.length)}
      ${kpi('b','map-pin','Filiais afetadas',filiaisDisponiveis.length)}
      ${kpi('a','alarm-clock','Mais antigo (dias)',diasMaisAntigo==null?'—':diasMaisAntigo)}
      ${kpi('g','check','Localizados (7 dias)',resolvidosSemana)}
    </div>

    <div class="chart-row" style="margin-bottom:20px">
      <div class="panel">
        <div class="ph"><h3>${ic('map-pin')} Pendentes por filial</h3></div>
        <div class="pb">
          ${filialArr.length?filialArr.map(([f,n])=>{
            const intensidade = n/maxFilial; // 0 a 1 — mais itens pendentes = vermelho mais forte/escuro (mesmo padrão de RMA/Itens Parados)
            const cor = `rgb(${220-Math.round(60*(1-intensidade))},${38+Math.round(90*(1-intensidade))},${38+Math.round(90*(1-intensidade))})`;
            return `
            <div class="bar-row" style="cursor:pointer" onclick="perdidosToggleFilial('${esc(f)}')">
              <div class="bl">${esc(f)}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${n/maxFilial*100}%;background:${cor}">${n}</div></div>
            </div>`;}).join(''):'<div class="empty">Nenhum equipamento pendente de localização — tudo certo.</div>'}
        </div>
      </div>
      <div class="panel">
        <div class="ph"><h3>${ic('package')} Distribuição por tipo</h3></div>
        <div class="pb"><div class="donut-wrap">
          ${donutTipo.length?donut(donutTipo):'<div class="empty">Sem dados</div>'}
        </div></div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:18px"><div class="ph"><h3>${ic('list-checks')} Pendentes de localizar</h3><span class="count-badge" id="perdidosTabelaCount">${pendentes.length}</span></div><div class="pb">
      <div class="toolbar" style="margin-bottom:16px">
        <div class="search"><span class="si">${ic('search')}</span><input placeholder="Buscar por nº de série..." value="${esc(perdidosBusca)}" oninput="perdidosBusca=this.value;renderPerdidosTabela()"></div>
        <select class="filter" onchange="perdidosTipoFiltro=this.value;renderInventarioPendente()">
          <option value="">Todos os tipos</option>
          ${tiposDisponiveis.map(t=>`<option value="${t}" ${perdidosTipoFiltro===t?'selected':''}>${esc(tipoNome(t))}</option>`).join('')}
        </select>
        <select class="filter" onchange="perdidosFiliaisFiltro=this.value?[this.value]:[];renderInventarioPendente()">
          <option value="">Todas as filiais</option>
          ${filiaisDisponiveis.map(f=>`<option value="${esc(f)}" ${perdidosFiliaisFiltro.length===1&&perdidosFiliaisFiltro[0]===f?'selected':''}>${esc(f)}</option>`).join('')}
        </select>
        ${pendentes.length?`<button class="btn sm" onclick="exportarPerdidosExcel()">${ic('bar-chart-3')} Exportar Excel</button><button class="btn sm" onclick="gerarRelatorioPerdidos()">${ic('printer')} Gerar relatório</button>`:''}
      </div>
      <div id="perdidosTabelaBox"></div>
    </div></div>

    <div class="panel"><div class="ph"><h3>${ic('clock')} Histórico de localizados</h3><span class="count-badge" id="resolvidosTabelaCount">${resolvidosTodos.length}</span></div><div class="pb">
      <div class="toolbar" style="margin-bottom:16px">
        <div class="search"><span class="si">${ic('search')}</span><input placeholder="Buscar por nº de série..." value="${esc(resolvidosBusca)}" oninput="resolvidosBusca=this.value;renderResolvidosTabela()"></div>
        <select class="filter" onchange="resolvidosFilialFiltro=this.value;renderInventarioPendente()">
          <option value="">Todas as filiais</option>
          ${resolvidosFiliaisDisponiveis.map(f=>`<option value="${esc(f)}" ${resolvidosFilialFiltro===f?'selected':''}>${esc(f)}</option>`).join('')}
        </select>
        <select class="filter" onchange="resolvidosTecnicoFiltro=this.value;renderInventarioPendente()">
          <option value="">Todos os técnicos</option>
          ${resolvidosTecnicosDisponiveis.map(t=>`<option value="${t.id}" ${resolvidosTecnicoFiltro===t.id?'selected':''}>${t.regiao?'['+esc(t.regiao)+'] ':''}${esc(t.nome)}</option>`).join('')}
        </select>
        ${resolvidosTodos.length?`<button class="btn sm" onclick="exportarResolvidosExcel()">${ic('bar-chart-3')} Exportar Excel</button><button class="btn sm" onclick="gerarRelatorioResolvidos()">${ic('printer')} Gerar relatório</button>`:''}
      </div>
      <div id="resolvidosTabelaBox"></div>
    </div></div>`;
  renderPerdidosTabela();
  renderResolvidosTabela();
}
// Re-renderiza só a tabela "Histórico de localizados" (mesmo motivo de
// renderPerdidosTabela() — o campo de busca não pode perder o foco a cada letra).
function renderResolvidosTabela(){
  const box = $('#resolvidosTabelaBox'); if(!box) return;
  const lista = resolvidosFiltrados();
  if($('#resolvidosTabelaCount')) $('#resolvidosTabelaCount').textContent = lista.length;
  box.innerHTML = !lista.length ? '<div class="empty">Nenhum item foi localizado ainda (ou nenhum bate com esses filtros).</div>' :
    `<div class="tbl-wrap"><table><thead><tr><th>Quando</th><th>Nº Série</th><th>Tipo</th><th>Foi localizado</th><th>Usuário</th></tr></thead><tbody>
      ${lista.map(({mov:m,eq})=>`<tr><td class="mono">${fmtTS(m.ts)}</td><td class="mono">${esc(m.serie)}</td><td>${eq?`<span class="tag-tipo" style="border-left:3px solid ${tipoCor(eq.tipo)}">${esc(tipoNome(eq.tipo))}</span>`:'—'}</td><td>${esc(m.para)}</td><td>${esc(m.usuario||'—')}</td></tr>`).join('')}
    </tbody></table></div>`;
}
// Re-renderiza só a tabela "Pendentes de localizar" (não o resto da tela) — usada pelo
// campo de busca (oninput, dispara a cada letra) pra não perder o foco do campo a cada
// tecla, mesmo motivo de filtrarEquip()/renderEquipTabela() em Equipamentos. Reflete
// todos os filtros de perdidosFiltrados() (região, pílula de filial, tipo, busca).
function renderPerdidosTabela(){
  const box = $('#perdidosTabelaBox'); if(!box) return;
  const podeAgir = souAdmin();
  const pendentes = perdidosFiltrados();
  if($('#perdidosTabelaCount')) $('#perdidosTabelaCount').textContent = pendentes.length;
  // Com centenas de itens espalhados por muitas filiais, listar tudo de uma vez de
  // propósito ficava poluído (achado do usuário, 20/07/2026) — a lista detalhada só
  // aparece depois de algum filtro ser aplicado (filial, tipo ou busca); sem filtro,
  // o gráfico "Pendentes por filial" acima já dá a visão agrupada/resumida.
  const temFiltro = perdidosFiliaisFiltro.length>0 || !!perdidosTipoFiltro || perdidosBusca.trim().length>0;
  if(!temFiltro){
    box.innerHTML = `<div class="empty">Selecione uma filial (pílula, gráfico ou o campo acima), um tipo, ou busque por um nº de série pra ver a lista detalhada — ${pendentes.length} equipamento(s) pendente(s) ao todo.</div>`;
    return;
  }
  const porFilialFiltrado = {};
  pendentes.forEach(e=>{ const f=e.perdidoFilial||'Sem filial'; (porFilialFiltrado[f]=porFilialFiltrado[f]||[]).push(e); });
  const filiaisFiltradas = Object.keys(porFilialFiltrado).sort();
  box.innerHTML = !pendentes.length ? '<div class="empty">Nenhum equipamento pendente de localização com esses filtros.</div>' :
    filiaisFiltradas.map(f=>`
      <div style="margin-bottom:18px">
        <h4 style="margin-bottom:8px">${esc(f)} <span class="count-badge">${porFilialFiltrado[f].length}</span></h4>
        <div class="tbl-wrap"><table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Há quanto tempo</th><th>Motivo</th><th>Marcado por</th>${podeAgir?'<th></th>':''}</tr></thead><tbody>
          ${porFilialFiltrado[f].map(e=>`<tr>
            <td class="mono">${esc(e.serie)}</td>
            <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span></td>
            <td>${fmtDias(Math.floor((Date.now()-(e.perdidoDesde||Date.now()))/86400000))}</td>
            <td>${esc(e.perdidoObs||'—')}</td>
            <td>${esc(e.perdidoUsuario||'—')}</td>
            ${podeAgir?`<td class="right"><button class="btn sm" onclick="desmarcarPerdido('${esc(e.serie)}')">Desmarcar</button></td>`:''}
          </tr>`).join('')}
        </tbody></table></div>
      </div>`).join('');
}
function exportarPerdidosExcel(){
  const pendentes = perdidosFiltrados();
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const linhas = pendentes.map(e=>({ 'Nº Série':e.serie, 'Tipo':tipoNome(e.tipo), 'Filial':e.perdidoFilial||'—', 'Há quanto tempo':fmtDias(Math.floor((Date.now()-(e.perdidoDesde||Date.now()))/86400000)), 'Motivo':e.perdidoObs||'—', 'Marcado por':e.perdidoUsuario||'—' }));
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Nº Série':'','Tipo':'','Filial':'','Há quanto tempo':'','Motivo':'','Marcado por':'Nenhum item'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inventario Pendente');
  XLSX.writeFile(wb, 'inventario_pendente_'+(perdidosFiliaisFiltro.length?perdidosFiliaisFiltro.join('_'):'todas_filiais').replace(/[^\w-]+/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
function gerarRelatorioPerdidos(){
  const pendentes = perdidosFiltrados();
  const titulo = perdidosFiliaisFiltro.length ? perdidosFiliaisFiltro.join(', ') : 'Todas as filiais';
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Inventário Pendente</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Relatório de Inventário Pendente</h1>
    <h2>${esc(titulo)} · ${pendentes.length} item(ns) pendente(s) · gerado em ${hoje}</h2>
    <table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Filial</th><th>Há quanto tempo</th><th>Motivo</th><th>Marcado por</th></tr></thead><tbody>
      ${pendentes.length? pendentes.map(e=>`<tr><td>${esc(e.serie)}</td><td>${esc(tipoNome(e.tipo))}</td><td>${esc(e.perdidoFilial||'—')}</td><td>${fmtDias(Math.floor((Date.now()-(e.perdidoDesde||Date.now()))/86400000))}</td><td>${esc(e.perdidoObs||'—')}</td><td>${esc(e.perdidoUsuario||'—')}</td></tr>`).join('') : '<tr><td colspan="6">Nenhum equipamento pendente de localização.</td></tr>'}
    </tbody></table>
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}
function exportarResolvidosExcel(){
  const lista = resolvidosFiltrados();
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const linhas = lista.map(({mov:m,eq})=>({ 'Quando':fmtTS(m.ts), 'Nº Série':m.serie, 'Tipo':eq?tipoNome(eq.tipo):'—', 'Foi localizado':m.para, 'Usuário':m.usuario||'—' }));
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Quando':'','Nº Série':'','Tipo':'','Foi localizado':'','Usuário':'Nenhum item'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Historico Localizados');
  XLSX.writeFile(wb, 'inventario_pendente_historico_'+(resolvidosFilialFiltro||'todas_filiais').replace(/[^\w-]+/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
function gerarRelatorioResolvidos(){
  const lista = resolvidosFiltrados();
  const titulo = resolvidosFilialFiltro || 'Todas as filiais';
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Histórico de Localizados</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Relatório de Histórico de Localizados</h1>
    <h2>${esc(titulo)} · ${lista.length} item(ns) · gerado em ${hoje}</h2>
    <table><thead><tr><th>Quando</th><th>Nº Série</th><th>Tipo</th><th>Foi localizado</th><th>Usuário</th></tr></thead><tbody>
      ${lista.length? lista.map(({mov:m,eq})=>`<tr><td>${fmtTS(m.ts)}</td><td>${esc(m.serie)}</td><td>${eq?esc(tipoNome(eq.tipo)):'—'}</td><td>${esc(m.para)}</td><td>${esc(m.usuario||'—')}</td></tr>`).join('') : '<tr><td colspan="5">Nenhum item foi localizado ainda.</td></tr>'}
    </tbody></table>
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}
// Importação em massa pro Inventário Pendente — pensada pra planilhas com equipamentos
// de VÁRIAS filiais diferentes no mesmo lote (diferente da marcação manual/do formulário
// acima, que é 1 filial calculada automaticamente por vez). Reaproveita o mesmo
// reconhecimento de colunas da importação de estoque (COL_MAP/acharCol/parseCSVLinha,
// app.js:~3327+), mas a coluna Depósito aqui é OBRIGATÓRIA e é ela que vira
// perdido_filial de cada linha (decisão do usuário, 20/07/2026) — ao contrário da
// marcação manual, que calcula a filial pela localização atual do item no sistema.
function parseLinhasPerdido(matriz, motivo){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  if(!matriz.length){ flash('Arquivo vazio','red'); return; }
  let hi=0; for(let i=0;i<Math.min(20,matriz.length);i++){ const row=matriz[i].map(c=>String(c).toLowerCase()); if(row.some(c=>c.includes('série')||c.includes('serie'))){ hi=i; break; } }
  const headers=matriz[hi].map(c=>String(c));
  const ci={ serie:acharCol(headers,COL_MAP.serie), produto:acharCol(headers,COL_MAP.produto), deposito:acharCol(headers,COL_MAP.deposito) };
  if(ci.serie<0){ flash('Não encontrei a coluna "Nº Série". Verifique o cabeçalho.','red'); return; }
  if(ci.deposito<0){ flash('Não encontrei a coluna "Depósito" — obrigatória aqui, já que cada linha pode ser de uma filial diferente.','red'); return; }

  const usuario = nomeUsuarioAtual();
  let marcados=0, criados=0, ignorados=0;
  for(let i=hi+1;i<matriz.length;i++){
    const row=matriz[i]; if(!row||!row.length) continue;
    const serie=String(row[ci.serie]==null?'':row[ci.serie]).trim(); if(!serie) continue;
    const filial = limparFilial(row[ci.deposito]||'');
    if(!filial){ ignorados++; continue; }
    let e = acharEquipPorSerie(serie);
    if(e){
      if(e.perdido){ ignorados++; continue; }
    } else {
      const tipoProduto = ci.produto>=0? String(row[ci.produto]||'').trim() : '';
      const tipo = detectarTipoPorSerie(serie) || tipoProduto || 'SEM-TIPO';
      e = { serie, tipo, deposito:filial, local:filial, status:'estoque', tecnicoId:null, dataEntrada:'', origem:'', familia:'', derivacao:'', um:'', obs:'', confirmado:true, desde:Date.now() };
      DB.equipamentos.push(e);
      if(!DB.tipos[tipo]) DB.tipos[tipo]={nome:tipo,cor:''};
      criados++;
    }
    e.perdido=true; e.perdidoDesde=Date.now(); e.perdidoFilial=filial; e.perdidoUsuario=usuario; e.perdidoObs=motivo||'';
    registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'perdido', serie:e.serie, de:filial, para:'Inventário Pendente', tecnicoId:e.tecnicoId||null, usuario, obs:motivo||'' });
    marcados++;
  }
  salvar(); render();
  flash(`${marcados} equipamento(s) marcado(s) como perdido(s)`+(criados?`, ${criados} novo(s) no sistema`:'')+(ignorados?`, ${ignorados} ignorado(s) (já perdido ou sem depósito)`:''), marcados?'green':'red');
}
function importarColadoPerdido(){
  const txt=$('#perdidoPasteArea').value; if(!txt.trim()) return flash('Cole os dados primeiro','red');
  const motivo = $('#perdidoMotivoLote')?$('#perdidoMotivoLote').value.trim():'';
  const delim = txt.includes('\t')?'\t':(txt.split('\n')[0].includes(';')?';':',');
  const matriz = txt.replace(/\r/g,'').split('\n').filter(l=>l.trim()).map(l=>parseCSVLinha(l,delim));
  parseLinhasPerdido(matriz, motivo);
}
function importarArquivoPerdido(input){
  const file=input.files[0]; if(!file) return;
  const motivo = $('#perdidoMotivoLote')?$('#perdidoMotivoLote').value.trim():'';
  const reader=new FileReader();
  if(/\.csv$/i.test(file.name)){
    reader.onload=e=>{ const txt=e.target.result; const delim=txt.includes('\t')?'\t':(txt.split('\n')[0].includes(';')?';':','); const matriz=txt.replace(/\r/g,'').split('\n').filter(l=>l.trim()).map(l=>parseCSVLinha(l,delim)); parseLinhasPerdido(matriz,motivo); };
    reader.readAsText(file,'utf-8');
  } else {
    if(window.__noXLSX||typeof XLSX==='undefined') return flash('Leitura de Excel indisponível (sem internet). Salve como CSV ou cole os dados.','red');
    reader.onload=e=>{ const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'}); const ws=wb.Sheets[wb.SheetNames[0]]; const matriz=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:''}); parseLinhasPerdido(matriz,motivo); };
    reader.readAsArrayBuffer(file);
  }
  input.value='';
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
  else if(movTipo==='uso_campo'){ destinoTxt='Instalado no cliente'; }

  if(movTipo==='transferencia' && !obs) return flash('Informe a observação para registrar a transferência','red');

  // Uso em campo: nada pode ficar pela metade — atendimento, OS e observação
  // são todos obrigatórios (regra de negócio confirmada em 11/07/2026).
  let atendimento = '';
  if(movTipo==='uso_campo'){
    atendimento = $('#movAtend')?$('#movAtend').value:'';
    if(!atendimento) return flash('Selecione o tipo de atendimento (Manutenção ou Instalação)','red');
    if(!obs) return flash('Informe a observação para registrar o uso em campo','red');
  }

  let numeroOS = '';
  if(movTipo==='baixa'||movTipo==='uso_campo'){
    numeroOS = $('#movOS')?$('#movOS').value.trim():'';
    if(!/^\d{6}$/.test(numeroOS)) return flash('Informe o número da OS com exatamente 6 números','red');
  }

  let n=0;
  movSel.forEach(serie=>{
    const e=DB.equipamentos.find(x=>x.serie===serie); if(!e || e.emTransito) return;
    const de = e.status==='com_tecnico'? tecNome(e.tecnicoId) : (e.local||e.deposito||'Estoque');
    const tecnicoAnterior = e.tecnicoId;
    const descricaoPerdido = (movTipo==='saida'||movTipo==='transferencia') ? 'Enviado para '+destinoTxt
      : movTipo==='entrada' ? 'Entrada no estoque de '+destinoTxt
      : movTipo==='baixa' ? 'Enviado para RMA (OS '+numeroOS+')'
      : 'Uso em campo (OS '+numeroOS+')';
    resolverPerdidoSeNecessario(e, descricaoPerdido);
    if(movTipo==='saida'||movTipo==='transferencia'){
      // fica "em trânsito": só sai do estoque/técnico de origem quando o destinatário confirmar o recebimento
      e.emTransito=true; e.transitoPara=tecId; e.transitoDesde=Date.now(); e.transitoDe=de; e.transitoUsuario=usuario; e.transitoDeTecnicoId=tecnicoAnterior||null;
    }
    else if(movTipo==='entrada'){ e.status='estoque'; e.tecnicoId=null; e.confirmado=true; e.emTransito=false; if($('#movDep')&&$('#movDep').value.trim()){e.deposito=limparFilial($('#movDep').value);} e.local=e.deposito; }
    else if(movTipo==='baixa'){ e.status='baixado'; e.tecnicoId=null; e.local='RMA'; e.confirmado=true; e.emTransito=false; e.rmaTecnicoId=tecnicoAnterior||null; e.rmaDeposito=e.deposito||null; e.rmaDesde=Date.now(); e.rmaOS=numeroOS; }
    else if(movTipo==='uso_campo'){ e.status='instalado'; e.tecnicoId=null; e.local='Cliente — OS '+numeroOS; e.confirmado=true; e.emTransito=false; e.instaladoTecnicoId=tecnicoAnterior||null; e.instaladoOS=numeroOS; e.instaladoDesde=Date.now(); }
    e.desde = Date.now();
    const motivo = movTipo==='baixa' && $('#movMotivo')? $('#movMotivo').value.trim() : '';
    const tecIdMov = (movTipo==='baixa'||movTipo==='uso_campo') ? tecnicoAnterior : tecId;
    const tecnicoIdOrigem = movTipo==='transferencia' ? (tecnicoAnterior||null) : null;
    const paraTxt = (movTipo==='saida'||movTipo==='transferencia') ? destinoTxt+' (aguardando confirmação)'
      : movTipo==='uso_campo' ? destinoTxt+' — OS '+numeroOS+' ('+atendimento+')' : destinoTxt;
    const obsFinal = movTipo==='baixa' ? ['OS '+numeroOS,obs,motivo].filter(Boolean).join(' · ')
      : movTipo==='uso_campo' ? ['OS '+numeroOS,atendimento,obs].filter(Boolean).join(' · ')
      : [obs,motivo].filter(Boolean).join(' · ');
    registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:movTipo, serie, de, para:paraTxt, tecnicoId:tecIdMov, tecnicoIdOrigem, usuario, obs:obsFinal, os:numeroOS });
    n++;
  });
  salvar(); closeModal(); render(); flash(`${n} ${n===1?'movimentação registrada':'movimentações registradas'}`+((movTipo==='saida'||movTipo==='transferencia')?' — aguardando confirmação do técnico':''),'green');
}

/* =========================================================
   IMPORTAÇÃO
   ========================================================= */
const COL_MAP = {
  serie:['nº série','no série','n° série','numero de serie','nº de série','serie','série','n serie','nº serie','iccid'],
  produto:['produto','tipo'],
  deposito:['depósito','deposito','local','armazém','armazem'],
  data:['data entrada','data de entrada','data','entrada'],
  origem:['origem'], familia:['família','familia'], derivacao:['derivação','derivacao'], um:['um','unidade'],
  operadora:['operadora'],
  // Frases específicas, de propósito (NÃO "número"/"numero" soltos — colidiria com
  // "nº de série", que também contém essa palavra e é resolvida antes desta coluna).
  numeroLinha:['número da linha','numero da linha','nº da linha','n da linha','linha'],
  // Usadas só pela importação em lote de chips por técnico (22/07/2026, ver mais abaixo).
  tecnico:['técnico','tecnico'],
  entregue:['entregue','data de entrega','data entrega']
};
function acharCol(headers, chaves){
  const norm = h => h.toLowerCase().trim().replace(/\s+/g,' ');
  for(let i=0;i<headers.length;i++){ const h=norm(headers[i]); if(chaves.some(c=>h===c||h.includes(c))) return i; }
  return -1;
}
function parseLinhas(matriz, substituir){
  if(!matriz.length){ flash('Arquivo vazio','red'); return; }
  // acha header
  let hi=0; for(let i=0;i<Math.min(20,matriz.length);i++){ const row=matriz[i].map(c=>String(c).toLowerCase()); if(row.some(c=>c.includes('série')||c.includes('serie'))){ hi=i; break; } }
  const headers=matriz[hi].map(c=>String(c));
  const ci={ serie:acharCol(headers,COL_MAP.serie), produto:acharCol(headers,COL_MAP.produto), deposito:acharCol(headers,COL_MAP.deposito), data:acharCol(headers,COL_MAP.data), origem:acharCol(headers,COL_MAP.origem), familia:acharCol(headers,COL_MAP.familia), derivacao:acharCol(headers,COL_MAP.derivacao), um:acharCol(headers,COL_MAP.um), operadora:acharCol(headers,COL_MAP.operadora), numeroLinha:acharCol(headers,COL_MAP.numeroLinha) };
  if(ci.serie<0){ flash('Não encontrei a coluna "Nº Série". Verifique o cabeçalho.','red'); return; }

  if(substituir && !confirm('Isso vai atualizar o ESTOQUE (itens em depósito) com base nesta planilha: itens em estoque que não aparecerem nela serão removidos do sistema. Equipamentos que estão com técnico ou em RMA NÃO serão alterados, mesmo que não apareçam na planilha. Continuar?')) return;

  const idxPorSerie = {}; DB.equipamentos.forEach((e,i)=>{ idxPorSerie[e.serie.toLowerCase()]=i; });
  const seriesNaPlanilha = new Set();
  let novos=0, atualizados=0;
  for(let i=hi+1;i<matriz.length;i++){
    const row=matriz[i]; if(!row||!row.length) continue;
    const serie=String(row[ci.serie]==null?'':row[ci.serie]).trim(); if(!serie) continue;
    seriesNaPlanilha.add(serie.toLowerCase());
    const tipoProduto = ci.produto>=0? String(row[ci.produto]||'').trim() : '';
    const tipo = detectarTipoPorSerie(serie) || tipoProduto || 'SEM-TIPO';
    const reg = {
      serie, tipo,
      deposito: ci.deposito>=0? limparFilial(row[ci.deposito]):'',
      dataEntrada: ci.data>=0? String(row[ci.data]||'').trim():'',
      origem: ci.origem>=0?String(row[ci.origem]||'').trim():'',
      familia: ci.familia>=0?String(row[ci.familia]||'').trim():'',
      derivacao: ci.derivacao>=0?String(row[ci.derivacao]||'').trim():'',
      um: ci.um>=0?String(row[ci.um]||'').trim():'',
      operadora: ci.operadora>=0?String(row[ci.operadora]||'').trim():'',
      numeroLinha: ci.numeroLinha>=0?String(row[ci.numeroLinha]||'').trim():''
    };
    if(tipo && !DB.tipos[tipo]) DB.tipos[tipo]={nome:tipo,cor:''};
    const idxExistente = idxPorSerie[serie.toLowerCase()];
    if(idxExistente!==undefined){
      const e=DB.equipamentos[idxExistente]; Object.assign(e,reg); atualizados++;
    } else {
      DB.equipamentos.push(Object.assign({status:'estoque',tecnicoId:null,local:reg.deposito,obs:''},reg));
      idxPorSerie[serie.toLowerCase()]=DB.equipamentos.length-1; novos++;
    }
  }
  let removidos=0;
  if(substituir){
    // Coleta as séries ANTES de filtrar: a exclusão no banco é explícita (a
    // sincronização não infere mais exclusões — ver sincronizarEquipamentos/BUG-034).
    const seriesRemovidas = DB.equipamentos
      .filter(e=> e.status==='estoque' && !seriesNaPlanilha.has(e.serie.toLowerCase()))
      .map(e=>e.serie);
    DB.equipamentos = DB.equipamentos.filter(e=> e.status!=='estoque' || seriesNaPlanilha.has(e.serie.toLowerCase()));
    removidos = seriesRemovidas.length;
    if(removidos){
      excluirEquipamentosNoBanco(seriesRemovidas).catch(err=>{
        flash('A remoção dos '+removidos+' item(ns) fora da planilha NÃO foi aplicada na nuvem ('+err.message+') — eles vão reaparecer. Importe de novo com conexão.','red');
      });
    }
  }
  DB.config.importadoEm=Date.now(); salvar();
  flash(`Importado: ${novos} novos, ${atualizados} atualizados`+(removidos?`, ${removidos} removido(s) do estoque (não estavam na planilha)`:''),'green');
  goto('dashboard');
}
function parseCSVLinha(linha, delim){
  const out=[]; let cur=''; let dentroAspas=false;
  for(let i=0;i<linha.length;i++){
    const c=linha[i];
    if(dentroAspas){
      if(c==='"'){ if(linha[i+1]==='"'){ cur+='"'; i++; } else dentroAspas=false; }
      else cur+=c;
    } else {
      if(c==='"') dentroAspas=true;
      else if(c===delim){ out.push(cur); cur=''; }
      else cur+=c;
    }
  }
  out.push(cur);
  return out;
}
function importarColado(){
  const txt=$('#pasteArea').value; if(!txt.trim()) return flash('Cole os dados primeiro','red');
  const delim = txt.includes('\t')?'\t':(txt.split('\n')[0].includes(';')?';':',');
  const matriz = txt.replace(/\r/g,'').split('\n').filter(l=>l.trim()).map(l=>parseCSVLinha(l,delim));
  parseLinhas(matriz, $('#pasteSubstituir').checked);
}
function importarArquivo(input){
  const file=input.files[0]; if(!file) return;
  const sub = $('#fileSubstituir').checked;
  const reader=new FileReader();
  if(/\.csv$/i.test(file.name)){
    reader.onload=e=>{ const txt=e.target.result; const delim=txt.includes('\t')?'\t':(txt.split('\n')[0].includes(';')?';':','); const matriz=txt.replace(/\r/g,'').split('\n').filter(l=>l.trim()).map(l=>parseCSVLinha(l,delim)); parseLinhas(matriz,sub); };
    reader.readAsText(file,'utf-8');
  } else {
    if(window.__noXLSX||typeof XLSX==='undefined') return flash('Leitura de Excel indisponível (sem internet). Salve como CSV ou cole os dados.','red');
    reader.onload=e=>{ const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'}); const ws=wb.Sheets[wb.SheetNames[0]]; const matriz=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:''}); parseLinhas(matriz,sub); };
    reader.readAsArrayBuffer(file);
  }
  input.value='';
}

/* =========================================================
   IMPORTAÇÃO DE CHIPS — colar direto do portal da operadora (Virtueyes)
   20/07/2026. Formato irregular, sempre em blocos de ~4 linhas por chip:
     <ICCID><TAB>ALARME 365<TAB>
     Virtueyes-Claro   (ou Virtueyes-Tim)
     Orsegups
     Em trânsito
   Só o ICCID e a operadora (Claro/TIM) interessam — "ALARME 365"/"Orsegups"/
   "Em trânsito" são descartados de propósito (decisão confirmada com o usuário).
   Cada chip novo entra JÁ em trânsito para o técnico escolhido (mesmo padrão do
   'saida' de confirmarMov: status continua 'estoque', emTransito=true) — aparece
   na tela do técnico como aguardando confirmação de recebimento.
   ========================================================= */
let chipsPendentesImport = [];
// Reconhece o ICCID reaproveitando detectarTipoPorSerie (mesma fonte de verdade do
// prefixo 8955 usada no resto do sistema, evita duplicar a regra aqui) — qualquer
// linha cujo primeiro token bater com o tipo 'Chip' inicia um novo bloco.
function parseColagemChips(texto){
  const linhas = String(texto||'').replace(/\r/g,'').split('\n').map(l=>l.trim()).filter(Boolean);
  const chips = [];
  let atual = null;
  linhas.forEach(linha=>{
    const primeiroToken = linha.split('\t')[0].trim();
    if(detectarTipoPorSerie(primeiroToken)==='Chip'){
      atual = { serie:primeiroToken, operadora:'' };
      chips.push(atual);
      return;
    }
    if(!atual) return; // linha antes de qualquer ICCID reconhecido — ignora
    const m = linha.match(/^Virtueyes-(\w+)/i);
    if(m){
      const op = m[1].toLowerCase();
      if(op==='claro') atual.operadora='Claro';
      else if(op==='tim') atual.operadora='TIM';
    }
    // demais linhas (produto, "Orsegups", status "Em trânsito") são ignoradas de propósito
  });
  return chips;
}
function reconhecerChipsColados(){
  const txt = $('#chipPasteArea').value;
  if(!txt.trim()) return flash('Cole os dados copiados do portal primeiro','red');
  const chips = parseColagemChips(txt);
  if(!chips.length) return flash('Não reconheci nenhum ICCID (nº de série 8955...) nesse texto','red');
  const vistos = new Set();
  chipsPendentesImport = chips.map(c=>{
    const duplicado = !!acharEquipPorSerie(c.serie) || vistos.has(c.serie.toLowerCase());
    vistos.add(c.serie.toLowerCase());
    return { serie:c.serie, operadora:c.operadora, duplicado };
  });
  abrirModalImportChips();
}
function abrirModalImportChips(){
  const linhas = chipsPendentesImport.map((c,i)=>`
    <tr>
      <td class="mono">${esc(c.serie)}</td>
      <td>${c.duplicado
        ? `<span class="badge baixado">${ic('alert-triangle')} Já existe — será pulado</span>`
        : `<select onchange="chipsPendentesImport[${i}].operadora=this.value" style="padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--panel);color:var(--txt)">
            <option value="" ${!c.operadora?'selected':''}>— selecione —</option>
            <option value="Claro" ${c.operadora==='Claro'?'selected':''}>Claro</option>
            <option value="TIM" ${c.operadora==='TIM'?'selected':''}>TIM</option>
          </select>`}
      </td>
    </tr>`).join('');
  const novos = chipsPendentesImport.filter(c=>!c.duplicado).length;
  const pulados = chipsPendentesImport.length - novos;
  modal(ic('inbox')+' Importar chips — '+chipsPendentesImport.length+' reconhecido(s)', `
    <p class="muted" style="margin-bottom:12px">${novos} novo(s) será(ão) enviado(s)${pulados?`, ${pulados} já existente(s) será(ão) pulado(s)`:''}. Selecione o técnico que vai receber TODO o lote — a entrada no estoque da filial dele e o envio acontecem juntos, ele confirma o recebimento na tela dele.</p>
    <div class="tbl-wrap" style="max-height:280px;overflow:auto;margin-bottom:14px"><table><thead><tr><th>ICCID</th><th>Operadora</th></tr></thead><tbody>${linhas}</tbody></table></div>
    <div class="field"><label>Técnico de destino *</label><select id="chipImportTec"><option value="">— selecione —</option>${agruparTecsPorFilialOpt(DB.tecnicos,'')}</select></div>`,
    `<button class="btn" onclick="closeModal()">Cancelar</button>
     <button class="btn primary" onclick="confirmarImportChips()">${ic('check')} Confirmar envio</button>`, 'lg');
}
function confirmarImportChips(){
  const tecId = $('#chipImportTec').value;
  if(!tecId) return flash('Selecione o técnico de destino','red');
  const tecnico = DB.tecnicos.find(t=>t.id===tecId);
  if(!tecnico) return flash('Técnico não encontrado','red');
  const novos = chipsPendentesImport.filter(c=>!c.duplicado);
  if(!novos.length) return flash('Nenhum chip novo para enviar — todos já existem no sistema','red');
  const usuario = nomeUsuarioAtual();
  const filial = tecnico.regiao||'';
  const destinoTxt = tecNome(tecId);
  novos.forEach(c=>{
    DB.equipamentos.push({
      serie:c.serie, tipo:'Chip', deposito:filial, local:filial, status:'estoque', tecnicoId:null,
      dataEntrada:'', origem:'', familia:'', derivacao:'', um:'', obs:'', confirmado:true, desde:Date.now(),
      operadora:c.operadora||null, numeroLinha:null,
      emTransito:true, transitoPara:tecId, transitoDesde:Date.now(), transitoDe:filial, transitoUsuario:usuario, transitoDeTecnicoId:null
    });
    registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'saida', serie:c.serie, de:filial, para:destinoTxt+' (aguardando confirmação)', tecnicoId:tecId, tecnicoIdOrigem:null, usuario, obs:'Importado do portal da operadora' });
  });
  if(!DB.tipos['Chip']) DB.tipos['Chip']={nome:'Chip',cor:''};
  const pulados = chipsPendentesImport.length - novos.length;
  chipsPendentesImport = [];
  salvar(); closeModal(); render();
  flash(`${novos.length} chip(s) enviado(s) para ${destinoTxt} — aguardando confirmação`+(pulados?`, ${pulados} pulado(s) por já existir`:''),'green');
}

/* =========================================================
   IMPORTAÇÃO EM LOTE DE CHIPS JÁ EM MÃOS DOS TÉCNICOS (planilha)
   22/07/2026. Diferente da importação acima (que cola texto do portal e manda
   o lote inteiro pra 1 técnico só): aqui é uma PLANILHA onde cada LINHA já tem
   o seu próprio técnico — entrada retroativa de chips que já estão fisicamente
   com eles (decisão do usuário). O nome do técnico na planilha vem sujo, com
   prefixo de filial/produto (ex.: "SOO - EPV - A365 - Fulano de Tal") — o nome
   de verdade é sempre o ÚLTIMO trecho depois do último " - ". Cada chip entra
   em trânsito (emTransito=true, mesmo padrão de confirmarImportChips acima)
   pro técnico da linha — ele confirma o recebimento na tela dele, exatamente
   como pedido ("quando eu der entrada deve ficar para eles confirmarem que
   receberam"). Usa a data da coluna "Entregue" (quando existir) como
   transitoDesde/ts da movimentação, não a data de hoje — preserva o histórico
   real de quando o chip realmente chegou às mãos do técnico.
   ========================================================= */
let chipsTecPendentesImport = [];
function extrairNomeTecnicoBruto(raw){
  const partes = String(raw||'').split(' - ').map(p=>p.trim()).filter(Boolean);
  return partes.length ? partes[partes.length-1] : String(raw||'').trim();
}
// BUG-053: planilhas exportadas de sistema externo (Ubisafe) trazem nomes com
// caracteres invisíveis (espaço não separável, zero-width space, BOM) que o
// usuário não vê na tela mas que quebram uma comparação de texto ingênua —
// mesmo nome "idêntico" aos olhos do usuário não casava com NENHUM técnico.
// Usa NFD + remove marca diacrítica pelo código numérico (0x0300-0x036F, evita
// digitar a faixa Unicode como regex literal — problema real encontrado ao
// escrever isso, ver G.19) e some com uma lista de códigos de caractere
// invisível conhecidos (soft hyphen, zero-width space/non-joiner/joiner,
// marca direita-p-esquerda, BOM).
const CODIGOS_INVISIVEIS_NOME_TEC = new Set([173, 8203, 8204, 8205, 8206, 8207, 65279]);
function normalizarNomeTec(s){
  let out = '';
  for(const ch of String(s||'').normalize('NFD')){
    const c = ch.codePointAt(0);
    if(c>=768 && c<=879) continue;
    out += CODIGOS_INVISIVEIS_NOME_TEC.has(c) ? ' ' : ch;
  }
  return out.toLowerCase().trim().replace(/\s+/g,' ');
}
// Segundo nível, só usado se a comparação normal não achar candidato nenhum:
// compara só as letras (a-z), ignorando qualquer espaço/pontuação/caractere
// invisível que a normalização acima não tenha previsto — rede de segurança
// extra pra planilha externa, sem abrir mão da exigência de casar 1 só nome.
function normalizarNomeTecLetras(s){ return normalizarNomeTec(s).replace(/[^a-z]/g,''); }
// BUG-054: descoberto ao investigar por que NENHUM técnico casava mesmo com
// nome idêntico (planilha real do usuário, 22/07/2026) — a causa não era
// texto sujo, era o cadastro de técnicos ter ~92 registros duplicados
// (mesma pessoa cadastrada 2x, IDs diferentes; já corrigido em produção).
// candidatosTecnicoPorNome() expõe a lista inteira de candidatos (não só
// o match final) pra distinguir "não achei ninguém" de "achei mais de um" —
// essa distinção é o que teria tornado aquele diagnóstico imediato em vez de
// precisar investigar o banco direto.
function candidatosTecnicoPorNome(nomeExtraido){
  const alvo = normalizarNomeTec(nomeExtraido);
  if(!alvo) return [];
  const exatos = DB.tecnicos.filter(t=>normalizarNomeTec(t.nome)===alvo);
  if(exatos.length) return exatos;
  const alvoLetras = normalizarNomeTecLetras(nomeExtraido);
  if(!alvoLetras) return [];
  return DB.tecnicos.filter(t=>normalizarNomeTecLetras(t.nome)===alvoLetras);
}
// Só casa se for único candidato com nome idêntico (ignorando acento/caixa) —
// nome ambíguo (2 técnicos com mesmo nome) ou não encontrado fica sem match,
// exigindo escolha manual no modal em vez de arriscar mandar pro técnico errado.
function acharTecnicoPorNomePlanilha(raw){
  const candidatos = candidatosTecnicoPorNome(extrairNomeTecnicoBruto(raw));
  return candidatos.length===1 ? candidatos[0] : null;
}
function extrairOperadoraPlanilha(raw){
  const s = String(raw||'').trim();
  const m = s.match(/Virtueyes-(\w+)/i);
  if(m){ const op=m[1].toLowerCase(); if(op==='claro') return 'Claro'; if(op==='tim') return 'TIM'; }
  return s;
}
function parseDataChipPlanilha(raw){
  const s = String(raw||'').trim(); if(!s) return null;
  const ts = Date.parse(s.replace(' ','T'));
  return isNaN(ts) ? null : ts;
}
function parseLinhasChipsTecnico(matriz){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  if(!matriz.length){ flash('Arquivo vazio','red'); return; }
  let hi=0; for(let i=0;i<Math.min(20,matriz.length);i++){ const row=matriz[i].map(c=>String(c).toLowerCase()); if(row.some(c=>c.includes('iccid')||c.includes('série')||c.includes('serie'))){ hi=i; break; } }
  const headers=matriz[hi].map(c=>String(c));
  const ci={ serie:acharCol(headers,COL_MAP.serie), operadora:acharCol(headers,COL_MAP.operadora), numeroLinha:acharCol(headers,COL_MAP.numeroLinha), tecnico:acharCol(headers,COL_MAP.tecnico), entregue:acharCol(headers,COL_MAP.entregue) };
  if(ci.serie<0) return flash('Não encontrei a coluna "IccId"/"Nº Série". Verifique o cabeçalho.','red');
  if(ci.tecnico<0) return flash('Não encontrei a coluna "Técnico". Verifique o cabeçalho.','red');

  const vistos = new Set();
  const linhas = [];
  for(let i=hi+1;i<matriz.length;i++){
    const row=matriz[i]; if(!row||!row.length) continue;
    const serie=String(row[ci.serie]==null?'':row[ci.serie]).trim(); if(!serie) continue;
    const duplicado = !!acharEquipPorSerie(serie) || vistos.has(serie.toLowerCase());
    vistos.add(serie.toLowerCase());
    const tecnicoRaw = ci.tecnico>=0? String(row[ci.tecnico]||'').trim() : '';
    const tecnicoNome = extrairNomeTecnicoBruto(tecnicoRaw);
    const candidatosTecnico = candidatosTecnicoPorNome(tecnicoNome);
    linhas.push({
      serie, duplicado,
      operadora: ci.operadora>=0? extrairOperadoraPlanilha(row[ci.operadora]) : '',
      numeroLinha: ci.numeroLinha>=0? String(row[ci.numeroLinha]||'').trim() : '',
      entregueTS: ci.entregue>=0? parseDataChipPlanilha(row[ci.entregue]) : null,
      tecnicoRaw, tecnicoNome,
      tecnicoId: candidatosTecnico.length===1 ? candidatosTecnico[0].id : '',
      tecnicoAmbiguo: candidatosTecnico.length>1
    });
  }
  if(!linhas.length) return flash('Nenhuma linha reconhecida na planilha','red');
  chipsTecPendentesImport = linhas;
  abrirModalImportChipsTecnico();
}
function importarColadoChipsTecnico(){
  const txt = $('#chipTecPasteArea').value; if(!txt.trim()) return flash('Cole os dados primeiro','red');
  const delim = txt.includes('\t')?'\t':(txt.split('\n')[0].includes(';')?';':',');
  const matriz = txt.replace(/\r/g,'').split('\n').filter(l=>l.trim()).map(l=>parseCSVLinha(l,delim));
  parseLinhasChipsTecnico(matriz);
}
function importarArquivoChipsTecnico(input){
  const file=input.files[0]; if(!file) return;
  const reader=new FileReader();
  if(/\.csv$/i.test(file.name)){
    reader.onload=e=>{ const txt=e.target.result; const delim=txt.includes('\t')?'\t':(txt.split('\n')[0].includes(';')?';':','); const matriz=txt.replace(/\r/g,'').split('\n').filter(l=>l.trim()).map(l=>parseCSVLinha(l,delim)); parseLinhasChipsTecnico(matriz); };
    reader.readAsText(file,'utf-8');
  } else {
    if(window.__noXLSX||typeof XLSX==='undefined') return flash('Leitura de Excel indisponível (sem internet). Salve como CSV ou cole os dados.','red');
    reader.onload=e=>{ const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'}); const ws=wb.Sheets[wb.SheetNames[0]]; const matriz=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,defval:''}); parseLinhasChipsTecnico(matriz); };
    reader.readAsArrayBuffer(file);
  }
  input.value='';
}
function trocarTecnicoImportLinha(i, tecId){ if(chipsTecPendentesImport[i]) chipsTecPendentesImport[i].tecnicoId = tecId; }
function abrirModalImportChipsTecnico(){
  const linhas = chipsTecPendentesImport.map((c,i)=>{
    if(c.duplicado){
      return `<tr><td class="mono">${esc(c.serie)}</td><td colspan="4"><span class="badge baixado">${ic('alert-triangle')} Já existe — será pulado</span></td></tr>`;
    }
    return `<tr ${!c.tecnicoId?'style="background:var(--amber-soft)"':''}>
      <td class="mono">${esc(c.serie)}</td>
      <td>${esc(c.operadora||'—')}</td>
      <td>${esc(c.numeroLinha||'—')}</td>
      <td>${c.entregueTS? esc(fmtTS(c.entregueTS)) : '—'}</td>
      <td><select onchange="trocarTecnicoImportLinha(${i},this.value)" style="padding:6px 8px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--panel);color:var(--txt)">
          <option value="">— selecione —</option>
          ${agruparTecsPorFilialOpt(DB.tecnicos, c.tecnicoId)}
        </select>${!c.tecnicoId?`<div class="muted" style="font-size:11px;margin-top:2px">${c.tecnicoAmbiguo?`Encontrei mais de um técnico chamado "${esc(c.tecnicoNome)}" — escolha qual é`:`Não encontrei "${esc(c.tecnicoNome)}" no cadastro — selecione manualmente ou cadastre-o antes`}</div>`:''}</td>
    </tr>`;
  }).join('');
  const novos = chipsTecPendentesImport.filter(c=>!c.duplicado).length;
  const pulados = chipsTecPendentesImport.length - novos;
  const semTecnico = chipsTecPendentesImport.filter(c=>!c.duplicado && !c.tecnicoId).length;
  modal(ic('inbox')+' Importar chips em lote — '+chipsTecPendentesImport.length+' linha(s)', `
    <p class="muted" style="margin-bottom:12px">${novos} novo(s) será(ão) enviado(s)${pulados?`, ${pulados} já existente(s) será(ão) pulado(s)`:''}${semTecnico?`. <b>${semTecnico} sem técnico identificado</b> — selecione manualmente antes de confirmar.`:''} Cada chip entra em trânsito para o técnico indicado, aguardando confirmação de recebimento dele.</p>
    <div class="tbl-wrap" style="max-height:360px;overflow:auto;margin-bottom:14px"><table><thead><tr><th>ICCID</th><th>Operadora</th><th>Linha</th><th>Entregue</th><th>Técnico</th></tr></thead><tbody>${linhas}</tbody></table></div>`,
    `<button class="btn" onclick="closeModal()">Cancelar</button>
     <button class="btn primary" onclick="confirmarImportChipsTecnico()">${ic('check')} Confirmar envio</button>`, 'lg');
}
function confirmarImportChipsTecnico(){
  const novos = chipsTecPendentesImport.filter(c=>!c.duplicado);
  if(!novos.length) return flash('Nenhum chip novo para enviar — todos já existem no sistema','red');
  if(novos.some(c=>!c.tecnicoId)) return flash('Ainda tem chip sem técnico selecionado — resolva antes de confirmar','red');
  const usuario = nomeUsuarioAtual();
  novos.forEach(c=>{
    const tecnico = DB.tecnicos.find(t=>t.id===c.tecnicoId);
    const filial = tecnico.regiao||'';
    const destinoTxt = tecNome(c.tecnicoId);
    DB.equipamentos.push({
      serie:c.serie, tipo:'Chip', deposito:filial, local:filial, status:'estoque', tecnicoId:null,
      dataEntrada:'', origem:'', familia:'', derivacao:'', um:'', obs:'', confirmado:true, desde:Date.now(),
      operadora:c.operadora||null, numeroLinha:c.numeroLinha||null,
      emTransito:true, transitoPara:c.tecnicoId, transitoDesde:c.entregueTS||Date.now(), transitoDe:filial, transitoUsuario:usuario, transitoDeTecnicoId:null
    });
    registrarMovimentacao({ id:uid(), ts:c.entregueTS||Date.now(), tipo:'saida', serie:c.serie, de:filial, para:destinoTxt+' (aguardando confirmação)', tecnicoId:c.tecnicoId, tecnicoIdOrigem:null, usuario, obs:'Entrada retroativa em lote (planilha)'+(c.entregueTS?'':' — sem data de recebimento informada') });
  });
  if(!DB.tipos['Chip']) DB.tipos['Chip']={nome:'Chip',cor:''};
  const pulados = chipsTecPendentesImport.length - novos.length;
  chipsTecPendentesImport = [];
  salvar(); closeModal(); render();
  flash(`${novos.length} chip(s) enviado(s) para os técnicos — aguardando confirmação de cada um`+(pulados?`, ${pulados} pulado(s) por já existir`:''),'green');
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
  const linhas=historicoFiltrado().map(m=>[fmtTS(m.ts),MOV_LABEL[m.tipo],m.serie,m.de,m.para,m.usuario,m.obs]);
  baixar('historico_movimentacoes.csv','﻿'+[csvLinha(head),...linhas.map(csvLinha)].join('\n'),'text/csv');
}
function exportarFilialExcel(){
  const eq = dashboardFiltrado();
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const linhas = eq.map(e=>({ 'Nº Série':e.serie, 'Tipo':tipoNome(e.tipo), 'Depósito':e.deposito||'—', 'Status':STATUS[e.status]||e.status, 'Técnico':e.status==='com_tecnico'?tecNome(e.tecnicoId):'—', 'Desde':e.desde?fmtTS(e.desde):'—' }));
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Nº Série':'','Tipo':'','Depósito':'','Status':'','Técnico':'','Desde':'Nenhum item'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Equipamentos');
  const sufixoTec = dashTecnicoFiltro ? '_'+tecNome(dashTecnicoFiltro) : '';
  const sufixoStatus = dashStatusFiltro ? '_'+(STATUS[dashStatusFiltro]||dashStatusFiltro) : '';
  XLSX.writeFile(wb, 'equipamentos_'+(dashFiliais.length?dashFiliais.join('_'):'todas_filiais').replace(/[^\w-]+/g,'_')+sufixoTec.replace(/[^\w-]+/g,'_')+sufixoStatus.replace(/[^\w-]+/g,'_')+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
}
function relatorioFilial(){
  const eq = dashboardFiltrado();
  const titulo = (dashFiliais.length ? dashFiliais.join(', ') : 'Todas as filiais') + (dashTecnicoFiltro ? ' — '+tecNome(dashTecnicoFiltro) : '') + (dashStatusFiltro ? ' — '+(STATUS[dashStatusFiltro]||dashStatusFiltro) : '');
  const total=eq.length, emEstoque=eq.filter(e=>e.status==='estoque').length, comTec=eq.filter(e=>e.status==='com_tecnico').length, baixados=eq.filter(e=>e.status==='baixado').length;
  const porTipo={}; eq.forEach(e=>porTipo[e.tipo]=(porTipo[e.tipo]||0)+1);
  const porTec={}; eq.filter(e=>e.status==='com_tecnico').forEach(e=>{ const n=tecNome(e.tecnicoId); porTec[n]=(porTec[n]||0)+1; });
  const parados = eq.filter(e=>e.status==='com_tecnico'&&(diasEmPosse(e)||0)>=DIAS_PARADO);
  const alertasMin = dashFiliais.length ? alertasEstoqueMinPorFilial().filter(a=>dashFiliais.includes(a.filial)) : alertasEstoqueMinPorFilial();
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
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
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
    ${alertasMin.length?`<h3>Alertas de estoque mínimo</h3>${alertasMin.map(a=>linha(esc(a.filial)+' — '+esc(tipoNome(a.tipo)),a.atual+' / mín. '+a.min,'#dc2626')).join('')}`:''}
    ${parados.length?`<h3>Itens parados (${DIAS_PARADO}+ dias)</h3><table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Técnico</th><th>Dias</th></tr></thead><tbody>
      ${parados.map(e=>`<tr><td>${esc(e.serie)}</td><td>${esc(tipoNome(e.tipo))}</td><td>${esc(tecNome(e.tecnicoId))}</td><td>${diasEmPosse(e)}</td></tr>`).join('')}
    </tbody></table>`:''}
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}
function exportarBackup(automatico){
  baixar('backup_estoque_'+new Date().toISOString().slice(0,10)+'.json', JSON.stringify(DB,null,2),'application/json');
  DB.config.ultimoBackup = Date.now(); salvar();
  if(!automatico) flash('Backup exportado','green');
}
const RESPONSAVEL_BACKUP_EMAIL = 'cliver.guisolphi@orsegups.com.br';
let backupAutoChecado = false;
function verificarBackupAutomatico(){
  if(backupAutoChecado || !MEU_PERFIL || MEU_PERFIL.email!==RESPONSAVEL_BACKUP_EMAIL) return;
  backupAutoChecado = true;
  const dias = (Date.now()-(DB.config.ultimoBackup||0))/86400000;
  if(dias>=7){
    exportarBackup(true);
    flash('Backup automático gerado (já fazia '+Math.floor(dias)+' dia(s) do último). Confira sua pasta de downloads.','green');
  }
}
function importarBackup(input){
  const f=input.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=async e=>{
    try{
      const d=JSON.parse(e.target.result); if(!d.equipamentos) throw new Error('o arquivo não parece ser um backup deste sistema (falta a lista de equipamentos)');
      if(!confirm('Substituir TODOS os dados atuais pelo backup?')) return;
      const movsBackup = d.movimentacoes||[];
      const audsBackup = d.auditorias||[];
      DB=Object.assign(estadoInicial(),d); salvarLocal(); render(); renderNav();
      flash('Restaurando histórico, auditorias e equipamentos...','green');
      await limparTabela('movimentacoes');
      await gravarEmLote('movimentacoes', movsBackup.map(movimentacaoParaSnake));
      await limparTabela('auditorias');
      await gravarEmLote('auditorias', audsBackup.map(auditoriaParaSnake));
      // Equipamentos: substituição total EXPLÍCITA, mesmo padrão de movs/auditorias
      // acima (a sincronização não infere mais exclusões — ver BUG-034): limpa a
      // tabela e zera o rastro; o salvar() abaixo re-envia todos os itens do backup
      // como "alterados" (upsert em lotes), já na ordem certa depois de tipos/filiais/
      // técnicos por causa das chaves estrangeiras (ver salvar()/BUG-030).
      const { error: errLimpa } = await sb.from('equipamentos').delete().not('serie','is',null);
      if(errLimpa) throw errLimpa;
      ultimoSyncEquip = {};
      salvar();
      flash('Backup restaurado','green');
    }catch(err){ flash('Arquivo de backup inválido: '+err.message,'red'); }
  }; r.readAsText(f); input.value='';
}
async function gravarEmLote(tabela, lista){
  for(let i=0;i<lista.length;i+=500){
    const { error } = await sb.from(tabela).insert(lista.slice(i,i+500));
    if(error) throw error;
  }
}
async function limparTabela(tabela){
  const { error } = await sb.from(tabela).delete().not('id','is',null);
  if(error) throw error;
}
function corrigirItensCDO(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  const presos = DB.equipamentos.filter(e=>/^CDO/i.test(e.deposito||'') || /^CDO/i.test(e.local||''));
  if(!presos.length) return flash('Nenhum item preso em "CDO" encontrado — tudo certo','green');
  const destino = prompt('Encontrei '+presos.length+' equipamento(s) com depósito "CDO" (sobra de um teste). Pra qual filial devo mover eles? (digite a sigla)');
  if(!destino) return;
  const nome = limparFilial(destino);
  presos.forEach(e=>{ e.deposito=nome; if(e.status==='estoque') e.local=nome; });
  salvar(); render(); flash(`${presos.length} equipamento(s) movido(s) para ${nome}`,'green');
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
  salvar(); render(); flash(`${n} equipamento(s) corrigido(s)`,'green');
}
function corrigirTiposPorSerie(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  if(!confirm('Corrigir o TIPO de todos os equipamentos com base no padrão do nº de série (00-=Controle, 02-=Foto, 04-=Magnetico, 05-=Sirene, A453EE20=Módulo, 8955=Chip)? Isso também mescla "Central" em "Modulo" (mesmo tipo) e substitui o tipo atual sempre que o padrão for reconhecido.')) return;
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
  salvar(); render(); flash(`${n} equipamento(s) corrigido(s)`,'green');
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
  salvar(); render(); flash(`${n} equipamento(s) distribuído(s) entre técnicos (dados de teste)`,'green');
}
function gerarCenarioTesteCompleto(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  if(!confirm('Isso vai MEXER nos equipamentos reais cadastrados (só nos tipos com mínimo: Controle, Magnetico, Sirene, Foto, Modulo): vai distribuir quantidades aleatórias entre os técnicos, deixar algumas filiais de propósito abaixo do mínimo, e mandar uma parte pra RMA — só para você visualizar as telas. Depois dá pra desfazer no botão "Devolver tudo ao estoque". Continuar?')) return;
  const tiposComMin = Object.keys(DB.tipos).filter(tp=>(DB.tipos[tp].min||0)>0);
  const filiais = todasFiliaisConhecidas();
  let nTec=0, nRma=0;
  filiais.forEach(f=>{
    const tecs = DB.tecnicos.filter(t=>t.regiao===f);
    if(!tecs.length) return;
    const deixarBaixo = Math.random()<0.4;
    tiposComMin.forEach(tp=>{
      let itens = DB.equipamentos.filter(e=>e.deposito===f && e.tipo===tp && e.status==='estoque');
      if(!itens.length) return;
      itens = itens.slice().sort(()=>Math.random()-0.5);
      const qtdRma = Math.min(itens.length, Math.floor(Math.random()*3));
      for(let i=0;i<qtdRma;i++){
        const e = itens.pop();
        e.status='baixado'; e.tecnicoId=null; e.local='RMA'; e.confirmado=true; e.emTransito=false;
        e.rmaTecnicoId=null; e.rmaDeposito=e.deposito||null; e.rmaDesde=Date.now(); e.rmaOS='TESTE';
        e.cenarioTeste=true; nRma++;
      }
      const maxDistribuir = deixarBaixo ? Math.floor(itens.length*0.3) : itens.length;
      const qtdDistribuir = Math.floor(Math.random()*(maxDistribuir+1));
      for(let i=0;i<qtdDistribuir;i++){
        const e = itens[i];
        const tec = tecs[Math.floor(Math.random()*tecs.length)];
        e.status='com_tecnico'; e.tecnicoId=tec.id; e.local=tecNome(tec.id); e.confirmado=true; e.emTransito=false; e.desde=Date.now();
        e.cenarioTeste=true; nTec++;
      }
    });
  });
  salvar(); render(); flash(`Cenário de teste gerado: ${nTec} equipamento(s) com técnicos, ${nRma} em RMA`,'green');
}
function reverterCenarioTeste(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  const afetados = DB.equipamentos.filter(e=>e.cenarioTeste);
  if(!afetados.length) return flash('Nenhum equipamento de teste para reverter','red');
  if(!confirm(`Devolver ${afetados.length} equipamento(s) do cenário de teste de volta ao estoque?`)) return;
  afetados.forEach(e=>{
    e.status='estoque'; e.tecnicoId=null; e.local=e.deposito; e.confirmado=true; e.emTransito=false;
    e.rmaTecnicoId=null; e.rmaDeposito=null; e.rmaDesde=null; e.rmaOS=null;
    delete e.cenarioTeste;
  });
  salvar(); render(); flash(`${afetados.length} equipamento(s) devolvido(s) ao estoque`,'green');
}
function aplicarMinimosOficiais(){
  if(!souAdmin()) return flash('Somente administradores podem fazer isso','red');
  // Chip=4: o alerta dispara quando atual<min (ver alertasEstoqueMinPorTecnico/Filial) —
  // "ter 3 chips já deve aparecer como abaixo do mínimo" (decisão do usuário) exige
  // cadastrar 4 (3<4), não 3 (que só dispararia com 2 ou menos).
  const MINIMOS = { Controle:25, Magnetico:16, Sirene:8, Foto:30, Modulo:8, Chip:4 };
  if(!confirm('Aplicar o estoque mínimo oficial POR TÉCNICO (Controle=25, Magnetico=16, Sirene=8, Foto=30, Modulo=8, Chip=4)? O mínimo de cada filial passa a ser esse valor multiplicado pela quantidade de técnicos nela. Isso substitui o mínimo atual desses tipos.')) return;
  Object.entries(MINIMOS).forEach(([t,min])=>{
    if(!DB.tipos[t]) DB.tipos[t]={nome:t,cor:''};
    DB.tipos[t].min = min;
  });
  salvar(); render(); flash('Estoque mínimo aplicado','green');
}
async function limparTudo(){
  if(!confirm('Apagar TODOS os dados (equipamentos, técnicos, movimentações, auditorias)? Faça backup antes!')) return;
  const digitado = prompt('Esta ação não pode ser desfeita. Digite APAGAR (em maiúsculas) para confirmar:');
  if(digitado!=='APAGAR') return flash('Cancelado — nada foi apagado','red');
  DB=estadoInicial(); salvar(); goto('dados'); flash('Apagando histórico da nuvem...','green');
  try{
    await limparTabela('movimentacoes');
    await limparTabela('auditorias');
    await sb.from('equipamentos').delete().not('serie','is',null);
    ultimoSyncEquip={};
    flash('Todos os dados foram apagados');
  }catch(err){ flash(''+err.message,'red'); }
}

/* =========================================================
   KARDEX — histórico completo de um item
   ========================================================= */
async function abrirKardex(serie){
  const e=DB.equipamentos.find(x=>x.serie===serie);
  const movs=DB.movimentacoes.filter(m=>m.serie===serie);
  // Bucket privado — resolve URL assinada (temporária) só na hora de mostrar,
  // nunca guarda link público fixo (ver enviarFotosRetirada/resolverUrlsFotos).
  const urlsFotos = await resolverUrlsFotos(movs.flatMap(m=>m.fotos||[]));
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
          ${m.fotos&&m.fotos.length?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${m.fotos.filter(c=>urlsFotos[c]).map(c=>`<a href="${urlsFotos[c]}" target="_blank"><img src="${urlsFotos[c]}" style="width:56px;height:56px;object-fit:cover;border-radius:7px;border:1px solid var(--line)"></a>`).join('')}</div>`:''}
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
  modal(ic('hard-hat')+' '+(t.regiao?'['+esc(t.regiao)+'] ':'')+esc(t.nome), `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">
      <span class="badge blue" style="padding:8px 12px">${esc(t.regiao||'Sem região')}</span>
      ${t.matricula?`<span class="badge gray" style="padding:8px 12px">${esc(t.matricula)}</span>`:''}
      <span class="badge ${aud?'estoque':'baixado'}" style="padding:8px 12px">${aud?'Auditado '+fmtTS(aud.ts):'Nunca auditado'}</span>
      ${parados?`<span class="badge com_tecnico" style="padding:8px 12px">${parados} parado${parados>1?'s':''} ${DIAS_PARADO}+ dias</span>`:''}
    </div>
    <div class="chart-row" style="margin-bottom:18px">
      <div class="panel" style="box-shadow:none">
        <div class="ph"><h3>${ic('bar-chart-3')} Equipamentos por tipo</h3></div>
        <div class="pb"><div class="donut-wrap">
          ${donutData.length? donut(donutData) : '<div class="empty">Nenhum item em posse.</div>'}
        </div></div>
      </div>
      <div class="panel" style="box-shadow:none">
        <div class="ph"><h3>Resumo</h3></div>
        <div class="pb" style="display:flex;flex-direction:column;gap:14px">
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
            <div class="kpi a" style="padding:14px 16px"><div class="lbl" style="font-size:10px;letter-spacing:0">${ic('hard-hat')} EM POSSE</div><div class="val" style="font-size:22px">${itens.length}</div></div>
            <div class="kpi v" style="padding:14px 16px"><div class="lbl" style="font-size:10px;letter-spacing:0">${ic('clock')} MÉDIA POSSE</div><div class="val" style="font-size:22px">${mediaDias}d</div></div>
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
    `<button class="btn" style="margin-right:auto" onclick="termoResponsabilidade('${id}')">${ic('printer')} Termo de responsabilidade</button>
     <button class="btn primary" onclick="closeModal();iniciarAuditoria('tecnico','${id}')" ${itens.length?'':'disabled'}>${ic('search')} Auditar este técnico</button>`, 'lg');
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
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
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
  let tecsComItens=DB.tecnicos.filter(t=>itensDoTecnico(t.id).length>0);
  if(souSupervisor()) tecsComItens=tecsComItens.filter(t=>regiaoPermitida(t.regiao));
  let deps=[...new Set(DB.equipamentos.filter(e=>e.status==='estoque').map(e=>e.local||e.deposito).filter(Boolean))].sort();
  if(souSupervisor()) deps=deps.filter(regiaoPermitida);
  const audsPerm = auditoriasPermitidas();
  $('#content').innerHTML=`
  <div class="grid" style="grid-template-columns:1fr 1fr;margin-bottom:20px">
    <div class="panel"><div class="ph"><h3>${ic('search')} Auditar técnico</h3></div><div class="pb">
      <p class="muted" style="margin-bottom:12px">Confira fisicamente o que cada especialista tem em mãos. O sistema aponta o que <b>falta</b> e o que está <b>a mais</b>.</p>
      ${tecsComItens.length? `<div style="display:flex;flex-direction:column;gap:8px">${tecsComItens.map(t=>{const aud=ultimaAuditoria('tecnico',t.id);return `
        <button class="btn" style="justify-content:space-between;width:100%" onclick="iniciarAuditoria('tecnico','${t.id}')">
          <span>${ic('hard-hat')} ${esc(t.nome)} <span class="count-badge">${itensDoTecnico(t.id).length}</span></span>
          <span class="muted" style="font-size:11.5px">${aud?'auditado '+new Date(aud.ts).toLocaleDateString('pt-BR'):'nunca auditado'}</span>
        </button>`;}).join('')}</div>` : '<div class="empty">Nenhum técnico com itens em posse.</div>'}
    </div></div>
    <div class="panel"><div class="ph"><h3>${ic('map-pin')} Auditar depósito</h3></div><div class="pb">
      <p class="muted" style="margin-bottom:12px">Confira o saldo físico de um depósito contra o sistema.</p>
      ${deps.length? `<div style="display:flex;flex-direction:column;gap:8px">${deps.map(d=>`
        <button class="btn" style="justify-content:space-between;width:100%" onclick="iniciarAuditoria('deposito','${esc(d)}')">
          <span>${ic('map-pin')} ${esc(d)} <span class="count-badge">${itensDoDeposito(d).length}</span></span></button>`).join('')}</div>` : '<div class="empty">Nenhum depósito com itens.</div>'}
    </div></div>
  </div>
  ${audsPerm.length?`<div class="panel" style="margin-bottom:20px"><div class="ph"><h3>${ic('trending-up')} Evolução das divergências</h3><span class="muted" style="font-size:11.5px;margin-left:6px">(clique numa barra para ver o laudo)</span></div>
    <div class="pb">
      ${[...audsPerm].sort((a,b)=>a.ts-b.ts).map(a=>{
        const div=a.faltando.length+a.sobrando.length;
        const max=Math.max(1,...audsPerm.map(x=>x.faltando.length+x.sobrando.length));
        return `<div class="bar-row" style="cursor:pointer" onclick="verLaudo('${a.id}')">
          <div class="bl" style="width:190px;font-size:12px">${new Date(a.ts).toLocaleDateString('pt-BR')} · ${a.alvoTipo==='tecnico'?ic('hard-hat'):ic('map-pin')} ${esc(a.alvoNome)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(6,div/max*100)}%;background:${div?'var(--red)':'var(--green)'}">${div}</div></div>
        </div>`;}).join('')}
    </div>
  </div>`:''}
  <div class="panel"><div class="ph"><h3>${ic('clipboard-list')} Auditorias realizadas</h3><span class="count-badge">${audsPerm.length}</span></div>
    <div class="tbl-wrap">${
      audsPerm.length? `<table><thead><tr><th>Data</th><th>Alvo</th><th>Auditor</th><th class="center">Esperado</th><th class="center">Conferido</th><th class="center">Faltando</th><th class="center">Sobrando</th><th></th></tr></thead><tbody>
        ${[...audsPerm].reverse().map(a=>`<tr>
          <td class="muted">${fmtTS(a.ts)}</td>
          <td>${a.alvoTipo==='tecnico'?ic('hard-hat'):ic('map-pin')} ${esc(a.alvoNome)}</td>
          <td class="muted">${esc(a.auditor||'—')}</td>
          <td class="center">${a.esperados.length}</td>
          <td class="center"><b style="color:var(--green)">${a.conferidos.length}</b></td>
          <td class="center">${a.faltando.length?`<b style="color:var(--red)">${a.faltando.length}</b>`:'0'}</td>
          <td class="center">${a.sobrando.length?`<b style="color:var(--amber)">${a.sobrando.length}</b>`:'0'}</td>
          <td class="right"><button class="btn sm ghost" onclick="verLaudo('${a.id}')">Ver laudo</button></td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty"><div class="big">'+ic('search')+'</div>Nenhuma auditoria realizada ainda.</div>'
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
    <div style="flex:1;min-width:200px"><div class="muted" style="font-size:12px">Auditando ${AUD.alvoTipo==='tecnico'?'técnico':'depósito'}</div><div style="font-size:20px;font-weight:800">${AUD.alvoTipo==='tecnico'?ic('hard-hat'):ic('map-pin')} ${esc(AUD.alvoNome)}</div></div>
    <div class="center"><div style="font-size:26px;font-weight:800">${esp.length}</div><div class="muted" style="font-size:11px">ESPERADO</div></div>
    <div class="center"><div style="font-size:26px;font-weight:800;color:var(--green)">${conf.size}</div><div class="muted" style="font-size:11px">CONFERIDO</div></div>
    <div class="center"><div style="font-size:26px;font-weight:800;color:var(--red)">${faltando.length}</div><div class="muted" style="font-size:11px">FALTANDO</div></div>
    <div class="center"><div style="font-size:26px;font-weight:800;color:var(--amber)">${AUD.sobra.length}</div><div class="muted" style="font-size:11px">SOBRANDO</div></div>
  </div></div>

  <div class="panel" style="margin-bottom:18px"><div class="pb">
    <div class="field" style="margin-bottom:0"><label>Escaneie ou digite o nº de série e tecle Enter</label>
      <div style="display:flex;gap:8px;align-items:stretch">
        <div class="search" style="flex:1"><span class="si">${ic('camera')}</span><input id="audInput" autofocus placeholder="Bipe o código do equipamento..." onkeydown="if(event.key==='Enter'){audBipar();event.preventDefault()}"></div>
        <button class="btn primary" onclick="audBipar()">+ Adicionar</button>
      </div>
      <div class="hint">Item esperado → marca como conferido. Item não esperado → registrado como "sobrando" (divergência).</div>
    </div>
  </div></div>

  <div class="chart-row">
    <div class="panel"><div class="ph"><h3>Itens esperados</h3><div class="spacer"></div><button class="btn sm ghost" onclick="audMarcarTodos()">Marcar todos</button></div>
      <div class="tbl-wrap" style="max-height:360px"><table><tbody>
        ${esp.length?esp.map(s=>{const e=DB.equipamentos.find(x=>x.serie===s);const ok=conf.has(s);return `
          <tr onclick="audToggle('${esc(s)}')" style="cursor:pointer">
            <td style="width:30px">${ok?ic('check'):ic('square')}</td>
            <td class="mono"><b>${esc(s)}</b></td>
            <td>${e?`<span class="tag-tipo">${esc(tipoNome(e.tipo))}</span>`:''}</td>
            <td class="right">${ok?'<span class="badge estoque">conferido</span>':'<span class="badge gray">pendente</span>'}</td>
          </tr>`;}).join(''):'<tr><td class="empty">Nada esperado aqui.</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="panel"><div class="ph"><h3>${ic('alert-triangle')} Sobrando (não esperado)</h3></div>
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
    <button class="btn green" onclick="finalizarAuditoria()">${ic('check')} Finalizar e salvar laudo</button>
  </div>`;
  setTimeout(()=>{const i=$('#audInput');if(i)i.focus();},50);
}
function audBipar(){
  const inp=$('#audInput'); const v=inp.value.trim(); if(!v) return;
  const serie=(DB.equipamentos.find(x=>x.serie.toLowerCase()===v.toLowerCase())||{}).serie || v;
  if(AUD.esperados.includes(serie)){ AUD.conf.add(serie); flash('Conferido','green'); }
  else if(!AUD.sobra.includes(serie)){ AUD.sobra.push(serie); flash('Item não esperado (sobrando)','red'); }
  inp.value=''; renderAuditoriaEmAndamento();
}
function audToggle(s){ if(AUD.conf.has(s))AUD.conf.delete(s); else AUD.conf.add(s); renderAuditoriaEmAndamento(); }
function audMarcarTodos(){ AUD.esperados.forEach(s=>AUD.conf.add(s)); renderAuditoriaEmAndamento(); }
function audRemSobra(s){ AUD.sobra=AUD.sobra.filter(x=>x!==s); renderAuditoriaEmAndamento(); }
function finalizarAuditoria(){
  const conferidos=[...AUD.conf]; const faltando=AUD.esperados.filter(s=>!AUD.conf.has(s));
  const reg={ id:uid(), ts:Date.now(), alvoTipo:AUD.alvoTipo, alvoId:AUD.alvoId, alvoNome:AUD.alvoNome, auditor:nomeUsuarioAtual(), esperados:AUD.esperados.slice(), conferidos, faltando, sobrando:AUD.sobra.slice(), obs:'' };
  registrarAuditoria(reg); salvar();
  const divergencias=faltando.length+AUD.sobra.length;
  AUD=null; goto('auditoria');
  flash(divergencias? `Auditoria salva — ${divergencias} divergência(s)`:'Auditoria salva — tudo conferido!', divergencias?'red':'green');
  verLaudo(reg.id);
}
function verLaudo(id){
  const a=DB.auditorias.find(x=>x.id===id); if(!a) return;
  const sec=(titulo,arr,cor,vazio)=>`<div style="margin-bottom:12px"><div style="font-weight:700;margin-bottom:6px;color:${cor}">${titulo} (${arr.length})</div>${arr.length?`<div style="display:flex;flex-wrap:wrap;gap:6px">${arr.map(s=>`<span class="mono" style="background:var(--surface-2);padding:3px 8px;border-radius:6px;font-size:11.5px">${esc(s)}</span>`).join('')}</div>`:`<div class="muted" style="font-size:12.5px">${vazio}</div>`}</div>`;
  modal(ic('clipboard-list')+' Laudo de auditoria', `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <span class="badge blue" style="padding:8px 12px">${a.alvoTipo==='tecnico'?ic('hard-hat'):ic('map-pin')} ${esc(a.alvoNome)}</span>
      <span class="badge gray" style="padding:8px 12px">${fmtTS(a.ts)}</span>
      <span class="badge gray" style="padding:8px 12px">Auditor: ${esc(a.auditor||'—')}</span>
      <span class="badge ${(a.faltando.length+a.sobrando.length)?'baixado':'estoque'}" style="padding:8px 12px">${(a.faltando.length+a.sobrando.length)?(a.faltando.length+a.sobrando.length)+' divergência(s)':'Sem divergências'}</span>
    </div>
    ${sec(ic('check')+' Conferidos',a.conferidos,'var(--green)','—')}
    ${sec(ic('x-circle')+' Faltando (esperado, não encontrado)',a.faltando,'var(--red)','Nenhum item faltando.')}
    ${sec(ic('alert-triangle')+' Sobrando (encontrado, não esperado)',a.sobrando,'var(--amber)','Nenhum item a mais.')}`,
    `<button class="btn" onclick="exportarLaudoExcel('${a.id}')">${ic('bar-chart-3')} Exportar Excel</button><button class="btn" onclick="gerarRelatorioLaudo('${a.id}')">${ic('printer')} Gerar relatório</button><button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
}
function exportarLaudoExcel(id){
  const a=DB.auditorias.find(x=>x.id===id); if(!a) return;
  if(window.__noXLSX||typeof XLSX==='undefined') return flash('Exportação para Excel indisponível (sem internet). Use "Gerar relatório" e imprima como PDF.','red');
  const linhas = [
    ...a.conferidos.map(s=>({situacao:'Conferido', serie:s})),
    ...a.faltando.map(s=>({situacao:'Faltando', serie:s})),
    ...a.sobrando.map(s=>({situacao:'Sobrando (não esperado)', serie:s}))
  ].map(l=>{ const e=DB.equipamentos.find(x=>x.serie===l.serie); return { 'Nº Série':l.serie, 'Tipo':e?tipoNome(e.tipo):'—', 'Situação':l.situacao }; });
  const ws = XLSX.utils.json_to_sheet(linhas.length?linhas:[{'Nº Série':'','Tipo':'','Situação':'Nenhum item'}]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Laudo');
  const nomeArquivo = 'laudo_'+(a.alvoNome||'auditoria').replace(/[^\w-]+/g,'_')+'_'+new Date(a.ts).toISOString().slice(0,10)+'.xlsx';
  XLSX.writeFile(wb, nomeArquivo);
}
function gerarRelatorioLaudo(id){
  const a=DB.auditorias.find(x=>x.id===id); if(!a) return;
  const linhaSerie=(s,statusTxt,cor)=>{ const e=DB.equipamentos.find(x=>x.serie===s); return `<tr><td>${esc(s)}</td><td>${e?esc(tipoNome(e.tipo)):'—'}</td><td style="color:${cor}">${statusTxt}</td></tr>`; };
  const linhas = [
    ...a.conferidos.map(s=>linhaSerie(s,'Conferido','#16a34a')),
    ...a.faltando.map(s=>linhaSerie(s,'Faltando','#dc2626')),
    ...a.sobrando.map(s=>linhaSerie(s,'Sobrando (não esperado)','#d97706'))
  ];
  const hoje = new Date().toLocaleDateString('pt-BR')+' '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const divergencias = a.faltando.length+a.sobrando.length;
  const html=`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Laudo de Auditoria</title>
    <style>body{font-family:Arial,sans-serif;max-width:820px;margin:30px auto;padding:0 24px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;margin-bottom:2px}h2{font-size:13px;font-weight:normal;color:#555;margin-bottom:20px}
    table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12px}th{background:#f0f0f0}
    .kpis{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0}
    .kpi{flex:1;min-width:110px;border:1px solid #ddd;border-radius:8px;padding:12px 14px}
    .kpi b{display:block;font-size:22px;margin-top:4px}
    @media print{button{display:none}}</style></head><body>
    <button onclick="window.print()" style="padding:8px 16px;margin-bottom:16px;cursor:pointer">Imprimir / Salvar PDF</button>
    <h1>Laudo de Auditoria</h1>
    <h2>${esc(a.alvoNome)} · auditor: ${esc(a.auditor||'—')} · ${fmtTS(a.ts)} · gerado em ${hoje}</h2>
    <div class="kpis">
      <div class="kpi">Esperado<b>${a.esperados.length}</b></div>
      <div class="kpi">Conferido<b style="color:#16a34a">${a.conferidos.length}</b></div>
      <div class="kpi">Faltando<b style="color:#dc2626">${a.faltando.length}</b></div>
      <div class="kpi">Sobrando<b style="color:#d97706">${a.sobrando.length}</b></div>
    </div>
    <table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Situação</th></tr></thead><tbody>
      ${linhas.length?linhas.join(''):'<tr><td colspan="3">Nenhum item.</td></tr>'}
    </tbody></table>
    <p style="margin-top:20px">${divergencias?`${divergencias} divergência(s) encontrada(s).`:'Tudo conferido, sem divergências.'}</p>
    </body></html>`;
  const w=window.open('','_blank'); if(!w) return flash('Permita pop-ups para gerar o relatório','red'); w.document.write(html); w.document.close();
}

/* =========================================================
   ÁREA DO TÉCNICO (visão simplificada, mobile)
   ========================================================= */
function meuTecnico(){ return MEU_PERFIL && MEU_PERFIL.tecnicoId ? DB.tecnicos.find(t=>t.id===MEU_PERFIL.tecnicoId) : null; }
function semVinculoHtml(){
  return `<div class="panel"><div class="pb"><div class="empty"><div class="big">${ic('link')}</div>
    <h2 style="margin-bottom:8px">Seu acesso ainda não foi vinculado</h2>
    <p class="muted" style="max-width:420px;margin:0 auto">Peça para o administrador vincular seu login a um técnico cadastrado, na página <b>Usuários</b>.</p>
  </div></div></div>`;
}
let meusItensTipos = []; // array de tipos selecionados; vazio = todos
function meusItensToggleTipo(tp){
  const i = meusItensTipos.indexOf(tp);
  if(i>=0) meusItensTipos.splice(i,1); else meusItensTipos.push(tp);
  renderMeusItens();
}
function renderMeusItens(){
  const t = meuTecnico();
  if(!t) return $('#content').innerHTML = semVinculoHtml();
  const pendentes = DB.equipamentos.filter(e=>e.emTransito && e.transitoPara===t.id);
  const todosConfirmados = itensDoTecnico(t.id);
  const porTipoCount = {}; todosConfirmados.forEach(e=>{ porTipoCount[e.tipo]=(porTipoCount[e.tipo]||0)+1; });
  const tiposDisponiveis = Object.keys(porTipoCount).sort((a,b)=>tipoNome(a).localeCompare(tipoNome(b)));
  meusItensTipos = meusItensTipos.filter(tp=>tiposDisponiveis.includes(tp)); // limpa tipo que sumiu (item movimentado)
  const confirmados = meusItensTipos.length ? todosConfirmados.filter(e=>meusItensTipos.includes(e.tipo)) : todosConfirmados;
  $('#content').innerHTML = `
  <div class="grid kpis" style="margin-bottom:20px">
    ${kpi('a','package','Itens em posse',todosConfirmados.length)}
    ${kpi('r','hourglass','Aguardando confirmação',pendentes.length)}
  </div>
  <div class="panel" style="margin-bottom:20px;${pendentes.length?'border-left:4px solid var(--amber)':''}">
    <div class="ph"><h3>${ic('inbox')} Recebimento de equipamentos</h3><span class="count-badge">${pendentes.length} pendente${pendentes.length===1?'':'s'}</span></div>
    <div class="pb">
      ${pendentes.length?`
      <div class="field" style="margin-bottom:16px"><label>Bipe ou digite o nº de série e Enter para confirmar</label>
        <div style="display:flex;gap:8px;align-items:stretch">
          <div class="search" style="flex:1"><span class="si">${ic('camera')}</span><input id="recInput" autofocus placeholder="Bipe o código do equipamento..." onkeydown="if(event.key==='Enter'){recBipar();event.preventDefault()}"></div>
          <button class="btn primary" onclick="recBipar()">+ Adicionar</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${pendentes.map(e=>`
          <div class="rec-card">
            <div class="rec-info"><span class="mono rec-serie"><b>${esc(e.serie)}</b>${e.tipo==='Chip'&&e.operadora?` <span class="tag-tipo" style="background:var(--brand-soft);color:var(--brand-d)">${esc(e.operadora)}</span>`:''}</span><span class="rec-meta"><span class="tag-tipo">${esc(tipoNome(e.tipo))}</span><span class="muted" style="font-size:11.5px">de ${esc(e.transitoDe||'—')}</span></span></div>
            <button class="btn green sm" onclick="confirmarRecebimento('${esc(e.serie)}')">${ic('check')} Confirmar</button>
          </div>`).join('')}
      </div>` : '<div class="empty">Nenhum equipamento aguardando confirmação no momento.</div>'}
    </div>
  </div>
  <div class="panel"><div class="ph"><h3>${ic('package')} Meus equipamentos</h3><span class="count-badge">${confirmados.length}</span></div>
    ${tiposDisponiveis.length?`<div class="pb" style="padding-bottom:0">
      <div class="pill-tabs" style="flex-wrap:wrap;background:transparent;padding:0 0 14px;gap:8px">
        <button class="${!meusItensTipos.length?'active':''}" style="background:${!meusItensTipos.length?'var(--brand)':'var(--panel-soft)'};color:${!meusItensTipos.length?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="meusItensTipos=[];renderMeusItens()">Todos <span class="count-badge" style="background:rgba(255,255,255,.25);color:inherit;margin-left:4px">${todosConfirmados.length}</span></button>
        ${tiposDisponiveis.map(tp=>{ const on=meusItensTipos.includes(tp); return `
          <button class="${on?'active':''}" style="background:${on?'var(--brand)':'var(--panel-soft)'};color:${on?'#fff':'var(--txt)'};border-radius:var(--radius-md)" onclick="meusItensToggleTipo('${tp}')">${on?ic('check')+' ':''}${esc(tipoNome(tp))} <span class="count-badge" style="background:${on?'rgba(255,255,255,.25)':'var(--surface-2)'};color:inherit;margin-left:4px">${porTipoCount[tp]}</span></button>`;}).join('')}
      </div>
    </div>`:''}
    <div class="tbl-wrap">${
      confirmados.length? `<table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Há quanto tempo</th></tr></thead><tbody>
        ${confirmados.map(e=>`<tr>
          <td class="mono"><b>${esc(e.serie)}</b>${e.tipo==='Chip'&&e.operadora?` <span class="tag-tipo" style="background:var(--brand-soft);color:var(--brand-d)">${esc(e.operadora)}</span>`:''}</td>
          <td><span class="tag-tipo" style="border-left:3px solid ${tipoCor(e.tipo)}">${esc(tipoNome(e.tipo))}</span></td>
          <td>${fmtDias(diasEmPosse(e))} ${(diasEmPosse(e)||0)>=DIAS_PARADO?`<span class="badge com_tecnico" style="font-size:10px">parado</span>`:''}</td>
        </tr>`).join('')}</tbody></table>`
      : '<div class="empty">Nenhum equipamento com esse filtro.</div>'
    }</div></div>`;
  // Só foca o campo (e abre o teclado no celular) quando o técnico está ENTRANDO na
  // tela agora — nunca num re-render provocado por filtro/tempo real, senão o teclado
  // abre sozinho a cada clique num filtro (mesmo com preventScroll, que só evita a
  // rolagem — o teclado aparecendo já dá a mesma sensação incômoda de "pular pro topo").
  if(veioDeNavegacao){
    veioDeNavegacao = false;
    const i=$('#recInput'); if(i) i.focus({preventScroll:true});
  }
}
function recBipar(){
  const inp=$('#recInput'); const v=(inp.value||'').trim(); if(!v) return;
  const t = meuTecnico(); if(!t) return;
  const e = DB.equipamentos.find(x=>x.serie.toLowerCase()===v.toLowerCase() && x.emTransito && x.transitoPara===t.id);
  if(!e){ flash('Esse nº de série não está na sua lista de pendentes','red'); inp.value=''; return; }
  confirmarRecebimento(e.serie, true);
  inp.value='';
}
/* ---- Registro de retirada em campo (manutenção/desinstalação) ---- */
let formSel = [];
// Comprime a foto no navegador ANTES de enviar pro Storage — só se o arquivo for grande
// (>1MB); fotos já leves (testado com o usuário: câmera de celular moderna gera ~50-60KB
// pra esse tipo de foto, por causa das superfícies lisas dos equipamentos) sobem como
// estão, sem perder nitidez à toa. Usa createImageBitmap com correção de orientação EXIF
// (senão foto de celular sobe rotacionada — bug clássico). Redimensiona pro maior lado no
// máximo 1600px e reencoda em JPEG qualidade 0.72 — configuração validada visualmente com
// o usuário comparando original x comprimida antes de decidir (16/07/2026).
const FOTO_LIMIAR_COMPRIMIR = 1024*1024; // 1 MB
async function prepararFotoParaUpload(file){
  if(file.size <= FOTO_LIMIAR_COMPRIMIR) return file; // já é leve, sobe como está
  let bitmap;
  try{ bitmap = await createImageBitmap(file, {imageOrientation:'from-image'}); }
  catch(e){ return file; } // não conseguiu decodificar (formato raro) — sobe o original
  const maxDim = 1600;
  let w = bitmap.width, h = bitmap.height;
  if(Math.max(w,h) > maxDim){ const s = maxDim/Math.max(w,h); w = Math.round(w*s); h = Math.round(h*s); }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise(r=>canvas.toBlob(r, 'image/jpeg', 0.72));
  return blob || file;
}
// Comprime TODAS as fotos selecionadas no form — 100% local (canvas), funciona
// idêntico online e offline. Separado do envio (plano offline, 17/07/2026): assim a
// compressão acontece uma vez só, e o resultado (Blob já pronto) pode ser reaproveitado
// tanto pro envio imediato quanto pra guardar no IndexedDB caso não haja conexão.
async function prepararTodasFotosForm(){
  const prontos = [];
  for(const f of formFotos){
    const blob = await prepararFotoParaUpload(f.file);
    prontos.push({ idLocal:uid(), blob, nomeArquivo:f.file.name||'foto.jpg', contentType:blob.type||f.file.type||'image/jpeg' });
  }
  return prontos;
}
// Envia fotos JÁ PREPARADAS (ver prepararTodasFotosForm) pro bucket privado
// 'fotos-retirada', dentro da pasta do técnico (a RLS de Storage exige que o 1º
// segmento do caminho seja o próprio tecnico_id — ver supabase/rls_policies.sql).
// Devolve { caminhos, sobra, falhas }: caminhos = subiram com sucesso (não URLs — o
// bucket é privado, a exibição resolve URL assinada só na hora de mostrar); sobra =
// itens (mesmo formato de entrada) que falharam por FALTA DE CONEXÃO — ficam pendentes
// pra reenvio depois (plano offline: antes eram descartadas pra sempre); falhas =
// idLocal dos que falharam por erro REAL (não é falta de conexão), desistidos de vez.
async function enviarFotosPreparadas(tecnicoId, codigoRetirada, prontos){
  const caminhos = [], sobra = [], falhas = [];
  for(let i=0;i<prontos.length;i++){
    const p = prontos[i];
    const ext = p.contentType.includes('png')?'png':(p.contentType.includes('webp')?'webp':'jpg');
    const caminho = tecnicoId+'/'+codigoRetirada+'/'+Date.now()+'-'+i+'.'+ext;
    try{
      const { error } = await sb.storage.from('fotos-retirada').upload(caminho, p.blob, { contentType: p.contentType });
      if(error) throw error;
      caminhos.push(caminho);
    }catch(e){
      if(pareceFalhaDeConexao(e)) sobra.push(p);
      else { falhas.push(p.idLocal); flash('Falha ao enviar uma das fotos: '+e.message,'red'); }
    }
  }
  return { caminhos, sobra, falhas };
}
// Resolve caminhos do Storage (bucket privado) pra URLs assinadas temporárias, só na
// hora de EXIBIR — nunca guardamos link público fixo (mantém a mesma postura de
// privacidade endurecida na auditoria de segurança de 16/07/2026). 1h de validade é de
// sobra pra olhar a foto numa tela/modal já aberta.
async function resolverUrlsFotos(caminhos){
  const unicos = [...new Set((caminhos||[]).filter(Boolean))];
  if(!unicos.length) return {};
  try{
    const { data, error } = await sb.storage.from('fotos-retirada').createSignedUrls(unicos, 3600);
    if(error || !data) return {};
    const mapa = {};
    data.forEach(d=>{ if(d.signedUrl) mapa[d.path]=d.signedUrl; });
    return mapa;
  }catch(e){ return {}; }
}
let formFotos = []; // { file, url } - url é local (blob) até o envio
// Como o técnico agora só carrega localmente os itens dele, esse cache guarda o resultado
// de consultas ao servidor pra reconhecer itens de OUTROS técnicos (pro aviso funcionar de novo).
let formLookupCache = {};
function acharEquipParaForm(serie){ return formLookupCache[serie] || acharEquipPorSerie(serie); }
function abrirRegistrarForm(){
  if(!meuTecnico()) return flash('Seu acesso ainda não foi vinculado a um técnico','red');
  formSel = []; formFotos = []; formLookupCache = {};
  desenharRegistrarForm();
}
function desenharRegistrarForm(){
  const tiposOpt = Object.keys(DB.tipos).map(cod=>`<option value="${cod}">${esc(tipoNome(cod))}</option>`).join('');
  const novos = formSel.filter(s=>!acharEquipParaForm(s));
  const novosSemDeteccao = novos.filter(s=>!detectarTipoPorSerie(s));
  modal(ic('file-text')+' Registrar retirada em campo', `
    <div class="field"><label>Bipe ou digite o nº de série e Enter</label>
      <div style="display:flex;gap:8px;align-items:stretch">
        <div class="search" style="flex:1"><span class="si">${ic('camera')}</span><input id="formBusca" autofocus placeholder="Nº de série do equipamento..." onkeydown="if(event.key==='Enter'){formAddSerieBusca();event.preventDefault()}"></div>
        <button class="btn primary" onclick="formAddSerieBusca()">+ Adicionar</button>
      </div>
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
        <label class="btn" style="cursor:pointer">${ic('camera')} Tirar foto<input type="file" accept="image/*" capture="environment" multiple style="display:none" onchange="formAddFotos(this)"></label>
        <label class="btn" style="cursor:pointer">${ic('image')} Anexar da galeria<input type="file" accept="image/*" multiple style="display:none" onchange="formAddFotos(this)"></label>
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
      <img src="${f.url}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--radius-md);border:1px solid var(--line)">
      <button onclick="formRemoveFoto(${i})" aria-label="Remover foto" style="position:absolute;top:-7px;right:-7px;width:22px;height:22px;border-radius:50%;background:var(--red);color:#fff;font-weight:700;font-size:13px;line-height:1;cursor:pointer">×</button>
    </div>`).join('');
}
async function formAddSerieBusca(){
  const bruto=$('#formBusca').value.trim(); if(!bruto) return;
  const tokens=[...new Set(bruto.split(/[\s,;]+/).map(s=>s.trim()).filter(Boolean))];
  let add=0, dup=0;
  const novosTokens=[];
  tokens.forEach(v=>{ if(formSel.includes(v)) dup++; else { formSel.push(v); add++; novosTokens.push(v); } });
  desenharRegistrarForm();
  if(tokens.length>1) flash(`${add} adicionado(s)`+(dup?` — ${dup} já bipado(s)`:''), 'green');
  else if(dup) flash('Esse item já foi bipado','red');
  // consulta o servidor em segundo plano pra reconhecer itens de outros técnicos (não estão no recorte local)
  for(const v of novosTokens){
    if(!acharEquipParaForm(v)){
      const achado = await acharEquipPorSerieAsync(v);
      if(achado){ formLookupCache[v]=achado; if($('#formChips')) renderFormChips(); }
    }
  }
}
function formRemoveSerie(s){ formSel=formSel.filter(x=>x!==s); desenharRegistrarForm(); }
function renderFormChips(){
  const t = meuTecnico();
  $('#formChips').innerHTML = formSel.map(s=>{
    const existe = acharEquipParaForm(s);
    const deOutroTecnico = existe && existe.status==='com_tecnico' && t && existe.tecnicoId!==t.id;
    const rotulo = !existe? ' · novo' : (deOutroTecnico? ' · atual: '+esc(tecNome(existe.tecnicoId)) : '');
    return `<span class="chip" style="${(!existe||deOutroTecnico)?'background:var(--amber-soft);color:var(--amber)':''}">${esc(s)}${rotulo} <span class="rm" role="button" tabindex="0" aria-label="Remover ${esc(s)}" onclick="formRemoveSerie('${esc(s)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();formRemoveSerie('${esc(s)}')}">×</span></span>`;
  }).join('');
  if($('#formN')) $('#formN').textContent = formSel.length;
}
// Código da retirada gerado 100% no CLIENTE (plano offline, 17/07/2026) — substitui a
// antiga proximoCodigoRetirada() (RPC que consumia uma sequência do Postgres). Nunca
// colide entre técnicos (1º segmento vem do UUID de cada um — únicos por natureza) nem
// no mesmo técnico (timestamp em ms + sufixo aleatório; o botão já é desabilitado
// durante o registro, então nem duplo-clique chegaria a chamar isso duas vezes no mesmo
// ms). Síncrona de propósito: roda idêntica online e offline, sem exceção de rede — é
// o que permite "Registrar retirada em campo" funcionar sem sinal (o código não precisa
// mais representar uma contagem sequencial global, só ser único — decisão confirmada
// com o usuário).
function gerarCodigoRetiradaLocal(tecnicoId){
  const tec = String(tecnicoId||'').replace(/-/g,'').slice(0,6).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2,6).toUpperCase();
  return 'RET-'+tec+'-'+ts+'-'+rand;
}
// Aplica a mutação otimista LOCAL (equipamento) de uma retirada em campo — comum aos
// dois caminhos (sucesso imediato no servidor OU enfileirado offline), pra garantir que
// os dois deixam o estado local exatamente igual (plano offline, 17/07/2026).
function aplicarEquipRetiradaOtimista(serie, tipoNovo, para, tecnicoObj){
  let e = acharEquipPorSerie(serie);
  if(!e){
    e = { serie, tipo:tipoNovo, deposito:tecnicoObj.regiao||'', local:para, status:'com_tecnico', tecnicoId:tecnicoObj.id, dataEntrada:'', origem:'campo', familia:'', derivacao:'', um:'', obs:'', confirmado:true, desde:Date.now() };
    DB.equipamentos.push(e);
    if(!DB.tipos[tipoNovo]) DB.tipos[tipoNovo]={nome:tipoNovo,cor:''};
  } else {
    if(!DB.equipamentos.some(x=>x.serie===e.serie)) DB.equipamentos.push(e); // achado só no servidor (era de outro técnico) — traz pro array local pra sincronizar
    resolverPerdidoSeNecessario(e, 'Retirada em campo por '+tecNome(tecnicoObj.id));
    e.status='com_tecnico'; e.tecnicoId=tecnicoObj.id; e.local=para; e.confirmado=true; e.emTransito=false; e.transitoPara=null; e.transitoDesde=null; e.transitoDe=null; e.desde=Date.now();
  }
  if(souTecnico()){ delete equipsIncomingMap[e.serie]; equipsOwnMap[e.serie]=e; } // já é meu agora, atualiza os mapas na hora
  return e;
}
// Roda registrar_retirada_campo() pra UM item e, em sucesso, aplica a mutação otimista
// + grava/reconcilia a movimentação local — usado tanto no caminho online direto
// quanto na drenagem da fila offline (tentarEsvaziarFilaRetiradas), garantindo que os
// dois deixam o estado local idêntico. Privilégio elevado necessário porque a política
// normal de UPDATE não deixaria reivindicar item que hoje pertence a outro técnico
// (BUG-029/MAPA_DO_SISTEMA.md). Se `idLocalMovimentacao` for passado (veio de um item
// que estava na fila offline), RECONCILIA o id provisório pelo real do servidor em vez
// de criar uma movimentação nova — evita duplicar quando o Realtime entregar a linha
// real (o dedupe de Realtime é por id).
async function registrarItemRetiradaNoServidor({ serie, tipoNovo, de, para, obsCombinada, codigoRetirada, fotosCaminhos, tecnicoObj, idLocalMovimentacao }){
  let resp;
  try{
    const { data, error } = await sb.rpc('registrar_retirada_campo', {
      p_serie:serie, p_codigo:codigoRetirada, p_tipo:tipoNovo, p_os:null,
      p_obs:obsCombinada, p_de:de, p_para:para, p_usuario:nomeUsuarioAtual(),
      p_fotos:fotosCaminhos
    });
    if(error) throw error;
    resp = data;
  }catch(err){ return { ok:false, conexao:pareceFalhaDeConexao(err), erro:err }; }

  aplicarEquipRetiradaOtimista(serie, tipoNovo, para, tecnicoObj);
  const movExistente = idLocalMovimentacao ? DB.movimentacoes.find(m=>m.id===idLocalMovimentacao) : null;
  if(movExistente) movExistente.id = resp.movimentacao_id;
  else DB.movimentacoes.push({ id:resp.movimentacao_id, ts:Date.now(), tipo:'registro_campo', serie, de, para, tecnicoId:tecnicoObj.id, usuario:nomeUsuarioAtual(), obs:obsCombinada, fotos:fotosCaminhos, retiradaId:codigoRetirada, temFotosLocais:fotosCaminhos.length>0 });
  desmarcarSeriePendenteRetiradaOffline(serie);
  return { ok:true, movimentacaoIdServidor:resp.movimentacao_id };
}
// Aplica a MESMA mutação otimista acima, mas sem chamar o servidor — usado quando o
// item vai pra fila offline (sem conexão, ou a RPC falhou por conexão no meio do
// lote). `idLocalMovimentacao` é sempre um uid() novo aqui — a movimentação real do
// servidor ainda não existe, será reconciliada quando a fila drenar com sucesso.
function enfileirarItemRetiradaOffline({ serie, tipoNovo, de, para, obsCombinada, codigoRetirada, fotosCaminhos, tecnicoObj, idLocalMovimentacao }){
  aplicarEquipRetiradaOtimista(serie, tipoNovo, para, tecnicoObj);
  DB.movimentacoes.push({ id:idLocalMovimentacao, ts:Date.now(), tipo:'registro_campo', serie, de, para, tecnicoId:tecnicoObj.id, usuario:nomeUsuarioAtual(), obs:obsCombinada, fotos:fotosCaminhos, retiradaId:codigoRetirada, temFotosLocais:fotosCaminhos.length>0 });
  marcarSeriePendenteRetiradaOffline(serie);
}
async function confirmarRegistrarForm(){
  if(!formSel.length) return flash('Bipe ao menos um equipamento','red');
  const t = meuTecnico(); if(!t) return;
  const servico = $('#formServico').value;
  const servicoLabel = servico==='manutencao'?'Manutenção':'Desinstalação';
  const obs = $('#formObs').value.trim();
  const obsCombinada = [servicoLabel, obs].filter(Boolean).join(' · ');
  const novos = formSel.filter(s=>!acharEquipParaForm(s));
  const novosSemDeteccao = novos.filter(s=>!detectarTipoPorSerie(s));
  let tipoManual = '';
  if(novosSemDeteccao.length){
    tipoManual = $('#formTipo')?$('#formTipo').value:'';
    if(!tipoManual) return flash('Selecione o tipo para os equipamentos sem padrão reconhecido','red');
  }

  const deOutroTecnico = formSel.map(acharEquipParaForm).filter(e=>e && e.status==='com_tecnico' && e.tecnicoId!==t.id);
  if(deOutroTecnico.length){
    const nomes = [...new Set(deOutroTecnico.map(e=>tecNome(e.tecnicoId)))].join(', ');
    if(!confirm(`${deOutroTecnico.length} equipamento(s) bipado(s) está(ão) atualmente com outro técnico (${nomes}). Confirmar mesmo assim que esses itens são seus agora?`)) return;
  }

  const btn = $('#formBtnRegistrar');
  if(btn){ btn.disabled=true; btn.textContent='Preparando...'; }

  // Código gerado 100% no cliente (plano offline, 17/07/2026) — nunca depende de rede,
  // idêntico online e offline. Ver gerarCodigoRetiradaLocal.
  const codigoRetirada = gerarCodigoRetiradaLocal(t.id);

  // Compressão é 100% local (canvas) — feita ANTES de qualquer decisão de rede, pra
  // funcionar igual online e offline.
  const fotosPreparadas = formFotos.length ? await prepararTodasFotosForm() : [];

  const online = navigator.onLine;
  let fotosCaminhos = [];
  let fotosPendentes = []; // ficam pro registro offline, se sobrar alguma sem enviar
  if(fotosPreparadas.length){
    if(online){
      if(btn) btn.textContent='Enviando fotos...';
      const resultado = await enviarFotosPreparadas(t.id, codigoRetirada, fotosPreparadas);
      fotosCaminhos = resultado.caminhos;
      fotosPendentes = resultado.sobra.map(p=>({...p, status:'pendente'}));
    } else {
      fotosPendentes = fotosPreparadas.map(p=>({...p, status:'pendente'}));
    }
  }

  if(btn) btn.textContent='Registrando...';
  let n=0, algumEnfileirado=false;
  const itensParaFila = [];
  for(const serie of formSel){
    const eLocal = acharEquipParaForm(serie);
    const de = eLocal ? (eLocal.status==='com_tecnico'?tecNome(eLocal.tecnicoId):(eLocal.local||eLocal.deposito||'Estoque')) : 'Campo (novo no sistema)';
    const tipoNovo = eLocal ? null : (detectarTipoPorSerie(serie) || tipoManual);
    const para = tecNome(t.id);
    // Snapshot do estado local NESTE momento — usado só se este item precisar entrar
    // na fila offline, pra detectar conflito depois (ver detectarConflitoRetiradaOffline).
    const snapshotAntes = eLocal ? JSON.parse(JSON.stringify(eLocal)) : null;

    let processadoNoServidor = false;
    if(online){
      const resultado = await registrarItemRetiradaNoServidor({ serie, tipoNovo, de, para, obsCombinada, codigoRetirada, fotosCaminhos, tecnicoObj:t });
      if(resultado.ok){ n++; processadoNoServidor=true; }
      else if(!resultado.conexao){ flash('Falha ao registrar '+serie+': '+resultado.erro.message,'red'); continue; }
      // se foi falha de conexão, cai pro enfileiramento abaixo
    }
    if(!processadoNoServidor){
      const idLocalMovimentacao = uid();
      enfileirarItemRetiradaOffline({ serie, tipoNovo, de, para, obsCombinada, codigoRetirada, fotosCaminhos, tecnicoObj:t, idLocalMovimentacao });
      itensParaFila.push({ serie, tipoNovo, snapshotAntes, de, idLocalMovimentacao, status:'pendente', conflito:null, movimentacaoIdServidor:null });
      algumEnfileirado = true;
      n++;
    }
  }

  if(algumEnfileirado){
    await salvarRetiradaOffline({
      codigo:codigoRetirada, tecnicoId:t.id, tecnicoNome:t.nome, servico, obs, usuario:nomeUsuarioAtual(), criadoEm:Date.now(),
      fotos: fotosPendentes, fotosCaminhosEnviados: fotosCaminhos, itens: itensParaFila
    });
    atualizarIndicadorSincronizacao();
  }

  formFotos.forEach(f=>URL.revokeObjectURL(f.url)); formFotos=[];
  salvar(); render();
  modal(ic('check')+' Retirada registrada', `
    <div style="text-align:center;padding:10px 0">
      <div class="muted" style="font-size:12.5px;margin-bottom:6px">Código desta retirada</div>
      <div style="font-size:32px;font-weight:800;color:var(--brand);letter-spacing:1px;margin-bottom:14px">${codigoRetirada}</div>
      <p class="muted" style="max-width:380px;margin:0 auto 6px">${n} equipamento(s) registrado(s).${algumEnfileirado?' Salvo(s) só neste aparelho — sincroniza quando a conexão voltar.':(fotosCaminhos.length?' '+fotosCaminhos.length+' foto(s) enviada(s) com segurança.':'')}</p>
    </div>`, `<button class="btn primary" style="width:100%;justify-content:center" onclick="closeModal()">Entendi</button>`, '');
}
function confirmarRecebimento(serie, semConfirm){
  const e = DB.equipamentos.find(x=>x.serie===serie); if(!e || !e.emTransito) return;
  if(!semConfirm && !confirm('Confirmar o recebimento do equipamento '+serie+'?')) return;
  const destinoId = e.transitoPara;
  const origemTecId = e.transitoDeTecnicoId||null;
  resolverPerdidoSeNecessario(e, 'Recebimento confirmado por '+tecNome(destinoId));
  e.status='com_tecnico'; e.tecnicoId=destinoId; e.local=tecNome(destinoId); e.confirmado=true; e.desde=Date.now();
  e.emTransito=false; e.transitoPara=null; e.transitoDesde=null; e.transitoDe=null; e.transitoUsuario=null; e.transitoDeTecnicoId=null;
  // O item muda de categoria (de "a caminho" pra "meu"); atualiza os mapas na hora, sem
  // esperar os dois canais de tempo real (Supabase Realtime) confirmarem — evita ele sumir da tela por um instante.
  if(souTecnico()){ delete equipsIncomingMap[e.serie]; equipsOwnMap[e.serie]=e; }
  registrarMovimentacao({ id:uid(), ts:Date.now(), tipo:'confirmacao', serie, de:'Em trânsito', para:tecNome(destinoId), tecnicoId:destinoId, tecnicoIdOrigem:origemTecId, usuario:nomeUsuarioAtual(), obs:'Recebimento confirmado pelo técnico' });
  salvar(); render(); flash('Recebimento de '+serie+' confirmado','green');
}
function renderMeuHistorico(){
  const t = meuTecnico();
  if(!t) return $('#content').innerHTML = semVinculoHtml();
  const movs = DB.movimentacoes.filter(m=>m.tecnicoId===t.id || m.tecnicoIdOrigem===t.id).sort((a,b)=>b.ts-a.ts);
  $('#content').innerHTML = `
  <div class="panel"><div class="ph"><h3>${ic('clock')} Meu histórico</h3><span class="count-badge">${movs.length}</span></div>
    <div class="tbl-wrap">${movs.length?tabelaMov(movs.slice(0,300)):'<div class="empty">Nenhuma movimentação ainda.</div>'}</div>
  </div>`;
}

/* =========================================================
   CONSULTAR RETIRADA (busca por código RET-XXXX)
   ========================================================= */
function listaRetiradas(){
  const porId = {};
  DB.movimentacoes.filter(m=>m.tipo==='registro_campo' && m.retiradaId).forEach(m=>{
    if(!porId[m.retiradaId]) porId[m.retiradaId] = { codigo:m.retiradaId, ts:m.ts, tecnicoId:m.tecnicoId, usuario:m.usuario, obs:m.obs, temFotosLocais:m.temFotosLocais, fotos:m.fotos||[], itens:[] };
    porId[m.retiradaId].itens.push(m.serie);
  });
  let lista = Object.values(porId).sort((a,b)=>b.ts-a.ts);
  if(souTecnico() && meuTecnico()) lista = lista.filter(r=>r.tecnicoId===meuTecnico().id);
  else if(souSupervisor()) lista = lista.filter(r=>{ const tc=DB.tecnicos.find(x=>x.id===r.tecnicoId); return tc && regiaoPermitida(tc.regiao); });
  return lista;
}
let retiradaBusca = '';
function renderRetiradas(){
  const nPendentes = seriesPendentesRetiradaOffline.size;
  $('#content').innerHTML = `
  <div class="toolbar">
    <div class="search"><span class="si">${ic('search')}</span><input placeholder="Buscar por código (ex.: RET-0001)..." value="${esc(retiradaBusca)}" oninput="retiradaBusca=this.value;renderRetiradasLista()"></div>
    ${souTecnico()?`<button class="btn" style="${nPendentes?'background:var(--amber-soft);color:var(--amber);border-color:transparent':''}" onclick="abrirRetiradasOfflinePendentes()">${ic('alert-triangle')} Retiradas offline${nPendentes?' ('+nPendentes+')':''}</button>`:''}
  </div>
  <div class="panel"><div class="ph"><h3>${ic('search')} Retiradas em campo</h3><span class="count-badge" id="retiradasCount"></span></div>
    <div class="pb" style="display:flex;flex-direction:column;gap:10px" id="retiradasLista"></div>
  </div>`;
  renderRetiradasLista();
}
// Tela de revisão das retiradas registradas OFFLINE ainda não confirmadas no servidor
// (plano offline, 17/07/2026) — mostra o status de cada item e, pros que entraram em
// CONFLITO (outra pessoa mexeu no equipamento enquanto o técnico estava offline — ver
// detectarConflitoRetiradaOffline), deixa o técnico decidir explicitamente: aplicar
// mesmo assim ou descartar. Nunca aplica um conflito silenciosamente.
function abrirRetiradasOfflinePendentes(){
  modal(ic('alert-triangle')+' Retiradas offline pendentes', `<div id="retiradasOfflineBody">Carregando...</div>`, `<button class="btn" onclick="closeModal()">Fechar</button>`, 'lg');
  renderRetiradasOfflinePendentesBody();
}
function descreverConflitoRetirada(c){
  if(!c) return 'estado mudou desde o registro offline';
  if(c.motivo==='item_novo_ja_existe') return 'este item já existe no sistema — outra pessoa também o registrou enquanto você estava offline';
  if(c.motivo==='item_sumiu_do_servidor') return 'este item foi excluído do sistema por outra pessoa';
  if(c.motivo==='estado_mudou') return 'este item foi movimentado por outra pessoa — status atual: '+(c.atual?(STATUS[c.atual.status]||c.atual.status):'desconhecido');
  return 'estado mudou desde o registro offline';
}
async function renderRetiradasOfflinePendentesBody(){
  const el = $('#retiradasOfflineBody'); if(!el) return;
  let registros;
  try{ registros = await listarRetiradasOffline(); }
  catch(e){ el.innerHTML = '<div class="empty">Não foi possível ler os dados offline deste aparelho.</div>'; return; }
  if(!registros.length){ el.innerHTML = '<div class="empty">'+ic('check')+' Nenhuma retirada pendente — tudo sincronizado.</div>'; return; }
  el.innerHTML = registros.map(r=>`
    <div class="panel" style="box-shadow:none;margin-bottom:12px"><div class="pb">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:800;color:var(--brand)">${esc(r.codigo)}</div>
        <span class="muted" style="font-size:11.5px">${fmtTS(r.criadoEm)}</span>
      </div>
      <div class="tbl-wrap"><table><thead><tr><th>Nº Série</th><th>Status</th><th></th></tr></thead><tbody>
        ${r.itens.map(it=>`<tr>
          <td class="mono">${esc(it.serie)}</td>
          <td>${
            it.status==='conflito' ? `<span class="badge" style="background:var(--red-soft);color:var(--red)" title="${esc(descreverConflitoRetirada(it.conflito))}">${ic('alert-triangle')} Conflito</span>`
            : it.status==='erro' ? `<span class="badge" style="background:var(--red-soft);color:var(--red)">${ic('x')} Falhou</span>`
            : `<span class="badge gray">${ic('clock')} Pendente</span>`
          }</td>
          <td>${it.status==='conflito' ? `<div class="muted" style="font-size:11.5px;margin-bottom:6px">${esc(descreverConflitoRetirada(it.conflito))}</div>
            <button class="btn sm" onclick="confirmarConflitoRetiradaOffline('${esc(r.codigo)}','${esc(it.serie)}')">Aplicar mesmo assim</button>
            <button class="btn sm red ghost" onclick="descartarItemConflitanteRetiradaOffline('${esc(r.codigo)}','${esc(it.serie)}')">Descartar</button>`:''}</td>
        </tr>`).join('')}
      </tbody></table></div>
    </div></div>`).join('');
}
async function confirmarConflitoRetiradaOffline(codigo, serie){
  const registros = await listarRetiradasOffline();
  const registro = registros.find(r=>r.codigo===codigo); if(!registro) return;
  const item = registro.itens.find(it=>it.serie===serie); if(!item) return;
  const t = DB.tecnicos.find(x=>x.id===registro.tecnicoId) || { id:registro.tecnicoId, nome:registro.tecnicoNome, regiao:'' };
  const para = tecNome(registro.tecnicoId);
  const resultado = await registrarItemRetiradaNoServidor({
    serie, tipoNovo:item.tipoNovo, de:item.de, para, obsCombinada:registro.obs, codigoRetirada:registro.codigo,
    fotosCaminhos: registro.fotosCaminhosEnviados||[], tecnicoObj:t, idLocalMovimentacao:item.idLocalMovimentacao
  });
  if(resultado.ok){ item.status='concluido'; item.movimentacaoIdServidor=resultado.movimentacaoIdServidor; item.conflito=null; }
  else if(!resultado.conexao){ item.status='erro'; flash('Falha ao aplicar: '+resultado.erro.message,'red'); }
  else { flash('Sem conexão — tente de novo quando reconectar.','red'); return; }
  const todosItensResolvidos = registro.itens.every(it=>it.status==='concluido');
  const todasFotosResolvidas = !registro.fotos || registro.fotos.every(f=>f.status==='enviada'||f.status==='erro');
  await atualizarRetiradaOffline(codigo, ()=> (todosItensResolvidos&&todasFotosResolvidas) ? null : registro);
  salvar(); render(); renderRetiradasOfflinePendentesBody(); atualizarIndicadorSincronizacao();
}
async function descartarItemConflitanteRetiradaOffline(codigo, serie){
  if(!confirm('Descartar o registro deste item ('+serie+')? Ele NÃO será reivindicado — o estoque local volta a refletir o estado real do servidor.')) return;
  const registros = await listarRetiradasOffline();
  const registro = registros.find(r=>r.codigo===codigo); if(!registro) return;
  const item = registro.itens.find(it=>it.serie===serie); if(!item) return;

  // Reverte o equipamento local pro estado REAL do servidor (o que veio junto do conflito).
  const atualServidor = item.conflito && item.conflito.atual;
  const idx = DB.equipamentos.findIndex(e=>e.serie===serie);
  if(atualServidor){ if(idx>=0) DB.equipamentos[idx]=atualServidor; else DB.equipamentos.push(atualServidor); }
  else if(idx>=0) DB.equipamentos.splice(idx,1); // não existe mais no servidor — remove do local também
  DB.movimentacoes = DB.movimentacoes.filter(m=>m.id!==item.idLocalMovimentacao); // remove a otimista provisória, nunca confirmada
  desmarcarSeriePendenteRetiradaOffline(serie);

  registro.itens = registro.itens.filter(it=>it.serie!==serie);
  await atualizarRetiradaOffline(codigo, ()=> registro.itens.length ? registro : null);
  salvar(); render(); renderRetiradasOfflinePendentesBody(); atualizarIndicadorSincronizacao();
  flash('Item descartado','green');
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
          ${r.fotos&&r.fotos.length?`<span class="badge" style="background:var(--amber-soft);color:var(--amber)">${ic('camera')} ${r.fotos.length} foto(s)</span>`:(r.temFotosLocais?`<span class="badge" style="background:var(--amber-soft);color:var(--amber)">${ic('camera')} tem foto local</span>`:'')}
        </div></div>`).join('') : '<div class="empty"><div class="big">'+ic('search')+'</div>Nenhuma retirada encontrada.</div>';
}
async function verRetirada(codigo){
  const r = listaRetiradas().find(x=>x.codigo===codigo); if(!r) return;
  const urlsFotos = await resolverUrlsFotos(r.fotos);
  const galeriaFotos = r.fotos&&r.fotos.length
    ? `<div class="field"><label>${ic('camera')} Fotos de comprovação</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${r.fotos.filter(c=>urlsFotos[c]).map(c=>`<a href="${urlsFotos[c]}" target="_blank"><img src="${urlsFotos[c]}" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line)"></a>`).join('')}</div>
      </div>`
    : (r.temFotosLocais?`<div class="badge com_tecnico" style="padding:8px 12px;margin-bottom:14px">${ic('camera')} Fotos ficaram salvas só no celular do técnico (registradas antes do envio pra nuvem)</div>`:'');
  modal(ic('search')+' Retirada '+esc(codigo), `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <span class="badge blue" style="padding:8px 12px">${ic('hard-hat')} ${esc(tecNome(r.tecnicoId))}</span>
      <span class="badge gray" style="padding:8px 12px">${fmtTS(r.ts)}</span>
      <span class="badge gray" style="padding:8px 12px">Registrado por ${esc(r.usuario||'—')}</span>
    </div>
    <p class="muted" style="margin-bottom:14px">${esc(r.obs||'Sem observação.')}</p>
    ${galeriaFotos}
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
let usuariosCanalAtivo = null;
let usuariosCarregados = false;
async function carregarUsuariosLista(){
  try{
    const data = await selecionarTudo('usuarios');
    USUARIOS_LISTA = data.map(usuarioParaCamel);
    usuariosCarregados = true;
    if(PAGE==='usuarios') renderUsuarios();
  }catch(err){ flash('Erro ao carregar usuários: '+err.message,'red'); }
}
function renderUsuarios(){
  if(!souAdmin()){ $('#content').innerHTML='<div class="empty">Acesso restrito.</div>'; return; }
  if(!usuariosCanalAtivo){
    usuariosCanalAtivo = sb.channel('usuarios-rt').on('postgres_changes', {event:'*',schema:'public',table:'usuarios'}, carregarUsuariosLista).subscribe();
    carregarUsuariosLista();
    return; // vai re-renderizar assim que a lista carregar
  }
  if(!usuariosCarregados) return; // ainda carregando
  const regioesConhecidas = todasFiliaisConhecidas();
  const ordenados = [...USUARIOS_LISTA].sort((a,b)=>(a.papel==='pendente'?0:1)-(b.papel==='pendente'?0:1) || (a.criadoEm||0)-(b.criadoEm||0));
  $('#content').innerHTML = `
  <div class="panel"><div class="ph"><h3>${ic('lock')} Usuários e permissões</h3><span class="count-badge">${USUARIOS_LISTA.length}</span></div>
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
            <button class="btn sm" onclick="abrirEditarFiliaisSupervisor('${u.uid}')">
              ${ic('building-2')} ${(u.regioes||[]).length? (u.regioes||[]).length+' filial(is) — editar' : 'Nenhuma filial — editar'}
            </button>
          </div>`:''}
          ${u.papel==='tecnico'?`
          <div class="field" style="margin:0;min-width:220px"><label>Vincular ao técnico cadastrado</label>
            <select onchange="usuarioAtualizarCampo('${u.uid}','tecnicoId',this.value||null)">
              <option value="">— nenhum —</option>
              ${DB.tecnicos.map(t=>`<option value="${t.id}" ${u.tecnicoId===t.id?'selected':''}>${t.regiao?'['+esc(t.regiao)+'] ':''}${esc(t.nome)}</option>`).join('')}
            </select>
          </div>`:''}
          <button class="btn sm red ghost" onclick="usuarioRemover('${u.uid}')">Remover</button>
        </div></div>`).join('')}
    </div>
  </div>`;
}
function contarAdmins(){ return USUARIOS_LISTA.filter(u=>u.papel==='admin').length; }
const CAMPO_USUARIO_SNAKE = { tecnicoId:'tecnico_id' };
function usuarioAtualizarCampo(uid, campo, valor){
  const alvo = USUARIOS_LISTA.find(u=>u.uid===uid);
  if(campo==='papel' && alvo && alvo.papel==='admin' && valor!=='admin' && contarAdmins()<=1){
    flash('Não é possível rebaixar o único administrador do sistema. Promova outra pessoa a admin antes.','red');
    return renderUsuarios();
  }
  const updates = {[CAMPO_USUARIO_SNAKE[campo]||campo]:valor};
  if(campo==='papel'){
    if(valor!=='supervisor') updates.regioes=[];
    if(valor!=='tecnico') updates.tecnico_id=null;
  }
  sb.from('usuarios').update(updates).eq('id',uid).then(({error})=>{
    if(error) flash(''+error.message,'red'); else flash('Atualizado','green');
  });
}
function abrirEditarFiliaisSupervisor(uid){
  // Segurança (BUG-048): recebe SÓ o uid (UUID, sem caractere perigoso) e busca nome/
  // regiões na lista já carregada — em vez de receber nome/regiões interpolados no HTML.
  // Antes, o nome do usuário (controlável no cadastro) ia num onclick via JSON.stringify,
  // que não escapa aspas simples nem HTML dentro de atributo → XSS armazenado.
  const alvo = USUARIOS_LISTA.find(u=>u.uid===uid);
  if(!alvo) return;
  const nome = alvo.nome||alvo.email;
  const regioesAtuais = alvo.regioes||[];
  const todas = todasFiliaisConhecidas();
  modal(ic('building-2')+' Filiais de '+esc(nome), `
    <p class="muted" style="margin-bottom:12px">Marque as filiais que esse supervisor pode acessar.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;max-height:340px;overflow:auto">
      ${todas.length? todas.map(f=>`
        <label class="checkbox" style="background:var(--panel-soft);padding:8px 10px;border-radius:var(--radius-md)">
          <input type="checkbox" class="filialChk" value="${esc(f)}" ${regioesAtuais.includes(f)?'checked':''}> ${esc(f)}
        </label>`).join('') : '<div class="empty">Nenhuma filial cadastrada ainda.</div>'}
    </div>`,
    `<button class="btn" onclick="closeModal()">Cancelar</button>
     <button class="btn primary" onclick="salvarFiliaisSupervisor('${uid}')">Salvar</button>`, 'lg');
}
function salvarFiliaisSupervisor(uid){
  const vals = Array.from(document.querySelectorAll('.filialChk:checked')).map(c=>c.value);
  sb.from('usuarios').update({regioes:vals}).eq('id',uid).then(({error})=>{
    if(error) flash(''+error.message,'red'); else { closeModal(); flash('Filiais atualizadas','green'); }
  });
}
function usuarioRemover(uid){
  // Segurança (BUG-048): recebe só o uid e busca o e-mail na lista, em vez de recebê-lo
  // interpolado no HTML do onclick (ver abrirEditarFiliaisSupervisor).
  const alvo = USUARIOS_LISTA.find(u=>u.uid===uid);
  if(!alvo) return;
  if(alvo.papel==='admin' && contarAdmins()<=1) return flash('Não é possível remover o único administrador do sistema. Promova outra pessoa a admin antes.','red');
  const email = alvo.email;
  if(!confirm('Remover o acesso de '+email+'? A pessoa poderá criar uma conta nova, mas terá que ser aprovada de novo.')) return;
  sb.from('usuarios').delete().eq('id',uid).then(({error})=>{
    if(error) flash(''+error.message,'red'); else flash('Usuário removido');
  });
}

/* ---------- Boot ---------- */
renderNav();
