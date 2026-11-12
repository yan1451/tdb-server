// reaplicar_aparencia.js (2026-11-07) - corrige "personagem sem cabeca para os outros jogadores".
// Causa (medida ao vivo 07/11): o dono le a aparencia no Firestore, aplica em si e manda UpdateSaveCharactersServer(FS_SaveStructure);
// o servidor guarda em GI_Character_Save_Ref (pawn+0x2798; replicado, SEM OnRep) e chama UpdateSaveCharactersMulticast, que e quem
// monta rosto/cabelo/barba nos outros clientes. Multicast so vai para quem ja tem o pawn relevante (jogador: 300 m). Quem estava longe
// na hora (ou recebe o pawn depois, ao se aproximar ou ao reabrir o canal) ganha so a propriedade, que ninguem aplica: corpo e roupas
// aparecem (tem OnRep proprio), rosto/cabelo/barba nao. No cliente: GI_Character_Save_Ref chegou (Face=Basic_Head_V3...), mas os
// componentes Hair1/Hair2(rosto)/beard estavam vazios.
// Correcao: na thread do jogo (TickFlush), a cada 1 s, para cada par (conexao, pawn de OUTRO jogador) que ganhou canal ha >= 2 s,
// reenvia UpdateSaveCharactersMulticast(GI_Character_Save_Ref) daquele pawn (no maximo 1 vez a cada 3 s por pawn). Cosmetico: e o
// mesmo dado que o dono mandou. Se o canal fecha e reabre, reenvia de novo.
(function () {
'use strict';
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[aparencia] ' + m }); }
const pool = B.add(0x7c27980);
function fn(i) { try { const b = pool.add(0x10).add((i >>> 16) * 8).readPointer(); const e = b.add((i & 0xffff) * 2); const h = e.readU16(); const l = h >>> 6; return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l); } catch (x) { return '?'; } }
function nome(o) { return fn(o.add(0x18).readU32()); }
function classe(o) { return nome(o.add(0x10).readPointer()); }
function fstr(p) { try { const d = p.readPointer(), n = p.add(8).readS32(); if (d.isNull() || n <= 0 || n > 200) return '?'; return d.readUtf16String(n - 1); } catch (e) { return '?'; } }
const processEvent = new NativeFunction(B.add(0x24077b0), 'void', ['pointer', 'pointer', 'pointer']);
function acharFuncao(obj, nomeF) {
  let cls = obj.add(0x10).readPointer();
  for (let n = 0; n < 12 && !cls.isNull(); n++) { let f = cls.add(0x48).readPointer(); for (let k = 0; k < 4000 && !f.isNull(); k++) { if (nome(f) === nomeF) return f; f = f.add(0x28).readPointer(); } cls = cls.add(0x40).readPointer(); }
  return ptr(0);
}
const SAVE = 0x2798;          // SurvivalPlayer_C.GI_Character_Save_Ref (FS_SaveStructure, 0x1B0); Face em +0x0
const OPEN_CH = 0x70;         // UNetConnection.OpenChannels (TArray<UChannel*>)
const CH_ACTOR = 0x68;        // UActorChannel.Actor
const ESPERA_MS = 2000, INTERVALO_PAWN_MS = 3000;
let fMulti = null, drv = null, ultimo = 0, total = 0;
const vistos = new Map();     // "conn|pawn" -> {t: primeira vez com canal, feito: bool}
const ultimoEnvio = new Map(); // pawn -> ms
const nomes = new Map();      // pawn -> nome do dono (log)

const tickCb = new NativeCallback(function (a0) {
  const a = [a0];
  {
    try {
      if (drv === null) { if (classe(a[0]) !== 'IpNetDriver' || !a[0].add(0x98).readPointer().isNull()) return; drv = a[0]; log('driver ' + drv); }
      if (!a[0].equals(drv)) return;
      const agora = Date.now(); if (agora - ultimo < 1000) return; ultimo = agora;
      const conns = drv.add(0xa0).readPointer(), nc = drv.add(0xa8).readS32();
      const jog = [];   // {c, pawn}
      for (let i = 0; i < nc && i < 32; i++) {
        const c = conns.add(i * 8).readPointer(); if (c.isNull()) continue;
        const pc = c.add(0x30).readPointer(); if (pc.isNull()) continue;
        const pawn = pc.add(0x2d0).readPointer();
        jog.push({ c, pawn });
        if (!pawn.isNull() && !nomes.has(pawn.toString())) { const ps = pc.add(0x298).readPointer(); nomes.set(pawn.toString(), ps.isNull() ? 'conn' + i : fstr(ps.add(0x388))); }
      }
      if (jog.length < 2) { vistos.clear(); return; }
      const pawns = new Set(jog.filter(j => !j.pawn.isNull()).map(j => j.pawn.toString()));
      const presentes = new Set(), reenviar = new Set();
      for (const j of jog) {
        const arr = j.c.add(OPEN_CH).readPointer(), n = j.c.add(OPEN_CH + 8).readS32();
        if (arr.isNull() || n <= 0) continue;
        for (let k = 0; k < n && k < 60000; k++) {
          const ch = arr.add(k * 8).readPointer(); if (ch.isNull()) continue;
          const at = ch.add(CH_ACTOR).readPointer(); if (at.isNull()) continue;
          const ak = at.toString();
          if (!pawns.has(ak) || (!j.pawn.isNull() && j.pawn.equals(at))) continue;   // so pawns de OUTROS jogadores
          const key = j.c + '|' + ak; presentes.add(key);
          let v = vistos.get(key); if (!v) { v = { t: agora, feito: false }; vistos.set(key, v); }
          if (!v.feito && agora - v.t >= ESPERA_MS) reenviar.add(ak);
        }
      }
      for (const key of Array.from(vistos.keys())) if (!presentes.has(key)) vistos.delete(key);   // canal fechou: reenvia quando reabrir
      for (const ak of reenviar) {
        const pawn = ptr(ak);
        if ((ultimoEnvio.get(ak) || 0) > agora - INTERVALO_PAWN_MS) continue;
        if (pawn.add(SAVE).readPointer().isNull()) continue;   // o dono ainda nao mandou a aparencia: o multicast do proprio jogo vai cobrir
        if (fMulti === null) { fMulti = acharFuncao(pawn, 'UpdateSaveCharactersMulticast'); log(fMulti.isNull() ? 'ERRO: UpdateSaveCharactersMulticast nao achada' : 'funcao UpdateSaveCharactersMulticast ' + fMulti); }
        if (fMulti.isNull()) return;
        processEvent(pawn, fMulti, pawn.add(SAVE));   // o parametro unico (FS_SaveStructure) fica no offset 0 dos parametros
        ultimoEnvio.set(ak, agora); total++;
        let quantos = 0;
        for (const [key, v] of vistos) if (key.endsWith('|' + ak) && !v.feito && agora - v.t >= ESPERA_MS) { v.feito = true; quantos++; }
        log('reenviada a aparencia de ' + (nomes.get(ak) || ak) + ' (rosto ' + nome(pawn.add(SAVE).readPointer()) + ') para ' + quantos + ' cliente(s) que receberam o pawn depois | total ' + total);
      }
    } catch (e) { log('erro: ' + e); }
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
log('pronto: reaplica a aparencia (rosto/cabelo/barba) quando o pawn de um jogador chega a outro cliente');
})();
