// carregar_dados.js (2026-11-10) - HOST: jogador nascia na sala do doutor e o tutorial recomecava.
// Causa (bytecode do SurvPC + rastreio ao vivo 10/11 11:16-11:19): no login o servidor so faz a 1a leitura do save
// (SetLoginServer -> Get players/<SteamId> -> OnGot_D1E9: pega so o charlist). A 2a leitura, que carrega o "char"
// (TutorialBegginer -> TutorialCompleted, TutorStage, PlayerPosition -> PlayerLocSave), so acontece no evento SurvPC.LoadUserInfo,
// que no nosso servidor nunca e disparado. Sem esses dados, PlayerPlaceholder.PickSpawnPoint ve "iniciante" (TutorialCompleted=false,
// etapa padrao "DoctorSequence") -> ponto ForBeginner (sala do doutor) e o tutorial recomeca, gravando a sala como posicao.
// Prova: chamar LoadUserInfo a mao (11:19:26) carregou completo=1 e a posicao salva em 1 s (OnGot_F36A).
// Correcao: para cada SurvPC de jogador (Steam_Id preenchido, diferente do host) ainda sem dados (TutorialCompleted=0), chama
// LoadUserInfo uma vez, 2 s depois de o Steam_Id aparecer (bem antes do spawn, que vem ~50 s depois). Na thread do jogo (TickFlush,
// gancho em C que so chama o JS quando ha pedido). Jogadores: pelas conexoes do NetDriver, sem varrer a GObjects.
// Personagem novo (sem "char" no save) segue o fluxo normal do jogo: a leitura nao acha nada e ele continua iniciante. Prefixo [dados].
(function () {
'use strict';
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[dados] ' + m }); }
const pool = B.add(0x7c27980);
function fn(i) { try { const b = pool.add(0x10).add((i >>> 16) * 8).readPointer(); const e = b.add((i & 0xffff) * 2); const h = e.readU16(); const l = h >>> 6; return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l); } catch (x) { return '?'; } }
function nome(o) { try { return fn(o.add(0x18).readU32()); } catch (e) { return '?'; } }
function classe(o) { try { return nome(o.add(0x10).readPointer()); } catch (e) { return '?'; } }
function fstr(p) { try { const d = p.readPointer(), n = p.add(8).readS32(); return (d.isNull() || n <= 0) ? '' : d.readUtf16String(Math.min(n, 400)); } catch (e) { return '?'; } }
const processEvent = new NativeFunction(B.add(0x24077b0), 'void', ['pointer', 'pointer', 'pointer']);
const parms = Memory.alloc(64);
const MORTO = (1 << 28) | (1 << 29) | (1 << 21);
const HOST_ID = '76561197960271872';
// SurvPC_C (Dumper-7): TutorialCompleted 0xC88, CurrentTutorialStage 0xD70, Steam_Id 0xF20, PlayerLocSave 0xFA8
const OFF_COMPLETO = 0xC88, OFF_ETAPA = 0xD70, OFF_STEAMID = 0xF20, OFF_POS = 0xFA8;
let fLoad = null;
// 12/11: janelas de espera maiores (antes: conferia so 3 s depois e pedia de novo so quando vinha erro). A leitura do save pode demorar
// (a 1a leitura depois de uma pausa leva ~35 s e volta com erro). Agora: se nao responder em 20 s, pede de novo; ate 8 pedidos e 120 s no total;
// o log final so sai quando os dados chegam (completo=1), a leitura responde sem dados (personagem novo) ou o limite estoura.
const ESPERA_RESPOSTA_MS = 20000, MAX_TENT = 8, LIMITE_TOTAL_MS = 120000;
const vistoEm = new Map(), feitos = new Set(), fila = [];

function acharFuncao(o, alvo) {
  let cls = o.add(0x10).readPointer();
  for (let n = 0; n < 4 && !cls.isNull(); n++) { let x = cls.add(0x48).readPointer(); for (let k = 0; k < 3000 && !x.isNull(); k++) { if (nome(x) === alvo) return x; x = x.add(0x28).readPointer(); } cls = cls.add(0x40).readPointer(); }
  return ptr(0);
}
function pcs() {   // PCs dos clientes conectados, pelas conexoes do NetDriver (barato; NAO varre a GObjects)
  const r = [];
  try {
    const eng = B.add(0x7e20ea8).readPointer(); const w = eng.add(0xec0).readPointer().readPointer().add(0x2c0).readPointer();
    const d = w.add(0x38).readPointer(); if (d.isNull()) return r;
    const conns = d.add(0xa0).readPointer(), nc = d.add(0xa8).readS32();
    for (let i = 0; i < nc && i < 64; i++) { const pc = conns.add(i * 8).readPointer().add(0x30).readPointer(); if (!pc.isNull() && classe(pc) === 'SurvPC_C') r.push(pc); }
  } catch (e) {}
  return r;
}

setInterval(function () {
  try {
    const agora = Date.now();
    for (const pc of pcs()) {
      const k = pc.toString();
      if (feitos.has(k)) {
        const v = vistoEm.get(k);
        if (v && v.conferir) {
          const sidK = fstr(pc.add(OFF_STEAMID)), nT = tentativas.get(k) || 0, seg = ((agora - (v.primeiro || agora)) / 1000).toFixed(1);
          if (pc.add(OFF_COMPLETO).readU8() === 1) {
            v.conferir = false;
            log('dados carregados para ' + sidK + ' em ' + seg + ' s (pedidos: ' + nT + '): etapa="' + fstr(pc.add(OFF_ETAPA)) + '" posSalva=' +
                (fstr(pc.add(OFF_POS)).replace(/Rotation:.*/, '').trim() || '(vazia)'));
          } else if (v.got && agora - v.got > 3000) {
            v.conferir = false;
            log('a leitura de ' + sidK + ' respondeu em ' + seg + ' s mas sem dados do personagem (personagem novo?)');
          } else if (agora - (v.primeiro || agora) > LIMITE_TOTAL_MS) {
            v.conferir = false;
            log('DESISTO de carregar os dados de ' + sidK + ' depois de ' + seg + ' s e ' + nT + ' pedido(s)');
          } else if (!v.got && v.chamado && agora - v.chamado > ESPERA_RESPOSTA_MS && nT < MAX_TENT && !fila.length) {
            tentativas.set(k, nT + 1); v.chamado = agora;
            log('sem resposta de ' + sidK + ' em ' + ((agora - v.primeiro) / 1000).toFixed(0) + ' s; pedindo de novo (pedido ' + (nT + 1) + ' de ' + MAX_TENT + ')');
            fila.push([pc, sidK]); pendente.writeS32(1);
          }
        }
        continue;
      }
      const sid = fstr(pc.add(OFF_STEAMID));
      if (!sid || sid === HOST_ID) continue;
      if (pc.add(OFF_COMPLETO).readU8() !== 0) { feitos.add(k); continue; }   // o jogo ja carregou sozinho
      if (!vistoEm.has(k)) { vistoEm.set(k, { t: agora }); continue; }
      if (agora - vistoEm.get(k).t < 2000) continue;
      if (fLoad === null) {
        fLoad = acharFuncao(pc, 'LoadUserInfo'); log(fLoad.isNull() ? 'ERRO: SurvPC.LoadUserInfo nao achada' : 'LoadUserInfo ' + fLoad);
        const fGot = acharFuncao(pc, 'OnGot_F36A4BC64657E2B0074D619D06EC5286'), fErr = acharFuncao(pc, 'OnError_F36A4BC64657E2B0074D619D06EC5286');
        alvosResp.writePointer(fGot); alvosResp.add(8).writePointer(fErr); fGotPtr = fGot;
      }
      if (fLoad.isNull()) continue;
      feitos.add(k); tentativas.set(k, 1); fila.push([pc, sid]); pendente.writeS32(1);
    }
  } catch (e) { log('erro: ' + e); }
}, 1000);

const pendente = Memory.alloc(8); pendente.writeS32(0);
// 10/11 19:2x (VPS, medido): a conexao do host com o Firestore morre quando fica parada; a 1a leitura depois da pausa espera ~35 s e
// volta com OnError (e so entao o host reconecta); a seguinte volta em ~33 ms. Entao: se vier OnError, pede de novo na hora (ate 5x).
const alvosResp = Memory.alloc(16); alvosResp.writePointer(ptr(0)); alvosResp.add(8).writePointer(ptr(0));
let fGotPtr = ptr(0);
const tentativas = new Map();
const resposta = new NativeCallback(function (obj, f) {
  try {
    const k = obj.toString(), v = vistoEm.get(k) || {}, ms = v.chamado ? Date.now() - v.chamado : -1;
    const sid = fstr(obj.add(OFF_STEAMID));
    if (f.equals(fGotPtr)) { v.got = Date.now(); vistoEm.set(k, v); log('resposta OK para ' + sid + ' em ' + ms + ' ms (pedido ' + (tentativas.get(k) || 0) + ')'); return; }
    const n = (tentativas.get(k) || 0);
    if (n >= MAX_TENT) { log('ERRO de leitura para ' + sid + ' depois de ' + n + ' tentativas; desisto'); return; }
    tentativas.set(k, n + 1);
    log('ERRO de leitura para ' + sid + ' em ' + ms + ' ms (conexao velha com o banco); pedindo de novo (tentativa ' + (n + 1) + ')');
    fila.push([obj, sid]); pendente.writeS32(1);
  } catch (e) { log('erro na resposta: ' + e); }
}, 'void', ['pointer', 'pointer']);
const cmResp = new CModule(`
#include <gum/guminterceptor.h>
extern void resposta (void * obj, void * f);
extern void * alvosResp[2];
void onEnter (GumInvocationContext * ic)
{
  void * f = gum_invocation_context_get_nth_argument (ic, 1);
  if (f != 0 && (f == alvosResp[0] || f == alvosResp[1])) resposta (gum_invocation_context_get_nth_argument (ic, 0), f);
}
`, { resposta, alvosResp });
Interceptor.attach(B.add(0x24077b0), cmResp);
const chamar = new NativeCallback(function () {
  try {
    while (fila.length) {
      const [pc, sid] = fila.shift();
      if (classe(pc) !== 'SurvPC_C') continue;    // saiu antes
      parms.writeByteArray(new Array(64).fill(0));
      processEvent(pc, fLoad, parms);
      const v = vistoEm.get(pc.toString()) || {}; v.chamado = Date.now(); if (!v.primeiro) v.primeiro = v.chamado; v.got = 0; v.conferir = true; vistoEm.set(pc.toString(), v);
      log('LoadUserInfo chamado para ' + sid + ' (carrega tutorial e posicao salva antes do spawn)');
    }
  } catch (e) { log('erro chamando LoadUserInfo: ' + e); }
  pendente.writeS32(0);
}, 'void', []);
// 10/11 11:3x: a 1a versao (JS a cada quadro + varredura da GObjects a cada 1 s) travou o host na subida: o gancho da thread do
// jogo esperava a trava do JS durante a varredura. Agora o gancho e em C e so chama o JS quando ha pedido na fila.
const cm = new CModule(`
#include <gum/guminterceptor.h>
extern void chamar (void);
extern int pendente;
void onEnter (GumInvocationContext * ic) { if (pendente) chamar (); }
`, { chamar, pendente });
Interceptor.attach(B.add(0x42f3650), cm);
log('pronto: carrega os dados do personagem (LoadUserInfo) de quem entra');
})();
