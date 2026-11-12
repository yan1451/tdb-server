// listen_nativo.js (2026-11-05) - recria UWorld::Listen no host, na ordem da fonte UE 5.2 (World.cpp:6319-6390).
// O exe foi compilado sem codigo de servidor: UWorld::Listen virou `xor al,al; ret` (0x1409cfc70).
// Este script chama, na thread do jogo (dentro de UWorld::Tick), as funcoes que EXISTEM no exe:
//   CreateNetDriver_Local -> world->NetDriver -> driver->SetWorld(world) -> colecoes SetNetDriver -> InitListen(Notify=world)
// e aplica 1 patch de 1 byte: UWorld::InternalGetNetMode devolve 2 (ListenServer) em vez de 3 (Client) quando ha NetDriver.
// Nao faz replicacao de atores (etapa 5). So mede o que o lado servidor nativo faz com o cliente.
// Enderecos verificados no Ghidra em 05/11 (ver APRENDIZADO_TDB_2026-11-05_exe_sem_codigo_servidor.md).
(function () {
'use strict';
const main = Process.getModuleByName('TheDayBefore.exe');
const B = main.base;
function log(m) { send({ tdb: '[lnat] ' + m }); }

const RVA = {
  fnamePool: 0x7c27980,          // FNamePool (blocos em +0x10)
  gEngine: 0x7e20ea8,            // GEngine
  worldTick: 0x40d5230,          // UWorld::Tick (thread do jogo)
  createNetDriverLocal: 0x4683f90, // CreateNetDriver_Local(Engine, Context, Definition, Name)
  setWorld: 0x42f1370,           // UNetDriver::SetWorld (vtable +0x3e8)
  initListen: 0xc381f0,          // UIpNetDriver::InitListen (vtable +0x2d8)
  tickDispatch: 0xc4e380,        // UIpNetDriver::TickDispatch (vtable +0x348)
  worldNetMode: 0x470b920,       // UWorld::InternalGetNetMode
  netModeMov: 0x470b933,         // `mov eax,3` (b8 03 00 00 00) no ramo "tem NetDriver"
  notifyControlMessage: 0x470c950, // UWorld::NotifyControlMessage (this = world+0x28)
  sendChallenge: 0x42ed4c0,      // UNetConnection::SendChallengeControlMessage
  welcomePlayer: 0x471bc40,      // UWorld::WelcomePlayer
  spawnPlayActor: 0x4254d90,     // UWorld::SpawnPlayActor
  replicateActor: 0x402ec70,     // UActorChannel::ReplicateActor (so contagem)
};
const OFF = {
  worldNetDriver: 0x38, worldGameMode: 0x150, worldNotify: 0x28,
  worldCollections: 0x180, worldCollectionsNum: 0x188, collStride: 0x78, collNetDriver: 0x10,
  drvWorld: 0x150, drvServerConn: 0x98, drvNotify: 0x230, drvName: 0x1a8,
  engDefs: 0xe70, engDefsNum: 0xe78, defStride: 0x1c,
  engWorldList: 0xec0, engWorldListNum: 0xec8, ctxWorld: 0x2c0, ctxActiveDrivers: 0x210,
  vtSetWorld: 0x3e8, vtInitListen: 0x2d8, vtTickDispatch: 0x348,
  objClass: 0x10, objName: 0x18,
};
const PORTA = 7777;
const ESPERA_TICKS = 600;   // ticks do mundo do TDB_GameMode antes de abrir o listen (~10 s)
const NMT = {0:'Hello',1:'Welcome',2:'Upgrade',3:'Challenge',4:'Netspeed',5:'Login',6:'Failure',9:'Join',10:'JoinSplit',
  12:'Skip',13:'Abort',15:'PCSwap',16:'ActorChannelFailure',17:'DebugText',18:'NetGUIDAssign',19:'SecurityViolation',
  20:'GameSpecific',21:'EncryptionAck',22:'DestructionInfo',23:'CloseReason',24:'NetPing'};

// ---------- FName ----------
const fnamePool = B.add(RVA.fnamePool);
function findFName(target) {
  for (let block = 0; block < 512; block++) {
    const blockPtr = fnamePool.add(0x10).add(block * 8).readPointer();
    if (blockPtr.isNull()) break;
    let units = 0;
    while (units < 65536) {
      const entry = blockPtr.add(units * 2);
      const header = entry.readU16();
      const isWide = (header & 1) !== 0;
      const len = header >>> 6;
      if (len <= 0 || len > 1024) break;
      if (len === target.length) {
        let s = null;
        try { s = isWide ? entry.add(2).readUtf16String(len) : entry.add(2).readUtf8String(len); } catch (e) {}
        if (s === target) return ((block << 16) | units) >>> 0;
      }
      units += ((2 + len * (isWide ? 2 : 1)) + 1) >> 1;
    }
  }
  return -1;
}
function fnameStr(idx) {
  try {
    const blockPtr = fnamePool.add(0x10).add((idx >>> 16) * 8).readPointer();
    const entry = blockPtr.add((idx & 0xffff) * 2);
    const header = entry.readU16();
    const len = header >>> 6;
    return (header & 1) ? entry.add(2).readUtf16String(len) : entry.add(2).readUtf8String(len);
  } catch (e) { return '?' + idx; }
}
function nomeObj(o) {
  try { return fnameStr(o.add(OFF.objName).readU32()); } catch (e) { return '?'; }
}
function nomeClasse(o) {
  try { return fnameStr(o.add(OFF.objClass).readPointer().add(OFF.objName).readU32()); } catch (e) { return '?'; }
}

// ---------- estado ----------
let idxGameNetDriver = -1, idxTdbGm = -1, idxWorld = -1;
let alvo = null;          // mundo do TDB_GameMode
let ticksAlvo = 0;
let feito = false, falhou = false;
let drv = ptr(0);
const guarda = [];        // memoria alocada que precisa viver (FURL, FString)
let nTick = 0, nReplicate = 0, tentFName = 0;
const closeHooked = {};

function patchNetMode() {
  const p = B.add(RVA.netModeMov);
  const b = p.readByteArray(5);
  const u = new Uint8Array(b);
  if (u[0] === 0xb8 && u[1] === 0x02) { log('patch NetMode ja aplicado'); return true; }
  if (u[0] === 0xb8 && u[1] === 0x01) { log('NetMode ja em 1 (modo_dedicado.js): mantido'); return true; }
  if (!(u[0] === 0xb8 && u[1] === 0x03 && u[2] === 0 && u[3] === 0 && u[4] === 0)) {
    log('patch NetMode ABORTADO: bytes inesperados ' + Array.from(u).map(x => x.toString(16)).join(' '));
    return false;
  }
  Memory.protect(p, 8, 'rwx');
  p.add(1).writeU8(0x02);
  Memory.protect(p, 8, 'r-x');
  log('patch NetMode aplicado: InternalGetNetMode devolve 2 (ListenServer) com NetDriver');
  return true;
}

function acharContexto(eng, world) {
  const arr = eng.add(OFF.engWorldList).readPointer();
  const n = eng.add(OFF.engWorldListNum).readS32();
  for (let i = 0; i < n && i < 16; i++) {
    const ctx = arr.add(i * 8).readPointer();
    if (!ctx.isNull() && ctx.add(offMundo).readPointer().equals(world)) return ctx;
  }
  return ptr(0);
}

function listen(world) {
  feito = true;
  try {
    const eng = B.add(RVA.gEngine).readPointer();
    const ctx = acharContexto(eng, world);
    log('listen: world=' + world + ' (' + nomeObj(world) + ') ctx=' + ctx + ' GameMode=' + nomeClasse(world.add(OFF.worldGameMode).readPointer()));
    if (ctx.isNull()) { falhou = true; log('ABORTADO: contexto do mundo nao achado (ctx+0x2c0)'); return; }
    if (idxGameNetDriver < 0) { falhou = true; log('ABORTADO: FName GameNetDriver nao achado'); return; }
    const gnd = uint64(idxGameNetDriver);   // FName {ComparisonIndex, Number=0}
    // a definicao GameNetDriver precisa existir em Engine->NetDriverDefinitions
    const defs = eng.add(OFF.engDefs).readPointer(), nd = eng.add(OFF.engDefsNum).readS32();
    let defOk = false; const nomes = [];
    for (let i = 0; i < nd && i < 32; i++) {
      const e = defs.add(i * OFF.defStride);
      nomes.push(fnameStr(e.readU32()));
      if (e.readU32() === idxGameNetDriver && e.add(4).readU32() === 0) defOk = true;
    }
    log('definicoes de NetDriver: ' + nomes.join(', ') + ' | GameNetDriver ' + (defOk ? 'OK' : 'AUSENTE'));
    if (!defOk) { falhou = true; log('ABORTADO: definicao GameNetDriver ausente'); return; }
    if (!patchNetMode()) { falhou = true; return; }

    // 1) GEngine->CreateNamedNetDriver(this, NAME_GameNetDriver, NAME_GameNetDriver)
    const criar = new NativeFunction(B.add(RVA.createNetDriverLocal), 'pointer', ['pointer', 'pointer', 'uint64', 'uint64']);
    drv = criar(eng, ctx, gnd, gnd);
    log('1 CreateNetDriver_Local -> ' + drv + (drv.isNull() ? '' : ' classe=' + nomeClasse(drv) + ' nome=' + fnameStr(drv.add(OFF.drvName).readU32())));
    if (drv.isNull()) { falhou = true; log('ABORTADO: driver nao criado'); return; }
    const vt = drv.readPointer();
    const fSetWorld = vt.add(OFF.vtSetWorld).readPointer(), fInit = vt.add(OFF.vtInitListen).readPointer();
    log('vtable ' + vt.sub(B) + ' SetWorld=' + fSetWorld.sub(B) + ' InitListen=' + fInit.sub(B));
    if (!fSetWorld.equals(B.add(RVA.setWorld)) || !fInit.equals(B.add(RVA.initListen))) {
      falhou = true; log('ABORTADO: vtable nao e a do UIpNetDriver esperado'); return;
    }
    // 2) NetDriver = FindNamedNetDriver(...)
    world.add(OFF.worldNetDriver).writePointer(drv);
    // 3) NetDriver->SetWorld(this): World, WorldPackage, Notify=world+0x28, ticks no mundo, lista de objetos de rede
    new NativeFunction(fSetWorld, 'void', ['pointer', 'pointer'])(drv, world);
    log('3 SetWorld: drv+0x150=' + drv.add(OFF.drvWorld).readPointer() + ' Notify(drv+0x230)=' + drv.add(OFF.drvNotify).readPointer() +
        ' (esperado ' + world.add(OFF.worldNotify) + ')');
    // 4) colecoes DynamicSourceLevels (0) e StaticLevels (2) -> SetNetDriver
    const arr = world.add(OFF.worldCollections).readPointer(), nc = world.add(OFF.worldCollectionsNum).readS32();
    const tipos = [];
    for (let i = 0; i < nc && i < 8; i++) {
      const c = arr.add(i * OFF.collStride);
      const t = c.readU8(); tipos.push(t);
      if (t === 0 || t === 2) c.add(OFF.collNetDriver).writePointer(drv);
    }
    log('4 colecoes: n=' + nc + ' tipos=[' + tipos.join(',') + '] (0 e 2 recebem o driver)');
    // 5) NetDriver->InitListen(this, InURL, false, Error)
    const url = Memory.alloc(0x68); guarda.push(url);   // FURL zerado: Protocol,Host,Port(+0x20),Valid(+0x24),Map,Redirect,Op,Portal
    url.add(0x20).writeS32(PORTA); url.add(0x24).writeS32(1);
    const err = Memory.alloc(0x10); guarda.push(err);
    const ok = new NativeFunction(fInit, 'uint8', ['pointer', 'pointer', 'pointer', 'uint8', 'pointer'])(drv, world.add(OFF.worldNotify), url, 0, err);
    let errTxt = '';
    try { const p = err.readPointer(); if (!p.isNull()) errTxt = p.readUtf16String(); } catch (e) {}
    log('5 InitListen -> ' + ok + ' porta=' + url.add(0x20).readS32() + (errTxt ? ' erro=' + errTxt : ''));
    if (!ok) {
      falhou = true;
      world.add(OFF.worldNetDriver).writePointer(ptr(0));
      for (let i = 0; i < nc && i < 8; i++) { const c = arr.add(i * OFF.collStride); const t = c.readU8(); if (t === 0 || t === 2) c.add(OFF.collNetDriver).writePointer(ptr(0)); }
      log('InitListen falhou: world->NetDriver e colecoes desfeitos (driver fica orfao no contexto)');
      return;
    }
    log('LISTEN OK: ServerConnection(drv+0x98)=' + drv.add(OFF.drvServerConn).readPointer() + ' world+0x38=' + world.add(OFF.worldNetDriver).readPointer());
  } catch (e) {
    falhou = true; log('ERRO no listen: ' + e + ' ' + (e.stack || ''));
  }
}

// ---------- mundo atual: GEngine->WorldList[0] (+0x2c0), conferido pela classe 'World' ----------
let offMundo = OFF.ctxWorld;
function classeIdx(o) { return o.add(OFF.objClass).readPointer().add(OFF.objName).readU32(); }
function ehMundo(p) {
  try { return !p.isNull() && p.compare(ptr('0x10000')) > 0 && classeIdx(p) === idxWorld; } catch (e) { return false; }
}
function mundoAtual() {
  const eng = B.add(RVA.gEngine).readPointer();
  if (eng.isNull() || eng.add(OFF.engWorldListNum).readS32() < 1) return null;
  const ctx = eng.add(OFF.engWorldList).readPointer().readPointer();
  if (ctx.isNull()) return null;
  let w = ctx.add(offMundo).readPointer();
  if (ehMundo(w)) return w;
  for (let o = 0x20; o <= 0x400; o += 8) {      // reserva: varre o contexto como o host_flow
    let p; try { p = ctx.add(o).readPointer(); } catch (e) { continue; }
    if (ehMundo(p)) { if (o !== offMundo) log('mundo achado em ctx+0x' + o.toString(16) + ' (esperado 0x' + offMundo.toString(16) + ')'); offMundo = o; return p; }
  }
  return null;
}

// ---------- gatilho na thread do jogo (UWorld::Tick usado so como relogio) ----------
let errosGatilho = 0, ltMundo = null;
// 12/11: o gancho em JS custa uma chamada por quadro; depois do listen ele nao faz mais nada, entao se solta sozinho.
ltMundo = Interceptor.attach(B.add(RVA.worldTick), {
  onEnter() {
    if (feito) { if (ltMundo) { const l = ltMundo; ltMundo = null; setTimeout(function () { try { l.detach(); log('gancho do relogio do mundo solto (listen ja aberto)'); } catch (e) {} }, 0); } return; }
    try {
      if (idxGameNetDriver < 0 || idxTdbGm < 0 || idxWorld < 0) {   // FNames so existem depois que o motor/Blueprints carregam
        if (++tentFName % 300 !== 0) return;
        if (idxGameNetDriver < 0) idxGameNetDriver = findFName('GameNetDriver');
        if (idxWorld < 0) idxWorld = findFName('World');
        if (idxTdbGm < 0) idxTdbGm = findFName('TDB_GameMode_C');
        log('FNames: GameNetDriver=' + idxGameNetDriver + ' World=' + idxWorld + ' TDB_GameMode_C=' + idxTdbGm);
        return;
      }
      const world = mundoAtual();
      if (world === null) return;
      const gm = world.add(OFF.worldGameMode).readPointer();
      if (gm.isNull() || classeIdx(gm) !== idxTdbGm) return;
      if (alvo === null || !alvo.equals(world)) { alvo = world; ticksAlvo = 0; log('mundo do TDB_GameMode visto: ' + world + ' (' + nomeObj(world) + ')'); }
      if (!world.add(OFF.worldNetDriver).readPointer().isNull()) { feito = true; log('mundo ja tem NetDriver (' + world.add(OFF.worldNetDriver).readPointer() + '); nada a fazer'); return; }
      ticksAlvo++;
      if (ticksAlvo === ESPERA_TICKS) listen(world);
    } catch (e) {
      errosGatilho++;
      if (errosGatilho <= 5) log('erro no gatilho (#' + errosGatilho + ', tick ignorado): ' + e);
      if (errosGatilho >= 200) { feito = true; falhou = true; log('gatilho desligado: erros demais'); }
    }
  }
});

// ---------- medicoes (somente leitura) ----------
// 12/11: contador em C (antes: um gancho JS por chamada); o JS so le o valor 1x por segundo
const tdBuf = Memory.alloc(16); tdBuf.writeU64(0); tdBuf.add(8).writeU64(0);
const cmTD = new CModule(`
#include <gum/guminterceptor.h>
#include <stdint.h>
extern uint64_t tdBuf[2];
void onEnter (GumInvocationContext * ic)
{
  if (tdBuf[0] != 0 && (uint64_t) gum_invocation_context_get_nth_argument (ic, 0) == tdBuf[0]) tdBuf[1]++;
}
`, { tdBuf });
Interceptor.attach(B.add(RVA.tickDispatch), cmTD);
let tdLog = 0;
setInterval(function () {
  try {
    if (drv.isNull()) return;
    if (tdBuf.readU64().toNumber() === 0) tdBuf.writePointer(drv);
    nTick = tdBuf.add(8).readU64().toNumber();
    if (nTick >= 1 && (tdLog === 0 || nTick - tdLog >= 600)) { tdLog = nTick; log('TickDispatch do listen: ' + nTick); }
  } catch (e) {}
}, 1000);
Interceptor.attach(B.add(RVA.notifyControlMessage), {
  onEnter(args) {
    try {
      if (alvo === null || !args[0].equals(alvo.add(OFF.worldNotify))) return;
      const conn = args[1];
      const t = args[2].toInt32() & 0xff;
      log('NotifyControlMessage: ' + (NMT[t] || ('NMT_' + t)) + ' conn=' + conn);
      hookClose(conn);
    } catch (e) {}
  }
});
Interceptor.attach(B.add(RVA.sendChallenge), { onEnter(args) { log('-> SendChallengeControlMessage conn=' + args[0]); } });
Interceptor.attach(B.add(RVA.welcomePlayer), { onEnter(args) { if (alvo && args[0].equals(alvo)) log('-> WelcomePlayer conn=' + args[1]); } });
Interceptor.attach(B.add(RVA.spawnPlayActor), {
  onEnter(args) { this.meu = alvo !== null && args[0].equals(alvo); this.role = args[2].toInt32(); },
  onLeave(ret) {
    if (!this.meu) return;
    log('-> SpawnPlayActor(role=' + this.role + ') = ' + ret + (ret.isNull() ? ' (FALHOU: GameMode->Login recusou)' : ' classe=' + nomeClasse(ret)));
  }
});
// 06/11 (modo leve): o contador de ReplicateActor era um hook JS em cada ator replicado; desligado com HOST_LEVE.
if (typeof HOST_LEVE === 'undefined' || !HOST_LEVE) Interceptor.attach(B.add(RVA.replicateActor), { onEnter() { nReplicate++; if (nReplicate === 1 || nReplicate % 500 === 0) log('ReplicateActor chamado (total ' + nReplicate + ')'); } });
function hookClose(conn) {
  try {
    const k = conn.toString();
    if (closeHooked[k]) return;
    closeHooked[k] = true;
    const fClose = conn.readPointer().add(0x3d8).readPointer();
    log('conexao ' + conn + ' classe=' + nomeClasse(conn) + ' Close=' + fClose.sub(B));
    Interceptor.attach(fClose, { onEnter(args) { if (args[0].equals(conn)) log('!!! Close na conexao ' + conn + ' (de rva ' + this.returnAddress.sub(B) + ')'); } });
  } catch (e) { log('hookClose erro ' + e); }
}

log('pronto (FNames serao buscados no tick); espera=' + ESPERA_TICKS + ' ticks; porta=' + PORTA);
})();
