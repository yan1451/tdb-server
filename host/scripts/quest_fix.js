// quest_fix.js (2026-11-07; v2 2026-11-12 com a varredura em C) - HOST: itens de quest nao apareciam (no loot de baus, zumbis e carros das
// areas de quest).
// Causa (bytecode de BP_QuestItemsSpawnZone, V5\QuestBP; diagnostico confirmado tambem por outro jogador no host dele):
//   ReceiveBeginPlay -> entrada 3025 (Delay 5 s) -> 15: GS.InitLootZones(self) e, so no servidor, UMA vez:
//     183: para cada LootPoint_C que encosta na esfera -> LootPoint.QuestList[quest] += SpawnChance;
//     depois de Delay 10 s: BP_ZombieSpawner_C / BP_CarWithZombie_C que encostam -> SetLinkedQuests(Quests).
//   No host headless o mapa (World Partition) ainda esta carregando 5 s depois do BeginPlay da zona: nenhum bau encosta, e
//   NENHUM LootPoint recebe QuestList -> o servidor nunca sorteia item de quest.
// Correcao: espera o mapa estabilizar (mesma contagem de zonas e de LootPoints em 3 varreduras seguidas, a cada 6 s) e, na thread do
// jogo (TickFlush), chama ExecuteUbergraph_BP_QuestItemsSpawnZone(EntryPoint=183) UMA vez por zona. Prefixo [qfix].
// v2 (12/11): medido na VPS: este script era o maior culpado do atraso do host (tick 16-21 -> 28-34 q/s sem ele). A varredura da
// GObjects (140 mil objetos, em JS, a cada 6 s, para sempre) travava a thread do Frida e, com ela, o gancho do TickFlush. Agora a
// varredura roda em C, DENTRO do gancho do TickFlush (thread do jogo, sem corrida com a criacao/destruicao de objetos, ~1 ms) e o
// JS so le o resultado. O gancho e nativo: so chama o JS quando ha zona na fila.
(function () {
'use strict';
const B = Process.getModuleByName('TheDayBefore.exe').base;
function log(m) { send({ tdb: '[qfix] ' + m }); }
const pool = B.add(0x7c27980);
function fn(i) { try { const b = pool.add(0x10).add((i >>> 16) * 8).readPointer(); const e = b.add((i & 0xffff) * 2); const h = e.readU16(); const l = h >>> 6; return (h & 1) ? e.add(2).readUtf16String(l) : e.add(2).readUtf8String(l); } catch (x) { return '?'; } }
function nome(o) { try { return fn(o.add(0x18).readU32()); } catch (e) { return '?'; } }
function classe(o) { try { return nome(o.add(0x10).readPointer()); } catch (e) { return '?'; } }
function findFName(alvo) {   // indice do FName no pool (mesmo metodo do listen_nativo.js)
  for (let block = 0; block < 512; block++) {
    const bp = pool.add(0x10).add(block * 8).readPointer();
    if (bp.isNull()) break;
    let units = 0;
    while (units < 65536) {
      const entry = bp.add(units * 2), header = entry.readU16(), wide = (header & 1) !== 0, len = header >>> 6;
      if (len <= 0 || len > 1024) break;
      if (len === alvo.length) { let s = null; try { s = wide ? entry.add(2).readUtf16String(len) : entry.add(2).readUtf8String(len); } catch (e) {} if (s === alvo) return ((block << 16) | units) >>> 0; }
      units += ((2 + len * (wide ? 2 : 1)) + 1) >> 1;
    }
  }
  return -1;
}
const processEvent = new NativeFunction(B.add(0x24077b0), 'void', ['pointer', 'pointer', 'pointer']);
const ENTRADA_BAUS = 183;          // ExecuteUbergraph_BP_QuestItemsSpawnZone: inicio do laco dos LootPoints (depois do InitLootZones)
const QUESTLIST = 0x460;           // AMPMainContainerBox_C.QuestList (TMap<UQuest*, double>); +8 = numero de elementos
const MORTO = (1 << 28) | (1 << 29) | (1 << 21);
const parms = Memory.alloc(16);
globalThis.__tdbQuestFix = { parms };

// bloco de comunicacao JS <-> C (slots de 8 bytes): 0 pedido de varredura | 1 pronto | 2 fila de zonas pendente | 3 GObjects.objs |
// 4 num | 5 nch | 6 idx FName da zona | 7 idx FName do LootPoint | 8 mascara de mortos | 9 offset QuestList | 10 nZonas | 11 nLoot | 12 comLista
const blk = Memory.alloc(16 * 8); for (let i = 0; i < 16; i++) blk.add(i * 8).writeU64(0);
const zon = Memory.alloc(512 * 8);
let fUber = null, fila = [], feitas = new Set(), ultimo = '', iguais = 0, rodadas = 0;
let idxZ = -1, idxL = -1, esperandoRes = false, querResultado = false, proxima = 0, ocupadoAte = 0;

const processar = new NativeCallback(function () {   // thread do jogo, so quando ha zona na fila
  try {
    for (let n = 0; n < 4 && fila.length; n++) {
      const z = fila.shift(); const k = z.toString();
      if (feitas.has(k)) continue;
      feitas.add(k);
      try {
        if (classe(z) !== 'BP_QuestItemsSpawnZone_C') continue;   // destruida entre a varredura e agora
        parms.writeS32(ENTRADA_BAUS);
        processEvent(z, fUber, parms);
      } catch (e) { log('erro na zona ' + z + ': ' + e); }
    }
  } catch (e) { log('erro processando: ' + e); }
  if (!fila.length) blk.add(16).writeS32(0);
}, 'void', []);

const cm = new CModule(`
#include <gum/guminterceptor.h>
#include <stdint.h>
extern void processar (void);
extern uint64_t blk[16];
extern uint64_t zon[512];
static void varrer (void)
{
  uint64_t ** objs = (uint64_t **) blk[3];
  int num = (int) blk[4], nch = (int) blk[5], morto = (int) blk[8], offq = (int) blk[9];
  uint32_t idxZ = (uint32_t) blk[6], idxL = (uint32_t) blk[7];
  int nz = 0, loot = 0, cl = 0, i;
  for (i = 0; i < num; i++)
  {
    int ch = i >> 16;
    uint8_t * chunk, * it, * o, * cls;
    uint32_t ci;
    if (ch >= nch) break;
    chunk = (uint8_t *) objs[ch];
    if (chunk == 0) continue;
    it = chunk + (uint64_t) (i & 0xffff) * 0x18;
    o = *(uint8_t **) it;
    if (o == 0) continue;
    if (*(int *) (it + 8) & morto) continue;      /* ja morto/lixo */
    if (*(int *) (o + 8) & 0x10) continue;        /* RF_ClassDefaultObject (Default__...) */
    cls = *(uint8_t **) (o + 0x10);
    if (cls == 0) continue;
    ci = *(uint32_t *) (cls + 0x18);
    if (ci == idxZ) { if (nz < 512) zon[nz] = (uint64_t) o; nz++; }
    else if (ci == idxL) { loot++; if (*(int *) (o + offq + 8) > 0) cl++; }
  }
  blk[10] = (uint64_t) nz; blk[11] = (uint64_t) loot; blk[12] = (uint64_t) cl;
}
void onEnter (GumInvocationContext * ic)
{
  if (blk[0]) { varrer (); blk[0] = 0; blk[1] = 1; }
  if (blk[2]) processar ();
}
`, { processar, blk, zon });
Interceptor.attach(B.add(0x42f3650), cm);   // UNetDriver::TickFlush (thread do jogo)

function acharUber(zona) {
  let cls = zona.add(0x10).readPointer();
  for (let n = 0; n < 4 && !cls.isNull(); n++) { let x = cls.add(0x48).readPointer(); for (let k = 0; k < 2000 && !x.isNull(); k++) { if (nome(x) === 'ExecuteUbergraph_BP_QuestItemsSpawnZone') return x; x = x.add(0x28).readPointer(); } cls = cls.add(0x40).readPointer(); }
  return ptr(0);
}
function pedir() {
  const g = B.add(0x7ccda10);
  blk.add(24).writePointer(g.readPointer()); blk.add(32).writeU64(g.add(0x14).readS32()); blk.add(40).writeU64(g.add(0x1c).readS32());
  blk.add(48).writeU64(idxZ); blk.add(56).writeU64(idxL); blk.add(64).writeU64(MORTO); blk.add(72).writeU64(QUESTLIST);
  blk.add(8).writeU64(0); blk.add(0).writeU64(1); esperandoRes = true;
}
function consumir() {
  const nz = blk.add(80).readS32(), loot = blk.add(88).readS32(), comLista = blk.add(96).readS32();
  if (querResultado) { querResultado = false; log('RESULTADO: LootPoints com QuestList: ' + comLista + ' de ' + loot + ' (zonas processadas: ' + feitas.size + ')'); return; }
  const zonas = []; for (let i = 0; i < nz && i < 512; i++) zonas.push(zon.add(i * 8).readPointer());
  const chave = nz + '/' + loot;
  if (chave === ultimo) iguais++; else { iguais = 1; ultimo = chave; }
  const novas = zonas.filter(z => !feitas.has(z.toString()));
  if (iguais < 3 || loot < 100 || novas.length === 0) {
    if (rodadas === 0 && iguais <= 3) log('esperando o mapa estabilizar: zonas=' + nz + ' LootPoints=' + loot + ' (estavel ' + iguais + '/3)');
    return;
  }
  if (fUber === null) { fUber = acharUber(novas[0]); log(fUber.isNull() ? 'ERRO: ExecuteUbergraph_BP_QuestItemsSpawnZone nao achada' : 'funcao ' + fUber); }
  if (fUber.isNull()) return;
  rodadas++;
  log('mapa estavel (zonas=' + nz + ', LootPoints=' + loot + ', com QuestList=' + comLista + '): preenchendo baus de ' + novas.length + ' zona(s)');
  fila = novas.slice(); blk.add(16).writeS32(1);
  ocupadoAte = Date.now() + 25000;   // depois disso, uma varredura para o log de RESULTADO
}
setInterval(function () {   // JS leve: 1x por segundo
  try {
    const agora = Date.now();
    if (esperandoRes) { if (blk.add(8).readS32() === 1) { esperandoRes = false; blk.add(8).writeU64(0); consumir(); } return; }
    if (ocupadoAte) { if (agora >= ocupadoAte) { ocupadoAte = 0; querResultado = true; pedir(); } return; }
    if (fila.length || agora < proxima) return;
    proxima = agora + 6000;
    if (idxZ < 0) idxZ = findFName('BP_QuestItemsSpawnZone_C');
    if (idxL < 0) idxL = findFName('LootPoint_C');
    if (idxZ < 0 || idxL < 0) return;    // o Blueprint ainda nao carregou
    pedir();
  } catch (e) { log('erro no ciclo: ' + e); }
}, 1000);
log('pronto: itens de quest (varredura em C no TickFlush; preenche QuestList dos baus quando o mapa estabilizar)');
})();
