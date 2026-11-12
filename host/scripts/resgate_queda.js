// resgate_queda.js (2026-11-06) - ESCRITA no host: "unstuck" automatico e manual para quem cai no limbo.
// Por que: quando o cliente nao carrega o chao (ex.: bug da porta terreno->Woodberry, ver aprendizado host_linux_vps), o pawn cai sem fim
// e o save (char.PlayerPosition) grava a queda; ao reabrir, o jogador continua caindo.
// Como funciona (thread do jogo, hook no TickFlush 0x42f3650, amostra a cada 1 s):
//   - "lugar seguro" de cada jogador = ultima posicao em que ficou ~parado em Z por 3 amostras seguidas (pisando em algo);
//   - QUEDA = Z descendo > 5 m/s por QUEDA_S segundos seguidos, ou Z abaixo de Z_MIN;
//   - resgate: K2_TeleportTo(lugar seguro + 1 m) e LaunchCharacter(0,0,0, true, true) para zerar a velocidade (sem dano de queda).
//     Sem lugar seguro (ja entrou caindo) ou 3 resgates em 60 s -> ponto de spawn de Woodberry (PADRAO).
//   - manual: o arquivo %TEMP%\tdb_host_cmd\unstuck.txt (linux/unstuck.sh) com "<numero> <nome ou todos>"; cada numero novo e executado uma vez.
(function () {
'use strict';
const QUEDA_S = 6, Z_MIN = -150000, PADRAO = [-97150, -4240, -73700];   // cm (BP_PlayerSpawnPoint de Woodberry + 1 m)
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[resgate] ' + m }); }
const pool = B.add(0x7c27980);
function fn(i) { try { const b = pool.add(0x10).add((i >>> 16) * 8).readPointer(); const e = b.add((i & 0xffff) * 2); const h = e.readU16(); const l = h >>> 6; return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l); } catch (x) { return '?'; } }
function nome(o) { return fn(o.add(0x18).readU32()); }
function classe(o) { return nome(o.add(0x10).readPointer()); }
function fstr(p) { try { const d = p.readPointer(), n = p.add(8).readS32(); if (d.isNull() || n <= 0 || n > 200) return '?'; return d.readUtf16String(n - 1); } catch (e) { return '?'; } }
function loc(a) { const r = a.add(0x198).readPointer(); if (r.isNull()) return null; const p = r.add(0x128); return [p.readDouble(), p.add(8).readDouble(), p.add(16).readDouble()]; }
function yaw(a) { try { const y = a.add(0x198).readPointer().add(0x140 + 8).readDouble(); return (isFinite(y) && Math.abs(y) <= 720) ? y : 0; } catch (e) { return 0; } }
function m(v) { return v.map(x => (x / 100).toFixed(1)).join(', '); }
const processEvent = new NativeFunction(B.add(0x24077b0), 'void', ['pointer', 'pointer', 'pointer']);
const parms = Memory.alloc(0x100);
function acharFuncao(obj, nomeF) {
  let cls = obj.add(0x10).readPointer();
  for (let n = 0; n < 12 && !cls.isNull(); n++) { let f = cls.add(0x48).readPointer(); for (let k = 0; k < 4000 && !f.isNull(); k++) { if (nome(f) === nomeF) return f; f = f.add(0x28).readPointer(); } cls = cls.add(0x40).readPointer(); }
  return ptr(0);
}
// offsets dos parametros pela reflexao (UStruct::ChildProperties +0x50; FField Next +0x20, Name +0x28; FProperty Offset_Internal +0x4c)
function params(f) { const r = {}; try { let p = f.add(0x50).readPointer(); for (let k = 0; k < 16 && !p.isNull(); k++) { r[fn(p.add(0x28).readU32())] = p.add(0x4c).readS32(); p = p.add(0x20).readPointer(); } } catch (e) {} return r; }
let fTele = null, fLaunch = null, offT = null, offL = null;
function prepararFuncoes(pawn) {
  if (fTele) return true;
  const t = acharFuncao(pawn, 'K2_TeleportTo'), l = acharFuncao(pawn, 'LaunchCharacter');
  if (t.isNull()) { log('K2_TeleportTo nao achada em ' + classe(pawn)); return false; }
  fTele = t; fLaunch = l.isNull() ? null : l; offT = params(t); offL = fLaunch ? params(l) : null;
  log('funcoes: K2_TeleportTo ' + JSON.stringify(offT) + ' | LaunchCharacter ' + JSON.stringify(offL));
  return true;
}
let fClient = null, offC = null;
function teleportar(pawn, alvo, motivo, nomeJ, pc) {
  if (!prepararFuncoes(pawn)) return false;
  const oL = offT.DestLocation !== undefined ? offT.DestLocation : 0, oR = offT.DestRotation !== undefined ? offT.DestRotation : 0x18;
  const oV = offT.ReturnValue !== undefined ? offT.ReturnValue : 0x30;
  for (let i = 0; i < 0x100; i += 8) parms.add(i).writeU64(0);
  parms.add(oL).writeDouble(alvo[0]); parms.add(oL + 8).writeDouble(alvo[1]); parms.add(oL + 16).writeDouble(alvo[2]);
  parms.add(oR + 8).writeDouble(yaw(pawn));   // Pitch 0, Yaw atual, Roll 0
  processEvent(pawn, fTele, parms);
  const ok = parms.add(oV).readU8();
  // v2 (22:47): o movimento e do CLIENTE (o servidor aceita a posicao que ele manda): so o K2_TeleportTo no servidor e desfeito no
  // quadro seguinte (medido: pawn continuou caindo). Manda o teleporte ao cliente pelo RPC do PlayerController.
  let okC = 'sem PC';
  if (pc && !pc.isNull()) {
    if (!fClient) { fClient = acharFuncao(pc, 'ClientSetLocation'); offC = fClient.isNull() ? null : params(fClient); if (offC) log('funcao: ClientSetLocation ' + JSON.stringify(offC)); }
    if (!fClient.isNull()) {
      const cL = offC.NewLocation !== undefined ? offC.NewLocation : 0, cR = offC.NewRotation !== undefined ? offC.NewRotation : 0x18;
      for (let i = 0; i < 0x100; i += 8) parms.add(i).writeU64(0);
      parms.add(cL).writeDouble(alvo[0]); parms.add(cL + 8).writeDouble(alvo[1]); parms.add(cL + 16).writeDouble(alvo[2]);
      parms.add(cR + 8).writeDouble(yaw(pawn));
      processEvent(pc, fClient, parms); okC = 'enviado';
    } else okC = 'nao achada';
  }
  if (fLaunch) {
    for (let i = 0; i < 0x40; i += 8) parms.add(i).writeU64(0);
    parms.add(offL.bXYOverride !== undefined ? offL.bXYOverride : 0x18).writeU8(1);
    parms.add(offL.bZOverride !== undefined ? offL.bZOverride : 0x19).writeU8(1);
    processEvent(pawn, fLaunch, parms);   // velocidade (0,0,0) por cima da queda
  }
  log('RESGATE ' + nomeJ + ' (' + motivo + '): -> (' + m(alvo) + ') K2_TeleportTo=' + ok + ' ClientSetLocation=' + okC);
  return true;
}
// comando manual
const ARQ = Process.getTmpDir() + '\\tdb_host_cmd\\unstuck.txt';
let ultimoCmd = null, pedido = null;
setInterval(function () {
  try { const t = File.readAllText(ARQ).trim(); if (ultimoCmd === null) { ultimoCmd = t; return; } if (t && t !== ultimoCmd) { ultimoCmd = t; const p = t.split(/\s+/); pedido = (p.slice(1).join(' ') || 'todos'); log('pedido manual: ' + pedido); } } catch (e) { if (ultimoCmd === null) ultimoCmd = ''; }
}, 2000);

const est = new Map();   // pc -> { pawn, ult, parado, seguro, caindo, resgates:[t] }
let drv = ptr(0), proxima = 0, erros = 0;
const tickCb = new NativeCallback(function (a0) {
  const a = [a0];
  {
    try {
      if (drv.isNull()) { if (classe(a[0]) !== 'IpNetDriver' || !a[0].add(0x98).readPointer().isNull()) return; drv = a[0]; log('driver ' + drv); }
      if (!a[0].equals(drv)) return;
      const agora = Date.now(); if (agora < proxima) return; proxima = agora + 1000;
      const conns = drv.add(0xa0).readPointer(), nc = drv.add(0xa8).readS32();
      const vistos = new Set(), manual = pedido; pedido = null;
      for (let i = 0; i < nc && i < 16; i++) {
        const c = conns.add(i * 8).readPointer(); if (c.isNull()) continue;
        const pc = c.add(0x30).readPointer(); if (pc.isNull()) continue;
        const pawn = pc.add(0x2d0).readPointer(); if (pawn.isNull()) continue;
        if (classe(pawn).indexOf('SurvivalPlayer') !== 0) continue;
        const k = pc.toString(); vistos.add(k);
        const ps = pc.add(0x298).readPointer(); const nomeJ = ps.isNull() ? 'conn' + i : fstr(ps.add(0x388));
        const p = loc(pawn); if (!p) continue;
        let e = est.get(k);
        if (!e || !e.pawn.equals(pawn)) { e = { pawn, ult: p, parado: 0, seguro: e ? e.seguro : null, caindo: 0, resgates: e ? e.resgates : [] }; est.set(k, e); continue; }
        const dz = p[2] - e.ult[2], dxy = Math.hypot(p[0] - e.ult[0], p[1] - e.ult[1]);
        e.ult = p;
        if (e.espera && agora < e.espera) { e.caindo = 0; e.parado = 0; continue; }   // da tempo ao cliente de aplicar o resgate
        if (Math.abs(dz) < 30 && dxy < 2000 && p[2] > Z_MIN) { if (++e.parado >= 3) e.seguro = p; } else e.parado = 0;
        if (dz < -500) e.caindo++; else e.caindo = 0;
        if (e.caindo === 2) log(nomeJ + ': caindo em (' + m(p) + ')');
        let motivo = null;
        if (e.caindo >= QUEDA_S) motivo = 'caindo ha ' + e.caindo + ' s';
        else if (p[2] < Z_MIN) motivo = 'abaixo do mapa Z=' + (p[2] / 100).toFixed(0) + ' m';
        else if (manual && (manual === 'todos' || nomeJ.indexOf(manual) >= 0)) motivo = 'manual';
        if (!motivo) continue;
        e.resgates = e.resgates.filter(t => agora - t < 60000); e.resgates.push(agora);
        let alvo = e.seguro && e.resgates.length < 3 ? [e.seguro[0], e.seguro[1], e.seguro[2] + 100] : PADRAO;
        if (motivo === 'manual' && !e.seguro) alvo = PADRAO;
        teleportar(pawn, alvo, motivo + (alvo === PADRAO ? ', ponto padrao de Woodberry' : ', ultimo lugar seguro'), nomeJ, pc);
        e.caindo = 0; e.parado = 0; e.ult = alvo; e.espera = agora + 3000;
      }
      for (const k of Array.from(est.keys())) if (!vistos.has(k)) est.delete(k);
    } catch (e) { if (++erros <= 5) log('erro: ' + e); }
  }
}, 'void', ['pointer']);
const tickN = Memory.alloc(8); tickN.writeS32(0);
// 12/11: o gancho do TickFlush agora e nativo (CModule) e so chama o JS a cada 15 quadros (~0,5 s): antes era uma chamada JS por quadro
// (a thread do jogo esperava a trava do Frida). Todo o trabalho deste script ja tinha limite de ~1 s.
Interceptor.attach(B.add(0x42f3650), new CModule(`
#include <gum/guminterceptor.h>
extern void tickCb (void * drv);
extern int tickN[1];
void onEnter (GumInvocationContext * ic)
{
  if (++tickN[0] >= 15) { tickN[0] = 0; tickCb (gum_invocation_context_get_nth_argument (ic, 0)); }
}
`, { tickCb, tickN }));
log('pronto: resgate de queda (automatico: ' + QUEDA_S + ' s caindo ou Z < ' + (Z_MIN / 100) + ' m; manual: ' + ARQ + ')');
})();
