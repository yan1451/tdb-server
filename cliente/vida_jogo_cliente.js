// vida_jogo_cliente.js (2026-11-12) - CLIENTE: conserta a barra de vida da HUD de baixo (WBP_StatWithRedLine), que nao atualiza com o dano.
// Bytecode: SetValue(double) faz SetPercent(valor) na ProgressBar_StatValue (valor = fracao 0..1?) e rearma o timer da barra vermelha; Init(NewParam) so guarda o
// componente de estatisticas (New_Param +0x2E8). Nada chama SetValue no nosso cenario (o evento OnHPChange nao chega a UI).
// Etapa A (APLICAR=false): so LE: acha a instancia, mostra New_Param, CurrentValue (+0x2B8), IsCriticalState (+0x2C0), OLDHP (+0x2E0) e a vida real (Stats 1/2).
// Etapa B (APLICAR=true): a cada 150 ms o JS prepara o valor e a thread do jogo (gancho nativo em ProcessEvent, quando o BP_GameHUD processa ReceiveDrawHUD)
// chama WBP_StatWithRedLine.SetValue(vida/vidaMax). So chama quando o valor mudou.
(function () {
'use strict';
const APLICAR = true;
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[vida] ' + m }); }
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
// cfg: 0 hud, 1 fReceiveDrawHUD, 2 widget, 3 fSetValue, 4 pendente, 5 ProcessEvent, 6 contador
const cfg = Memory.alloc(8 * 8); for (let i = 0; i < 8; i++) cfg.add(i * 8).writeU64(0);
const parm = Memory.alloc(16); parm.writeByteArray(new Array(16).fill(0));   // SetValue(double CurrentValue)
const cm = new CModule(`
#include <gum/guminterceptor.h>
#include <stdint.h>
extern uint64_t cfg[8];
extern uint8_t parm[];
typedef void (*PE) (void *, void *, void *);
void onEnter (GumInvocationContext * ic)
{
  void * o = gum_invocation_context_get_nth_argument (ic, 0);
  void * f = gum_invocation_context_get_nth_argument (ic, 1);
  if (f != 0 && f == (void *) cfg[1] && o == (void *) cfg[0])
  {
    cfg[6]++;
    if (cfg[4] && cfg[2] != 0 && cfg[3] != 0 && cfg[5] != 0) { cfg[4] = 0; ((PE) cfg[5]) ((void *) cfg[2], (void *) cfg[3], parm); }
  }
}
`, { cfg, parm });
let i = 0, hud = ptr(0), wid = ptr(0), pcl = ptr(0), anexado = false, buscando = false;
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
      const c = classe(o);
      if (c === 'BP_GameHUD_C') hud = o; else if (c === 'WBP_StatWithRedLine_C') wid = o; else if (c === 'SurvPC_C') pcl = o;
    } catch (e) {}
  }
  if (i < num) { setTimeout(passo, 25); return; }
  if (hud.isNull() || wid.isNull() || pcl.isNull()) { hud = ptr(0); wid = ptr(0); pcl = ptr(0); i = 0; buscando = false; setTimeout(passo, 3000); return; }   // ainda no menu
  const fR = acharFuncao(hud, 'ReceiveDrawHUD'), fS = acharFuncao(wid, 'SetValue');
  if (fR.isNull() || fS.isNull()) { log('funcao nao achada'); hud = ptr(0); wid = ptr(0); i = 0; buscando = false; setTimeout(passo, 5000); return; }
  cfg.writeU64(uint64(hud.toString())); cfg.add(8).writeU64(uint64(fR.toString())); cfg.add(16).writeU64(uint64(wid.toString()));
  cfg.add(24).writeU64(uint64(fS.toString())); cfg.add(40).writeU64(uint64(B.add(0x24077b0).toString()));
  buscando = false; ultimo = -1;
  if (!anexado) { anexado = true; Interceptor.attach(B.add(0x24077b0), cm); setInterval(aplicar, 150); setInterval(vigiar, 5000); log('barra de vida do jogo ativa (widget ' + wid + ')'); }
  else log('barra de vida reativada (widget ' + wid + ')');
}
// HUD/widget/controle sao recriados ao trocar de mapa: se algum morreu, para de chamar o SetValue e procura de novo
function vigiar() {
  try {
    if (buscando || wid.isNull()) return;
    if (classe(hud) !== 'BP_GameHUD_C' || classe(wid) !== 'WBP_StatWithRedLine_C' || classe(pcl) !== 'SurvPC_C') {
      cfg.add(16).writeU64(0); hud = ptr(0); wid = ptr(0); pcl = ptr(0); i = 0; setTimeout(passo, 500);
    }
  } catch (e) {}
}
function vida() {   // componente de estatisticas do jogador local: New_Param do widget (esta NULL no cliente: o Init nunca recebeu o componente) ou, se nulo,
  // SurvPC local (so ha um no cliente) -> Pawn (+0x2D0) -> BPC_PlayerStatsComponent (+0x898). Stats TMap em +0x180, passo 0x18; 1 = Health, 2 = HealthMax
  let comp = wid.add(0x2E8).readPointer();
  if (comp.isNull() && !pcl.isNull()) { const pw = pcl.add(0x2D0).readPointer(); if (!pw.isNull() && classe(pw).indexOf('SurvivalPlayer') === 0) comp = pw.add(0x898).readPointer(); }
  if (comp.isNull()) return null;
  const m = comp.add(0x180), data = m.readPointer(), n = m.add(8).readS32(); let h = null, mx = null;
  for (let k = 0; k < n && k < 40; k++) { const e = data.add(k * 0x18), key = e.readU8(); if (key === 1) h = e.add(8).readDouble(); else if (key === 2) mx = e.add(8).readDouble(); }
  return { h: h, mx: mx };
}
function ler() {
  try {
    const v = vida(), pc = wid.add(0x2B8).readDouble();
    log('widget: New_Param=' + wid.add(0x2E8).readPointer() + ' CurrentValue=' + pc + ' critico=' + wid.add(0x2C0).readU8() + ' OLDHP=' + wid.add(0x2E0).readDouble() +
        ' | Stats: Health=' + (v && v.h) + ' HealthMax=' + (v && v.mx) + ' | quadros=' + cfg.add(48).readU64());
  } catch (e) { log('erro ler: ' + e); }
}
let ultimo = -1;
function aplicar() {
  try {
    if (wid.isNull()) return;
    const v = vida(); if (!v || v.h === null || !isFinite(v.h)) return;
    const f = Math.max(0, Math.min(1, v.mx && v.mx > 0 ? v.h / v.mx : v.h / 100));
    if (Math.abs(f - ultimo) < 0.0005 || cfg.add(32).readU64().toNumber() !== 0) return;
    ultimo = f; parm.writeDouble(f); cfg.add(32).writeU64(1);
  } catch (e) {}
}
setTimeout(passo, 3000);
})();
