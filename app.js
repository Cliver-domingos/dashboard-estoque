/* =========================================================
   Controle de Estoque & Inventário — App (vanilla JS)
   Salva tudo em localStorage. Sem servidor, sem instalação.
   ========================================================= */

const STORE_KEY = 'estoque_a365_v1';
const STATUS = { estoque:'Em estoque', com_tecnico:'Com técnico', baixado:'Baixado' };
const TIPO_CORES = ['#2563eb','#7c3aed','#16a34a','#d97706','#dc2626','#0891b2','#db2777','#65a30d'];
const MOV_LABEL = { entrada:'Entrada', saida:'Saída p/ técnico', transferencia:'Transferência', baixa:'Baixa/Defeito' };

/* ---------- Estado ---------- */
let DB = carregar();

function estadoInicial(){
  return {
    tipos: {},          // { "UBI.0001": {nome, cor, min} }  min = estoque mínimo
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

/* ---------- Sincronização em nuvem (Firestore) ---------- */
const DOC_REF = window.firestoreDB.collection('estoques').doc('dashboard');
let aplicandoRemoto = false;
let salvarTimeout = null;

function salvar(){
  salvarLocal();
  if(aplicandoRemoto) return;
  clearTimeout(salvarTimeout);
  salvarTimeout = setTimeout(()=>{
    DOC_REF.set(DB).catch(e=>flash('⚠️ Falha ao sincronizar: '+e.message,'red'));
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
      DB = Object.assign(estadoInicial(), data);
      salvarLocal();
      aplicandoRemoto = false;
      renderNav(); render();
    } else {
      DOC_REF.set(DB); // primeira vez: envia os dados locais como base
    }
  }, err=>{
    if(foot) foot.innerHTML = '⚠️ Sem conexão com a nuvem<br>Usando dados locais.';
    flash('⚠️ Erro de sincronização: '+err.message,'red');
  });
}
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => (s==null?'':String(s)).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function tecNome(id){ const t = DB.tecnicos.find(x=>x.id===id); return t?t.nome:'—'; }
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
function estoqueMinAlertas(){ const r=[]; Object.keys(DB.tipos).forEach(t=>{ const min=DB.tipos[t].min||0; if(min>0){ const n=DB.equipamentos.filter(e=>e.tipo===t&&e.status==='estoque').length; if(n<min) r.push({tipo:t,atual:n,min}); } }); return r; }

/* ---------- Navegação ---------- */
const PAGES = [
  { id:'dashboard', icon:'📊', titulo:'Visão Geral', sub:'Resumo do inventário' },
  { id:'equip',     icon:'📦', titulo:'Equipamentos', sub:'Inventário item a item' },
  { id:'mov',       icon:'🔄', titulo:'Movimentar', sub:'Registrar entrada, saída, transferência ou baixa' },
  { id:'tecnicos',  icon:'👷', titulo:'Técnicos', sub:'Cadastro e equipamentos em posse' },
  { id:'auditoria', icon:'🔍', titulo:'Auditoria', sub:'Conferência de estoque por técnico ou depósito' },
  { id:'hist',      icon:'🕓', titulo:'Histórico', sub:'Todas as movimentações registradas' },
  { id:'tipos',     icon:'🏷️', titulo:'Tipos', sub:'Os 5 tipos de equipamento' },
  { id:'dados',     icon:'💾', titulo:'Dados', sub:'Importar, exportar e backup' },
];
let PAGE = 'dashboard';

function renderNav(){
  $('#nav').innerHTML = PAGES.map(p=>`
    <button class="nav-item ${p.id===PAGE?'active':''}" onclick="goto('${p.id}')">
      <span class="ic">${p.icon}</span> ${p.titulo}
    </button>`).join('');
}
function goto(id){ PAGE=id; const p=PAGES.find(x=>x.id===id); $('#pageTitle').textContent=p.titulo; $('#pageSub').textContent=p.sub; renderNav(); render(); window.scrollTo(0,0); }

function render(){
  if(DB.equipamentos.length===0 && PAGE!=='dados' && PAGE!=='tipos'){ return renderVazio(); }
  ({ dashboard:renderDashboard, equip:renderEquip, mov:renderMovPage, tecnicos:renderTecnicos, auditoria:renderAuditoria, hist:renderHist, tipos:renderTipos, dados:renderDados }[PAGE])();
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
function renderDashboard(){
  const eq = DB.equipamentos;
  const total = eq.length;
  const emEstoque = eq.filter(e=>e.status==='estoque').length;
  const comTec = eq.filter(e=>e.status==='com_tecnico').length;
  const baixados = eq.filter(e=>e.status==='baixado').length;

  // por tipo
  const porTipo = {};
  eq.forEach(e=>{ porTipo[e.tipo]=(porTipo[e.tipo]||0)+1; });
  const tiposArr = Object.entries(porTipo).sort((a,b)=>b[1]-a[1]);
  const maxTipo = Math.max(1,...tiposArr.map(t=>t[1]));

  // por depósito
  const porDep = {};
  eq.filter(e=>e.status!=='baixado').forEach(e=>{ const d=e.local||e.deposito||'—'; porDep[d]=(porDep[d]||0)+1; });
  const depArr = Object.entries(porDep).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxDep = Math.max(1,...depArr.map(d=>d[1]));

  const ultimas = [...DB.movimentacoes].slice(-8).reverse();

  // alertas
  const alertasMin = estoqueMinAlertas();
  const parados = DB.equipamentos.filter(e=>e.status==='com_tecnico' && (diasEmPosse(e)||0)>=90);
  const tecsSemAud = DB.tecnicos.filter(t=>itensDoTecnico(t.id).length>0 && !ultimaAuditoria('tecnico',t.id));

  $('#content').innerHTML = `
  <div class="grid kpis" style="margin-bottom:20px">
    ${kpi('b','📦','Total de itens',total)}
    ${kpi('g','✅','Em estoque',emEstoque)}
    ${kpi('a','👷','Com técnicos',comTec)}
    ${kpi('r','⚠️','Baixados',baixados)}
    ${kpi('v','🔍','Auditorias',DB.auditorias.length)}
  </div>

  ${(alertasMin.length||parados.length||tecsSemAud.length)?`
  <div class="panel" style="margin-bottom:20px;border-left:4px solid var(--amber)">
    <div class="ph"><h3>⚠️ Alertas</h3></div>
    <div class="pb" style="display:flex;flex-wrap:wrap;gap:10px">
      ${alertasMin.map(a=>`<div class="badge baixado" style="padding:8px 12px">Estoque baixo: <b style="margin-left:4px">${esc(tipoNome(a.tipo))}</b> — ${a.atual}/${a.min}</div>`).join('')}
      ${parados.length?`<button class="badge com_tecnico" style="padding:8px 12px;border:0;cursor:pointer" onclick="goto('equip')">${parados.length} ${parados.length===1?'item parado':'itens parados'} 90+ dias com técnico</button>`:''}
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
        ${donut([['Em estoque',emEstoque,'#16a34a'],['Com técnico',comTec,'#d97706'],['Baixado',baixados,'#dc2626']])}
      </div></div>
    </div>
  </div>

  <div class="chart-row">
    <div class="panel">
      <div class="ph"><h3>📍 Itens ativos por depósito/local</h3></div>
      <div class="pb">
        ${depArr.length?depArr.map(([d,n])=>`
          <div class="bar-row">
            <div class="bl">${esc(d)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${n/maxDep*100}%;background:#2563eb">${n}</div></div>
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
function movBadge(t){ const m={entrada:'badge blue',saida:'badge com_tecnico',transferencia:'badge violet',baixa:'badge baixado'}; return `<span class="${m[t]||'badge gray'}">${MOV_LABEL[t]||t}</span>`; }

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
      <td><span class="badge ${e.status}">${STATUS[e.status]}</span></td>
      <td>${e.status==='com_tecnico'?esc(tecNome(e.tecnicoId)):esc(e.local||e.deposito||'—')}</td>
      <td class="muted">${e.status==='com_tecnico'?'há '+fmtDias(diasEmPosse(e)):fmtData(e.dataEntrada)}</td>
      <td class="right">
        <button class="btn sm" onclick="openMov('${esc(e.serie)}')">Mover</button>
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
   MOVIMENTAR
   ========================================================= */
function renderMovPage(){
  $('#content').innerHTML = `
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:8px">
    ${movCard('entrada','📥','Entrada no estoque','Equipamento novo ou que retornou','green')}
    ${movCard('saida','👷','Saída para técnico','Entregar item a um técnico','b')}
    ${movCard('transferencia','🔁','Transferência','Passar item entre técnicos','v')}
    ${movCard('baixa','⚠️','Baixa / Defeito','Retirar item definitivamente','r')}
  </div>
  <div class="panel" style="margin-top:18px"><div class="ph"><h3>🕓 Movimentações recentes</h3><div class="spacer"></div><button class="btn sm ghost" onclick="goto('hist')">Ver histórico →</button></div>
    <div class="tbl-wrap">${tabelaMov([...DB.movimentacoes].slice(-12).reverse())}</div>
  </div>`;
}
function movCard(tipo,ic,titulo,desc,cor){
  const cores={green:'var(--green)',b:'var(--brand)',v:'var(--violet)',r:'var(--red)'};
  return `<button class="panel" style="text-align:left;padding:0;border:0" onclick="openMov(null,'${tipo}')">
    <div class="pb" style="display:flex;gap:14px;align-items:flex-start">
      <div style="font-size:24px;width:50px;height:50px;border-radius:13px;background:${cores[cor]}1a;display:grid;place-items:center;flex-shrink:0">${ic}</div>
      <div><div style="font-weight:700;font-size:15px;margin-bottom:3px">${titulo}</div><div class="muted" style="font-size:12.5px">${desc}</div></div>
    </div></button>`;
}

/* =========================================================
   TÉCNICOS
   ========================================================= */
function renderTecnicos(){
  $('#content').innerHTML = `
  <div class="toolbar">
    <div style="flex:1"></div>
    <button class="btn primary" onclick="openTec()">＋ Novo técnico</button>
  </div>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
    ${DB.tecnicos.length? DB.tecnicos.map(t=>{
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
function renderTipos(){
  const cods=Object.keys(DB.tipos);
  $('#content').innerHTML = `
  <div class="panel"><div class="ph"><h3>🏷️ Tipos de equipamento</h3><div class="spacer"></div><button class="btn sm primary" onclick="openTipo()">＋ Adicionar tipo</button></div>
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

  <div class="panel" style="margin-top:18px"><div class="ph"><h3>💾 Backup & compartilhamento</h3></div><div class="pb">
    <p class="muted" style="margin-bottom:14px">Os dados ficam salvos <b>neste navegador</b>. Para fazer cópia de segurança ou usar em outra máquina/compartilhar via rede, exporte o backup e importe no outro computador.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn green" onclick="exportarBackup()">⬇️ Exportar backup (.json)</button>
      <label class="btn">⬆️ Importar backup<input type="file" accept=".json" style="display:none" onchange="importarBackup(this)"></label>
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
      <input id="e_serie" value="${e?esc(e.serie):''}" ${e?'disabled':''} placeholder="Ex.: 00-124B...-AA"></div>
    <div class="row2">
      <div class="field"><label>Tipo *</label><select id="e_tipo">${tiposOpt||'<option value="">— nenhum tipo —</option>'}</select></div>
      <div class="field"><label>Depósito / Local</label><input id="e_dep" value="${e?esc(e.deposito||''):''}" placeholder="Ex.: CASEPV"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Status</label><select id="e_status">${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${e&&e.status===k?'selected':''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>Data de entrada</label><input id="e_data" value="${e?esc(e.dataEntrada||''):''}" placeholder="dd/mm/aaaa"></div>
    </div>
    <div class="field"><label>Observação</label><input id="e_obs" value="${e?esc(e.obs||''):''}"></div>`,
    `${e?`<button class="btn red ghost" style="margin-right:auto" onclick="excluirEquip('${esc(e.serie)}')">Excluir</button>`:''}
     <button class="btn" onclick="closeModal()">Cancelar</button>
     <button class="btn primary" onclick="salvarEquip(${e?`'${esc(e.serie)}'`:'null'})">Salvar</button>`);
}
function salvarEquip(serieEdit){
  const serie = serieEdit || $('#e_serie').value.trim();
  if(!serie) return flash('Informe o nº de série','red');
  if(!serieEdit && DB.equipamentos.some(e=>e.serie===serie)) return flash('Já existe um item com esse nº de série','red');
  let e = serieEdit? DB.equipamentos.find(x=>x.serie===serieEdit) : null;
  const dados={ tipo:$('#e_tipo').value, deposito:$('#e_dep').value.trim(), status:$('#e_status').value, dataEntrada:$('#e_data').value.trim(), obs:$('#e_obs').value.trim() };
  if(e){ Object.assign(e,dados); }
  else { DB.equipamentos.push(Object.assign({serie, local:dados.deposito, tecnicoId:null}, dados)); }
  // garante que o tipo exista
  if(dados.tipo && !DB.tipos[dados.tipo]) DB.tipos[dados.tipo]={nome:dados.tipo,cor:''};
  salvar(); closeModal(); render(); flash('✅ Equipamento salvo','green');
}
function excluirEquip(serie){
  if(!confirm('Excluir o equipamento '+serie+'? O histórico de movimentações é mantido.')) return;
  DB.equipamentos = DB.equipamentos.filter(e=>e.serie!==serie);
  salvar(); closeModal(); render(); flash('Equipamento excluído');
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
function openMov(serie, tipo){
  movTipo = tipo || 'saida';
  movSel = serie? [serie] : [];
  desenharMov();
}
function desenharMov(){
  const tecsOpt = DB.tecnicos.map(t=>`<option value="${t.id}">${esc(t.nome)}</option>`).join('');
  const semTec = DB.tecnicos.length===0;
  modal('🔄 Registrar movimentação', `
    <div class="field"><label>Tipo de movimentação</label>
      <div class="pill-tabs" style="width:100%">
        ${Object.entries(MOV_LABEL).map(([k,v])=>`<button class="${movTipo===k?'active':''}" style="flex:1" onclick="movTipo='${k}';desenharMov()">${v}</button>`).join('')}
      </div>
    </div>

    <div class="field"><label>Equipamentos (nº de série)</label>
      <div class="search"><span class="si">🔎</span><input id="movBusca" placeholder="Digite/scan o nº de série e Enter para adicionar..." onkeydown="if(event.key==='Enter'){addMovSerieBusca();event.preventDefault()}" oninput="filtrarPickMov(this.value)"></div>
      <div class="chips" id="movChips"></div>
      <div class="pick-list" id="movPick" style="margin-top:8px"></div>
    </div>

    ${movTipo==='saida'||movTipo==='transferencia'? `
      <div class="field"><label>${movTipo==='transferencia'?'Transferir PARA o técnico *':'Entregar ao técnico *'}</label>
        <select id="movTec">${semTec?'<option value="">— cadastre um técnico antes —</option>':tecsOpt}</select>
        ${semTec?'<div class="hint">Vá em <b>Técnicos</b> e cadastre ao menos um.</div>':''}
      </div>`:''}
    ${movTipo==='entrada'? `<div class="field"><label>Depósito de destino</label><input id="movDep" placeholder="Ex.: CASEPV"></div>`:''}
    ${movTipo==='baixa'? `<div class="field"><label>Motivo da baixa</label><input id="movMotivo" placeholder="Ex.: Defeito irreparável, perda..."></div>`:''}

    <div class="field"><label>Observação</label><input id="movObs" placeholder="Opcional"></div>
  `, `<button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="confirmarMov()">Confirmar (<span id="movN">${movSel.length}</span> ${movSel.length===1?'item':'itens'})</button>`, 'lg');
  renderMovChips(); filtrarPickMov('');
}
function filtrarPickMov(q){
  q=(q||'').trim().toLowerCase();
  // candidatos dependem do tipo
  let cand = DB.equipamentos.filter(e=>!movSel.includes(e.serie));
  if(movTipo==='saida') cand=cand.filter(e=>e.status==='estoque');
  else if(movTipo==='transferencia') cand=cand.filter(e=>e.status==='com_tecnico');
  else if(movTipo==='entrada') cand=cand.filter(e=>e.status!=='estoque');
  else if(movTipo==='baixa') cand=cand.filter(e=>e.status!=='baixado');
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
  const usuario = DB.config.usuario||'';
  const obs = $('#movObs')?$('#movObs').value.trim():'';
  let tecId=null, destinoTxt='';
  if(movTipo==='saida'||movTipo==='transferencia'){
    tecId=$('#movTec')?$('#movTec').value:''; if(!tecId) return flash('Selecione o técnico','red');
    destinoTxt=tecNome(tecId);
  } else if(movTipo==='entrada'){ destinoTxt=($('#movDep')?$('#movDep').value.trim():'')||'Estoque'; }
  else if(movTipo==='baixa'){ destinoTxt='Baixado'; }

  let n=0;
  movSel.forEach(serie=>{
    const e=DB.equipamentos.find(x=>x.serie===serie); if(!e) return;
    const de = e.status==='com_tecnico'? tecNome(e.tecnicoId) : (e.local||e.deposito||'Estoque');
    if(movTipo==='saida'||movTipo==='transferencia'){ e.status='com_tecnico'; e.tecnicoId=tecId; e.local=tecNome(tecId); }
    else if(movTipo==='entrada'){ e.status='estoque'; e.tecnicoId=null; if($('#movDep')&&$('#movDep').value.trim()){e.deposito=$('#movDep').value.trim();} e.local=e.deposito; }
    else if(movTipo==='baixa'){ e.status='baixado'; e.tecnicoId=null; e.local='Baixado'; }
    e.desde = Date.now();
    const motivo = movTipo==='baixa' && $('#movMotivo')? $('#movMotivo').value.trim() : '';
    DB.movimentacoes.push({ id:uid(), ts:Date.now(), tipo:movTipo, serie, de, para:destinoTxt, tecnicoId:tecId, usuario, obs:[obs,motivo].filter(Boolean).join(' · ') });
    n++;
  });
  salvar(); closeModal(); render(); flash(`✅ ${n} ${n===1?'movimentação registrada':'movimentações registradas'}`,'green');
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
    const tipo = ci.produto>=0? String(row[ci.produto]||'').trim() : 'SEM-TIPO';
    const reg = {
      serie, tipo,
      deposito: ci.deposito>=0? String(row[ci.deposito]||'').trim():'',
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
function exportarBackup(){ baixar('backup_estoque_'+new Date().toISOString().slice(0,10)+'.json', JSON.stringify(DB,null,2),'application/json'); flash('✅ Backup exportado','green'); }
function importarBackup(input){
  const f=input.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=e=>{ try{ const d=JSON.parse(e.target.result); if(!d.equipamentos) throw 0; if(!confirm('Substituir TODOS os dados atuais pelo backup?')) return; DB=Object.assign(estadoInicial(),d); salvar(); render(); renderNav(); flash('✅ Backup restaurado','green'); }catch(err){ flash('Arquivo de backup inválido','red'); } }; r.readAsText(f); input.value='';
}
function limparTudo(){ if(!confirm('Apagar TODOS os dados (equipamentos, técnicos, movimentações)? Faça backup antes!')) return; if(!confirm('Tem certeza? Esta ação não pode ser desfeita.')) return; DB=estadoInicial(); salvar(); goto('dados'); flash('Todos os dados foram apagados'); }

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
  modal('👷 '+esc(t.nome), `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
      <span class="badge blue" style="padding:8px 12px">${esc(t.regiao||'Sem região')}</span>
      ${t.matricula?`<span class="badge gray" style="padding:8px 12px">Matrícula ${esc(t.matricula)}</span>`:''}
      <span class="badge ${itens.length?'com_tecnico':'gray'}" style="padding:8px 12px">${itens.length} itens em posse</span>
      <span class="badge ${aud?'estoque':'baixado'}" style="padding:8px 12px">${aud?'Auditado '+fmtTS(aud.ts):'Nunca auditado'}</span>
    </div>
    ${Object.keys(porTipo).length?`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">${Object.entries(porTipo).map(([tp,n])=>`<span class="tag-tipo" style="border-left:3px solid ${tipoCor(tp)}">${esc(tipoNome(tp))}: ${n}</span>`).join('')}</div>`:''}
    <div class="tbl-wrap" style="max-height:340px">${
      itens.length? `<table><thead><tr><th>Nº Série</th><th>Tipo</th><th>Há quanto tempo</th><th></th></tr></thead><tbody>
        ${itens.map(e=>`<tr>
          <td class="mono"><a href="#" onclick="abrirKardex('${esc(e.serie)}');return false">${esc(e.serie)}</a></td>
          <td><span class="tag-tipo">${esc(tipoNome(e.tipo))}</span></td>
          <td class="${(diasEmPosse(e)||0)>=90?'':''}">${fmtDias(diasEmPosse(e))} ${(diasEmPosse(e)||0)>=90?'<span class="badge com_tecnico" style="font-size:10px">parado</span>':''}</td>
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
  const reg={ id:uid(), ts:Date.now(), alvoTipo:AUD.alvoTipo, alvoId:AUD.alvoId, alvoNome:AUD.alvoNome, auditor:DB.config.usuario||'', esperados:AUD.esperados.slice(), conferidos, faltando, sobrando:AUD.sobra.slice(), obs:'' };
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

/* ---------- Boot ---------- */
renderNav();
goto('dashboard');
iniciarSyncNuvem();
