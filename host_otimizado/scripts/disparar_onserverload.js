// disparar_onserverload.js (2026-11-05) - faz no host o que o SurvPC faria ao terminar de ler o jogador no Firestore:
// SurvPC.ServerLocationLoaded -> PlayerPlaceholder.OnServerLoad (delegate 5, bytecode mem 1038).
// Motivo: em modo dedicado o SurvPC do servidor tenta ler players/<SteamId> e recebe OnError (backend fora), entao nunca dispara.
// Roda uma vez, na thread do jogo (TickFlush do driver), para cada placeholder de cliente remoto com LoginCompleted=false.
(function () {
'use strict';
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[osl] ' + m }); }
const pool = B.add(0x7c27980);
function fn(i) { try { const b = pool.add(0x10).add((i >>> 16) * 8).readPointer(); const e = b.add((i & 0xffff) * 2); const h = e.readU16(); const l = h >>> 6; return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l); } catch (x) { return '?'; } }
function nome(o) { return fn(o.add(0x18).readU32()); }
function classe(o) { return nome(o.add(0x10).readPointer()); }
const processEvent = new NativeFunction(B.add(0x24077b0), 'void', ['pointer', 'pointer', 'pointer']);
const OFF_LOGIN = 0x3c8;       // PlayerPlaceholder_C.LoginCompleted (SDK)
const feitos = {};
const vistoEm = {};
// RESERVA: com o Firestore do host no emulador, o caminho normal (SurvPC OnGot -> ServerLocationLoaded -> OnServerLoad)
// deve completar o login sozinho. So disparamos se, 25 s depois de ver o placeholder (BeginPlay dedicado = 14 s), LoginCompleted ainda for 0.
const ESPERA_MS = 25000;
const parms = Memory.alloc(256);

function acharFuncao(obj, nomeF) {
  // UStruct::Children (+0x48) -> lista de UField, Next em +0x28; sobe pela SuperStruct (+0x40)
  let cls = obj.add(0x10).readPointer();
  for (let n = 0; n < 8 && !cls.isNull(); n++) {
    let f = cls.add(0x48).readPointer();
    for (let k = 0; k < 2000 && !f.isNull(); k++) {
      if (nome(f) === nomeF) return f;
      f = f.add(0x28).readPointer();
    }
    cls = cls.add(0x40).readPointer();
  }
  return ptr(0);
}

let drv = ptr(0);
const tickCb = new NativeCallback(function (a0) {
  const a = [a0];
  {
    try {
      if (drv.isNull()) { if (classe(a[0]) !== 'IpNetDriver' || !a[0].add(0x98).readPointer().isNull()) return; drv = a[0]; }
      if (!a[0].equals(drv)) return;
      const conns = drv.add(0xa0).readPointer(), nc = drv.add(0xa8).readS32();
      for (let i = 0; i < nc && i < 16; i++) {
        const conn = conns.add(i * 8).readPointer();
        const pc = conn.add(0x30).readPointer(); if (pc.isNull()) continue;
        const pawn = pc.add(0x2d0).readPointer(); if (pawn.isNull()) continue;
        const k = pawn.toString();
        if (feitos[k]) continue;
        if (classe(pawn) !== 'PlayerPlaceholder_C') continue;
        // espera o fluxo normal: BeginPlay dedicado (14 s) liga os delegates; disparamos 20 s depois de ver o placeholder
        if (!vistoEm[k]) { vistoEm[k] = Date.now(); log('placeholder de cliente visto: ' + pawn + ' (disparo em ' + ESPERA_MS / 1000 + ' s)'); continue; }
        if (Date.now() - vistoEm[k] < ESPERA_MS) continue;
        if (pawn.add(OFF_LOGIN).readU8()) { feitos[k] = true; log('placeholder ' + pawn + ' ja com LoginCompleted=1: nada a fazer'); continue; }
        feitos[k] = true;
        const antes = pawn.add(OFF_LOGIN).readU8();
        const f = acharFuncao(pawn, 'OnServerLoad');
        if (f.isNull()) { log('OnServerLoad NAO achada na classe de ' + pawn); continue; }
        log('placeholder ' + pawn + ' (PC ' + pc + ' ' + classe(pc) + ') LoginCompleted=' + antes + ' -> chamando OnServerLoad (UFunction ' + f + ')');
        parms.writeByteArray(new Array(256).fill(0));
        processEvent(pawn, f, parms);
        log('OnServerLoad chamada; o Blueprint espera ~3 s (Delay) antes de LoadPlayerPos/LoginCompleted');
        const p = pawn;
        let n = 0;
        const t = setInterval(function () {
          n++;
          try { const v = p.add(OFF_LOGIN).readU8(); if (v || n >= 20) { log('LoginCompleted do placeholder ' + p + ' = ' + v + ' (apos ' + n + ' s)'); clearInterval(t); } } catch (e) { clearInterval(t); }
        }, 1000);
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
log('pronto: aguardando placeholder de cliente no TickFlush');
})();
