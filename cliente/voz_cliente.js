// voz_cliente.js (2026-11-12) - CLIENTE: liga o chat de voz de proximidade que o jogo traz mas nao inicia.
// Achados (12/11): o handler VoipManager.VoiceGenerated so envia a voz (SendVoiceData -> servidor -> ReceiveVoice nos pawns a ate 40 m) se
// SurvivalPlayer.AllowVoice (+0x1681) for verdadeiro (no cliente vem 0), e NENHUM Blueprint chama VoipManagerComponent.InitVoice(Controller), que
// abre o microfone (modulo "Voice": CreateVoiceCapture/Encoder/Decoder). Aqui: ao entrar no mapa (SurvPC local com pawn e VoipManager), chama
// InitVoice(controle local) pela thread do jogo (gancho nativo em ProcessEvent no ReceiveDrawHUD) e repete se devolver falso (a 1a chamada falhou no
// teste e a 2a passou); mantem AllowVoice = 1. Se o pawn mudar (morte, troca de mapa), inicia de novo. --sem-voz no launcher desliga.
(function () {
'use strict';
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[voz] ' + m }); }
const pool = B.add(0x7c27980);
function fn(i) { try { const b = pool.add(0x10).add((i >>> 16) * 8).readPointer(); const e = b.add((i & 0xffff) * 2); const h = e.readU16(); const l = h >>> 6; return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l); } catch (x) { return '?'; } }
function nome(o) { try { return fn(o.add(0x18).readU32()); } catch (e) { return '?'; } }
function classe(o) { try { return fn(o.add(0x10).readPointer().add(0x18).readU32()); } catch (e) { return '?'; } }
function acharFuncao(o, alvo) {
  let cls = o.add(0x10).readPointer();
  for (let n = 0; n < 8 && !cls.isNull(); n++) { let x = cls.add(0x48).readPointer(); for (let k = 0; k < 3000 && !x.isNull(); k++) { if (nome(x) === alvo) return x; x = x.add(0x28).readPointer(); } cls = cls.add(0x40).readPointer(); }
  return ptr(0);
}
const g = B.add(0x7ccda10); let objs = ptr(0), num = 0, nch = 0;   // carregado ao abrir o jogo: relido a cada busca
function refrescar() { try { objs = g.readPointer(); num = g.add(0x14).readS32(); nch = g.add(0x1c).readS32(); } catch (e) { num = 0; } return num > 100000 && !objs.isNull(); }
const MORTO = (1 << 28) | (1 << 29) | (1 << 21);
// cfg: 0 hud, 1 fReceiveDrawHUD, 2 ProcessEvent, 3 obj, 4 func, 5 parms, 6 pendente
const cfg = Memory.alloc(8 * 8); for (let i = 0; i < 8; i++) cfg.add(i * 8).writeU64(0);
const pI = Memory.alloc(32); pI.writeByteArray(new Array(32).fill(0));   // InitVoice(AController* Controller) -> bool
const cm = new CModule(`
#include <gum/guminterceptor.h>
#include <stdint.h>
extern uint64_t cfg[8];
typedef void (*PE) (void *, void *, void *);
void onEnter (GumInvocationContext * ic)
{
  void * o = gum_invocation_context_get_nth_argument (ic, 0);
  void * f = gum_invocation_context_get_nth_argument (ic, 1);
  if (f != 0 && f == (void *) cfg[1] && o == (void *) cfg[0] && cfg[6] && cfg[2] != 0)
  {
    cfg[6] = 0;
    ((PE) cfg[2]) ((void *) cfg[3], (void *) cfg[4], (void *) cfg[5]);
  }
}
`, { cfg });
let i = 0, hud = ptr(0), pcl = ptr(0), anexado = false, buscando = false;
let pawnOk = ptr(0), tentativas = 0, proxTent = 0, aguardando = false, tIni = 0, fInit = ptr(0), vmUsado = ptr(0);
function passo() {
  if (i === 0 && !refrescar()) { setTimeout(passo, 3000); return; }
  buscando = true;
  const fim = Math.min(i + 3000, num);
  for (; i < fim; i++) {
    try {
      const ch = i >> 16; if (ch >= nch) { i = num; break; }
      const chunk = objs.add(ch * 8).readPointer(); if (chunk.isNull()) continue;
      const it = chunk.add((i & 0xffff) * 0x18); const o = it.readPointer(); if (o.isNull()) continue;
      if (it.add(8).readS32() & MORTO) continue; if (o.add(8).readS32() & 0x10) continue;
      const c = classe(o); if (c === 'BP_GameHUD_C') hud = o; else if (c === 'SurvPC_C') pcl = o;
    } catch (e) {}
  }
  if (i < num) { setTimeout(passo, 25); return; }
  if (hud.isNull() || pcl.isNull()) { hud = ptr(0); pcl = ptr(0); i = 0; buscando = false; setTimeout(passo, 3000); return; }   // ainda no menu
  const fR = acharFuncao(hud, 'ReceiveDrawHUD');
  if (fR.isNull()) { hud = ptr(0); pcl = ptr(0); i = 0; buscando = false; setTimeout(passo, 5000); return; }
  cfg.writeU64(uint64(hud.toString())); cfg.add(8).writeU64(uint64(fR.toString())); cfg.add(16).writeU64(uint64(B.add(0x24077b0).toString()));
  buscando = false; pawnOk = ptr(0); tentativas = 0; proxTent = 0; aguardando = false;
  if (!anexado) { anexado = true; Interceptor.attach(B.add(0x24077b0), cm); setInterval(ciclo, 1000); log('chat de voz: pronto (controle ' + pcl + ')'); }
  else log('chat de voz: reativado (controle ' + pcl + ')');
}
function ciclo() {
  try {
    if (buscando || pcl.isNull()) return;
    if (classe(hud) !== 'BP_GameHUD_C' || classe(pcl) !== 'SurvPC_C') { cfg.add(48).writeU64(0); hud = ptr(0); pcl = ptr(0); i = 0; setTimeout(passo, 500); return; }   // trocou de mapa
    const pw = pcl.add(0x2D0).readPointer(); if (pw.isNull() || classe(pw).indexOf('SurvivalPlayer') !== 0) return;
    if (pw.add(0x2980).readU8() === 0 && pw.add(0x1681).readU8() === 0) pw.add(0x1681).writeU8(1);   // AllowVoice (BlockVoiceChat = 0)
    if (aguardando) {   // pedido enviado: espera o gancho executar (ate 5 s)
      if (cfg.add(48).readU64().toNumber() === 0) {
        const r = pI.add(8).readU8();
        aguardando = false; tentativas++;
        if (r === 1) { pawnOk = pw; log('InitVoice OK (tentativa ' + tentativas + ', pawn ' + pw + '): microfone aberto'); }
        else { log('InitVoice devolveu falso (tentativa ' + tentativas + ')'); proxTent = Date.now() + (tentativas < 6 ? 3000 : 30000); }
      } else if (Date.now() - tIni > 5000) { aguardando = false; cfg.add(48).writeU64(0); proxTent = Date.now() + 3000; }
      return;
    }
    if (pawnOk.equals(pw)) return;           // este pawn ja tem a voz iniciada
    if (!pawnOk.isNull() && !pawnOk.equals(pw)) { pawnOk = ptr(0); tentativas = 0; proxTent = 0; }   // pawn novo
    if (Date.now() < proxTent) return;
    const vm = pw.add(0x8B8).readPointer(); if (vm.isNull()) return;
    if (fInit.isNull() || !vmUsado.equals(vm)) { fInit = acharFuncao(vm, 'InitVoice'); vmUsado = vm; }
    if (fInit.isNull()) { log('InitVoice nao achada'); proxTent = Date.now() + 30000; return; }
    pI.writeByteArray(new Array(32).fill(0)); pI.writePointer(pcl);
    cfg.add(24).writeU64(uint64(vm.toString())); cfg.add(32).writeU64(uint64(fInit.toString())); cfg.add(40).writeU64(uint64(pI.toString()));
    cfg.add(48).writeU64(1); aguardando = true; tIni = Date.now();
  } catch (e) {}
}
setTimeout(passo, 3000);
})();
