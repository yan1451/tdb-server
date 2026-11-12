// v71: log silencioso + fila cmd_<id>.json + monitor off
/**
 * Host-flow v6.8 (v6.6 + TRACE de teleport/cutscene/missao) (offline LAN helper): ProcessEvent + F10 host/spawn.
 *
 *   python attach_host.py attach <PID>
 *
 * SPACE â€” abre Server Browser (NAO e o menu ESC)
 * ESC   â€” pause: Continue / Settings / Quit (sem entrada Server)
 * F10   â€” StartLevel / CreateSession / Restart* (0-arg only)
 * F12   â€” PrepareServerList se ParmsSize==0 (refresh lista)
 * F11   â€” re-descobrir ProcessEvent
 *
 * NUNCA ProcessEvent: SetSpawnRegion / JoinToServer / InitClient
 * (ParmsSize mislido como 0 â†’ AV 0x0 / caminho BE online).
 */
'use strict';

var QUIET_LOG = /^(DIAG_Z|MONITOR|ANIMSM|ANIMSMHDR|ANIMTRANS|ANIMPROBE|DIAG_UI)/;
function log(msg) {
  if (QUIET_LOG.test(String(msg))) return; // v71: reduz ruido do log
  console.log('[host-flow] ' + msg);
  try {
    send({ tdb: '[host-flow] ' + msg });
  } catch (e) {}
}

let main = null;
Process.enumerateModules().forEach(function (m) {
  if (m.name.toLowerCase() === 'thedaybefore.exe') main = m;
});
// [teste] Browse retorno 2 -> 1 dentro do host_flow (copia): evita voltar ao menu
function instalarBrowseHook() {   // 06/11: em funcao para ser reinstalado depois do Interceptor.detachAll() do modo leve
Interceptor.attach(main.base.add(0x467e880), { onEnter: function (a) { try { send({ tdb: '[hf] Browse CALL from rva=' + this.returnAddress.sub(main.base).toString() }); } catch (e) {} }, onLeave: function (r) { try { const v = r.toInt32(); send({ tdb: '[hf] Browse RET=' + v }); if (v === 2) { r.replace(ptr(1)); send({ tdb: '[hf] Browse 2->1 forcado' }); } } catch (e) {} } });
}
instalarBrowseHook();

if (!main) {
  log('TheDayBefore.exe nao encontrado');
} else {
  const gEngineSlot = main.base.add(0x7e20ea8);
  const tickAddress = main.base.add(0x40d5230);
  // WATCH_HOOK (diagnostico, sem mudar comportamento): conta chamadas de WatchGameServer (RVA 0x171a110) e o caller.
  const watchGsAddr = main.base.add(0x171a110);
  let watchGsHits = 0;
  try {
    Interceptor.attach(watchGsAddr, {
      onEnter: function () {
        watchGsHits++;
        if (watchGsHits <= 10) {
          log(
            'WATCH_HIT #' +
              watchGsHits +
              ' caller_rva=' +
              this.returnAddress.sub(main.base) +
              ' this=' +
              this.context.rcx
          );
        }
      },
    });
    log('WATCH_HOOK instalado em ' + watchGsAddr);
  } catch (eWatch) {
    log('WATCH_HOOK erro ' + eWatch);
  }
  const fnamePool = main.base.add(0x7c27980);
  const peKnown = main.base.add(0x24077b0); // ProcessEvent RVA (UE shipping)

  // v6.5 = v6.4 + modo 'camera' no seq99 (SetViewTarget no pawn A durante o loading, espera OnLevelShown, depois EndLoadingScreen+Close) + contador OnLevelShown.
  // v6.4 = v6.3 + comando manual 'seq99' (sequencia de saida do loading de 99%, NAO automatica: so roda quando o cmd.json pedir).
  // v6.3 = v6.2 + alvos 'bs'/'ptr:' + LSBS. v6.2 (SOMENTE LEITURA): hooks nativos para descobrir o nome do nivel do terreno e quem muda o ViewTarget.
  // Chamadas feitas por Blueprint (EX_CallMath) nao passam pelo ProcessEvent, por isso hook direto nas funcoes nativas.
  var v62Budget = { lsl: 60, lli: 60, svt: 150, pe: 120 };
  function v62Bt(ctx) {
    try {
      return Thread.backtrace(ctx, Backtracer.ACCURATE).slice(0, 10).map(function (a) {
        return '+0x' + a.sub(main.base).toString(16);
      }).join(' ');
    } catch (e) { return 'bt?'; }
  }
  try {
    // UGameplayStatics::LoadStreamLevel(WorldContext, FName LevelName, bool bMakeVisible, bool bBlock, FLatentActionInfo)
    Interceptor.attach(main.base.add(0x410be50), {
      onEnter: function (args) {
        if (v62Budget.lsl-- <= 0) return;
        let nm = '?';
        try {
          const idx = args[1].toInt32() >>> 0;
          const num = parseInt(args[1].shr(32).toString(), 16) || 0;
          nm = (readFNameEntry(idx) || ('idx' + idx)) + (num ? '_' + (num - 1) : '');
        } catch (e) {}
        let ctxName = '?';
        try { ctxName = objectName(args[0]); } catch (e) {}
        log('V62_LOADSTREAMLEVEL ' + new Date().toISOString() + ' level=' + nm + ' ctx=' + ctxName +
          ' visible=' + (args[2].toInt32() & 0xff) + ' block=' + (args[3].toInt32() & 0xff) + ' bt=' + v62Bt(this.context));
      },
    });
    log('V62 hook LoadStreamLevel instalado');
  } catch (eV1) { log('V62 hook LoadStreamLevel erro ' + eV1); }
  try {
    // ULevelStreamingDynamic::LoadLevelInstance(WorldContext, FString* LevelName, ...)
    Interceptor.attach(main.base.add(0x42497d0), {
      onEnter: function (args) {
        if (v62Budget.lli-- <= 0) return;
        let nm = '?';
        try { nm = readFStringAt(args[1]); } catch (e) {}
        log('V62_LOADLEVELINSTANCE ' + new Date().toISOString() + ' level=' + nm + ' bt=' + v62Bt(this.context));
      },
    });
    log('V62 hook LoadLevelInstance instalado');
  } catch (eV2) { log('V62 hook LoadLevelInstance erro ' + eV2); }

  // SPAWNHOOK (so leitura): thunks de execBeginDeferredActorSpawnFromClass (RVA 0x41306d0) e execFinishSpawningActor (RVA 0x4133e60),
  // achados no Ghidra pela tabela de registro nativo (0x14696a4e0 e 0x14696a640). Assinatura confirmada pelo decompile:
  // Begin(ctx, frame, AActor* *result) e Finish(ctx, frame, AActor* *result). Nao altera argumentos nem retorno: so loga.
  try {
    Interceptor.attach(main.base.add(0x41306d0), {
      onEnter: function (args) {
        this.res = args[2];
        let cn = '?';
        try { cn = objectName(args[0]); } catch (e) {}
        log('SPAWNHOOK BeginDeferred ctx=' + args[0] + ' nome=' + cn);
      },
      onLeave: function (retval) {
        try {
          const a = this.res.readPointer();
          if (!a || a.isNull()) { log('SPAWNHOOK BeginDeferred ret=NULL'); return; }
          const cls = a.add(0x10).readPointer();
          log('SPAWNHOOK BeginDeferred ret=' + a + ' nome=' + objectName(a) + ' classe=' + (cls && !cls.isNull() ? objectName(cls) : '?'));
        } catch (eSB) { log('SPAWNHOOK BeginDeferred ret erro ' + eSB); }
      },
    });
    log('SPAWNHOOK BeginDeferred instalado');
  } catch (eSH1) { log('SPAWNHOOK BeginDeferred erro ' + eSH1); }
  try {
    Interceptor.attach(main.base.add(0x4133e60), {
      onEnter: function (args) {
        this.res = args[2];
        let cn = '?';
        try { cn = objectName(args[0]); } catch (e) {}
        log('SPAWNHOOK FinishSpawning ctx=' + args[0] + ' nome=' + cn);
      },
      onLeave: function (retval) {
        try {
          const a = this.res.readPointer();
          if (!a || a.isNull()) { log('SPAWNHOOK FinishSpawning ret=NULL'); return; }
          log('SPAWNHOOK FinishSpawning ret=' + a + ' nome=' + objectName(a));
        } catch (eSF) { log('SPAWNHOOK FinishSpawning ret erro ' + eSF); }
      },
    });
    log('SPAWNHOOK FinishSpawning instalado');
  } catch (eSH2) { log('SPAWNHOOK FinishSpawning erro ' + eSH2); }

  // Keep in cache (not all are safe to call).
  // TRACE v6.8 (somente leitura): quais funcoes registrar e orcamento de linhas.
  const TRACE_RE = /^(CT_|Cutscene|LoadingScreen|EndLoadingScreen|EnteredWorld|EnterRoom|ShowBanner|ShowLocationNotification|TeleportToSpawnPoint|TeleportAt|Serv_TeleportAt|MC_TeleportAt|RequireTeleportToRegion|TeleportToRegion|On ?Black ?Screen ?Opened|OnLocalInteract|OnInteract|OnBeginInteract|OnStopInteract|HouseEnter|HouseLeave|OnSaveHouse|OnLoadHouse|OnTutorStageUpdated|SetPlayerIsLoading|OnStartEndLoadingScreen|StartInitial|StopInitial|SkyScene|DisableInput|EnableInput|ServerSetPlayerInCutscene|ServSetLocInCutscene|OnStartCutscene|OnFinished|OnCutsceneEnded|ChangeIcon|Garage|GroupTeleport|ExitToRaid|HidePlayers|ActionInputs|SetAfterRaid|Phasing|HiddenSync|.*Quest.*|.*Complet.*|ExecuteUbergraph_(PlayerCutsceneComponent|BP_HouseGateTeleport|BP_DoorTeleport|BP_TeleportToRegion))$/;
  const TRACE_SKIP = /Tick|GetActor|Overlap|Update|Timer|Anim|Footstep|Widget/;
  let traceBudget = 30000;
  function hexdumpShort(p, n) {
    let o = '';
    for (let i = 0; i < n; i++) { try { o += ('0' + p.add(i).readU8().toString(16)).slice(-2); } catch (e) { break; } }
    return o;
  }
  const INTEREST =
    /StartLevel|JoinToServer|SetSpawnRegion|SetServerAddress|ServerListByRegion|ServerListRearrange|AuthToServer|CreateSession|DestroySession|OpenLevel|RestartPlayer|SpawnDefaultPawn|ServerRestartPlayer|InitClient|HideLoadingScreenAfterLoadLevel|HideLoadingScreen|PrepareServerList|ServerTravel|HostGame|HostSession|ListenServer|ShowMouseCursor|SetShowMouseCursor|BndEvt_.*Server|ServerCategory|ServerScreen|OnButtonPressed|Server_Continue|Match|Lobby|DebugCreatePlayer|DebugRemovePlayer|HandleTravelError|GetPlayerController|OnRequestRestartClient|NewCharCreated|NewCharacterCreated|CharactedCreated|ServerLogined|ServerLogin|PlayerPlaceholder|SurvivalPlayer|FakeLogin|LoadCharacter|LoadCharacterInfo|LoadCharInit|LoadFromPlaceholder|OnCharacterLoaded|SaveCharacter|SaveCharacterInfo|IsNewCharacter|GetSaveCharsFromServer|Login|LoginCompleted|InitPlayer|PickPlayer|OnServerLogin|GetDefaultPawnClassForController|SpawnDefaultPawnFor|SpawnDefaultPawnAtTransform|K2_PostLogin|ClientRestart|ReceivePossess|ClientSetLocation|K2_SetActorLocation|K2_GetActorLocation|LoadPlayerPos|PickSpawnPoint|Possess|ServerPossess|SetViewTarget|SetViewTargetWithBlend|EnableInput|SetIgnoreMoveInput|SetIgnoreLookInput|SetActorHiddenInGame|SetMovementMode|AddMovementInput|SetHiddenInGame|SetVisibility|CancelFPS|SwitchToStanding|OnCharLoadMeshes|InitLocalPlayer|SaveMeshes|FullyLoad|SetUseControllerRotationYaw|SetUsePawnControlRotation|SetInputModeGameOnly|ResetIgnoreLookInput|ResetIgnoreMoveInput|SetLeaderPoseComponent|InpAxisEvt_MoveForward|InpAxisEvt_MoveRight|InpAxisEvt_Turn|InpAxisEvt_LookUp|AddControllerYawInput|AddControllerPitchInput/i;

  // Host/spawn preference order (exact names + variants via pickHostHits).
  // NEVER invoke JoinToServer / InitClient / SetSpawnRegion:
  //   JoinToServer = client-join / BattlEye path.
  //   InitClient = BEClient.
  //   SetSpawnRegion = PE null â†’ AV 0x0 (ParmsSize often misread).
  const invokeOrder = [
    'StartLevel',
    'CreateSession',
    'RestartPlayer',
    'RestartPlayerAtPlayerStart',
    'ServerRestartPlayer',
    'HostGame',
    'ServerTravel',
    'OpenLevel',
    'SpawnDefaultPawnFor',
    'SetServerAddress', // FString â€” ver invokeSetServerAddress
    'ServerListByRegion',
  ];
  const neverInvoke = {
    JoinToServer: true,
    InitClient: true,
    SetSpawnRegion: true,
    // ParmsSize mentiroso (=0) mas PE(null) â†’ AV 0x0
    DebugCreatePlayer: true,
    DebugRemovePlayer: true,
    AuthToServer: true,
    GetBEServerVersion: true,
    ServerListByRegion: true, // AV com null
  };
  // So estas podem ser chamadas com parms=null quando readParmsSize diz 0.
  const safeZeroArg = {
    PrepareServerList: true,
    ServerListRearrange: true,
    GetPlayerController: true,
    HandleTravelError: true,
    HideLoadingScreenAfterLoadLevel: true,
    NewCharCreated: true,
    NewCharacterCreated: true,
    CharactedCreated: true,
    FakeLogin: true,
    Login: true,
    LoginCompleted: true,
    LoadCharacter: true,
    LoadCharacterInfo: true,
    LoadCharInit: true,
    LoadFromPlaceholder: true,
    OnCharacterLoaded: true,
    SaveCharacter: true,
    SaveCharacterInfo: true,
    IsNewCharacter: true,
    GetSaveCharsFromServer: true,
    InitPlayer: true,
    PickPlayer: true,
    OnServerLogin: true,
    ServerLogin: true,
    PickSpawnPoint: true,
    ServerPickSpawnPoint: true,
    LoadPlayerPos: true,
    MoveStartPoint: true,
    HideLoadingScreen: true,
    // ClientSetLocation: ParmsSize mentiroso (=0) â€” chamar via rescueVoidZ com FVector double
    // ServerLogined / RestartPlayer: ParmsSize mentiroso â†’ AV â€” nao chamar zero-arg
  };
  // false = Placeholderâ†’Jumpâ†’V2 (caminho provado). true = forca DefaultPawn cedo demais.
  const FORCE_SURVIVAL_PAWN = false;
  // Jump live Script: ServerLogined@0x2399 -> PickPlayer@0x12AA (spawna SurvivalPlayer_V2)
  const ENTRY_SL = 0x2399;
  const ENTRY_PICK = 0x12aa;
  let survivalPawnClass = null;
  let defaultPawnForced = 0;
  let pendingHideLoading = false;
  let hideLoadingDone = false;
  let travelArmed = false;
  let travelDone = false;
  // true durante Browse/listen â€” PE em UObject do mundo antigo = Fatal world leaks
  let travelBusy = false;
  let hideLoadingQueued = false;
  let pendingOfflineSpawn = false;
  let offlineSpawnDone = false;
  let sawPlaceholder = false;
  let sawSurvivalPlayer = false;
  let placeholderObj = null;
  // Cache de UFunction por nome (preenchido pelo fnlayout; evita busca pesada de classes no call).
  const ufnCache = {};
  let survPcObj = null;
  let survPawnObj = null;
  let wpShownCount = 0;
  let landscapeShown = 0;
  let lvlLogBudget = 120;
  let wpLogBudget = 3000; // orcamento separado para eventos OnLevel de celulas NewCity_persistent_WP
  let wpSumLast = -1;
  let jumpPatched = false;
  let placeholderScript = null;
  let placeholderScriptNum = 0;
  let pendingPostSurvFix = false;
  let postSurvFixDone = false;
  let pendingPickAfterJump = false;
  let pendingRescueZ = false;
  let rescueVoidZAttempts = 0;
  const RESCUE_Z_MAX = 4;
  let softLiftZAttempts = 0;
  const SOFT_LIFT_Z_MAX = 40;
  let pendingMakePlayable = false;
  let makePlayableDone = false;
  let bodyApplyDone = false;
  let releaseDone = false;
  // Fases unicas (tudo no host_flow â€” NAO attach scripts mid-game):
  // IDLE â†’ TRAVEL â†’ STREAM â†’ WAIT_PAWN â†’ GROUND â†’ BODY â†’ RELEASE â†’ READY
  const PH = {
    IDLE: 0,
    TRAVEL: 1,
    STREAM: 2,
    WAIT_PAWN: 3,
    GROUND: 4,
    BODY: 5,
    RELEASE: 6,
    READY: 7,
  };
  let phase = PH.IDLE;
  let phaseSince = 0;
  // AUTOHUB: depois do READY, acha o spawn mais perto do hub e chama TeleportToSpawnPoint.
  let autoHubAt = 0;
  let autoHubDone = false;
  function setPhase(p, why) {
    if (phase === p) return;
    phase = p;
    phaseSince = Date.now();
    const names = [
      'IDLE',
      'TRAVEL',
      'STREAM',
      'WAIT_PAWN',
      'GROUND',
      'BODY',
      'RELEASE',
      'READY',
    ];
    log('PHASE -> ' + names[p] + ' (' + why + ')');
  }
  // BP recebe InpAxisEvt_Move*/Turn/LookUp mas nao aplica â€” bridges
  let moveBridgeOn = false;
  var MOVE_BRIDGE_OFF = false; // v82: desliga o empurrao do AddMovementInput
  let moveBridgeCount = 0;
  let lookBridgeOn = false;
  let lookBridgeCount = 0;
  let lookYawAccum = 0; // yaw sintetico (WASD + write mem)
  let lookPitchAccum = 0;
  let lookRotSeeded = false;
  // Experimento isolado: escrever ControlRotation no SurvPC (sem PE AddController*).
  // Z/chao NAO toca neste caminho.
  const LOOK_MEM_WRITE = true;
  let lookMemWriteOk = 0;
  let lookMemWriteFail = 0;
  let pcControlRotOff = -1; // offset Pitch float no SurvPC (Yaw=off+4, Roll=off+8)
  // DIAG M/Tab v2: foco em troca de modo de camera (tag nos parms), sem spam.
  const DIAG_UI_MODE = false;
  let peUiBudget = 300;
  let gpsUiBudget = 400; // GPS_SPAWN: orcamento proprio
  const peUiLast = {}; // "obj::name" -> ultimo log (dedupe 800ms)
  let lsTraceBudget = 600; // LSTRACE: quem reabre a tela de carregamento (somente log)
  const lsTraceLast = {}; // "obj::name" -> ultimo log (dedupe 250ms)
  // LSWIDE: janela larga (so log) aberta por 25s apos CMD call EndLoadingScreen/DelayNePashet.
  let lsWideUntil = 0;
  let lsWideBudget = 2500;
  let lsWorldAt = 0;
  const lsWideLast = {};
  // A3: enumerar UFunctions Camera do ATPCCamera/pawn/PC (so leitura, 1x no READY).
  const DIAG_ATPC_API = true;
  let atpcApiDone = false;
  function listCameraFuncs(obj, tag, nameRe) {
    if (!obj || obj.isNull()) return 0;
    const seen = {};
    let count = 0;
    let cls = null;
    try {
      cls = obj.add(0x10).readPointer();
    } catch (e) {
      return 0;
    }
    for (let depth = 0; depth < 14 && cls && !cls.isNull() && count < 140; depth++) {
      for (let o = 0x28; o < 0x2c0 && count < 140; o += 8) {
        try {
          const p = cls.add(o).readPointer();
          if (p.isNull()) continue;
          for (let i = 0; i < 220 && count < 140; i++) {
            try {
              const q =
                i === 0 && looksLikeUObject(p)
                  ? p
                  : p.add(i * 8).readPointer();
              if (!looksLikeUObject(q)) continue;
              const nm = objectName(q);
              if (!nm || !nameRe.test(nm) || seen[nm]) continue;
              seen[nm] = true;
              count++;
              log(
                'ATPC_API ' + tag + ' ' + nm + ' ParmsSize=' + readParmsSize(q)
              );
            } catch (e2) {
              break;
            }
          }
        } catch (e) {}
      }
      let next = null;
      const supers = [0x40, 0x48, 0x30, 0x38, 0x50];
      for (let s = 0; s < supers.length; s++) {
        try {
          const cand = cls.add(supers[s]).readPointer();
          if (cand.isNull() || cand.equals(cls)) continue;
          if (!looksLikeUObject(cand)) continue;
          next = cand;
          break;
        } catch (e3) {}
      }
      cls = next;
    }
    log('ATPC_API ' + tag + ' total=' + count + ' em ' + objectName(obj));
    return count;
  }
  function findAtpcCameraComp() {
    if (!survPawnObj) return null;
    for (let off = 0x200; off < 0xe00; off += 8) {
      try {
        const p = survPawnObj.add(off).readPointer();
        if (!p || p.isNull()) continue;
        const n = objectName(p);
        if (!n) continue;
        if (
          /ATPCCamera/i.test(n) &&
          !/Object|Shake|Modifier|Fading|FollowTerrain|LockOn|Location|FOV/i.test(
            n
          )
        )
          return p;
      } catch (e) {}
    }
    return null;
  }
  function diagAtpcApi() {
    atpcApiDone = true;
    log('ATPC_API inicio (A3 â€” enumeracao, nenhuma chamada)');
    try {
      if (survPawnObj) listCameraFuncs(survPawnObj, 'PAWN', /Camera/i);
    } catch (eP) {}
    try {
      if (survPcObj) listCameraFuncs(survPcObj, 'PC', /Camera/i);
    } catch (eC) {}
    try {
      const comp = findAtpcCameraComp();
      if (comp) {
        log('ATPC_API comp=' + objectName(comp));
        listCameraFuncs(
          comp,
          'ATPC',
          /Camera|Mode|Tag|View|GPS|Person|Perspective/i
        );
      } else {
        log('ATPC_API comp ATPCCamera NAO encontrado no pawn');
      }
    } catch (eA) {
      log('ATPC_API erro: ' + eA);
    }
    log('ATPC_API fim');
  }
  // A4: introspecao de parametros das UFunctions de camera (so leitura).
  const DIAG_ATPC_PARMS = true;
  let atpcParmsDone = false;
  function fnameAt(addr) {
    try {
      const idx = addr.readS32();
      const n = readFNameEntry(idx >>> 0);
      return n || 'idx:' + (idx >>> 0);
    } catch (e) {
      return '?';
    }
  }
  function hexBytes(p, len) {
    try {
      const u = new Uint8Array(p.readByteArray(len));
      let s = '';
      for (let i = 0; i < u.length; i++)
        s += ('0' + u[i].toString(16)).slice(-2);
      return s;
    } catch (e) {
      return '<err>';
    }
  }
  function dumpUFnParms(ownerObj, fnName) {
    const ufn = findUFn(ownerObj, new RegExp('^' + fnName + '$'));
    if (!ufn) {
      log('ATPC_PARMS ' + fnName + ' NAO encontrada');
      return;
    }
    log(
      'ATPC_PARMS ' +
        fnName +
        ' ufn=' +
        ufn +
        ' readParmsSize=' +
        readParmsSize(ufn)
    );
    log('ATPC_PARMS ' + fnName + ' hdr=' + hexBytes(ufn, 0xd0));
    // ChildProperties (FField*) candidatos: 0x50 (UE5) e 0x48 (Children/UField).
    let foundChain = false;
    const headOffs = [0x50, 0x48];
    for (let h = 0; h < headOffs.length && !foundChain; h++) {
      let node = null;
      try {
        node = ufn.add(headOffs[h]).readPointer();
      } catch (e) {}
      if (!node || node.isNull()) continue;
      for (let i = 0; i < 10 && node && !node.isNull(); i++) {
        let nm = '?';
        let clsName = '?';
        let off = -1;
        let elem = -1;
        let dim = -1;
        let flags = '?';
        let next = null;
        try {
          nm = fnameAt(node.add(0x28));
          const fc = node.add(0x8).readPointer();
          if (fc && !fc.isNull()) clsName = fnameAt(fc);
          off = node.add(0x4c).readS32();
          elem = node.add(0x3c).readS32();
          dim = node.add(0x38).readS32();
          flags = node.add(0x40).readU64().toString(16);
          next = node.add(0x20).readPointer();
        } catch (e) {
          break;
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) break;
        foundChain = true;
        log(
          'ATPC_PARMS ' +
            fnName +
            ' prop[' +
            i +
            '] name=' +
            nm +
            ' class=' +
            clsName +
            ' off=' +
            off +
            ' elem=' +
            elem +
            ' dim=' +
            dim +
            ' flags=0x' +
            flags
        );
        node = next;
      }
    }
    if (!foundChain)
      log('ATPC_PARMS ' + fnName + ' sem ChildProperties legivel (ver hdr)');
  }
  function diagAtpcParms() {
    atpcParmsDone = true;
    log('ATPC_PARMS inicio (A4 â€” introspecao, nenhuma chamada)');
    try {
      const comp = findAtpcCameraComp();
      if (comp) {
        const targets = [
          'SetCameraMode',
          'CanSetCameraMode',
          'GetCurrentCameraModeTag',
          'GetInitialCameraModeTag',
          'GetCameraMode',
        ];
        for (let t = 0; t < targets.length; t++)
          dumpUFnParms(comp, targets[t]);
      } else {
        log('ATPC_PARMS comp ATPCCamera NAO encontrado');
      }
    } catch (e) {
      log('ATPC_PARMS erro: ' + e);
    }
    log('ATPC_PARMS fim');
  }
  // A5: chamar SO getters de tag (leitura) p/ saber modo atual/inicial.
  const DIAG_ATPC_GET = true;
  let atpcGetDone = false;
  function callTagGetter(comp, fnName) {
    const fn = findUFn(comp, new RegExp('^' + fnName + '$'));
    if (!fn) {
      log('ATPC_GET ' + fnName + ' NAO encontrada');
      return;
    }
    const buf = Memory.alloc(32);
    for (let i = 0; i < 32; i++) buf.add(i).writeU8(0);
    try {
      processEventFn(comp, fn, buf);
    } catch (e) {
      log('ATPC_GET ' + fnName + ' PE throw: ' + e);
      return;
    }
    let idx = 0;
    let num = 0;
    try {
      idx = buf.readS32();
      num = buf.add(4).readS32();
    } catch (e2) {}
    const s = idx !== 0 ? readFNameEntry(idx >>> 0) : null;
    log(
      'ATPC_GET ' +
        fnName +
        ' idx=' +
        (idx >>> 0) +
        ' num=' +
        num +
        ' str=' +
        (s || '?') +
        ' hex=' +
        hexBytes(buf, 16)
    );
    return { idx: idx >>> 0, num: num, str: s || '' };
  }
  function diagAtpcGet() {
    atpcGetDone = true;
    log('ATPC_GET inicio (A5 â€” so getters, nenhum setter)');
    try {
      const comp = findAtpcCameraComp();
      if (comp && processEventFn) {
        callTagGetter(comp, 'GetCurrentCameraModeTag');
        callTagGetter(comp, 'GetInitialCameraModeTag');
      } else {
        log('ATPC_GET comp/PE indisponivel');
      }
    } catch (e) {
      log('ATPC_GET erro: ' + e);
    }
    log('ATPC_GET fim');
  }
  // B6: dump so-leitura das propriedades do componente ATPCCamera (classe+valores).
  const DIAG_ATPC_PROPS = true;
  let atpcPropsDone = false;
  function readPropValueStr(inst, clsName, off, elem, node) {
    try {
      const a = inst.add(off);
      if (/BoolProperty/.test(clsName)) {
        const byte = a.readU8();
        // B10: FBoolProperty guarda ByteMask @+0x7A â€” descodificar o bit real.
        if (node) {
          try {
            const mask = node.add(0x7a).readU8();
            if (mask)
              return (
                'bool=' +
                ((byte & mask) !== 0) +
                ' (byte=' +
                byte +
                ' mask=0x' +
                mask.toString(16) +
                ')'
              );
          } catch (eB) {}
        }
        return 'byte=' + byte;
      }
      if (/IntProperty/.test(clsName)) return '' + a.readS32();
      if (/UInt32Property/.test(clsName)) return '' + a.readU32();
      if (/FloatProperty/.test(clsName)) return '' + a.readFloat().toFixed(4);
      if (/DoubleProperty/.test(clsName))
        return '' + a.readDouble().toFixed(4);
      if (/ByteProperty/.test(clsName)) return 'byte=' + a.readU8();
      if (/NameProperty/.test(clsName)) {
        const s = readFNameEntry(a.readS32() >>> 0);
        return 'name=' + (s || '?');
      }
      if (/ObjectProperty|ClassProperty|WeakObjectProperty/.test(clsName)) {
        const p = a.readPointer();
        if (!p || p.isNull()) return 'null';
        return objectName(p) + '@' + p;
      }
      if (/ArrayProperty|MapProperty|SetProperty/.test(clsName)) {
        const n = a.add(8).readS32();
        return 'num=' + n;
      }
      if (/StructProperty/.test(clsName)) {
        let extra = '';
        try {
          const s = readFNameEntry(a.readS32() >>> 0);
          if (s && /^[A-Za-z_][A-Za-z0-9_ .]*$/.test(s))
            extra = ' fname?=' + s;
        } catch (e3) {}
        return 'hex=' + hexBytes(a, Math.min(elem > 0 ? elem : 16, 24)) + extra;
      }
      return 'hex=' + hexBytes(a, Math.min(elem > 0 ? elem : 8, 16));
    } catch (e) {
      return '<err>';
    }
  }
  function dumpPropsFor(inst, tag, filterRe) {
    log('ATPC_PROPS objeto ' + tag + '=' + objectName(inst));
    try {
      let cls = null;
      try {
        cls = inst.add(0x10).readPointer();
      } catch (e) {}
      let total = 0;
      for (let depth = 0; depth < 12 && cls && !cls.isNull() && total < 260; depth++) {
        log('ATPC_PROPS class=' + objectName(cls));
        let node = null;
        try {
          node = cls.add(0x50).readPointer();
        } catch (e2) {}
        try {
          const dChildren = cls.add(0x48).readPointer();
          log('ATPC_DIAG class=' + objectName(cls) + ' +0x48=' + dChildren + ' +0x50=' + node);
          if (node && !node.isNull()) {
            log('ATPC_DIAG first nm=' + fnameAt(node.add(0x28)) + ' off=' + node.add(0x4c).readS32());
          }
        } catch (eD) {
          log('ATPC_DIAG erro class=' + objectName(cls) + ' ' + eD);
        }
        try {
          let uf = cls.add(0x48).readPointer();
          let ufN = 0;
          let ufHits = [];
          for (let k = 0; k < 400 && uf && !uf.isNull(); k++) {
            let ufName = '?';
            let ufNext = null;
            try {
              ufName = fnameAt(uf.add(0x18));
              ufNext = uf.add(0x28).readPointer();
            } catch (eU) {
              break;
            }
            ufN++;
            if (/Blocker|Custom|Input|Jump|Sprint|Grounded|Stamina/i.test(ufName)) ufHits.push(ufName);
            uf = ufNext;
          }
          log('ATPC_DIAG children class=' + objectName(cls) + ' n=' + ufN + ' hits=' + ufHits.join(','));
        } catch (eC) {
          log('ATPC_DIAG children erro class=' + objectName(cls) + ' ' + eC);
        }
        const seenHere = {};
        const chainNames = [];
        let chainEnd = 'limite';
        for (let i = 0; i < 1500 && node && !node.isNull() && total < 260; i++) {
          let nm = '?';
          let clsName = '?';
          let off = -1;
          let elem = -1;
          let next = null;
          try {
            nm = fnameAt(node.add(0x28));
            const fc = node.add(0x8).readPointer();
            if (fc && !fc.isNull()) clsName = fnameAt(fc);
            off = node.add(0x4c).readS32();
            elem = node.add(0x3c).readS32();
            next = node.add(0x20).readPointer();
          } catch (e3) {
            chainEnd = 'erro_leitura';
            break;
          }
          chainNames.push(nm + '@' + off.toString(16) + '[' + clsName + ']');
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) {
            node = next;
            continue;
          }
          const nodeKey = node.toString();
          if (seenHere[nodeKey]) {
            chainEnd = 'repetido_no';
            break;
          }
          seenHere[nodeKey] = true;
          if (filterRe && !filterRe.test(nm) && !filterRe.test(clsName)) {
            node = next;
            continue;
          }
          let val = '-';
          if (off >= 0 && off < 0x4000)
            val = readPropValueStr(inst, clsName, off, elem, node);
          total++;
          log(
            'ATPC_PROPS ' +
              nm +
              ' class=' +
              clsName +
              ' off=0x' +
              off.toString(16) +
              ' elem=' +
              elem +
              ' val=' +
              val
          );
          if (!next || next.isNull()) chainEnd = 'next_nulo';
          node = next;
        }
        log('ATPC_CHAIN class=' + objectName(cls) + ' n=' + chainNames.length + ' fim=' + chainEnd + ' nos=' + chainNames.join(' > '));
        let nextCls = null;
        const supers = [0x40, 0x48, 0x30, 0x38, 0x50];
        for (let s = 0; s < supers.length; s++) {
          try {
            const cand = cls.add(supers[s]).readPointer();
            if (!cand || cand.isNull() || cand.equals(cls)) continue;
            if (!looksLikeUObject(cand)) continue;
            nextCls = cand;
            break;
          } catch (e4) {}
        }
        cls = nextCls;
      }
      log('ATPC_PROPS total[' + tag + ']=' + total);
    } catch (e) {
      log('ATPC_PROPS erro[' + tag + ']: ' + e);
    }
  }
  function diagAtpcProps() {
    atpcPropsDone = true;
    log('ATPC_PROPS inicio (B6 â€” so leitura, nenhuma chamada)');
    const comp = findAtpcCameraComp();
    if (!comp) {
      log('ATPC_PROPS comp ATPCCamera NAO encontrado');
      log('ATPC_PROPS fim');
      return;
    }
    dumpPropsFor(comp, 'ATPC');
    log('ATPC_PROPS fim');
  }
  // B7: dump dos objetos de posicao/FOV da camera (instancias no componente).
  const DIAG_OBJ_PROPS = true;
  let atpcObjPropsDone = false;
  function diagObjProps() {
    atpcObjPropsDone = true;
    log('ATPC_PROPS inicio (B7 â€” Location/FOV, so leitura)');
    try {
      const comp = findAtpcCameraComp();
      if (comp) {
        const locObj = comp.add(0x360).readPointer();
        if (
          locObj &&
          !locObj.isNull() &&
          /ATPCCameraLocationObject/.test(objectName(locObj))
        )
          dumpPropsFor(locObj, 'LOC');
        else log('ATPC_PROPS LOC invalido');
        const fovObj = comp.add(0x368).readPointer();
        if (
          fovObj &&
          !fovObj.isNull() &&
          /ATPCCameraFOVObject/.test(objectName(fovObj))
        )
          dumpPropsFor(fovObj, 'FOV');
        else log('ATPC_PROPS FOV invalido');
      } else {
        log('ATPC_PROPS comp NAO encontrado (B7)');
      }
    } catch (e) {
      log('ATPC_PROPS erro B7: ' + e);
    }
    log('ATPC_PROPS fim (B7)');
  }
  // A8: forcar re-entrada do modo atual (tag ja correta; Enter pode nunca ter corrido).
  const DIAG_ATPC_SET = true;
  let atpcSetDone = false;
  function diagAtpcSet() {
    atpcSetDone = true;
    log('ATPC_SET inicio (A8 â€” re-entrada forcada do modo, 1x)');
    try {
      const comp = findAtpcCameraComp();
      if (!comp || !processEventFn) {
        log('ATPC_SET comp/PE indisponivel â€” abortado');
        return;
      }
      const before = callTagGetter(comp, 'GetCurrentCameraModeTag');
      const initial = callTagGetter(comp, 'GetInitialCameraModeTag');
      if (!initial || !initial.idx) {
        log('ATPC_SET tag inicial invalida â€” abortado');
        return;
      }
      // CanSetCameraMode(tag) -> bool @8
      const canFn = findUFn(comp, /^CanSetCameraMode$/);
      if (!canFn) {
        log('ATPC_SET CanSetCameraMode NAO encontrada â€” abortado');
        return;
      }
      const bufC = Memory.alloc(16);
      for (let i = 0; i < 16; i++) bufC.add(i).writeU8(0);
      bufC.writeS32(initial.idx | 0);
      bufC.add(4).writeS32(initial.num | 0);
      processEventFn(comp, canFn, bufC);
      const canSet = bufC.add(8).readU8() !== 0;
      log(
        'ATPC_SET CanSetCameraMode(' +
          (initial.str || initial.idx) +
          ')=' +
          canSet
      );
      if (!canSet) {
        log('ATPC_SET CanSet=false â€” setter NAO chamado');
        return;
      }
      // SetCameraMode(tag @0, bWithInterpolation=false @8, bForceSet=true @9)
      const setFn = findUFn(comp, /^SetCameraMode$/);
      if (!setFn) {
        log('ATPC_SET SetCameraMode NAO encontrada â€” abortado');
        return;
      }
      const bufS = Memory.alloc(16);
      for (let i = 0; i < 16; i++) bufS.add(i).writeU8(0);
      bufS.writeS32(initial.idx | 0);
      bufS.add(4).writeS32(initial.num | 0);
      bufS.add(8).writeU8(0);
      bufS.add(9).writeU8(1);
      processEventFn(comp, setFn, bufS);
      log('ATPC_SET SetCameraMode aplicado (bForceSet=1, interp=0)');
      const after = callTagGetter(comp, 'GetCurrentCameraModeTag');
      log(
        'ATPC_SET antes=' +
          (before ? before.str : '?') +
          ' depois=' +
          (after ? after.str : '?')
      );
    } catch (e) {
      log('ATPC_SET erro: ' + e);
    }
    log('ATPC_SET fim');
  }
  // D9: snapshots diferenciais GPS (M aberto) vs NORMAL (apos sair).
  const DIAG_DIFF = true;
  let diffSnapPending = null;
  let diffSnapAt = 0;
  let diffSnapCount = 0;
  // X15: vigia total de PE por 2.5s apos Enter/Exit do GPS (sem filtro de nome,
  // teto de linhas) p/ ver quem liga/desliga os slots.
  var peWatchUntil = 0;
  var pelogOn = false;   // v82: log de ProcessEvent sob demanda (so leitura)
  var pelogLeft = 0;
  var pelogTag = '';
  var peWatchLeft = 0;
  function scheduleDiffSnap(kind) {
    if (diffSnapCount >= 4) return;
    if (diffSnapPending === kind) return;
    diffSnapPending = kind;
    diffSnapAt = Date.now() + 700;
    log('DIFF agendado ' + kind);
  }
  function findMeshComps() {
    const out = [];
    const seen = {};
    if (!survPawnObj) return out;
    for (let off = 0x200; off < 0xe00; off += 8) {
      try {
        const p = survPawnObj.add(off).readPointer();
        if (!p || p.isNull()) continue;
        const ks = p.toString();
        if (seen[ks]) continue;
        const n = objectName(p);
        if (!n || n === '?' || n.indexOf('idx:') === 0) continue;
        if (!/Mesh/i.test(n)) continue;
        if (/Camera|ATPC/i.test(n)) continue;
        seen[ks] = true;
        out.push(p);
      } catch (e) {}
    }
    return out;
  }
  // V1: posicao/rotacao reais da camera vs pawn (so getters PE).
  let camLocDone = false;
  // Auto-fix offline: a cutscene de abertura adiciona "cutscene" em CustomInputBlockers
  // e so remove no termino, que nao dispara offline. Chamamos CutsceneFinish uma vez
  // por sessao quando a trava existe (pawn+0x16E0, num>0).
  let cutsceneFixDone = false;
  // Diagnostico GPS: loga cada mudanca de GPSRef_FP (pawn+0x3158) com timestamp.
  // Mostra se/quando o ator do tablet e criado e ligado, e quando e limpo.
  let lastGpsRef = null;
  let gpsRefWatchDone = false;
  let animApiDone = false;
  let animFixDone = false;
  let animFixRecheckDone = false;
  let animFixAt = 0;
  let vtDone = false;
  let animInitDone = false;
  let animInitRecheckDone = false;
  let animInitAt = 0;
  let boneSnap1Done = false;
  let boneSnap2Done = false;
  let boneSnap1Hex = '';
  let guardDone = false;
  let treeDone = false;
  let instVarsDone = false;
  let slotsPreDone = false;
  let pawnApiDone = false;
  function callCamLoc(comp, tag) {
    if (!comp || !processEventFn) return;
    let cam = null;
    let rot = null;
    try {
      const fnL = findUFnDet(comp, 'GetCameraLocation');
      if (fnL) {
        const buf = Memory.alloc(64);
        for (let i = 0; i < 64; i++) buf.add(i).writeU8(0);
        processEventFn(comp, fnL, buf);
        cam = [buf.readDouble(), buf.add(8).readDouble(), buf.add(16).readDouble()];
      }
    } catch (eL) {}
    try {
      const fnR = findUFnDet(comp, 'GetCameraRotation');
      if (fnR) {
        const buf = Memory.alloc(64);
        for (let i = 0; i < 64; i++) buf.add(i).writeU8(0);
        processEventFn(comp, fnR, buf);
        rot = [buf.readDouble(), buf.add(8).readDouble(), buf.add(16).readDouble()];
      }
    } catch (eR) {}
    const p = readPawnZQuick();
    let dist = -1;
    if (cam && p && isFinite(cam[0]) && isFinite(p.x)) {
      dist = Math.round(
        Math.hypot(cam[0] - p.x, cam[1] - p.y, cam[2] - p.z)
      );
    }
    log(
      'CAMLOC ' +
        tag +
        ' cam=' +
        (cam
          ? Math.round(cam[0]) + ',' + Math.round(cam[1]) + ',' + Math.round(cam[2])
          : '?') +
        ' rot=' +
        (rot
          ? Math.round(rot[0]) + ',' + Math.round(rot[1]) + ',' + Math.round(rot[2])
          : '?') +
        ' pawn=' +
        (p ? Math.round(p.x) + ',' + Math.round(p.y) + ',' + Math.round(p.z) : '?') +
        ' dist=' +
        dist
    );
  }
  // W1: posicao mundial real de cada mesh vs pawn (getter PE deterministico).
  function callMeshLoc(tag) {
    const comps = findMeshComps();
    const p = readPawnZQuick();
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      let loc = null;
      try {
        const fn = findUFnDet(c, 'K2_GetComponentLocation');
        if (fn && processEventFn) {
          const buf = Memory.alloc(64);
          for (let b = 0; b < 64; b++) buf.add(b).writeU8(0);
          processEventFn(c, fn, buf);
          loc = [
            buf.readDouble(),
            buf.add(8).readDouble(),
            buf.add(16).readDouble(),
          ];
        }
      } catch (eML) {}
      let dist = -1;
      if (loc && p && isFinite(loc[0]) && isFinite(p.x))
        dist = Math.round(Math.hypot(loc[0] - p.x, loc[1] - p.y, loc[2] - p.z));
      log(
        'MESHLOC ' +
          tag +
          ' ' +
          objectName(c) +
          ' loc=' +
          (loc
            ? Math.round(loc[0]) + ',' + Math.round(loc[1]) + ',' + Math.round(loc[2])
            : '?') +
          ' distPawn=' +
          dist
      );
    }
  }
  // X1: estado de animacao da CharacterMesh0 (so leitura).
  function findPropOffset(inst, propName) {
    let cls = null;
    try {
      cls = inst.add(0x10).readPointer();
    } catch (e) {
      return null;
    }
    for (let depth = 0; depth < 12 && cls && !cls.isNull(); depth++) {
      let node = null;
      try {
        node = cls.add(0x50).readPointer();
      } catch (e2) {}
      for (let i = 0; i < 160 && node && !node.isNull(); i++) {
        let nm = null;
        let off = -1;
        let clsName = '?';
        let next = null;
        try {
          nm = fnameAt(node.add(0x28));
          off = node.add(0x4c).readS32();
          const fc = node.add(0x8).readPointer();
          if (fc && !fc.isNull()) clsName = fnameAt(fc);
          next = node.add(0x20).readPointer();
        } catch (e3) {
          break;
        }
        if (nm === propName) return { off: off, clsName: clsName };
        node = next;
      }
      let nextCls = null;
      const supers = [0x40, 0x48, 0x30, 0x38, 0x50];
      for (let s = 0; s < supers.length; s++) {
        try {
          const cand = cls.add(supers[s]).readPointer();
          if (!cand || cand.isNull() || cand.equals(cls)) continue;
          if (!isLikelyUClass(cand)) continue;
          nextCls = cand;
          break;
        } catch (e4) {}
      }
      cls = nextCls;
    }
    return null;
  }
  function diagAnim() {
    const comps = findMeshComps();
    let mesh0 = null;
    for (let i = 0; i < comps.length; i++) {
      if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
    }
    if (!mesh0) {
      log('ANIM sem CharacterMesh0');
      return;
    }
    dumpPropsFor(mesh0, 'ANIM', /Anim/);
    try {
      const hit = findPropOffset(mesh0, 'AnimScriptInstance');
      if (hit && hit.off >= 0) {
        const inst = mesh0.add(hit.off).readPointer();
        if (inst && !inst.isNull()) {
          let clsN = '?';
          try {
            clsN = objectName(inst.add(0x10).readPointer());
          } catch (e5) {}
          log(
            'ANIM AnimScriptInstance=' + objectName(inst) + ' class=' + clsN
          );
        } else {
          log('ANIM AnimScriptInstance=null');
        }
      } else {
        log('ANIM AnimScriptInstance prop NAO encontrada');
      }
    } catch (e) {
      log('ANIM erro: ' + e);
    }
  }
  // X2: inventario SO-LEITURA das UFunctions de animacao (nome + parms + thunk).
  // O RVA do thunk vai para o Ghidra (UI) confirmar a semantica antes de chamar.
  function dumpAnimFnParms(ufn, fnName) {
    let node = null;
    try {
      node = ufn.add(0x50).readPointer();
    } catch (e) {}
    if (!node || node.isNull()) {
      try {
        node = ufn.add(0x48).readPointer();
      } catch (e2) {}
    }
    for (let i = 0; i < 80 && node && !node.isNull(); i++) {
      let nm = '?';
      let clsName = '?';
      let off = -1;
      let elem = -1;
      let fl = 0;
      let next = null;
      try {
        nm = fnameAt(node.add(0x28));
        const fc = node.add(0x8).readPointer();
        if (fc && !fc.isNull()) clsName = fnameAt(fc);
        off = node.add(0x4c).readS32();
        elem = node.add(0x3c).readS32();
        try { fl = node.add(0x40).readU32(); } catch (e4) {}
        next = node.add(0x20).readPointer();
      } catch (e3) {
        break;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) break;
      log(
        'ANIM_API ' +
          fnName +
          ' prop[' +
          i +
          '] ' +
          nm +
          ' class=' +
          clsName +
          ' off=' +
          off +
          ' elem=' +
          elem +
          ' fl=0x' +
          fl.toString(16)
      );
      node = next;
    }
  }
  function dumpThunkCands(ufn, fnName) {
    for (let off = 0x90; off <= 0x118; off += 8) {
      let p = null;
      try {
        p = ufn.add(off).readPointer();
      } catch (e) {
        continue;
      }
      if (!p || p.isNull()) continue;
      try {
        if (
          p.compare(main.base) >= 0 &&
          p.compare(main.base.add(main.size)) < 0
        ) {
          log(
            'ANIM_API ' +
              fnName +
              ' thunkCand +0x' +
              off.toString(16) +
              ' RVA=0x' +
              p.sub(main.base).toString(16)
          );
        }
      } catch (e2) {}
    }
  }
  function enumAnimFns(clsObj, label, filterRe, maxOut) {
    let out = 0;
    let cls = clsObj;
    for (
      let depth = 0;
      depth < 24 && cls && !cls.isNull() && out < maxOut;
      depth++
    ) {
      let clsName = '?';
      try {
        clsName = objectName(cls);
      } catch (e0) {}
      try {
        let node = cls.add(0x48).readPointer();
        for (let i = 0; i < 500 && node && !node.isNull() && out < maxOut; i++) {
          let nm = null;
          try {
            nm = objectName(node);
          } catch (e1) {
            break;
          }
          if (nm && filterRe.test(nm)) {
            let isFn = false;
            try {
              const nc = node.add(0x10).readPointer();
              if (nc && !nc.isNull()) isFn = objectName(nc) === 'Function';
            } catch (e2) {}
            if (isFn) {
              out++;
              log(
                'ANIM_API ' +
                  label +
                  ' fn=' +
                  nm +
                  ' owner=' +
                  clsName +
                  ' ufn=' +
                  node
              );
              dumpAnimFnParms(node, nm);
              dumpThunkCands(node, nm);
            }
          }
          let next = null;
          try {
            next = node.add(0x28).readPointer();
          } catch (e3) {
            break;
          }
          if (next && next.equals(node)) break;
          node = next;
        }
      } catch (e4) {}
      let nextCls = null;
      const supers = [0x40, 0x48, 0x30, 0x38, 0x50];
      for (let s = 0; s < supers.length; s++) {
        try {
          const cand = cls.add(supers[s]).readPointer();
          if (!cand || cand.isNull() || cand.equals(cls)) continue;
          if (!isLikelyUClass(cand)) continue;
          nextCls = cand;
          break;
        } catch (e5) {}
      }
      cls = nextCls;
    }
    log('ANIM_API ' + label + ' total=' + out);
  }
  function diagAnimApi() {
    const comps = findMeshComps();
    let mesh0 = null;
    for (let i = 0; i < comps.length; i++) {
      if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
    }
    if (!mesh0) {
      log('ANIM_API sem CharacterMesh0');
      return;
    }
    let meshCls = null;
    try {
      meshCls = mesh0.add(0x10).readPointer();
    } catch (e) {}
    if (!meshCls || meshCls.isNull()) {
      log('ANIM_API sem classe do mesh');
      return;
    }
    log('ANIM_API meshClass=' + objectName(meshCls));
    enumAnimFns(meshCls, 'MESH', /Anim/i, 40);
    // Calibracao do offset do thunk: SetVisibility funciona via peBoolOn.
    const ufnVis = findUFnDet(mesh0, 'SetVisibility');
    if (ufnVis) dumpThunkCands(ufnVis, 'SetVisibility');
    try {
      const hit = findPropOffset(mesh0, 'AnimScriptInstance');
      if (hit && hit.off >= 0) {
        const inst = mesh0.add(hit.off).readPointer();
        if (inst && !inst.isNull()) {
          const instCls = inst.add(0x10).readPointer();
          log('ANIM_API instClass=' + objectName(instCls));
          enumAnimFns(instCls, 'INST', /Init|Anim|Update/i, 40);
        }
      }
    } catch (eI) {
      log('ANIM_API inst erro: ' + eI);
    }
  }
  // X4 DIAG (so leitura): slots da vtable do CharacterMesh0.
  // 0xaa8 = virtual final do InitializeAnimScriptInstance;
  // 0xad0 = impl. real do SetAnimClass (alvo do thunk).
  function diagVtable() {
    const comps = findMeshComps();
    let mesh0 = null;
    for (let i = 0; i < comps.length; i++) {
      if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
    }
    if (!mesh0) {
      log('VT sem CharacterMesh0');
      return;
    }
    let vt = null;
    try {
      vt = mesh0.readPointer();
    } catch (e) {}
    if (!vt || vt.isNull()) {
      log('VT vtable null');
      return;
    }
    log(
      'VT vtable RVA=0x' +
        vt.sub(main.base).toString(16) +
        ' class=' +
        objectName(mesh0.add(0x10).readPointer())
    );
    for (let off = 0xa80; off <= 0xb10; off += 8) {
      let p = null;
      try {
        p = vt.add(off).readPointer();
      } catch (e2) {
        continue;
      }
      if (!p || p.isNull()) continue;
      try {
        if (
          p.compare(main.base) >= 0 &&
          p.compare(main.base.add(main.size)) < 0
        ) {
          log(
            'VT slot +0x' +
              off.toString(16) +
              ' RVA=0x' +
              p.sub(main.base).toString(16)
          );
        }
      } catch (e3) {}
    }
  }
  // X3 EXPERIMENTO (1x, READY+8s): SetAnimationMode(0) na CharacterMesh0.
  // DESLIGADO nesta run (ANIM_FIX_ON=false): ja correu, insuficiente.
  // Cadeia provada no Ghidra: modo==0 -> InitializeAnimScriptInstance(1,0)
  // -> inicializa a arvore na instancia existente. Sem trocar classe/mesh.
  const ANIM_FIX_ON = false;
  function applyAnimFix() {
    const comps = findMeshComps();
    let mesh0 = null;
    for (let i = 0; i < comps.length; i++) {
      if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
    }
    if (!mesh0) {
      log('ANIM_FIX sem CharacterMesh0');
      return;
    }
    log('ANIM_FIX antes:');
    try {
      diagAnim();
    } catch (e0) {}
    const ok = peBoolOn(mesh0, /^SetAnimationMode$/, false);
    log('ANIM_FIX SetAnimationMode(0) -> ' + ok);
    animFixAt = Date.now();
  }
  // X5 EXPERIMENTO (1x, READY+9s): InitAnim(mesh0, true) via NativeFunction.
  // Endereco lido da vtable do proprio objeto (slot +0xae8; RVA esperado
  // 0x3fd9da0). E a chamada que o motor faz no registo/posse; offline,
  // a segunda chamada (apos aplicar aparencia) nunca acontece.
  function applyAnimInit() {
    const comps = findMeshComps();
    let mesh0 = null;
    for (let i = 0; i < comps.length; i++) {
      if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
    }
    if (!mesh0) {
      log('ANIM_INIT sem CharacterMesh0');
      return;
    }
    let initAnimPtr = null;
    try {
      const vt = mesh0.readPointer();
      initAnimPtr = vt.add(0xae8).readPointer();
      log(
        'ANIM_INIT alvo RVA=0x' +
          initAnimPtr.sub(main.base).toString(16) +
          ' (esperado 0x3fd9da0)'
      );
    } catch (e0) {
      log('ANIM_INIT erro vtable: ' + e0);
      return;
    }
    if (!initAnimPtr || initAnimPtr.isNull()) {
      log('ANIM_INIT alvo null');
      return;
    }
    log('ANIM_INIT antes:');
    try {
      diagAnim();
    } catch (e1) {}
    try {
      const initAnimFn = new NativeFunction(initAnimPtr, 'void', [
        'pointer',
        'int',
      ]);
      initAnimFn(mesh0, 1);
      log('ANIM_INIT InitAnim(mesh,true) executou');
    } catch (e2) {
      log('ANIM_INIT excecao: ' + e2);
    }
    animInitAt = Date.now();
  }
  // X6/X9 DIAG (so leitura): os ossos mexem? Varre o componente a procura
  // de TArrays com assinatura FTransform (quat norma~1) e amostra 2x.
  let boneTarget = null; // legado (nao usado)
  let boneCands = [];
  let boneSnapHexArr = [];
  function quatNormOk(p, dbl) {
    try {
      let s = 0;
      for (let i = 0; i < 4; i++) {
        const v = dbl ? p.add(i * 8).readDouble() : p.add(i * 4).readFloat();
        if (Math.abs(v) > 1.01) return false;
        s += v * v;
      }
      return s > 0.85 && s < 1.15;
    } catch (e) {
      return false;
    }
  }
  function diagBoneSnap(which) {
    const comps = findMeshComps();
    let mesh0 = null;
    for (let i = 0; i < comps.length; i++) {
      if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
    }
    if (!mesh0) {
      log('BONE sem CharacterMesh0');
      return;
    }
    if (which === 1) {
      log('FLAGS +0x80=' + hexBytes(mesh0.add(0x80), 16));
      log('FLAGS +0xa70=' + hexBytes(mesh0.add(0xa70), 24));
    }
    if (which === 1) {
      boneCands = [];
      for (let off = 0x300; off <= 0x1300; off += 8) {
        let data = null;
        let num = 0;
        let max = 0;
        try {
          data = mesh0.add(off).readPointer();
          num = mesh0.add(off + 8).readS32();
          max = mesh0.add(off + 12).readS32();
        } catch (e) {
          continue;
        }
        if (!data || data.isNull()) continue;
        if (num < 50 || num > 600 || max < num) continue;
        try {
          if (
            data.compare(main.base) >= 0 &&
            data.compare(main.base.add(main.size)) < 0
          )
            continue;
        } catch (e2) {
          continue;
        }
        boneCands.push(off);
        if (boneCands.length >= 6) break;
      }
      log('BONE candidatos=' + boneCands.length);
      boneSnapHexArr = [];
    }
    if (!boneCands || boneCands.length === 0) {
      log('BONE sem candidatos snap' + which);
      return;
    }
    for (let ci = 0; ci < boneCands.length; ci++) {
      const off = boneCands[ci];
      let data = null;
      let num = 0;
      try {
        data = mesh0.add(off).readPointer();
        num = mesh0.add(off + 8).readS32();
      } catch (e3) {
        continue;
      }
      if (!data || data.isNull() || num <= 0) {
        log('BONE c' + ci + ' snap' + which + ' invalido');
        continue;
      }
      const hex = hexBytes(data, 512);
      log(
        'BONE c' +
          ci +
          ' snap' +
          which +
          ' off=0x' +
          off.toString(16) +
          ' num=' +
          num +
          ' ' +
          hex
      );
      if (which === 1) {
        boneSnapHexArr[ci] = hex;
      } else {
        log('BONE c' + ci + ' changed=' + (hex !== boneSnapHexArr[ci]));
      }
    }
  }
  // X7 DIAG (so leitura): que classe exige o guarda IsA do InitAnim?
  // FUN_1445633d0 (RVA 0x45633d0) devolve o UClass singleton do guarda.
  function diagGuard() {
    try {
      const getGuardCls = new NativeFunction(main.base.add(0x45633d0), 'pointer', []);
      const gc = getGuardCls();
      log('GUARD cls=' + objectName(gc) + ' @' + gc);
    } catch (e) {
      log('GUARD erro getter: ' + e);
    }
    const comps = findMeshComps();
    let mesh0 = null;
    for (let i = 0; i < comps.length; i++) {
      if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
    }
    if (!mesh0) {
      log('GUARD sem CharacterMesh0');
      return;
    }
    try {
      const asset = mesh0.add(0x5a8).readPointer();
      log('GUARD asset@0x5a8=' + objectName(asset));
      let cls = asset.add(0x10).readPointer();
      const chain = [];
      for (let d = 0; d < 12 && cls && !cls.isNull(); d++) {
        chain.push(objectName(cls));
        let nextCls = null;
        const supers = [0x40, 0x48, 0x30, 0x38, 0x50];
        for (let s = 0; s < supers.length; s++) {
          try {
            const cand = cls.add(supers[s]).readPointer();
            if (!cand || cand.isNull() || cand.equals(cls)) continue;
            if (!isLikelyUClass(cand)) continue;
            nextCls = cand;
            break;
          } catch (e5) {}
        }
        cls = nextCls;
      }
      log('GUARD assetChain=' + chain.join(' -> '));
      log(
        'GUARD byte88=0x' +
          mesh0.add(0x88).readU8().toString(16) +
          ' boneCount=' +
          mesh0.add(0x740).readS32()
      );
    } catch (e2) {
      log('GUARD erro asset: ' + e2);
    }
  }
  // X10 DIAG (so leitura): inventario completo de componentes (pawn + mesh0),
  // campos directos + TArrays de componentes (OwnedComponents/AttachChildren).
  function dumpCompTree(rootObj, label, seen) {
    let logged = 0;
    function noteComp(p, via) {
      if (!p || p.isNull()) return;
      const key = p.toString();
      if (seen[key]) return;
      let clsN = '';
      try {
        const c = p.add(0x10).readPointer();
        if (c && !c.isNull()) clsN = objectName(c);
      } catch (e) {}
      if (!/Component/.test(clsN)) return;
      seen[key] = true;
      if (logged >= 90) return;
      logged++;
      let fl = '??';
      try {
        fl = hexBytes(p.add(0x188), 2);
      } catch (e2) {}
      log(
        'TREE ' +
          label +
          ' ' +
          via +
          ' ' +
          objectName(p) +
          ' class=' +
          clsN +
          ' fl188=' +
          fl +
          ' @' +
          p
      );
    }
    for (let off = 0x100; off <= 0x1000; off += 8) {
      let p = null;
      try {
        p = rootObj.add(off).readPointer();
      } catch (e) {
        continue;
      }
      if (!p || p.isNull()) continue;
      if (looksLikeUObject(p)) noteComp(p, 'field+0x' + off.toString(16));
      // TArray de componentes?
      let data = null;
      let num = 0;
      let max = 0;
      try {
        data = p;
        num = rootObj.add(off + 8).readS32();
        max = rootObj.add(off + 12).readS32();
      } catch (e3) {
        continue;
      }
      if (!data || data.isNull() || num <= 0 || num > 64 || max < num) continue;
      try {
        if (
          data.compare(main.base) >= 0 &&
          data.compare(main.base.add(main.size)) < 0
        )
          continue;
      } catch (e4) {
        continue;
      }
      for (let i = 0; i < num; i++) {
        let el = null;
        try {
          el = data.add(i * 8).readPointer();
        } catch (e5) {
          break;
        }
        if (el && !el.isNull() && looksLikeUObject(el))
          noteComp(el, 'arr+0x' + off.toString(16) + '[' + i + ']');
      }
    }
  }
  function diagTreeInv() {
    if (!survPawnObj) {
      log('TREE sem pawn');
      return;
    }
    const seen = {};
    dumpCompTree(survPawnObj, 'PAWN', seen);
    const comps = findMeshComps();
    for (let i = 0; i < comps.length; i++) {
      if (objectName(comps[i]) === 'CharacterMesh0')
        dumpCompTree(comps[i], 'MESH0', seen);
    }
    log('TREE fim total=' + Object.keys(seen).length);
  }
  // X10: variaveis de locomocao da AnimScriptInstance (inputs do grafo).
  function diagInstVars() {
    const comps = findMeshComps();
    let mesh0 = null;
    for (let i = 0; i < comps.length; i++) {
      if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
    }
    if (!mesh0) {
      log('INSTVARS sem mesh0');
      return;
    }
    try {
      const hit = findPropOffset(mesh0, 'AnimScriptInstance');
      if (!hit || hit.off < 0) {
        log('INSTVARS sem instancia');
        return;
      }
      const inst = mesh0.add(hit.off).readPointer();
      if (!inst || inst.isNull()) {
        log('INSTVARS instancia null');
        return;
      }
      dumpPropsFor(
        inst,
        'INSTVARS',
        /Speed|Velocity|Direction|Ground|Move|Fall|Crouch|Aim|State|Idle|Walk|Run|Sprint|Lean|ADS/i
      );
    } catch (e) {
      log('INSTVARS erro: ' + e);
    }
  }
  // X10: amostra larga (8KB) dos arrays de transformacoes 0x600/0x610.
  let boneWideHex = {};
  function diagBoneWide(which) {
    const comps = findMeshComps();
    let mesh0 = null;
    for (let i = 0; i < comps.length; i++) {
      if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
    }
    if (!mesh0) {
      log('BONEW sem mesh0');
      return;
    }
    const offs = [0x600, 0x610];
    for (let a = 0; a < offs.length; a++) {
      const off = offs[a];
      let data = null;
      let num = 0;
      try {
        data = mesh0.add(off).readPointer();
        num = mesh0.add(off + 8).readS32();
      } catch (e) {
        continue;
      }
      if (!data || data.isNull() || num <= 0) {
        log('BONEW snap' + which + ' off=0x' + off.toString(16) + ' invalido');
        continue;
      }
      const bytes = Math.min(8192, num * 0x50);
      const hex = hexBytes(data, bytes);
      log(
        'BONEW snap' +
          which +
          ' off=0x' +
          off.toString(16) +
          ' num=' +
          num +
          ' ' +
          hex
      );
      if (which === 1) {
        boneWideHex[off] = hex;
      } else {
        log(
          'BONEW off=0x' +
            off.toString(16) +
            ' changed=' +
            (hex !== boneWideHex[off])
        );
      }
    }
  }
  // X11 DIAG (so leitura): cada SkeletalMeshComponent do pawn tem malha?
  // Compara PRE (READY, antes do M) vs GPS/NORMAL (via DIFF).
  function isSkMeshComp(p) {
    try {
      let cls = p.add(0x10).readPointer();
      for (let d = 0; d < 8 && cls && !cls.isNull(); d++) {
        const n = objectName(cls);
        if (/SkeletalMeshComponent|SkMeshComp/.test(n)) return true;
        let nextCls = null;
        const supers = [0x40, 0x48, 0x30, 0x38, 0x50];
        for (let s = 0; s < supers.length; s++) {
          try {
            const cand = cls.add(supers[s]).readPointer();
            if (!cand || cand.isNull() || cand.equals(cls)) continue;
            if (!isLikelyUClass(cand)) continue;
            nextCls = cand;
            break;
          } catch (e) {}
        }
        cls = nextCls;
      }
    } catch (e2) {}
    return false;
  }
  function diagSlots(tag) {
    if (!survPawnObj) {
      log('SLOTS ' + tag + ' sem pawn');
      return;
    }
    const seen = {};
    let n = 0;
    for (let off = 0x100; off <= 0xb00; off += 8) {
      let p = null;
      try {
        p = survPawnObj.add(off).readPointer();
      } catch (e) {
        continue;
      }
      if (!p || p.isNull() || seen[p.toString()]) continue;
      if (!looksLikeUObject(p)) continue;
      if (!isSkMeshComp(p)) continue;
      seen[p.toString()] = true;
      n++;
      let meshName = 'NULL';
      try {
        const m = p.add(0x5a8).readPointer();
        if (m && !m.isNull()) meshName = objectName(m);
      } catch (e3) {}
      let fl = '??';
      try {
        fl = hexBytes(p.add(0x188), 2);
      } catch (e4) {}
      log(
        'SLOTS ' +
          tag +
          ' ' +
          objectName(p) +
          ' mesh=' +
          meshName +
          ' fl188=' +
          fl
      );
    }
    log('SLOTS ' + tag + ' total=' + n);
    // Capsula: bytes crus da zona de colisao p/ diff PRE vs POS-M
    for (let off = 0x100; off <= 0xb00; off += 8) {
      let p = null;
      try {
        p = survPawnObj.add(off).readPointer();
      } catch (e) {
        continue;
      }
      if (!p || p.isNull()) continue;
      if (objectName(p) === 'CollisionCylinder') {
        try {
          log('CAPS ' + tag + ' b230=' + hexBytes(p.add(0x230), 0x90));
        } catch (e6) {}
        break;
      }
    }
  }
  // X12 DIAG (so leitura): UFunctions do pawn ligadas a visibilidade/load/GPS.
  // --- X13: visibility/collision activate experiment (user-approved) ---
  // BP fn 'Set Visible and Collision(IsActive)' on SurvivalPlayer_C. Baseline
  // SLOTS dump, then one PE call with IsActive=1, then SLOTS again after 2s.
  var visFixOn = true, visFixDone = false, visFixAt = 0, visFixRecheckDone = false;
  function applyVisFix() {
    if (!visFixOn || visFixDone) return;
    visFixDone = true;
    visFixAt = Date.now();
    try {
      log('VISFIX start');
      dumpPropsFor(survPawnObj, 'PAWNSTATE', /Active|Loaded|Loading|Fully/);
      diagSlots('PREVIS');
      var ok = peBoolSafe(survPawnObj, 'Set Visible and Collision', 1);
      log('VISFIX peBoolSafe(Set Visible and Collision,1)=' + ok);
    } catch (e) {
      log('VISFIX exc ' + e);
    }
  }
  // --- X14: slot visibility toggle experiment ---
  // 'VisToggleForHiddenShadowComponents(Vis)' on SurvivalPlayer_C. Runs after
  // X13 recheck. Read-only pawn BP array dump first, then one PE call, then SLOTS.
  var visTglDone = false, visTglAt = 0, visTglRecheckDone = false;
  function applyVisToggle() {
    if (visTglDone) return;
    visTglDone = true;
    visTglAt = Date.now();
    try {
      log('VISTGL start');
      dumpPropsFor(survPawnObj, 'PAWNARR', /Skel|Shadow/);
      diagSlots('PRETGL');
      var ok = peBoolSafe(survPawnObj, 'VisToggleForHiddenShadowComponents', 1);
      log('VISTGL peBoolSafe(VisToggleForHiddenShadowComponents,1)=' + ok);
    } catch (e) {
      log('VISTGL exc ' + e);
    }
  }
  // --- X16: direct SetVisibility(true) on slot comps ---
  // PEWATCH (X15) showed the GPS-exit flip uses NO ProcessEvent (native/BP-VM
  // direct call). Replicate with the engine UFunction via PE, same pattern
  // applyBody already uses to hide FPMeshNew. Skips CharacterMesh0 (already
  // visible) and FPMeshNew (FP mesh; game keeps it hidden in TP).
  var slotVisDone = false, slotVisAt = 0, slotVisRecheckDone = false;
  function applySlotVis() {
    if (slotVisDone) return;
    slotVisDone = true;
    slotVisAt = Date.now();
    try {
      log('SLOTVIS start');
      diagSlots('PRESV');
      const seen = {};
      for (let off = 0x100; off <= 0xb00; off += 8) {
        let p = null;
        try {
          p = survPawnObj.add(off).readPointer();
        } catch (e) {
          continue;
        }
        if (!p || p.isNull() || seen[p.toString()]) continue;
        if (!looksLikeUObject(p)) continue;
        if (!isSkMeshComp(p)) continue;
        seen[p.toString()] = true;
        const nm = objectName(p);
        if (nm === 'CharacterMesh0' || nm === 'FPMeshNew') continue;
        const ok = peBoolOn(p, /^SetVisibility$/, 1);
        log('SLOTVIS SetVisibility(' + nm + ',1)=' + ok);
      }
    } catch (e) {
      log('SLOTVIS exc ' + e);
    }
  }
  // --- X17: ANIMPROBE (read-only) ---
  // Samples pawn speed (position delta) vs anim instance getSpeed() return,
  // idle and walking. Discriminates: speed input == 0 (input broken) vs
  // speed > 0 but no locomotion transition (state machine gate).
  var probeSetupDone = false, probeDone = false, probeInst = null, probeGsFn = null;
  var probeLastLoc = null, probeLastT = 0, probeNextAt = 0, probeLines = 0, probeTickN = 0;
  var probeMov = null, probeVelOff = -1;
  var probeTrans = [];
  var probeStateFn = null;
  var probeWeightFn = null;
  var probeMachines = [];
  var probeMachWF = null, probeElapsedF = null;
  var probeMutIdle = null, probeMutDone = false, probeMutOff = -1;
  var traceOn = false, traceUntil = 0, traceSet = null, traceDone = false;
  var trace2On = false, trace2Done = false, trace2Until = 0;
  var calcMutLogged = false;
  var trace0On = false, trace0Done = false, trace0Until = 0, traceSet0 = null;
  var traceSetPawn = null;
  var probePostInst = null, traceSetPost = null;
  var calcFns = [], calcOn = false, calcUntil = 0, calcDone = false, calcRounds = 0;
  var init2Fns = [], init2Done = false, init2AtRound = -1, calcMut2Logged = false;
  var calcBufs = [];
  var vbProbeDone = false;
  var traceCalcSet = null, traceCalcOn = false, traceCalcDone = false;
  var initAnimFn = null, initAnimDone = false;
  var optAnimFn = null, optDiffDone = false;
  // RITUAL: o trecho do evento que alimenta a locomocao (obter camada ->
  // CollectVariables/UpdateLayerValues + Calculate*) nunca e executado
  // no fluxo offline. Chamamos as mesmas funcoes a cada frame
  // (pos-READY) para manter as variaveis vivas e o no de ligacao com
  // peso â€” na mao, em rajada, as pernas rabiscaram (2026-10-22).
  var ritualFns = [], ritualBufs = [], ritualOn = false, ritualN = 0;
  // ritualMode: 0=off, 1=so CollectVariables+UpdateLayerValues (o que o
  // evento chama de verdade), 2=sequencia completa de 7. Ajustavel pelo
  // canal ('ritual') sem relancar. Evidencia 2026-10-22: com as 7, o
  // campo que o coletor preenche fica zerado (os Calculate* com entrada
  // vazia apagam o trabalho dele).
  var ritualMode = 1;
  var nodePtrDone = false;
  var probeLinkedInst = null;
  var linkFn = null, linkChkFn = null, linkDone = false;
  var pawnIdDone = false;
  // LOADTRY: carregador nativo (Ghidra: RVA 0x242f7f0 =
  // FSoftObjectPath::TryLoad â€” monta caminho completo e carrega sincrono).
  var loadTryDone = false;
  var pendingLoadTry = false;
  var loadTryBuf = null;
  var loadTryNative = null;
  function findFNameIndices(targets) {
    // Varredura sequencial da FNamePool; devolve {alvo: comparisonIndex|-1}
    const out = {};
    for (let ti = 0; ti < targets.length; ti++) out[targets[ti]] = -1;
    let remaining = targets.length;
    try {
      for (let block = 0; block < 512 && remaining > 0; block++) {
        const blockPtr = fnamePool.add(0x10).add(block * 8).readPointer();
        if (blockPtr.isNull()) break;
        let units = 0;
        while (units < 65536 && remaining > 0) {
          const entry = blockPtr.add(units * 2);
          const header = entry.readU16();
          const isWide = (header & 1) !== 0;
          const len = header >>> 6;
          if (len <= 0 || len > 1024) break;
          let matchLen = false;
          for (let ti2 = 0; ti2 < targets.length; ti2++) {
            if (out[targets[ti2]] < 0 && targets[ti2].length === len) { matchLen = true; break; }
          }
          if (matchLen) {
            let s = null;
            try {
              s = isWide ? entry.add(2).readUtf16String(len) : entry.add(2).readUtf8String(len);
            } catch (eS) {}
            if (s !== null && out[s] === -1) {
              out[s] = ((block << 16) | units) >>> 0;
              remaining--;
            }
          }
          const byteLen = 2 + len * (isWide ? 2 : 1);
          units += (byteLen + 1) >> 1;
        }
      }
    } catch (eF) {
      log('LOADTRY findFName exc ' + eF);
    }
    return out;
  }
  var loadTryQueue = [];
  function execLoadTry(tag) {
    try {
      if (!loadTryNative) {
        loadTryNative = new NativeFunction(main.base.add(0x242f7f0), 'pointer', ['pointer']);
      }
      if (!loadTryQueue.length) { log('LOADTRY4 fila vazia (' + tag + ')'); return; }
      for (let qi = 0; qi < loadTryQueue.length; qi++) {
        const item = loadTryQueue[qi];
        try {
          const ret = loadTryNative(item.buf);
          if (!ret || ret.isNull()) {
            log('LOADTRY4 ' + item.tag + ' ret=NULL buf=' + hexBytes(item.buf, 32));
            continue;
          }
          let cls = '?';
          try { cls = objectName(ret.add(0x10).readPointer()); } catch (eC) {}
          let eq = '';
          if (item.expect) eq = ' igualAoVivo=' + (ret.equals(item.expect) ? 'SIM' : 'NAO');
          log('LOADTRY4 ' + item.tag + ' ret=' + ret + ' nome=' + objectName(ret) + ' cls=' + cls + eq);
        } catch (eQ) {
          log('LOADTRY4 ' + item.tag + ' exc ' + eQ);
        }
      }
      loadTryQueue = [];
    } catch (eL) {
      log('LOADTRY4 exc ' + eL + ' (' + tag + ')');
    }
  }
  // PLAYTRY: tocar Surv_Jog_F (ciclo desarmado, rig Surv_Male_FullRig)
  // via PlaySlotAnimationAsDynamicMontage quando velMag sobe; parar ao
  // parar. Setup e comandos executam no Tick (game thread).
  var playTryDone = false;
  var pendingPlaySetup = false;
  var pendingPlayCmd = '';
  var playSeq = null;
  var playFn = null;
  var playStopFn = null;
  var playRateFn = null;
  var playSlotIdx = -1;
  var playPathBuf = null;
  var playTryPlaying = false;
  var playMontage = null;
  var playRateNow = 1.0;
  var playSlotList = [];
  var playSlotPos = 0;
  var playSlotAtual = null;
  var playSlotMoveTime = 0;
  var playCheckAt = -1;
  var playActiveFn = null;
  // Neste teste o controle do paliativo fica DESLIGADO (grafo puro).
  var playControlEnabled = false;
  // LINK2: carregar a classe Masc de locomocao e repetir a ligacao.
  var link2Done = false;
  var pendingLink2 = false;
  function execLink2() {
    try {
      if (!loadTryNative) {
        loadTryNative = new NativeFunction(main.base.add(0x242f7f0), 'pointer', ['pointer']);
      }
      const li = findFNameIndices([
        '/Game/SurvAnimator/New_Character/SurviveLocomotion',
        'SurviveLocomotion_C',
      ]);
      let mascCls = null;
      const mp = li['/Game/SurvAnimator/New_Character/SurviveLocomotion'];
      const ma = li['SurviveLocomotion_C'];
      log('LINK2 fnames mascPkg=' + mp + ' mascCls=' + ma);
      if (mp >= 0 && ma >= 0) {
        const bb = Memory.alloc(32);
        for (let i = 0; i < 32; i++) bb.add(i).writeU8(0);
        bb.writeU32(mp >>> 0);
        bb.add(8).writeU32(ma >>> 0);
        const r = loadTryNative(bb);
        if (r && !r.isNull()) {
          mascCls = r;
          log('LINK2 masc ret=' + r + ' nome=' + objectName(r));
        } else {
          log('LINK2 masc ret=NULL');
        }
      }
      const linkFn2 = findUFnWide(probeInst, 'LinkAnimClassLayers');
      const chkFn2 = findUFnWide(probeInst, 'GetLinkedAnimLayerInstanceByClass');
      log('LINK2 fns link=' + (linkFn2 ? 'ok' : 'NULL') + ' chk=' + (chkFn2 ? 'ok' : 'NULL'));
      if (linkFn2) dumpAnimFnParms(linkFn2, 'LinkAnimClassLayers');
      if (chkFn2) dumpAnimFnParms(chkFn2, 'GetLinkedAnimLayerInstanceByClass');
      if (!linkFn2 || !chkFn2) return;
      const candidates = [];
      if (mascCls) candidates.push({ tag: 'masc', cls: mascCls });
      try {
        const femCls = probeInst.add(0x9888).readPointer();
        if (femCls && !femCls.isNull() && looksLikeUObject(femCls)) {
          candidates.push({ tag: 'fem', cls: femCls });
        }
      } catch (eF2) {}
      for (let ci2 = 0; ci2 < candidates.length; ci2++) {
        const cand = candidates[ci2];
        try {
          const b1 = Memory.alloc(16);
          for (let i1 = 0; i1 < 16; i1++) b1.add(i1).writeU8(0);
          b1.writePointer(cand.cls);
          processEventFn(probeInst, linkFn2, b1);
          const b2 = Memory.alloc(16);
          for (let i2 = 0; i2 < 16; i2++) b2.add(i2).writeU8(0);
          b2.writePointer(cand.cls);
          processEventFn(probeInst, chkFn2, b2);
          const linked = b2.add(8).readPointer();
          log('LINK2 ' + cand.tag + ' linked=' +
            (linked && !linked.isNull() ? linked + ' nome=' + objectName(linked) : 'NULL'));
          if (linked && !linked.isNull()) probeLinkedInst = linked;
        } catch (eL2) {
          log('LINK2 ' + cand.tag + ' exc ' + eL2);
        }
      }
    } catch (eLX) {
      log('LINK2 exc ' + eLX);
    }
  }
  // REBIRTH: forca o motor a recriar a instancia de animacao no mundo
  // (SetAnimInstanceClass null -> mesma classe). Se a camada de
  // locomocao nasce na inicializacao do grafo, ela nasce aqui.
  var rebirthDone = false;
  var pendingRebirth = false;
  var rebirthApplied = false;
  var nodeScanDone = false;
  var subMasc = null, subFem = null;
  var subMascGsFn = null, subFemGsFn = null;
  var subProbeSetupDone = false;
  // Canal de comandos quente: le cmd.json (id crescente) e executa na
  // game thread, sem relancar o jogo. Resultados saem no log ('CMD ').
  var cmdLastId = 1403; // v83: pula cmd_1362..1403 ja executados (evita replay ao reiniciar)
  var jumpHooked = false;
  var jumpTries = 0;
  var cmdPollAt = 0;
  // MONITOR (somente leitura): loga flags de loading/render do PC a cada 1s quando ligado por cmd 'monitor'.
  var monitorOn = false, monitorAt = 0, monitorN = 0, monitorLast = '';
  // ---- Monitor de streaming do World Partition (reflexao por nome, sem offsets fixos) ----
  // Para cada ULevelStreaming listado no UWorld (inclui UWorldPartitionLevelStreamingDynamic):
  //   pedido = bool bShouldBeLoaded ; carregado = LoadedLevel nao nulo ; pendente = pedido && !carregado.
  // Limitacao: so enxerga celulas que ja possuem objeto de streaming na lista do mundo.
  const wpPropCache = {};
  let wpScanTick = 0;
  let wpStateLast = '';
  let wpPendLast = '';
  let loadedNotVisSig = '';
  let wpDumpDone = false;
  let wpStateBudget = 2000;
  let wpCalibDone = false;
  function wpHasKey(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function wpIsUClass(p) {
    try {
      return looksLikeUObject(p) && objectName(p.add(0x10).readPointer()) === 'Class';
    } catch (e) { return false; }
  }
  function wpClassPropMap(cls) {
    const key = cls.toString();
    if (wpPropCache[key]) return wpPropCache[key];
    const map = {};
    let c = cls;
    for (let depth = 0; depth < 12 && c && !c.isNull(); depth++) {
      let node = null;
      try { node = c.add(0x50).readPointer(); } catch (e0) {}
      for (let i = 0; i < 1500 && node && !node.isNull(); i++) {
        let nm = '?', clsName = '?', off = -1, next = null;
        try {
          nm = fnameAt(node.add(0x28));
          const fc = node.add(0x8).readPointer();
          if (fc && !fc.isNull()) clsName = fnameAt(fc);
          off = node.add(0x4c).readS32();
          next = node.add(0x20).readPointer();
        } catch (e1) { break; }
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm) && off >= 0 && off < 0x4000 && !wpHasKey(map, nm))
          map[nm] = { off: off, clsName: clsName, node: node };
        node = next;
      }
      let nextCls = null;
      const supers = [0x40, 0x48, 0x30, 0x38, 0x50];
      for (let s = 0; s < supers.length; s++) {
        try {
          const cand = c.add(supers[s]).readPointer();
          if (!cand || cand.isNull() || cand.equals(c)) continue;
          if (!wpIsUClass(cand)) continue;
          nextCls = cand;
          break;
        } catch (e2) {}
      }
      c = nextCls;
    }
    wpPropCache[key] = map;
    return map;
  }
  function wpReadBool(inst, ent) {
    const byte = inst.add(ent.off).readU8();
    let mask = 0;
    try { mask = ent.node.add(0x7a).readU8(); } catch (e) {}
    return mask ? (byte & mask) !== 0 : byte !== 0;
  }
  function wpFindStreamArr() {
    if (!survPcObj || survPcObj.isNull()) return null;
    let cur = survPcObj;
    let lvl = null;
    for (let i = 0; i < 8 && cur && !cur.isNull(); i++) {
      const cls = cur.add(0x10).readPointer();
      if (!cls.isNull() && objectName(cls) === 'Level') { lvl = cur; break; }
      const nxt = cur.add(0x20).readPointer();
      if (!looksLikeUObject(nxt)) break;
      cur = nxt;
    }
    if (!lvl) return null;
    const world = lvl.add(0x20).readPointer();
    if (!looksLikeUObject(world)) return null;
    for (let woff = 0x20; woff < 0x400; woff += 8) {
      try {
        const data = world.add(woff).readPointer();
        const num = world.add(woff + 8).readS32();
        if (data.isNull() || num < 1 || num > 5000) continue;
        const first = data.readPointer();
        if (!looksLikeUObject(first)) continue;
        const fcn = objectName(first.add(0x10).readPointer());
        if (!/LevelStreaming/i.test(fcn)) continue;
        return { data: data, num: num, off: woff, world: world, lvl: lvl };
      } catch (e) {}
    }
    return null;
  }
  // Procura, no ULevel persistente e no UWorld, ponteiros para objetos cuja classe contem 'Partition' (so leitura).
  var wpPartDone = false;
  var wpLoadPrev = false;
  function wpFindPartitionObj(arr) {
    const cands = [];
    [arr.lvl, arr.world].forEach(function (base, bi) {
      if (!base || base.isNull()) return;
      for (let off = 0x20; off < 0x4000; off += 8) {
        try {
          const p = base.add(off).readPointer();
          if (!looksLikeUObject(p)) continue;
          const cn = objectName(p.add(0x10).readPointer());
          if (/Partition/i.test(cn)) {
            log('WPOBJ base=' + (bi ? 'world' : 'level') + ' off=0x' + off.toString(16) + ' class=' + cn + ' name=' + objectName(p) + ' ptr=' + p);
            cands.push(p);
          }
        } catch (e) {}
      }
    });
    // Cadeia Outer (+0x20) do primeiro objeto de streaming: o Outer costuma ser o WorldPartition.
    try {
      let cur = arr.data.readPointer();
      if (looksLikeUObject(cur)) {
        log('WPOUTER inicio=' + objectName(cur) + ' cls=' + objectName(cur.add(0x10).readPointer()));
        for (let d = 0; d < 8; d++) {
          const up = cur.add(0x20).readPointer();
          if (!looksLikeUObject(up)) { log('WPOUTER fim em d=' + d); break; }
          const ucn = objectName(up.add(0x10).readPointer());
          log('WPOUTER d=' + d + ' name=' + objectName(up) + ' cls=' + ucn + ' ptr=' + up);
          if (/Partition/i.test(ucn)) cands.push(up);
          if (up.equals(cur)) break;
          cur = up;
        }
      }
    } catch (eO) { log('WPOUTER erro: ' + eO); }
    return cands;
  }
  // Procura TArrays no mundo e no nivel cujos elementos sao celulas de runtime do World Partition (so leitura).
  function wpCountCellArrays(arr) {
    const found = [];
    [arr.lvl, arr.world].forEach(function (base, bi) {
      if (!base || base.isNull()) return;
      for (let off = 0x20; off < 0x4000; off += 8) {
        try {
          const data = base.add(off).readPointer();
          const num = base.add(off + 8).readS32();
          if (data.isNull() || num < 1 || num > 5000) continue;
          const first = data.readPointer();
          if (!looksLikeUObject(first)) continue;
          const fcn = objectName(first.add(0x10).readPointer());
          if (!/RuntimeLevelStreamingCell|RuntimeCell|SpatialHash|CellData/i.test(fcn)) continue;
          let good = 0;
          const kinds = {};
          for (let k = 0; k < num && k < 5000; k++) {
            const e = data.add(k * 8).readPointer();
            if (!looksLikeUObject(e)) continue;
            good++;
            const ek = objectName(e.add(0x10).readPointer());
            kinds[ek] = (kinds[ek] || 0) + 1;
          }
          log('WPCELLARR base=' + (bi ? 'world' : 'level') + ' off=0x' + off.toString(16) + ' num=' + num + ' validos=' + good + ' tipos=' + JSON.stringify(kinds));
          found.push({ off: off, num: num });
        } catch (e) {}
      }
    });
    return found;
  }
  // Dump completo, sem filtro, numa unica rodada por carregamento: primeiro objeto de streaming, mundo e nivel persistente.
  var wpFullDone = false;
  function wpFullDump(arr) {
    if (wpFullDone) return;
    wpFullDone = true;
    try {
      const first = arr.data.readPointer();
      if (looksLikeUObject(first)) dumpPropsFor(first, 'FULL_STREAM0', null);
      dumpPropsFor(arr.world, 'FULL_WORLD', null);
      dumpPropsFor(arr.lvl, 'FULL_LEVEL', null);
      log('FULL_DUMP fim');
    } catch (eF) { log('FULL_DUMP erro: ' + eF); }
  }
  function wpScanStreaming() {
    const arr = wpFindStreamArr();
    if (!arr) {
      if (wpStateLast !== 'sem_array') { wpStateLast = 'sem_array'; log('WPSTATE sem array de LevelStreaming'); }
      return;
    }
    // diagnostico one-shot: props do UWorld e do ULevel que apontam para o WorldPartition (contagem de celulas por outra fonte)
    if (!wpDumpDone) {
      wpDumpDone = true;
      try { dumpPropsFor(arr.world, 'WPWORLD', /Partition|Cell|Runtime|Hash|Stream|DataLayer/i); } catch (eD1) { log('WPDUMP erro world: ' + eD1); }
      try { dumpPropsFor(arr.lvl, 'WPLEVEL', /Partition|Cell|Runtime|Hash|Stream/i); } catch (eD2) { log('WPDUMP erro level: ' + eD2); }
    }
    if (!wpFullDone) wpFullDump(arr);
    if (!wpPartDone) {
      wpPartDone = true;
      try {
        const parts = wpFindPartitionObj(arr);
        log('WPOBJ encontrados=' + parts.length);
        try { wpCountCellArrays(arr); } catch (eCA) { log('WPCELLARR erro: ' + eCA); }
        parts.forEach(function (wp, i) {
          dumpPropsFor(wp, 'WPOBJ' + i, /Cell|Hash|Runtime|Stream|Level|Grid|Num|Count|Partition|Map|Set|Array|Actor|Tile|Cluster/i);
          // Segue RuntimeCellData (dados espaciais da celula) e a cadeia Outer ate o hash.
          try {
            const pmW = wpClassPropMap(wp.add(0x10).readPointer());
            if (wpHasKey(pmW, 'RuntimeCellData')) {
              const cd = wp.add(pmW.RuntimeCellData.off).readPointer();
              log('WPCELLDATA' + i + ' ptr=' + cd);
              if (looksLikeUObject(cd)) {
                dumpPropsFor(cd, 'WPCELLDATA' + i, null);
                let cur = cd;
                for (let d = 0; d < 6; d++) {
                  const up = cur.add(0x20).readPointer();
                  if (!looksLikeUObject(up)) { log('WPCELLDATA' + i + ' outer fim d=' + d); break; }
                  log('WPCELLDATA' + i + ' outer d=' + d + ' name=' + objectName(up) + ' cls=' + objectName(up.add(0x10).readPointer()) + ' ptr=' + up);
                  dumpPropsFor(up, 'WPCELLOUT' + i + '_' + d, null);
                  cur = up;
                }
              }
            }
          } catch (eCD) { log('WPCELLDATA erro: ' + eCD); }
        });
      } catch (eP) { log('WPOBJ erro: ' + eP); }
    }
    let total = 0, req = 0, loaded = 0, pending = 0, unknownLoaded = 0;
    let visibleReq = 0, loadedNotVisible = 0;
    const loadedNotVisNames = [];
    const pendNames = [];
    for (let k = 0; k < arr.num && k < 2000; k++) {
      let sl = null;
      try { sl = arr.data.add(k * 8).readPointer(); } catch (e) { continue; }
      if (!looksLikeUObject(sl)) continue;
      total++;
      const cls = sl.add(0x10).readPointer();
      const pm = wpClassPropMap(cls);
      if (!wpCalibDone) {
        wpCalibDone = true;
        const names = Object.keys(pm).filter(function (n) { return /Load|Shoul|Visib|Level|State|Cell|Unload|Request|Stream|Hidden/i.test(n); });
        log('WPCAL arr=0x' + arr.off.toString(16) + ' num=' + arr.num + ' cls=' + objectName(cls) + ' obj=' + objectName(sl) + ' props=' + Object.keys(pm).length);
        names.slice(0, 60).forEach(function (n) {
          log('WPCAL prop ' + n + ' class=' + pm[n].clsName + ' off=0x' + pm[n].off.toString(16));
        });
      }
      let shouldBe = null;
      if (wpHasKey(pm, 'bShouldBeLoaded')) {
        try { shouldBe = wpReadBool(sl, pm.bShouldBeLoaded); } catch (e) {}
      }
      let isLoaded = null;
      const loadKey = ['LoadedLevel', 'LoadedLevelPtr', 'LoadedLevelRef'].find(function (kk) { return wpHasKey(pm, kk); });
      if (loadKey) {
        try { isLoaded = !sl.add(pm[loadKey].off).readPointer().isNull(); } catch (e) {}
      }
      let isVisible = null;
      if (wpHasKey(pm, 'bShouldBeVisible')) {
        try { isVisible = wpReadBool(sl, pm.bShouldBeVisible); } catch (e) {}
      }
      if (shouldBe) req++;
      if (isLoaded === true) loaded++;
      if (isLoaded === null) unknownLoaded++;
      if (isVisible === true) visibleReq++;
      if (isLoaded === true && isVisible !== true) {
        loadedNotVisible++;
        loadedNotVisNames.push(objectName(sl).replace(/^WorldPartitionLevelStreaming_NewCity_persistent_WP_/, ''));
      }
      if (shouldBe && isLoaded !== true) {
        pending++;
        pendNames.push(objectName(sl).replace(/^WorldPartitionLevelStreaming_NewCity_persistent_WP_/, ''));
      }
    }
    const sig = 'total=' + total + ' req=' + req + ' loaded=' + loaded + ' pending=' + pending + ' unknownLoaded=' + unknownLoaded + ' visibleReq=' + visibleReq + ' loadedNotVisible=' + loadedNotVisible;
    if (loadedNotVisNames.length && loadedNotVisSig !== loadedNotVisNames.slice().sort().join(',') && wpStateBudget > 0) {
      wpStateBudget--;
      loadedNotVisSig = loadedNotVisNames.slice().sort().join(',');
      log('WPLNV n=' + loadedNotVisNames.length + ' names=' + loadedNotVisNames.slice(0, 40).join(','));
    }
    if (sig !== wpStateLast && wpStateBudget > 0) {
      wpStateBudget--;
      wpStateLast = sig;
      log('WPSTATE ' + sig + ' monitorN=' + monitorN);
    }
    try { wpGateProbe(arr); } catch (eG) { log('GATE erro: ' + eG); }
    const pendSig = pendNames.slice().sort().join(',');
    if (pendSig !== wpPendLast && wpStateBudget > 0) {
      wpStateBudget--;
      wpPendLast = pendSig;
      log('WPPEND n=' + pendNames.length + ' names=' + pendNames.slice(0, 40).join(','));
    }
  }
  // Sonda read-only do portao nativo GetCurrentLevelLoadedFull (engine: 142107730 -> 144249110):
  // para cada LevelStreaming do mundo do terreno, compara bShouldBeLoaded/LoadedLevel e bShouldBeVisible com o flag +0x234 bit 0x20 do nivel carregado.
  // So roda quando o mundo atual e o terreno (NewCity/persistent_WP); o mapa inicial e ignorado.
  var wpGateWaitLogged = false;
  var wpGateSig = '';
  var wpGateSample = 0;
  var wpGateBudget = 0;
  function wpGateProbe(arr) {
    if (!arr || !arr.world) return;
    const wname = objectName(arr.world);
    if (!/NewCity|persistent_WP/i.test(wname)) {
      if (!wpGateWaitLogged) { wpGateWaitLogged = true; log('GATE aguardando mapa do terreno; mundo atual=' + wname); }
      return;
    }
    const mism = [];
    for (let k = 0; k < arr.num && k < 2000; k++) {
      let sl = null;
      try { sl = arr.data.add(k * 8).readPointer(); } catch (e) { continue; }
      if (!looksLikeUObject(sl)) continue;
      try {
        const pm = wpClassPropMap(sl.add(0x10).readPointer());
        const nm = objectName(sl).replace(/^WorldPartitionLevelStreaming_NewCity_persistent_WP_/, '');
        const shouldBe = wpHasKey(pm, 'bShouldBeLoaded') ? wpReadBool(sl, pm.bShouldBeLoaded) : null;
        const shouldVis = wpHasKey(pm, 'bShouldBeVisible') ? wpReadBool(sl, pm.bShouldBeVisible) : null;
        const lk = ['LoadedLevel', 'LoadedLevelPtr', 'LoadedLevelRef'].find(function (kk) { return wpHasKey(pm, kk); });
        const lp = lk ? sl.add(pm[lk].off).readPointer() : ptr(0);
        const hasLvl = !lp.isNull();
        let flag = -1;
        if (hasLvl) { try { flag = lp.add(0x234).readU8(); } catch (eF) {} }
        const visBit = flag >= 0 ? ((flag & 0x20) !== 0) : null;
        const bad = (shouldBe !== null && shouldBe !== hasLvl) || (shouldVis !== null && visBit !== null && shouldVis !== visBit);
        if (wpGateSample < 3) {
          wpGateSample++;
          log('GATE amostra ' + nm + ' lvl=' + lp + ' flag234=' + flag + ' shouldBeLoaded=' + shouldBe + ' shouldBeVisible=' + shouldVis);
        }
        if (bad) mism.push(nm + '(load=' + shouldBe + '/' + hasLvl + ',vis=' + shouldVis + '/' + visBit + ')');
      } catch (eK) {}
    }
    const sig = mism.slice().sort().join(';');
    if (sig !== wpGateSig && wpGateBudget > 0) {
      wpGateBudget--;
      wpGateSig = sig;
      log('GATE mism=' + mism.length + ' ' + mism.slice(0, 60).join(' '));
    }
  }
  // Sonda read-only do timer de carregamento do GI_Survival: mostra o valor de LoadLevelTimerHandle (0 = nao agendado).
  var tmrLastSig = '';
  var tmrBudget = 0;
  // Procura o GI_Survival dentro do UWorld do terreno (somente leitura), caso nao tenha sido capturado por hook.
  function findGiObj() {
    if (globalThis.__giObj && !globalThis.__giObj.isNull()) return globalThis.__giObj;
    const arr = wpFindStreamArr();
    if (!arr || !arr.world) return null;
    for (let off = 0x20; off < 0x1000; off += 8) {
      try {
        const p = arr.world.add(off).readPointer();
        if (!looksLikeUObject(p)) continue;
        const cls = p.add(0x10).readPointer();
        if (/GI_Survival/i.test(objectName(cls))) {
          globalThis.__giObj = p;
          log('TIMER GI encontrado via world off=0x' + off.toString(16) + ' ' + p);
          return p;
        }
      } catch (e) {}
    }
    return null;
  }
  function timerProbe(bLoad) {
    if (tmrBudget <= 0) return;
    const gi = findGiObj();
    if (!gi || gi.isNull()) { tmrBudget--; log('TIMER gi nao encontrado'); return; }
    try {
      const pm = wpClassPropMap(gi.add(0x10).readPointer());
      if (!wpHasKey(pm, 'LoadLevelTimerHandle')) { tmrBudget--; log('TIMER sem prop LoadLevelTimerHandle'); return; }
      const h = gi.add(pm.LoadLevelTimerHandle.off).readU64().toString();
      const sig = 'handle=' + h + ' load=' + bLoad;
      if (sig !== tmrLastSig) {
        tmrBudget--;
        tmrLastSig = sig;
        log('TIMER ' + sig + ' gi=' + gi + ' off=0x' + pm.LoadLevelTimerHandle.off.toString(16));
      }
    } catch (eT) { tmrBudget--; log('TIMER erro: ' + eT); }
  }
  // Sonda read-only de progresso: le do SurvPC as propriedades numericas ligadas a progresso/total/contagem.
  // Loga so quando algum valor muda (PROG). Serve para achar a origem da porcentagem da tela de carregamento.
  var progLastSig = '';
  var progBudget = 0;
  function progProbe(bLoad) {
    if (progBudget <= 0 || !survPcObj || survPcObj.isNull()) return;
    try {
      const pmP = wpClassPropMap(survPcObj.add(0x10).readPointer());
      const names = Object.keys(pmP).filter(function (n) { return /Progress|Total|Max|Count|Step|Loaded|Percent|Loading/i.test(n); }).slice(0, 40);
      const parts = names.map(function (n) {
        const e = pmP[n];
        let iv = 'x', fv = 'x';
        try { iv = survPcObj.add(e.off).readS32(); } catch (a) {}
        try { fv = survPcObj.add(e.off).readFloat(); } catch (b) {}
        return n + '=' + iv + '/' + fv;
      });
      const sig = 'load=' + bLoad + ' ' + parts.join(' ');
      if (sig !== progLastSig) {
        progBudget--;
        progLastSig = sig;
        log('PROG ' + sig);
      }
    } catch (eP) { progBudget--; log('PROG erro: ' + eP); }
  }
  // Sonda read-only do widget da tela de carregamento: le SurvPC.LoadingScreen e loga as propriedades numericas do widget (PWIDGET).
  var wgLastSig = '';
  var wgBudget = 0;
  var wgClassLogged = false;
  // O widget fica no HUD (PlayerController.MyHUD @0x340 = BP_GameHUD_C). Lista uma vez as ObjectProperty do HUD
  // e acompanha os numeros de qualquer objeto cujo nome/classe sugira carregamento, tela ou progresso.
  function widgetProbe(bLoad) {
    if (wgBudget <= 0 || !survPcObj || survPcObj.isNull()) return;
    try {
      const hud = survPcObj.add(0x340).readPointer();
      if (!looksLikeUObject(hud)) {
        if (wgLastSig !== 'semhud') { wgBudget--; wgLastSig = 'semhud'; log('PWIDGET HUD invalido ptr=' + hud); }
        return;
      }
      const pmH = wpClassPropMap(hud.add(0x10).readPointer());
      const objs = [];
      const listing = [];
      Object.keys(pmH).forEach(function (n) {
        const e = pmH[n];
        if (!/ObjectProperty/.test(e.clsName || '')) return;
        let p = null;
        try { p = hud.add(e.off).readPointer(); } catch (eR) { return; }
        if (!looksLikeUObject(p)) { listing.push(n + '=null'); return; }
        const cn = objectName(p.add(0x10).readPointer());
        listing.push(n + '=' + cn);
        if (/Load|Percent|Progress|Screen|Splash/i.test(n + ' ' + cn)) objs.push({ n: n, p: p, cn: cn });
      });
      if (!wgClassLogged) {
        wgClassLogged = true;
        log('PWIDGET HUD=' + objectName(hud) + ' classe=' + objectName(hud.add(0x10).readPointer()) + ' objetos: ' + listing.slice(0, 60).join(' '));
      }
      const parts = [];
      objs.slice(0, 4).forEach(function (o) {
        const pmW = wpClassPropMap(o.p.add(0x10).readPointer());
        const names = Object.keys(pmW).filter(function (n) { return /Percent|Progress|Pct|Value|Load|Bar|Fill|Ratio|Current|Total|Max|Step|Done|Complete|Count/i.test(n); }).slice(0, 30);
        names.forEach(function (n) {
          const e = pmW[n];
          let iv = 'x', fv = 'x';
          try { iv = o.p.add(e.off).readS32(); } catch (a) {}
          try { fv = o.p.add(e.off).readFloat(); } catch (b) {}
          parts.push(o.n + '.' + n + '=' + iv + '/' + fv);
        });
        if (!names.length) parts.push(o.n + '(' + o.cn + ') sem props numericas');
      });
      const sig = 'load=' + bLoad + ' alvos=' + objs.map(function (o) { return o.n + ':' + o.cn; }).join(',') + ' ' + parts.join(' ');
      if (sig !== wgLastSig) {
        wgBudget--;
        wgLastSig = sig;
        log('PWIDGET ' + sig);
      }
    } catch (eW) { wgBudget--; log('PWIDGET erro: ' + eW); }
  }
  function monitorTick() {
    if (!survPcObj || survPcObj.isNull()) { log('MONITOR sem PC'); return; }
    const bLoad = survPcObj.add(0xaf0).readU8() & 1;
    const bRend = survPcObj.add(0x950).readU8() & 1;
    const bBlack = survPcObj.add(0xad0).readPointer();
    const pawnNow = survPawnObj && !survPawnObj.isNull() ? survPawnObj : null;
    const st = 'load=' + bLoad + ' rendered=' + bRend + ' blackScreen=' + (bBlack.isNull() ? 'null' : 'set');
    monitorN++;
    // rearma a sonda do World Partition a cada inicio de carregamento (load 0 -> 1), para pegar o terreno acessado pela porta
    if (bLoad && !wpLoadPrev) { wpPartDone = false; wpFullDone = false; wpGateBudget = 60; wpGateSig = ''; tmrBudget = 80; tmrLastSig = ''; progBudget = 120; progLastSig = ''; wgBudget = 200; wgLastSig = ''; log('WPPART rearmado no inicio do carregamento n=' + monitorN); }
    if (bLoad) timerProbe(bLoad);
    if (bLoad) progProbe(bLoad);
    if (bLoad) widgetProbe(bLoad);
    wpLoadPrev = !!bLoad;
    // resumo do streaming do World Partition: so loga quando a contagem de celulas mostradas muda
    if (wpShownCount !== wpSumLast) {
      wpSumLast = wpShownCount;
      log('WPCELLS shown=' + wpShownCount + ' landscape=' + landscapeShown + ' load=' + bLoad + ' rendered=' + bRend + ' n=' + monitorN);
    }
    // estado por celula (pedido / carregado / pendente) a cada 3 ticks
    wpScanTick++;
    if (wpScanTick % 3 === 0) {
      try { wpScanStreaming(); } catch (eWS) { log('WPSTATE erro: ' + eWS); }
    }
    // loga a cada 1s, mas marca mudancas de estado com MONITOR_CHANGE
    if (st !== monitorLast) {
      log('MONITOR_CHANGE n=' + monitorN + ' ' + st + ' pawn=' + (pawnNow ? 'ok' : 'null'));
      monitorLast = st;
    } else {
      log('MONITOR n=' + monitorN + ' ' + st);
    }
  }
  function cmdTarget(nome) {
    try {
      if (nome === 'inst') return probeInst;
      if (nome === 'pawn') return survPawnObj;
      if (nome === 'ph') return placeholderObj;
      if (nome === 'pc') return survPcObj;
      if (nome === 'gi') return globalThis.__giObj || null;
      if (nome === 'hud') return survPcObj && !survPcObj.isNull() ? survPcObj.add(0x340).readPointer() : null;
      // v6.3: W_BlackScreen (HUD.BlackScreen) e ponteiro generico ptr:0x... (validado por looksLikeUObject).
      if (nome === 'bs') {
        if (!survPcObj || survPcObj.isNull()) return null;
        const hudB = survPcObj.add(0x340).readPointer();
        const pb = lsProp(hudB, 'BlackScreen', 'ptr');
        if (pb && !pb.isNull() && !looksLikeUObject(pb)) {
          try { log('BS_RESOLVE: looksLikeUObject recusou ' + pb + ' vt=' + pb.readPointer() + ' main=' + main.base + '+' + main.size + ' name=' + objectName(pb)); } catch (eBR) { log('BS_RESOLVE erro ' + eBR); }
        }
        return pb && !pb.isNull() ? pb : null; // v6.9: aceita o ponteiro mesmo se a checagem falhar (diagnostico no log)
      }
      if (typeof nome === 'string' && nome.indexOf('ptr:') === 0) {
        const pp = ptr(nome.substring(4));
        return pp && !pp.isNull() && looksLikeUObject(pp) ? pp : null;
      }
      // Componentes do pawn (offsets absolutos, via TREE PAWN / props):
      // BreathSprint(FMOD) @0x7c8, BreathSystem(FMOD) @0x7d0, BPC_BarPlayerComponent @0x7c0,
      // BPC_PlayerStatsComponent @0x898, CharMoveComp (CharacterMovementComponent) @0x320.
      if (nome === 'breath' || nome === 'breathsprint' || nome === 'bar' || nome === 'stats' || nome === 'cmc') {
        if (!survPawnObj || survPawnObj.isNull()) return null;
        const offsPawn = { breath: 0x7d0, breathsprint: 0x7c8, bar: 0x7c0, stats: 0x898, cmc: 0x320 };
        const bp = survPawnObj.add(offsPawn[nome]).readPointer();
        return bp && !bp.isNull() ? bp : null;
      }
      // Componentes de quest do pawn (offsets confirmados por props): QuestComponentV4 @0x8c0, QuestSystemComp @0x8c8.
      if (nome === 'qsc' || nome === 'qcv4') {
        if (!survPawnObj || survPawnObj.isNull()) return null;
        const offsQ = { qcv4: 0x8c0, qsc: 0x8c8 };
        const qp = survPawnObj.add(offsQ[nome]).readPointer();
        return qp && !qp.isNull() && looksLikeUObject(qp) ? qp : null;
      }
      // PlayerCutsceneComponent do pawn (offset 0x4660, confirmado por props).
      if (nome === 'cutcomp') {
        if (!survPawnObj || survPawnObj.isNull()) return null;
        const cp = survPawnObj.add(0x4660).readPointer();
        return cp && !cp.isNull() && looksLikeUObject(cp) ? cp : null;
      }
      if (nome === 'subfem') return subFem;
      if (nome === 'submasc') return subMasc;
      // Alvos vivos: rele o campo da instancia na hora (a sub-instancia
      // e recriada com o tempo; o ponteiro guardado apodrece).
      if (nome === 'subfemlive' || nome === 'submasclive') {
        if (!probeInst) return null;
        const p = probeInst.add(nome === 'subfemlive' ? 0x9840 : 0x9788).readPointer();
        return p && !p.isNull() && looksLikeUObject(p) ? p : null;
      }
      if (nome === 'mesh') {
        const comps = findMeshComps();
        for (let i = 0; i < comps.length; i++) {
          if (objectName(comps[i]) === 'CharacterMesh0') return comps[i];
        }
      }
    } catch (e) {}
    return null;
  }
  // CSHOOK (so log): entrada e saida de CutsceneBegin e CutsceneFinish (funcoes de Blueprint do PCC).
  // A Func de uma UFunction de Blueprint aponta para a ProcessInternal (VM); o hook e instalado nessa Func lida em runtime
  // (UFunction+0xd8), sem RVA fixo. Em cada chamada, procura nos primeiros 0x100 bytes do FFrame (args[1]) o ponteiro
  // igual a UFunction de CutsceneBegin ou CutsceneFinish, e so loga quando bate. onLeave registra o retorno dessa chamada.
  var csHookInstalled = false;
  var csFns = null;
  function installCsHook(pcc) {
    if (csHookInstalled || !pcc || pcc.isNull()) return;
    try {
      const ufBegin = findUFnWide(pcc, 'CutsceneBegin');
      const ufFinish = findUFnWide(pcc, 'CutsceneFinish');
      if (!ufBegin || ufBegin.isNull() || !ufFinish || ufFinish.isNull()) { log('CSHOOK UFunction NULL'); return; }
      const pi = ufBegin.add(0xd8).readPointer();
      const ufUber = findUFnWide(pcc, 'ExecuteUbergraph_PlayerCutsceneComponent');
      csFns = { begin: ufBegin.toString(), finish: ufFinish.toString(), uber: ufUber && !ufUber.isNull() ? ufUber.toString() : '-' };
      csHookInstalled = true;
      Interceptor.attach(pi, {
        onEnter: function (args) {
          this.tag = null;
          this.off = -1;
          this.nptr = 0;
          try {
            const frame = args[1];
            if (frame && !frame.isNull()) {
              for (let off = 0; off <= 0x100; off += 8) {
                const s = frame.add(off).readPointer().toString();
                if (s !== '0x0') this.nptr++;
                if (s === csFns.begin) { this.tag = 'CutsceneBegin'; this.off = off; break; }
                if (s === csFns.finish) { this.tag = 'CutsceneFinish'; this.off = off; break; }
                if (s === csFns.uber) { this.tag = 'ExecuteUbergraph'; this.off = off; break; }
              }
            }
          } catch (eE) {}
          if (this.tag) log('CSHOOK enter ' + this.tag + ' self=' + args[0] + ' nome=' + objectName(args[0]) + ' ptrFrameOff=' + this.off + ' nptr=' + this.nptr);
          // EntryPoint (candidatos): o parametro do ubergraph fica na memoria de parametros do FFrame. Procura int32 com os
          // offsets conhecidos de entrada (12174 = CutsceneBegin, 12968 = CutsceneBegin do PCC, 1456 = op de CutsceneFinish).
          if (this.tag === 'ExecuteUbergraph') {
            try {
              const frame2 = args[1];
              for (let o2 = 0; o2 <= 0x100; o2 += 8) {
                try {
                  const p2 = frame2.add(o2).readPointer();
                  if (!p2 || p2.isNull()) continue;
                  const v2 = p2.readS32();
                  if (v2 === 12174 || v2 === 12968 || v2 === 1456) log('CSHOOK UBER entry cand frameOff=' + o2 + ' ptr=' + p2 + ' valor=' + v2);
                } catch (eP2) {}
              }
            } catch (eU) {}
          }
        },
        onLeave: function (retval) {
          if (this.tag) log('CSHOOK leave ' + this.tag + ' ptrFrameOff=' + this.off);
        },
      });
      log('CSHOOK instalado Func=' + pi + ' begin=' + csFns.begin + ' finish=' + csFns.finish);
    } catch (eI) { log('CSHOOK erro ' + eI); }
  }
  // Hook de log em Character::Jump (opcao A). Instalada automaticamente quando o
  // pawn aparece (fase >= WAIT_PAWN), ou sob demanda via cmd 'hookjump'.
  // Valida que o ponteiro Func (UFunction+0xd8) cai dentro do modulo do exe.
  function installJumpHook(origem) {
    try {
      if (jumpHooked) return true;
      if (!survPawnObj || survPawnObj.isNull()) return false;
      const jfn = findUFnWide(survPawnObj, 'Jump');
      if (!jfn || jfn.isNull()) { log('HOOKJUMP UFunction Jump NULL (' + origem + ')'); return false; }
      const jfunc = jfn.add(0xd8).readPointer();
      const jmod = jfunc && !jfunc.isNull() ? Process.findModuleByAddress(jfunc) : null;
      if (!jmod) { log('HOOKJUMP Func fora do modulo ' + jfunc + ' (' + origem + ')'); return false; }
      jumpHooked = true;
      Interceptor.attach(jfunc, {
        onEnter(args) {
          log('JUMP_NATIVE self=' + args[0] + ' phase=' + phase);
        }
      });
      log('HOOKJUMP instalado Func=' + jfunc + ' modulo=' + jmod.name + ' UFunction=' + jfn + ' (' + origem + ')');
      return true;
    } catch (eHJ) {
      log('HOOKJUMP exc ' + eHJ);
      return false;
    }
  }
  // v6.4 seq99: sequencia manual para sair do loading travado em 99%. Cada passo reusa execCmd (mesmos alvos/chamadas dos ids 1027-1035).
  // modo 'natural' (padrao): NAO chama CutsceneFinish; observa se a cena termina sozinha (EnteredWorld/banner). modo 'forcar': chama CutsceneFinish no fim.
  // Opcoes do cmd: esperar (ms entre EndLoadingScreen e Close, padrao 3000), pawn (ptr do pawn A; padrao: primeira instancia em lsPawns).
  // v6.5 seq99 modo 'camera': move o ViewTarget para o pawn A com o loading ainda ligado, espera as celulas do World Partition
  // carregarem (OnLevelShown) e so depois faz EndLoadingScreen + Close. Opcoes: ate (s de espera, padrao 40), parar (true = so espera/observa).
  function runSeq99Camera(c) {
    const TAG = 'SEQ99C';
    const ate = (c.ate || 40) * 1000;
    let n = 0;
    function sub(o) { n++; o.id = c.id + '.' + n; execCmd(o); }
    function estado(label) {
      try {
        const cc = cmdTarget('cutcomp');
        if (cc) dumpPropsFor(cc, TAG + '_' + label, /^(LSPlayer|PlayerInCutscene)$/);
        log(TAG + ' ' + label + ' pawn=' + (survPawnObj ? objectName(survPawnObj) + '@' + survPawnObj : 'null') + ' shown=' + (globalThis.__lvlShown || 0));
      } catch (eE) { log(TAG + ' estado erro ' + eE); }
    }
    let pA = null;
    try {
      if (c.pawn) pA = ptr(c.pawn);
      else { const ks = Object.keys(lsPawns); if (ks.length) pA = ptr(ks[0]); }
    } catch (eP) {}
    if (!pA || pA.isNull() || !survPcObj || survPcObj.isNull()) { log(TAG + ' abortado: pawn A=' + pA + ' pc=' + survPcObj); return; }
    globalThis.__lvlShown = 0; globalThis.__lvlShownNames = []; globalThis.__lvlShownAt = 0;
    const t0 = Date.now();
    log(TAG + ' inicio ate=' + (ate / 1000) + 's parar=' + !!c.parar + ' pawnA=' + pA);
    estado('antes');
    sub({ cmd: 'call', alvo: 'pc', fn: 'SetViewTargetWithBlend', buf: [
      { off: 0, tipo: 'ptr', valor: pA.toString() }, { off: 8, tipo: 'f32', valor: 0 }, { off: 12, tipo: 'u8', valor: 0 },
      { off: 16, tipo: 'f32', valor: 0 }, { off: 20, tipo: 'u8', valor: 0 }] });
    function finalizar() {
      log(TAG + ' espera concluida shown=' + (globalThis.__lvlShown || 0) + ' nomes=' + (globalThis.__lvlShownNames || []).join('|'));
      estado('fim_espera');
      if (c.parar) { log(TAG + ' parar=true: NAO chamo EndLoadingScreen/Close'); return; }
      try { const fb = survPcObj.add(0xaf0); const v0 = fb.readU8(); fb.writeU8(v0 | 1); log(TAG + ' IsLoadingScreen byte ' + v0 + ' -> ' + fb.readU8()); } catch (e1) { log(TAG + ' passo IsLoadingScreen erro ' + e1); }
      sub({ cmd: 'call', alvo: 'pc', fn: 'EndLoadingScreen', retLen: 8, buf: [] });
      setTimeout(function () {
        estado('apos_endloading');
        sub({ cmd: 'call', alvo: 'bs', fn: 'Close', retLen: 8, buf: [{ off: 0, tipo: 'u8', valor: 0 }] });
        setTimeout(function () { estado('t+5s'); }, 5000);
        setTimeout(function () { estado('t+15s'); }, 15000);
        setTimeout(function () { estado('t+30s'); log(TAG + ' fim'); }, 30000);
      }, c.esperar || 3000);
    }
    const iv = setInterval(function () {
      const el = Date.now() - t0;
      let loc = '?';
      try { const l = lsActorLoc(pA); if (l) loc = l.join(','); } catch (eL) {}
      log(TAG + ' t=' + Math.round(el / 1000) + 's shown=' + (globalThis.__lvlShown || 0) + ' ultimoShown=' + (globalThis.__lvlShownAt ? Math.round((Date.now() - globalThis.__lvlShownAt) / 1000) + 's atras' : 'nunca') + ' pawnA=' + loc);
      if (el >= ate) { clearInterval(iv); finalizar(); }
    }, 2000);
  }
  function runSeq99(c) {
    const TAG = 'SEQ99';
    if (c.modo === 'camera') { runSeq99Camera(c); return; }
    const modo = c.modo || 'natural';
    const esperar = c.esperar || 3000;
    let n = 0;
    function sub(o) { n++; o.id = c.id + '.' + n; execCmd(o); }
    function estado(label) {
      try {
        const cc = cmdTarget('cutcomp');
        if (cc) dumpPropsFor(cc, TAG + '_' + label, /^(LSPlayer|PlayerInCutscene)$/);
        else log(TAG + ' ' + label + ' cutcomp null');
        log(TAG + ' ' + label + ' pawn=' + (survPawnObj ? objectName(survPawnObj) + '@' + survPawnObj : 'null') + ' bs=' + cmdTarget('bs'));
      } catch (eE) { log(TAG + ' estado erro ' + eE); }
    }
    let pA = null;
    try {
      if (c.pawn) pA = ptr(c.pawn);
      else { const ks = Object.keys(lsPawns); if (ks.length) pA = ptr(ks[0]); }
    } catch (eP) {}
    if (!pA || pA.isNull() || !survPcObj || survPcObj.isNull()) { log(TAG + ' abortado: pawn A=' + pA + ' pc=' + survPcObj); return; }
    log(TAG + ' inicio modo=' + modo + ' esperar=' + esperar + ' pawnA=' + pA + ' lsPawns=' + Object.keys(lsPawns).join(','));
    estado('antes');
    // 1) IsLoadingScreen=1 (off 0xaf0 bit 0x1)
    try { const fb = survPcObj.add(0xaf0); const v0 = fb.readU8(); fb.writeU8(v0 | 1); log(TAG + ' passo1 IsLoadingScreen byte ' + v0 + ' -> ' + fb.readU8()); } catch (e1) { log(TAG + ' passo1 erro ' + e1); }
    // 2) SurvPC.EndLoadingScreen (percentual -> 100)
    sub({ cmd: 'call', alvo: 'pc', fn: 'EndLoadingScreen', retLen: 8, buf: [] });
    setTimeout(function () {
      // 3) W_BlackScreen.Close(OnCar=0)
      estado('apos_endloading');
      sub({ cmd: 'call', alvo: 'bs', fn: 'Close', retLen: 8, buf: [{ off: 0, tipo: 'u8', valor: 0 }] });
      setTimeout(function () {
        // 4) Possess(A)
        sub({ cmd: 'call', alvo: 'pc', fn: 'Possess', buf: [{ off: 0, tipo: 'ptr', valor: pA.toString() }] });
        setTimeout(function () {
          // 5) SetViewTargetWithBlend(A, 0, 0, 0, 0)
          sub({ cmd: 'call', alvo: 'pc', fn: 'SetViewTargetWithBlend', buf: [
            { off: 0, tipo: 'ptr', valor: pA.toString() }, { off: 8, tipo: 'f32', valor: 0 }, { off: 12, tipo: 'u8', valor: 0 },
            { off: 16, tipo: 'f32', valor: 0 }, { off: 20, tipo: 'u8', valor: 0 }] });
          setTimeout(function () {
            if (modo === 'forcar') sub({ cmd: 'call', alvo: 'cutcomp', fn: 'CutsceneFinish', retLen: 8, buf: [] });
            else log(TAG + ' modo natural: CutsceneFinish NAO chamado');
            setTimeout(function () { estado('t+5s'); }, 5000);
            setTimeout(function () { estado('t+15s'); }, 15000);
            setTimeout(function () { estado('t+30s'); log(TAG + ' fim'); }, 30000);
          }, 2000);
        }, 1000);
      }, 1500);
    }, esperar);
  }
  function execCmd(c) {
    try {
      log('CMD exec id=' + c.id + ' cmd=' + c.cmd + ' alvo=' + (c.alvo || '-'));
      if (c.cmd === 'seq99') { runSeq99(c); return; }
      if (c.cmd === 'call' && /EndLoadingScreen|DelayNePashet|^Close$|RemoveLoadingScreen/.test(c.fn || '')) {
        lsWideUntil = Date.now() + 25000;
        lsWorldAt = 0;
        for (const k in lsFlagsSig) delete lsFlagsSig[k];
        lsFlagsBudget = 900;
        if (lsFlagsTimer) clearInterval(lsFlagsTimer);
        lsFlagsTimer = setInterval(function () { try { lsFlagsTick(); } catch (eLF) {} }, 200);
        try { lsFlagsTick(); } catch (eLF0) {}
        log('LSWIDE janela aberta 25s (antes da chamada ' + c.fn + ')');
      }
      if (c.cmd === 'ritual') {
        ritualMode = (typeof c.modo === 'number') ? c.modo : ritualMode;
        log('CMD ritual modo=' + ritualMode);
        return;
      }
      if (c.cmd === 'scan') { execNodeScan(); return; }
      if (c.cmd === 'tag') {
        const tfn = findUFnWide(probeInst, 'GetLinkedAnimGraphInstanceByTag');
        if (!tfn) { log('CMD tag fn NULL'); return; }
        const ii = findFNameIndices([c.tag]);
        const ti = ii[c.tag];
        log('CMD tag ' + c.tag + ' fname=' + ti);
        if (ti < 0) return;
        const buf = Memory.alloc(32);
        for (let i = 0; i < 32; i++) buf.add(i).writeU8(0);
        buf.writeU32(ti >>> 0);
        processEventFn(probeInst, tfn, buf);
        const r = buf.add(8).readPointer();
        log('CMD tag ret=' + (r && !r.isNull() ? r + ' nome=' + objectName(r) : 'NULL'));
        return;
      }
      if (c.cmd === 'hookjump') {
        if (jumpHooked) log('HOOKJUMP ja instalado');
        else installJumpHook('cmd');
        return;
      }
      if (c.cmd === 'watchgs') { watchGameServerOnce(); return; }
      const alvo = c.alvo ? cmdTarget(c.alvo) : null;
      if (!alvo && c.alvo !== 'chris') { log('CMD alvo indisponivel'); return; }
      if (c.cmd === 'enumfns') {
        let aCls = null;
        try { aCls = alvo.add(0x10).readPointer(); } catch (eA) {}
        if (!aCls || aCls.isNull()) { log('CMD enumfns sem classe'); return; }
        enumAnimFns(aCls, 'CMDFNS', c.filtro ? new RegExp(c.filtro, 'i') : /./, c.limite || 80);
        return;
      }
      // FNADDR: endereco do UFunction e do ponteiro Func (+0xd8) de cada funcao GPS.
      // Func de funcao de Blueprint aponta para a ProcessInternal (VM); com isso
      // o hook pode ser colocado na VM e pegar chamadas internas do grafo.
      if (c.cmd === 'fnaddr') {
        const nomesFA = c.nomes || [
          'EquipGpsServer',
          'SpawnGPSMulticast',
          'DestroyGPSMulticast',
          'InpActEvt_EquipGPS_K2Node_InputActionEvent_27',
          'ExecuteUbergraph_SurvivalPlayer'
        ];
        for (let k = 0; k < nomesFA.length; k++) {
          try {
            const ufnFA = findUFnWide(alvo, nomesFA[k]);
            if (!ufnFA || ufnFA.isNull()) {
              log('FNADDR ' + nomesFA[k] + ' = NULL');
              continue;
            }
            const funcFA = ufnFA.add(0xd8).readPointer();
            let modOff = 'fora-do-modulo';
            try {
              const mb = main.base;
              const ms = main.size;
              if (funcFA.compare(mb) >= 0 && funcFA.compare(mb.add(ms)) < 0) {
                modOff = 'RVA=0x' + funcFA.sub(mb).toString(16);
              }
            } catch (eMo) {}
            log(
              'FNADDR ' + nomesFA[k] + ' ufn=' + ufnFA + ' Func(+0xd8)=' + funcFA +
                ' ' + modOff + ' flags=0x' + ufnFA.add(0xb0).readU32().toString(16)
            );
          } catch (eFA) {
            log('FNADDR ' + nomesFA[k] + ' ERRO ' + eFA);
          }
        }
        return;
      }
      if (c.cmd === 'fnparms') {
        const fn = findUFnWide(alvo, c.fn);
        log('CMD fnparms ' + c.fn + ' = ' + (fn ? 'ok' : 'NULL'));
        if (fn) dumpAnimFnParms(fn, c.fn);
      } else if (c.cmd === 'monitor') {
        monitorOn = !!c.valor;
        monitorAt = 0;
        monitorLast = '';
        log('CMD monitor ' + (monitorOn ? 'LIGADO' : 'DESLIGADO'));
      } else if (c.cmd === 'setfstr') {
        // Grava texto no buffer JA EXISTENTE de um FString (campo em alvo+off).
        // FString: Data ptr @0, Num (i32, inclui terminador) @8, Max (i32) @12.
        // Nao aloca memoria nova: so escreve se o texto couber em Max.
        const fsP = alvo.add(c.off || 0);
        const fsData = fsP.readPointer();
        const fsNum = fsP.add(8).readS32();
        const fsMax = fsP.add(12).readS32();
        const fsTxt = String(c.valor || '');
        const fsNeed = fsTxt.length + 1;
        if (fsData.isNull() || fsNeed > fsMax) {
          log('CMD setfstr RECUSADO capacidade data=' + fsData + ' max=' + fsMax + ' need=' + fsNeed);
          return;
        }
        let fsAntes = '';
        for (let q = 0; q < fsNum - 1 && q < 64; q++) fsAntes += String.fromCharCode(fsData.add(q * 2).readU16());
        for (let q = 0; q < fsTxt.length; q++) fsData.add(q * 2).writeU16(fsTxt.charCodeAt(q));
        fsData.add(fsTxt.length * 2).writeU16(0);
        fsP.add(8).writeS32(fsNeed);
        log('CMD setfstr off=0x' + (c.off || 0).toString(16) + ' antes="' + fsAntes + '" depois="' + fsTxt + '" num=' + fsNeed + ' max=' + fsMax);
      } else if (c.cmd === 'pelog') {
        // v82 (somente leitura): {"id":N,"cmd":"pelog","on":true,"tag":"terreno","limite":400}
        pelogOn = !!c.on;
        pelogTag = c.tag || '';
        pelogLeft = c.limite || 400;
        log('CMD pelog on=' + pelogOn + ' tag=' + pelogTag + ' limite=' + pelogLeft);
      } else if (c.cmd === 'write') {
        const woff = c.off || 0;
        const wp = alvo.add(woff);
        const wt = c.tipo || 'f64';
        let antes = null;
        if (wt === 'f64') antes = wp.readDouble();
        else if (wt === 'f32') antes = wp.readFloat();
        else if (wt === 'u8') antes = wp.readU8();
        if (wt === 'f64') wp.writeDouble(c.valor);
        else if (wt === 'f32') wp.writeFloat(c.valor);
        else if (wt === 'u8') wp.writeU8(c.valor & 0xff);
        else { log('CMD write tipo desconhecido: ' + wt); return; }
        log('CMD write ' + c.alvo + '+0x' + woff.toString(16) + ' tipo=' + wt + ' antes=' + antes + ' depois=' + c.valor);
      } else if (c.cmd === 'props') {
        dumpPropsFor(alvo, 'CMDPROPS', c.filtro ? new RegExp(c.filtro, 'i') : null);
      } else if (c.cmd === 'arr') {
        const ap = alvo.add(c.off || 0);
        const adata = ap.readPointer();
        const anum = ap.add(8).readS32();
        const amax = ap.add(12).readS32();
        log('CMD arr ' + c.alvo + '+0x' + (c.off || 0).toString(16) + ' data=' + adata + ' num=' + anum + ' max=' + amax);
        for (let q = 0; q < Math.min(anum, 32); q++) {
          try {
            const ep = adata.add(q * 16);
            const sp = ep.readPointer();
            const sn = ep.add(8).readS32();
            const sv = sp.isNull() || sn <= 0 ? '' : sp.readUtf16String(sn);
            log('CMD arr[' + q + '] len=' + sn + ' str=' + JSON.stringify(sv));
          } catch (eA) {
            log('CMD arr[' + q + '] erro ' + eA);
          }
        }
      } else if (c.cmd === 'read') {
        const off = c.off || 0;
        const len = c.len || 64;
        const base = alvo.add(off);
        log('CMD read ' + c.alvo + '+0x' + off.toString(16) + ' = ' + hexBytes(base, len));
        for (let q = 0; q + 8 <= len; q += 8) {
          try {
            const p = base.add(q).readPointer();
            if (p && !p.isNull() && looksLikeUObject(p)) {
              log('CMD read ptr@+0x' + q.toString(16) + ' = ' + p + ' nome=' + objectName(p));
            }
          } catch (eQ) {}
        }
      } else if (c.cmd === 'call') {
        const fn = ufnCache[c.fn] || findUFnWide(alvo, c.fn);
        if (!fn) { log('CMD call fn NULL: ' + c.fn); return; }
        const buf = Memory.alloc(256);
        for (let i = 0; i < 256; i++) buf.add(i).writeU8(0);
        const wr = c.buf || [];
        for (let w = 0; w < wr.length; w++) {
          const it = wr[w];
          const dst = buf.add(it.off || 0);
          if (it.tipo === 'ptr') dst.writePointer(ptr(it.valor));
          else if (it.tipo === 'u32') dst.writeU32(it.valor >>> 0);
          else if (it.tipo === 's32') dst.writeS32(it.valor | 0);
          else if (it.tipo === 'f32') dst.writeFloat(it.valor);
          else if (it.tipo === 'f64') dst.writeDouble(it.valor);
          else if (it.tipo === 'u8') dst.writeU8(it.valor & 0xff);
          else if (it.tipo === 'alvo') dst.writePointer(alvo);
          else if (it.tipo === 'pawn') dst.writePointer(survPawnObj);
          else if (it.tipo === 'inst') dst.writePointer(probeInst);
          else if (it.tipo === 'subfem') dst.writePointer(subFem);
          else if (it.tipo === 'submasc') dst.writePointer(subMasc);
        }
        // DIAG_LS (so log): valida o PCC (alvo) e o pawn antes de CT_FirstLaunch.
        if (c.fn === 'CT_FirstLaunch') {
          try {
            const pccOk = !!(alvo && !alvo.isNull() && looksLikeUObject(alvo));
            const pawnOk = !!(survPawnObj && !survPawnObj.isNull() && looksLikeUObject(survPawnObj));
            log('DIAG_LS pcc=' + alvo + ' valido=' + pccOk + ' nome=' + (pccOk ? objectName(alvo) : '-'));
            log('DIAG_LS pawn=' + survPawnObj + ' valido=' + pawnOk + ' nome=' + (pawnOk ? objectName(survPawnObj) : '-'));
          } catch (eDL) { log('DIAG_LS erro ' + eDL); }
          installCsHook(alvo);
        }
        processEventFn(alvo, fn, buf);
        log('CMD call ' + c.fn + ' ret buf=' + hexBytes(buf, c.retLen || 64));
      } else if (c.cmd === 'fnlayout') {
        // Loga o layout de parametros (nome/offset/elem/flags) de um UFunction do alvo.
        if (!alvo || alvo.isNull()) { log('CMD fnlayout alvo NULL'); return; }
        const fnL = findUFnWide(alvo, c.fn);
        if (!fnL) { log('CMD fnlayout fn NULL: ' + c.fn); return; }
        ufnCache[c.fn] = fnL;
        log('CMD fnlayout cache ' + c.fn);
        log('CMD fnlayout ' + c.fn + ' em ' + objectName(alvo));
        dumpAnimFnParms(fnL, c.fn);
        log('CMD fnlayout done ' + c.fn);
      } else if (c.cmd === 'readstate') {
        // SOMENTE LEITURA: estado de tutorial/quest no PC, no pawn e no BP_LeadChriss.
        if (survPcObj && !survPcObj.isNull()) {
          dumpPropsFor(survPcObj, 'PCSTATE', /Tutorial|Stage|Beginner|WayOut|Repository|Quest/i);
        }
        if (survPawnObj && !survPawnObj.isNull()) {
          dumpPropsFor(survPawnObj, 'PAWNSTATE', /Tutorial|Stage|Beginner|Quest/i);
        }
        // QUESTCOMP: le a lista de quests do QuestSystemComp (pawn+0x8c8) e do QuestComponentV4 (pawn+0x8c0)
        const qscObj = cmdTarget('qsc');
        if (qscObj) dumpPropsFor(qscObj, 'QSC', /Quest|Mark|Stage|Track|Active/i);
        else log('READSTATE QSC indisponivel');
        const qcvObj = cmdTarget('qcv4');
        if (qcvObj) dumpPropsFor(qcvObj, 'QCV4', /Quest|Mark|Stage|Track|Active/i);
        else log('READSTATE QCV4 indisponivel');
        execCmd({ id: -903, cmd: 'findactor', alvo: 'pawn', name: 'BP_LeadChriss' });
        const chrisObj = (globalThis.__doorCands || [])[0];
        if (chrisObj) dumpPropsFor(chrisObj, 'CHRIS', /Quest|Active|Dialog|Chriss|Tutorial|Stage/i);
        else log('READSTATE Chris nao encontrado');
        log('CMD readstate done');
      } else if (c.cmd === 'setprop') {
        // Escreve um campo do alvo (pc/pawn) no offset dado. tipo: i32 | u8 | bool (usa mask).
        // Ex: {cmd:'setprop', alvo:'pc', off:3184, tipo:'i32', valor:0}
        let tgt = alvo;
        if (c.alvo === 'chris') {
          // Acha o BP_LeadChriss pelo nome (findactor) e escreve nele.
          execCmd({ id: -904, cmd: 'findactor', alvo: 'pawn', name: 'BP_LeadChriss' });
          const hitC = (globalThis.__doorCands || []).find(function (o) {
            return /^BP_LeadChriss/.test(objectName(o));
          });
          tgt = hitC || null;
          log('CMD setprop chris alvo=' + (hitC ? objectName(hitC) : 'NAO ACHADO'));
        }
        if (!tgt || tgt.isNull()) { log('CMD setprop alvo NULL'); return; }
        const pAddr = tgt.add(c.off);
        if (c.tipo === 'i32') {
          const before = pAddr.readS32();
          pAddr.writeS32(c.valor);
          log('CMD setprop i32 off=0x' + c.off.toString(16) + ' ' + before + ' -> ' + pAddr.readS32());
        } else if (c.tipo === 'u8') {
          const before = pAddr.readU8();
          pAddr.writeU8(c.valor & 0xff);
          log('CMD setprop u8 off=0x' + c.off.toString(16) + ' ' + before + ' -> ' + pAddr.readU8());
        } else if (c.tipo === 'bool') {
          const mask = c.mask || 0x1;
          const before = pAddr.readU8();
          const after = c.valor ? (before | mask) : (before & ~mask);
          pAddr.writeU8(after & 0xff);
          log('CMD setprop bool off=0x' + c.off.toString(16) + ' ' + before + ' -> ' + pAddr.readU8());
        } else { log('CMD setprop tipo invalido: ' + c.tipo); }
        log('CMD setprop done');
      } else if (c.cmd === 'dumpcands') {
        // SOMENTE LEITURA: dump das propriedades de sequencia/tutorial de cada hit do findactor.
        const cands = (globalThis.__doorCands || []).slice(0, c.lim || 12);
        log('CMD dumpcands n=' + cands.length);
        for (let i = 0; i < cands.length; i++) {
          try { dumpPropsFor(cands[i], 'CAND' + i, c.regex ? new RegExp(c.regex, 'i') : /Sequence|Play|Auto|Tutorial|Level|Stage/i); } catch (eDC) { log('CMD dumpcands erro ' + i + ' ' + eDC); }
        }
        log('CMD dumpcands done');
      } else if (c.cmd === 'qaddq') {
        // Chama QuestSystemComp.AddQuest(QuestName FString @0, QuestItemID int @16, QuestItem obj @24).
        const qs = cmdTarget('qsc');
        if (!qs) { log('CMD qaddq qsc indisponivel'); return; }
        const fnQ = ufnCache['AddQuest'] || findUFnWide(qs, 'AddQuest');
        if (!fnQ) { log('CMD qaddq fn AddQuest NULL'); return; }
        const qname = c.name || 'FindTheWayOut_Tutorial';
        const wbuf = Memory.alloc((qname.length + 1) * 2);
        for (let i = 0; i < qname.length; i++) wbuf.add(i * 2).writeU16(qname.charCodeAt(i));
        wbuf.add(qname.length * 2).writeU16(0);
        const qparms = Memory.alloc(64);
        for (let i = 0; i < 64; i++) qparms.add(i).writeU8(0);
        qparms.writePointer(wbuf);
        qparms.add(8).writeS32(qname.length + 1);
        qparms.add(12).writeS32(qname.length + 1);
        qparms.add(16).writeS32(c.itemId || 0);
        qparms.add(24).writePointer(ptr(0));
        log('CMD qaddq chamando AddQuest name=' + qname + ' qsc=' + objectName(qs));
        processEventFn(qs, fnQ, qparms);
        log('CMD qaddq done (confira readstate QSC Quests)');
      } else if (c.cmd === 'gifs') {
        // Liga/desliga o forcar IsFirstStart=true. off = offset do ReturnValue no buffer de parms.
        globalThis.__forceFS = !!c.valor;
        globalThis.__fsRetOff = c.off || 0;
        log('CMD gifs force=' + globalThis.__forceFS + ' off=' + globalThis.__fsRetOff + ' GI=' + (globalThis.__giObj ? globalThis.__giObj : 'nao capturado') + ' calls=' + (globalThis.__fsCalls || 0));
      } else if (c.cmd === 'doorset') {
        // Lista funcoes candidatas da porta, seta StartTeleport (bit 0x1 @0x338) e tenta
        // chamar o evento de black screen. Loga tudo para validar.
        const dr = (globalThis.__doorCands || [])[c.idx || 0];
        if (!dr) { log('CMD doorset sem porta (rode findactor antes)'); return; }
        log('CMD doorset alvo=' + objectName(dr) + ' ptr=' + dr);
        dumpPropsFor(dr, 'DOORFN', /Black|Screen|Teleport|Spawn|Interact|Tip|Overlap|Stage|Open/i);
        const sp = dr.add(0x338);
        const before = sp.readU8();
        sp.writeU8(before | 0x1);
        log('CMD doorset StartTeleport byte ' + before + ' -> ' + sp.readU8());
        const names = ['On Black Screen Opened', 'OnBlackScreenOpened', 'OnBlackScreenOpen', 'On_Black_Screen_Opened', 'BlackScreenOpened'];
        for (let n = 0; n < names.length; n++) {
          const fnD = findUFnDet(dr, names[n]);
          if (!fnD) { log('CMD doorset fn NAO achada: ' + names[n]); continue; }
          log('CMD doorset fn achada: ' + names[n] + ' -> chamando');
          const bufD = Memory.alloc(16);
          for (let i = 0; i < 16; i++) bufD.add(i).writeU8(0);
          try { processEventFn(dr, fnD, bufD); log('CMD doorset chamada OK'); } catch (eD) { log('CMD doorset erro: ' + eD); }
          break;
        }
        log('CMD doorset done');
      } else if (c.cmd === 'doorgate') {
        // SOMENTE LEITURA: loga os valores do gate da porta achada pelo findactor.
        const dr = (globalThis.__doorCands || [])[c.idx || 0];
        if (!dr) { log('CMD doorgate sem porta (rode findactor antes)'); return; }
        log('CMD doorgate alvo=' + objectName(dr) + ' ptr=' + dr);
        dumpPropsFor(dr, 'DOOR', /ToHub|StartTeleport|InHub|PendingTeleport|Tutorial|HasAuth/i);
        if (survPawnObj && !survPawnObj.isNull()) {
          dumpPropsFor(survPawnObj, 'PAWN_SPRINT', /SprintPressed|isRunning|RunningSpeed|SprintingSpeed|Stamina|Breath/i);
        }
        log('CMD doorgate done');
      } else if (c.cmd === 'findactor') {
        // Sobe a cadeia Outer a partir do alvo ate achar o ULevel; depois varre
        // os TArray* do ULevel procurando elementos cujo nome bate com c.name (ex: DoorTeleport).
        if (!alvo || alvo.isNull()) { log('CMD findactor alvo NULL'); return; }
        const want = new RegExp(c.name || 'DoorTeleport', 'i');
        let lvl = null;
        let cur = alvo;
        for (let i = 0; i < 8 && cur && !cur.isNull(); i++) {
          const cls = cur.add(0x10).readPointer();
          if (!cls.isNull() && objectName(cls) === 'Level') { lvl = cur; break; }
          const nxt = cur.add(0x20).readPointer();
          if (!looksLikeUObject(nxt)) break;
          cur = nxt;
        }
        if (!lvl) { log('CMD findactor ULevel nao encontrado a partir de ' + objectName(alvo)); return; }
        const hits = [];
        // Sublevels: o UWorld (Outer do ULevel) tem um TArray<ULevel*> com os niveis carregados
        const lvlsToScan = [lvl];
        try {
          const world = lvl.add(0x20).readPointer();
          if (looksLikeUObject(world)) {
            for (let woff = 0x20; woff < 0x400; woff += 8) {
              const wd = world.add(woff).readPointer();
              const wn = world.add(woff + 8).readS32();
              if (wd.isNull() || wn < 1 || wn > 200) continue;
              const first = wd.readPointer();
              if (!looksLikeUObject(first) || objectName(first.add(0x10).readPointer()) !== 'Level') continue;
              for (let k = 0; k < wn; k++) {
                const sl = wd.add(k * 8).readPointer();
                if (looksLikeUObject(sl) && sl.toString() !== lvl.toString()) lvlsToScan.push(sl);
              }
              log('CMD findactor world TArray off=0x' + woff.toString(16) + ' niveis=' + wn);
              break;
            }
          }
        } catch (eW) {}
        log('CMD findactor niveis a varrer=' + lvlsToScan.length);
        for (const LV of lvlsToScan) {
        log('CMD findactor level=' + objectName(LV) + ' ptr=' + LV);
        for (let off = 0x20; off < 0x400; off += 8) {
          try {
            const data = LV.add(off).readPointer();
            const num = LV.add(off + 8).readS32();
            const max = LV.add(off + 12).readS32();
            if (data.isNull() || num < 20 || num > 20000 || max < num) continue;
            let ok = 0;
            for (let k = 0; k < Math.min(num, 20); k++) {
              if (looksLikeUObject(data.add(k * 8).readPointer())) ok++;
            }
            if (ok < 18) continue;
            log('CMD findactor TArray off=0x' + off.toString(16) + ' num=' + num);
            for (let k = 0; k < num; k++) {
              const a = data.add(k * 8).readPointer();
              if (!looksLikeUObject(a)) continue;
              const nm = objectName(a);
              if (want.test(nm)) {
                log('FINDACTOR hit off=0x' + off.toString(16) + ' idx=' + k + ' ptr=' + a + ' name=' + nm);
                hits.push(a);
                if (c.locs) {
                  // v6.6 SOMENTE LEITURA: posicao + flags do BP_PlayerSpawnPoint (offsets do log ATPC_PROPS)
                  try {
                    const lr = readActorLoc(a);
                    let extra = '';
                    if (/SpawnPoint/i.test(nm)) {
                      let reg = '';
                      try {
                        const rd = a.add(0x2b8).readPointer();
                        const rn = a.add(0x2c0).readS32();
                        if (!rd.isNull() && rn > 0 && rn < 64) reg = rd.readUtf16String(rn - 1);
                      } catch (eR) {}
                      extra = ' Region="' + reg + '" Tier=' + a.add(0x2dc).readS32() +
                        ' FirstLaunch=' + (a.add(0x2d0).readU8() & 1) + ' Car=' + (a.add(0x2e0).readU8() & 1) +
                        ' Beginner=' + (a.add(0x2e1).readU8() & 1) + ' ToHub=' + (a.add(0x2e2).readU8() & 1);
                    }
                    log('FINDLOC ptr=' + a + ' name=' + nm + ' loc=' + (lr ? lr.loc.map(function (v) { return Math.round(v); }).join(',') : 'null') + extra);
                  } catch (eL) { log('FINDLOC erro ' + eL); }
                }
              }
            }
          } catch (eF) {}
        }
        }
        globalThis.__doorCands = hits;
        log('CMD findactor done hits=' + hits.length);
      } else if (c.cmd === 'scanobj') {
        // Varre ponteiros diretos do objeto alvo e loga componentes de streaming/Agones.
        if (!alvo || alvo.isNull()) { log('CMD scanobj alvo NULL'); return; }
        const lim = c.lim || 0x1200;
        let found = 0;
        for (let off = 0; off < lim; off += 8) {
          try {
            const p = alvo.add(off).readPointer();
            if (!looksLikeUObject(p)) continue;
            const nm = objectName(p);
            if (/StreamingSource|WorldPartition|Agones|Streaming/i.test(nm)) {
              log('SCANOBJ +0x' + off.toString(16) + ' ' + nm + ' ptr=' + p);
              found++;
              if (/StreamingSource/i.test(nm)) {
                const lf = findUFnWide(p, 'K2_GetComponentLocation');
                if (lf) {
                  const lb = Memory.alloc(64);
                  for (let i3 = 0; i3 < 64; i3++) lb.add(i3).writeU8(0);
                  processEventFn(p, lf, lb);
                  log('SCANOBJ ss loc=' + hexBytes(lb, 48));
                } else {
                  log('SCANOBJ ss sem K2_GetComponentLocation');
                }
              }
            }
          } catch (eS) {}
        }
        log('SCANOBJ done found=' + found + ' alvo=' + objectName(alvo));
      } else if (c.cmd === 'tryload') {
        if (!loadTryNative) {
          loadTryNative = new NativeFunction(main.base.add(0x242f7f0), 'pointer', ['pointer']);
        }
        const ii = findFNameIndices([c.pkg, c.asset]);
        if (ii[c.pkg] < 0 || ii[c.asset] < 0) { log('CMD tryload fname ausente'); return; }
        const bb = Memory.alloc(32);
        for (let i2 = 0; i2 < 32; i2++) bb.add(i2).writeU8(0);
        bb.writeU32(ii[c.pkg] >>> 0);
        bb.add(8).writeU32(ii[c.asset] >>> 0);
        const r = loadTryNative(bb);
        log('CMD tryload ' + c.asset + ' = ' + (r && !r.isNull() ? r + ' nome=' + objectName(r) : 'NULL'));
      } else {
        log('CMD desconhecido: ' + c.cmd);
      }
    } catch (eC) {
      log('CMD exc ' + eC);
    }
  }
  // WATCHGS: chama UAgonesComponent::WatchGameServer uma vez via ProcessEvent.
  let watchGsCalled = false;

  function readFStringAt(p) {
    try {
      const d = p.readPointer();
      const n = p.add(8).readS32();
      if (d.isNull() || n <= 1 || n > 256) return '';
      return d.readUtf16String(n - 1);
    } catch (e) {
      return '?';
    }
  }

  function findGsTdb(eng) {
    const ctx = getWorldContext(eng);
    if (!ctx) return null;
    const isGs = function (p) {
      if (!p || p.isNull() || !looksLikeUObject(p)) return false;
      const cls = p.add(0x10).readPointer();
      return !cls.isNull() && objectName(cls) === 'GS_TDB_C';
    };
    for (let o = 0x0; o <= 0x400; o += 8) {
      let p = null;
      try { p = ctx.add(o).readPointer(); } catch (e) { continue; }
      if (!p || p.isNull()) continue;
      if (isGs(p)) { log('WATCHGS GS_TDB @ ctx+0x' + o.toString(16)); return p; }
      for (let w = 0x20; w <= 0x400; w += 8) {
        try {
          const gs = p.add(w).readPointer();
          if (isGs(gs)) {
            log('WATCHGS GS_TDB @ ctx+0x' + o.toString(16) + ' -> +0x' + w.toString(16));
            return gs;
          }
        } catch (e2) {}
      }
    }
    return null;
  }

  function watchGameServerOnce() {
    if (watchGsCalled) { log('WATCHGS ja chamado nesta sessao'); return; }
    if (travelBusy) { log('WATCHGS abortado: travelBusy'); return; }
    if (!processEventFn) { log('WATCHGS sem ProcessEvent'); return; }
    const eng = getEngine();
    if (!eng) { log('WATCHGS sem engine'); return; }
    const gs = findGsTdb(eng);
    if (!gs) { log('WATCHGS GS_TDB nao encontrado'); return; }
    let comp = null;
    const prop = findPropOffset(gs, 'AgonesComponent');
    if (prop) {
      try { comp = gs.add(prop.off).readPointer(); } catch (e) { log('WATCHGS leitura comp exc ' + e); return; }
    } else {
      // Fallback: varre o GS por ponteiro direto para AgonesComponent, e por TArray (data+count) de componentes.
      const isAgones = function (p) {
        if (!p || p.isNull() || !looksLikeUObject(p)) return false;
        const cls = p.add(0x10).readPointer();
        return !cls.isNull() && objectName(cls) === 'AgonesComponent';
      };
      for (let o = 0x0; o <= 0x1000 && !comp; o += 8) {
        try {
          const v = gs.add(o).readPointer();
          if (isAgones(v)) { comp = v; log('WATCHGS AgonesComponent ptr direto em GS+0x' + o.toString(16)); break; }
          const cnt = gs.add(o + 8).readS32();
          if (cnt > 0 && cnt <= 64 && !v.isNull()) {
            for (let i = 0; i < cnt && !comp; i++) {
              const e = v.add(i * 8).readPointer();
              if (isAgones(e)) { comp = e; log('WATCHGS AgonesComponent em TArray GS+0x' + o.toString(16) + '[' + i + ']'); }
            }
          }
        } catch (e3) {}
      }
      if (!comp) {
        // DIAG_AGONES: lista componentes e varre pawn/SurvPC por AgonesComponent.
        const scanObj = function (base, label) {
          let found = null;
          let n = 0;
          for (let o = 0x0; o <= 0x1000 && n < 300; o += 8) {
            try {
              const cnt = base.add(o + 8).readS32();
              const v = base.add(o).readPointer();
              if (cnt > 0 && cnt <= 512 && !v.isNull()) {
                for (let i = 0; i < cnt && n < 300; i++) {
                  const e = v.add(i * 8).readPointer();
                  if (!e.isNull() && looksLikeUObject(e)) {
                    const cn = objectName(e.add(0x10).readPointer());
                    n++;
                    if (cn === 'AgonesComponent' && !found) found = e;
                    log('DIAG_AGONES ' + label + ' +0x' + o.toString(16) + '[' + i + '] cls=' + cn);
                  }
                }
              }
            } catch (e4) {}
          }
          return found;
        };
        comp = scanObj(gs, 'GS');
        if (!comp && placeholderObj && !placeholderObj.isNull()) comp = scanObj(placeholderObj, 'PH');
        if (!comp) {
          const pawnDiag = cmdTarget('pawn');
          if (pawnDiag && !pawnDiag.isNull()) comp = scanObj(pawnDiag, 'PAWN');
        }
        if (!comp) {
          const subDiag = cmdTarget('subfemlive');
          if (subDiag && !subDiag.isNull()) comp = scanObj(subDiag, 'SUB');
        }
        if (!comp) { log('DIAG_AGONES nenhum AgonesComponent (GS/PAWN/SUB)'); return; }
        log('DIAG_AGONES achado comp=' + comp);
      }
    }
    if (!comp || comp.isNull() || !looksLikeUObject(comp)) { log('WATCHGS comp invalido'); return; }
    const compCls = objectName(comp.add(0x10).readPointer());
    log('WATCHGS comp=' + comp + ' cls=' + compCls + ' off=0x' + prop.off.toString(16));
    if (compCls !== 'AgonesComponent') { log('WATCHGS classe inesperada, abort'); return; }
    const port = readFStringAt(comp.add(0xa0));
    log('WATCHGS this+0xa0 (string de porta, hipotese) = ' + JSON.stringify(port));
    if (!port || port === '?') { log('WATCHGS porta vazia, abort'); return; }
    const fn = findUFnWide(comp, 'WatchGameServer');
    if (!fn || fn.isNull()) { log('WATCHGS UFunction WatchGameServer nao achada'); return; }
    const buf = Memory.alloc(256);
    for (let i = 0; i < 256; i++) buf.add(i).writeU8(0);
    watchGsCalled = true;
    log('WATCHGS ProcessEvent comp=' + comp + ' fn=' + fn + ' buf=256 zerado');
    processEventFn(comp, fn, buf);
    log('WATCHGS retornou; WATCH_HIT=' + watchGsHits + ' socket(+0xe0)=' + comp.add(0xe0).readPointer());
  }

  function runAutoHub() {
    if (!autoHubAt || autoHubDone || Date.now() < autoHubAt) return;
    autoHubDone = true;
    log('AUTOHUB inicio');
    execCmd({ id: -901, cmd: 'findactor', alvo: 'pawn', name: 'PlayerStart|SpawnPoint' });
    const cands = (globalThis.__doorCands || []).slice(0, 120);
    const tx = -97737, ty = -3599, tz = -72350;
    // Usa o primeiro spawn da lista (o que levou ao hub no teste manual). A leitura
    // de posicao por distancia escolheu spawn errado (75k de distancia).
    const best = cands.length ? cands[0] : null;
    if (!best) { log('AUTOHUB sem spawn'); return; }
    log('AUTOHUB spawn ptr=' + best + ' (primeiro da lista)');
    execCmd({ id: -902, cmd: 'call', alvo: 'pc', fn: 'TeleportToSpawnPoint', retLen: 8, buf: [{ off: 0, tipo: 'ptr', valor: best.toString() }] });
    log('AUTOHUB fim');
  }
  // AUTOQUEST: depois do READY, adiciona a TrainingQuest, inicia e grava a etapa TalkLead.
  // Usa o ponteiro do tryload direto (sem arquivo), e a etapa e gravada so depois de iniciar a quest.
  var autoQ = { on: true, step: 0, at: 0 };
  function autoLoadPtr(pkg, asset) {
    if (!loadTryNative) {
      loadTryNative = new NativeFunction(main.base.add(0x242f7f0), 'pointer', ['pointer']);
    }
    const ii = findFNameIndices([pkg, asset]);
    if (ii[pkg] < 0 || ii[asset] < 0) return null;
    const bb = Memory.alloc(32);
    for (let i2 = 0; i2 < 32; i2++) bb.add(i2).writeU8(0);
    bb.writeU32(ii[pkg] >>> 0);
    bb.add(8).writeU32(ii[asset] >>> 0);
    const r = loadTryNative(bb);
    return r && !r.isNull() ? r : null;
  }
  function runAutoQuest() {
    if (!autoQ.on || autoQ.step >= 90 || phase !== PH.READY) return;
    if (autoQ.at === 0) { autoQ.at = Date.now(); log('AUTOQ READY detectado, aguardando 3s'); return; }
    const dt = Date.now() - autoQ.at;
    const PKG = '/Game/Blueprints/QuestSystem/V5/Quests/Training_Quests/TrainingQuest';
    if (autoQ.step === 0 && dt >= 3000) {
      const qs = cmdTarget('qsc');
      const num = qs ? qs.add(0xa8 + 8).readS32() : -1;
      if (num > 0) { log('AUTOQ Quests ja tem ' + num + ' entrada(s); pula qaddq'); autoQ.step = 2; autoQ.at = Date.now(); return; }
      execCmd({ id: -920, cmd: 'qaddq', alvo: 'pc', name: 'TrainingQuest', itemId: 0 });
      log('AUTOQ qaddq TrainingQuest');
      autoQ.step = 1; autoQ.at = Date.now();
    } else if (autoQ.step === 1 && dt >= 2000) {
      autoQ.step = 2; autoQ.at = Date.now();
    } else if (autoQ.step === 2) {
      const p = autoLoadPtr(PKG, 'TrainingQuest');
      if (!p) { log('AUTOQ tryload falhou'); autoQ.step = 90; return; }
      log('AUTOQ ptr TrainingQuest=' + p);
      execCmd({ id: -921, cmd: 'call', alvo: 'pc', fn: 'StartQuest_Server', buf: [{ off: 0, tipo: 'ptr', valor: p.toString() }] });
      autoQ.step = 3; autoQ.at = Date.now();
    } else if (autoQ.step === 3 && dt >= 3000) {
      execCmd({ id: -922, cmd: 'setfstr', alvo: 'pc', off: 3440, valor: 'TalkLead2' });
      log('AUTOQ setfstr TalkLead');
      autoQ.step = 90;
    }
  }
  // Diagnostico do inventario (so leitura), uma vez por lancamento ao atingir READY.
  // Loga os slots de arma/roupa/mochila do personagem e os primeiros itens de ContainerItems.
  var invDumpDone = false;
  function invDumpTick() {
    if (invDumpDone || phase !== PH.READY || !survPawnObj || survPawnObj.isNull()) return;
    invDumpDone = true;
    log('INVDUMP inicio pawn=' + survPawnObj);
    const slots = [
      ['JSISlotPrimaryWeapon', 0x1140], ['MeleeWeaponSlot', 0x1148], ['JSISlotSecondaryWeapon', 0x1150],
      ['JSISlotPistolWeapon', 0x1158], ['BackpackContainer', 0x1100], ['PocketContainer', 0x1388],
      ['JSISlotHelmet', 0x1240], ['JSISlotArmor', 0x1248], ['JSISlotBackpack', 0x1688],
      ['JSISlotOutfit', 0x1690], ['JSISlotPants', 0x1698], ['JSISlotPocket', 0x16a0]
    ];
    slots.forEach(function (s) {
      try {
        const p = survPawnObj.add(s[1]).readPointer();
        if (!p || p.isNull()) { log('INVDUMP slot ' + s[0] + ' = null'); return; }
        log('INVDUMP slot ' + s[0] + ' = ' + objectName(p) + ' @' + p);
        dumpPropsFor(p, 'SLOT_' + s[0], /Item|Weapon|Name|Data|Id|Count|Amount|Ammo|Class|Owner|Slot|Stack|Num|Index/i);
      } catch (eS) { log('INVDUMP slot erro ' + s[0] + ': ' + eS); }
    });
    try {
      const ap = survPawnObj.add(0x1170);
      const adata = ap.readPointer();
      const anum = ap.add(8).readS32();
      log('INVDUMP ContainerItems num=' + anum + ' data=' + adata);
      for (let q = 0; q < Math.min(anum, 16); q++) {
        const ep = adata.add(q * 16);
        const p0 = ep.readPointer();
        let desc = 'hex=' + hexBytes(ep, 16);
        if (looksLikeUObject(p0)) desc = objectName(p0) + ' @' + p0;
        log('INVDUMP ContainerItems[' + q + '] ' + desc);
      }
    } catch (eC) { log('INVDUMP ContainerItems erro: ' + eC); }
    log('INVDUMP fim');
  }

  // LSFLAGS (so leitura): amostra a cada 200 ms flags/visibilidade que podem trazer a tela de carregamento inicial de volta.
  // Loga apenas mudancas, com timestamp ISO igual ao do LSWIDE, para cruzar com os eventos do tracer.
  var lsFlagsTimer = null;
  var lsFlagsBudget = 900;
  const lsFlagsSig = {};
  // v6: registro de cada instancia de SurvivalPlayer_V2_C vista em ProcessEvent (so leitura).
  const lsPawns = {};
  var lsPawnBudget = 60;
  function lsRound(v, step) { return Math.round(v / step) * step; }
  function lsPawnSeen(obj, fnName) {
    if (!obj || obj.isNull()) return;
    const k = obj.toString();
    let e = lsPawns[k];
    if (!e) {
      if (lsPawnBudget <= 0) return;
      e = lsPawns[k] = { first: new Date().toISOString(), n: 0, fns: {}, nf: 0 };
      lsPawnBudget--;
      let loc = 'null';
      try { const l0 = lsActorLoc(obj); if (l0) loc = l0.join(','); } catch (eL) {}
      log('LSPAWN nova instancia ptr=' + k + ' t=' + e.first + ' loc=' + loc + ' primeira_fn=' + fnName + ' total=' + Object.keys(lsPawns).length);
    }
    e.n++;
    if (fnName && !e.fns[fnName] && e.nf < 10) {
      e.fns[fnName] = 1; e.nf++;
      if (lsPawnBudget > 0) { lsPawnBudget--; log('LSPAWN fn ptr=' + k + ' fn=' + fnName); }
    }
  }
  function lsObjState(obj, boolRe, numRe, objRe) {
    const parts = [];
    if (!obj || obj.isNull() || !looksLikeUObject(obj)) return 'invalido';
    const pm = wpClassPropMap(obj.add(0x10).readPointer());
    let n = 0;
    Object.keys(pm).forEach(function (k) {
      if (n >= 40) return;
      const e = pm[k];
      try {
        if (/BoolProperty/.test(e.clsName || '') && boolRe.test(k)) { parts.push(k + '=' + (wpReadBool(obj, e) ? 1 : 0)); n++; }
        else if (/FloatProperty|DoubleProperty/.test(e.clsName || '') && numRe.test(k)) {
          const v = /Double/.test(e.clsName) ? obj.add(e.off).readDouble() : obj.add(e.off).readFloat();
          parts.push(k + '=' + (Math.round(v * 1000) / 1000)); n++;
        }
        else if (/IntProperty/.test(e.clsName || '') && numRe.test(k)) { parts.push(k + '=' + obj.add(e.off).readS32()); n++; }
        else if (/ByteProperty|EnumProperty/.test(e.clsName || '') && (k === 'Visibility' || numRe.test(k))) { parts.push(k + '=' + obj.add(e.off).readU8()); n++; }
        else if (/ObjectProperty/.test(e.clsName || '') && objRe.test(k)) {
          const q = obj.add(e.off).readPointer();
          parts.push(k + '=' + (looksLikeUObject(q) ? objectName(q) + '@' + q : 'null')); n++;
        }
      } catch (eP) {}
    });
    return parts.join(' ');
  }
  // Camera: alvo de visao (FTViewTarget.Target no inicio da struct) comparado com os pawns conhecidos.
  function lsCamExtra(cam) {
    if (!cam || cam.isNull() || !looksLikeUObject(cam)) return '';
    const pm = wpClassPropMap(cam.add(0x10).readPointer());
    const out = [];
    ['ViewTarget', 'PendingViewTarget'].forEach(function (nm) {
      const e = pm[nm];
      if (!e) { out.push(nm + '=semprop'); return; }
      try {
        const t = cam.add(e.off).readPointer();
        out.push(nm + '=' + (looksLikeUObject(t) ? objectName(t) + '@' + t : 'null'));
      } catch (eV) { out.push(nm + '=erro'); }
    });
    return ' ' + out.join(' ');
  }
  function lsPawnState(pw) {
    let loc = 'loc=null';
    try {
      const l1 = lsActorLoc(pw);
      if (l1) loc = 'loc~' + l1.map(function (q) { return lsRound(q, 1000) / 100; }).join(',') + 'm';
    } catch (eL) {}
    return loc + ' ' + lsObjState(pw, /Cutscene|Possess|Dead|Hidden|Ready|Spawned|Teleport|Loading|Intro|Sleep|bIsPlaying/i, /^$/, /Controller|PlayerState|Cutscene/i);
  }

  // v6.1: posicao correta via K2_GetActorLocation (mesmo metodo do DIAG_Z) + batimento LSHB sempre logado.
  function lsActorLoc(actor) {
    try {
      const getHit = found.K2_GetActorLocation;
      if (!actor || !getHit || !processEventFn) return null;
      const buf = Memory.alloc(64);
      for (let i = 0; i < 64; i++) buf.add(i).writeU8(0);
      processEventFn(actor, getHit.fn, buf);
      const x = buf.readDouble(), y = buf.add(8).readDouble(), z = buf.add(16).readDouble();
      if (!isFinite(x) || !isFinite(y) || !isFinite(z) || Math.abs(z) > 5e6) return null;
      return [Math.round(x), Math.round(y), Math.round(z)];
    } catch (e) { return null; }
  }
  function lsProp(obj, name, kind) {
    try {
      if (!obj || obj.isNull() || !looksLikeUObject(obj)) return 'x';
      const e = wpClassPropMap(obj.add(0x10).readPointer())[name];
      if (!e) return 'semprop';
      if (kind === 'u8') return obj.add(e.off).readU8();
      if (kind === 'bool') return wpReadBool(obj, e) ? 1 : 0;
      if (kind === 'f32') return Math.round(obj.add(e.off).readFloat() * 1000) / 1000;
      if (kind === 'ptr') return obj.add(e.off).readPointer();
      if (kind === 'obj') { const q = obj.add(e.off).readPointer(); return looksLikeUObject(q) ? objectName(q) + '@' + q : 'null'; }
    } catch (eP) { return 'err'; }
    return 'x';
  }
  // v6.2: hook (lazy) no slot de vtable 0xd40 do PlayerController = implementacao de SetViewTargetWithBlend (Blueprint).
  var v62VtHooked = false;
  function v62TryHookVT() {
    if (v62VtHooked || !survPcObj || survPcObj.isNull()) return;
    v62VtHooked = true;
    try {
      const fn = survPcObj.readPointer().add(0xd40).readPointer();
      Interceptor.attach(fn, {
        onEnter: function (args) {
          if (v62Budget.svt-- <= 0) return;
          let tn = '?';
          try { tn = args[1].isNull() ? 'null' : objectName(args[1]) + '@' + args[1]; } catch (e) {}
          log('V62_SETVIEWTARGET ' + new Date().toISOString() + ' this=' + objectName(args[0]) + ' target=' + tn + ' bt=' + v62Bt(this.context));
        },
      });
      log('V62 hook SetViewTarget (vtable+0xd40) instalado em rva +0x' + fn.sub(main.base).toString(16));
    } catch (e) { log('V62 hook SetViewTarget erro ' + e); }
  }
  var lsHbAt = 0;
  var lsHbBudget = 400;
  function lsHeartbeat() {
    if (Date.now() > lsWideUntil || lsHbBudget <= 0 || !survPcObj || survPcObj.isNull()) return;
    if (Date.now() - lsHbAt < 900) return;
    lsHbAt = Date.now();
    lsHbBudget--;
    let vt = 'x', bsVis = 'x', bsPct = 'x', tipsVis = 'x', cutVis = 'x', hudAfter = 'x';
    try {
      const cam = lsProp(survPcObj, 'PlayerCameraManager', 'ptr');
      if (cam && looksLikeUObject(cam)) {
        const e = wpClassPropMap(cam.add(0x10).readPointer())['ViewTarget'];
        if (e) { const t = cam.add(e.off).readPointer(); vt = looksLikeUObject(t) ? objectName(t) + '@' + t : 'null'; }
      }
    } catch (eV) { vt = 'err'; }
    try {
      const hud = survPcObj.add(0x340).readPointer();
      hudAfter = lsProp(hud, 'AfterLoading', 'bool');
      const bs = lsProp(hud, 'BlackScreen', 'ptr'), tp = lsProp(hud, 'WBP_TipsInfo', 'ptr'), ct = lsProp(hud, 'CutsceneTips', 'ptr');
      bsVis = lsProp(bs, 'Visibility', 'u8'); bsPct = lsProp(bs, 'CurrentLoadingPercentTime', 'f32');
      tipsVis = lsProp(tp, 'Visibility', 'u8'); cutVis = lsProp(ct, 'Visibility', 'u8');
    } catch (eH) {}
    let vtLoc = '';
    try {
      const m = /@(0x[0-9a-f]+)/i.exec(vt);
      if (m) { const l0 = lsActorLoc(ptr(m[1])); vtLoc = ' VTloc=' + (l0 ? l0.join(',') : 'null'); }
    } catch (eVL) {}
    const ps = Object.keys(lsPawns).slice(0, 3).map(function (k, i) {
      const l = lsActorLoc(ptr(k));
      return 'P' + i + '=' + (l ? l.join(',') : 'null');
    }).join(' ');
    log('LSHB ' + new Date().toISOString() + ' pcLoad=' + lsProp(survPcObj, 'IsLoadingScreen', 'bool') + ' hudAfter=' + hudAfter +
      ' VT=' + vt + vtLoc + ' bs.vis=' + bsVis + ' bs.pct=' + bsPct + ' tips.vis=' + tipsVis + ' cut.vis=' + cutVis + ' ' + ps);
  }
  function lsFlagsTick() {
    if (Date.now() > lsWideUntil) { if (lsFlagsTimer) { clearInterval(lsFlagsTimer); lsFlagsTimer = null; } return; }
    try { lsHeartbeat(); } catch (eHB) { log('LSHB erro ' + eHB); }
    if (lsFlagsBudget <= 0 || !survPcObj || survPcObj.isNull()) return;
    const boolRe = /Load|Initial|Black|Seq|Intro|Cutscene|Teleport|Fade|Screen|Ready|Started|Stop|Tutorial|Spawn|Respawn|Init/i;
    const numRe = /Load|Fade|Percent|Alpha|Time|Stage|State|Opacity/i;
    const objRe = /Black|Load|Tip|Camera|Cutscene|Seq|Splash|Intro/i;
    const samples = [];
    samples.push(['PC', survPcObj, '']);
    try {
      const pmPC = wpClassPropMap(survPcObj.add(0x10).readPointer());
      const cm = pmPC['PlayerCameraManager'];
      if (cm) { const cam = survPcObj.add(cm.off).readPointer(); samples.push(['CAM', cam, lsCamExtra(cam)]); }
    } catch (e1) {}
    // v7: widgets do HUD (BlackScreen / Tips / CutsceneTips) com visibilidade e opacidade.
    try {
      const hud = survPcObj.add(0x340).readPointer();
      samples.push(['HUD', hud, '']);
      const pmH = wpClassPropMap(hud.add(0x10).readPointer());
      ['BlackScreen', 'WBP_TipsInfo', 'CutsceneTips', 'LoadingScreenWidget'].forEach(function (nm) {
        const e = pmH[nm];
        if (!e) return;
        const w = hud.add(e.off).readPointer();
        if (looksLikeUObject(w)) samples.push(['W:' + nm, w, '']);
      });
    } catch (e2) {}
    // v6.3: filhos do W_BlackScreen (visibilidade/opacidade) â€” loga LSBS so quando muda.
    try {
      const hudC = survPcObj.add(0x340).readPointer();
      const bsw = lsProp(hudC, 'BlackScreen', 'ptr');
      if (bsw && !bsw.isNull() && looksLikeUObject(bsw)) {
        const parts = [];
        ['Image_Black', 'TDB_Logo', 'Image_Logo', 'Overlay', 'TextBlock_LoadPercent', 'RichTextBlock_NewHint'].forEach(function (cn) {
          const ch = lsProp(bsw, cn, 'ptr');
          if (ch && ch !== 'x' && ch !== 'semprop' && ch !== 'err' && !ch.isNull() && looksLikeUObject(ch)) {
            parts.push(cn + ':v=' + lsProp(ch, 'Visibility', 'u8') + ',o=' + lsProp(ch, 'RenderOpacity', 'f32'));
          } else parts.push(cn + ':-');
        });
        parts.push('pct=' + lsProp(bsw, 'CurrentLoadingPercentTime', 'f32') + ' black=' + lsProp(bsw, 'BlackScreen', 'bool') + ' opened=' + lsProp(bsw, 'bStopAction', 'bool'));
        const sigBs = parts.join(' ');
        if (sigBs !== globalThis.__lsBsSig) {
          globalThis.__lsBsSig = sigBs;
          log('LSBS ' + new Date().toISOString() + ' bs=' + bsw + ' ' + sigBs);
        }
      }
    } catch (eBs) {}
    try { if (globalThis.__giObj) samples.push(['GI', globalThis.__giObj, '']); } catch (e3) {}
    try { if (placeholderObj && !placeholderObj.isNull()) samples.push(['PH', placeholderObj, '']); } catch (e4) {}
    // v6/v7: cada pawn conhecido (posicao, controller) e o componente de cutscene dele.
    try {
      Object.keys(lsPawns).slice(0, 4).forEach(function (k) {
        const pw = ptr(k);
        if (!looksLikeUObject(pw)) { samples.push(['PAWN:' + k, null, 'morto/invalido']); return; }
        samples.push(['PAWN:' + k, pw, '', true]);
        const pmP = wpClassPropMap(pw.add(0x10).readPointer());
        const ce = pmP['PlayerCutsceneComponent'];
        if (ce) {
          const cc = pw.add(ce.off).readPointer();
          if (looksLikeUObject(cc)) samples.push(['CUT:' + k, cc, '', false, true]);
        }
      });
    } catch (e5) {}
    samples.forEach(function (sm) {
      let st = '';
      try {
        if (!sm[1]) st = sm[2];
        else if (sm[3]) st = lsPawnState(sm[1]);
        else if (sm[4]) st = lsObjState(sm[1], /Play|Cutscene|Active|Finish|Stop|Start|Sequence|bIs/i, /Time|State|Stage|Position/i, /Sequence|Player|Actor|Cutscene|Camera/i);
        else st = lsObjState(sm[1], boolRe, numRe, objRe) + sm[2];
      } catch (eS) { st = 'erro ' + eS; }
      if (lsFlagsSig[sm[0]] !== st) {
        lsFlagsSig[sm[0]] = st;
        lsFlagsBudget--;
        let cn = '?';
        try { if (sm[1]) cn = objectName(sm[1].add(0x10).readPointer()); } catch (eC) {}
        log('LSFLAGS ' + new Date().toISOString() + ' ' + sm[0] + ' ' + cn + ' :: ' + st);
      }
    });
  }
  function pollCmdFile() {
    try { v62TryHookVT(); } catch (eV62) {}
    // LSWORLD (so leitura): ponteiros de mundo/level/pc/pawn durante a janela larga.
    try {
      if (Date.now() < lsWideUntil && Date.now() - lsWorldAt > 700) {
        lsWorldAt = Date.now();
        const aw = wpFindStreamArr();
        log('LSWORLD world=' + (aw ? aw.world : 'null') + ' lvl=' + (aw ? aw.lvl : 'null') +
          ' nStream=' + (aw ? aw.num : 0) + ' pc=' + survPcObj + ' pawn=' + survPawnObj +
          ' pawnName=' + ((survPawnObj && !survPawnObj.isNull()) ? objectName(survPawnObj) : '-'));
      }
    } catch (eLw) {}
    try { if (Date.now() < lsWideUntil) lsFlagsTick(); } catch (eLT) { log('LSFLAGS erro ' + eLT); }
    try { runAutoHub(); } catch (eAH) { log('AUTOHUB erro: ' + eAH); }
    // AUTOQUEST desativado para testar se a primeira quest aparece sozinha (runAutoQuest nao e chamado).
    try { invDumpTick(); } catch (eID) { log('INVDUMP erro: ' + eID); }
    try {
      // v71: fila por arquivo. Executa cmd_<ultimo+1>.json; se nao existir, cai no cmd.json (compatibilidade).
      // fila de comandos de diagnostico (cmd.json / cmd_<n>.json) em %TEMP%\tdb_host_cmd\ (opcional; sem arquivo, nada acontece)
      const base = (Process.getTmpDir ? Process.getTmpDir() : 'C:\\Windows\\Temp') + '\\tdb_host_cmd\\';
      let txt = null;
      try {
        const nf = new File(base + 'cmd_' + (cmdLastId + 1) + '.json', 'r');
        try { txt = nf.readText(); } catch (eR) {}
        try { nf.close(); } catch (eC) {}
      } catch (eO) {}
      if (!txt) {
        try {
          const f = new File(base + 'cmd.json', 'r');
          try { txt = f.readText(); } catch (eR2) {}
          try { f.close(); } catch (eC2) {}
        } catch (eO2) {}
      }
      if (!txt) return;
      const c = JSON.parse(txt);
      if (!c || typeof c.id !== 'number' || c.id <= cmdLastId) return;
      cmdLastId = c.id;
      execCmd(c);
    } catch (e) {}
  }
  function isAnimInstCls(clsP) {
    // Estrutural: a classe herda de AnimInstance? (sobe SuperStruct +0x40)
    let c = clsP;
    for (let d = 0; d < 8 && c && !c.isNull(); d++) {
      if (objectName(c) === 'AnimInstance') return true;
      let nx = null;
      try { nx = c.add(0x40).readPointer(); } catch (e) { break; }
      if (!nx || nx.isNull() || nx.equals(c)) break;
      c = nx;
    }
    return false;
  }
  function execNodeScan() {
    try {
      let hits = 0;
      let validos = 0;
      for (let off = 0x300; off < 0x16000; off += 8) {
        try {
          const p = probeInst.add(off).readPointer();
          if (!p || p.isNull() || !looksLikeUObject(p)) continue;
          validos++;
          const clsP = p.add(0x10).readPointer();
          const clsN = clsP && !clsP.isNull() ? objectName(clsP) : '?';
          const nm = objectName(p);
          // Nome OU estrutura: sub-instancia de grafo ligado e, por
          // construcao, um objeto de animacao â€” tenha o nome que tiver.
          const ehAnim = clsP && !clsP.isNull() ? isAnimInstCls(clsP) : false;
          if (/Locomotion/i.test(clsN) || /Locomotion/i.test(nm) || ehAnim) {
            log('NODESCAN hit off=0x' + off.toString(16) + ' obj=' + p + ' nome=' + nm + ' cls=' + clsN + ' animInst=' + (ehAnim ? 'SIM' : 'nao'));
            hits++;
          }
        } catch (eN) {}
      }
      log('NODESCAN fim hits=' + hits + ' validos=' + validos + ' inst=' + probeInst);
    } catch (eNS) {
      log('NODESCAN exc ' + eNS);
    }
  }
  function execRebirth() {
    try {
      const comps = findMeshComps();
      let mesh0 = null;
      for (let i = 0; i < comps.length; i++) {
        if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
      }
      if (!mesh0) { log('REBIRTH sem CharacterMesh0'); return; }
      const hCls = findPropOffset(mesh0, 'AnimClass');
      const hInst = findPropOffset(mesh0, 'AnimScriptInstance');
      if (!hCls || hCls.off < 0 || !hInst || hInst.off < 0) {
        log('REBIRTH offsets nao achou');
        return;
      }
      const animClass = mesh0.add(hCls.off).readPointer();
      const instBefore = mesh0.add(hInst.off).readPointer();
      log('REBIRTH classe=' + (animClass && !animClass.isNull() ? objectName(animClass) : 'NULL') +
        ' instAntes=' + instBefore);
      // SetAnimInstanceClass nao e UFunction neste build (a busca
      // percorreu a hierarquia inteira). Equivalente oficial: alternar
      // o modo (SingleNode destroi a instancia; Blueprint recria).
      const setFn = findUFnWide(mesh0, 'SetAnimationMode');
      log('REBIRTH SetAnimationMode=' + (setFn ? 'ok' : 'NAO ACHOU'));
      if (!setFn) return;
      dumpAnimFnParms(setFn, 'SetAnimationMode');
      const bMode1 = Memory.alloc(16);
      for (let i0 = 0; i0 < 16; i0++) bMode1.add(i0).writeU8(0);
      bMode1.writeU8(1);
      processEventFn(mesh0, setFn, bMode1);
      const instMid = mesh0.add(hInst.off).readPointer();
      const bMode0 = Memory.alloc(16);
      for (let i1 = 0; i1 < 16; i1++) bMode0.add(i1).writeU8(0);
      processEventFn(mesh0, setFn, bMode0);
      const instAfter = mesh0.add(hInst.off).readPointer();
      log('REBIRTH instMeio=' + instMid + ' instDepois=' + instAfter +
        ' mudou=' + (instAfter && instBefore && !instAfter.equals(instBefore) ? 'SIM' : 'NAO'));
      if (instAfter && !instAfter.isNull()) {
        probeInst = instAfter;
        probeLinkedInst = null;
        rebirthApplied = true;
      }
      // Consulta a camada ligada na instancia (nova) â€” as duas classes.
      if (!loadTryNative) {
        loadTryNative = new NativeFunction(main.base.add(0x242f7f0), 'pointer', ['pointer']);
      }
      const chkFn = findUFnWide(probeInst, 'GetLinkedAnimLayerInstanceByClass');
      const li = findFNameIndices([
        '/Game/SurvAnimator/New_Character/SurviveLocomotion',
        'SurviveLocomotion_C',
      ]);
      const cands = [];
      try {
        const femCls = probeInst.add(0x9888).readPointer();
        if (femCls && !femCls.isNull() && looksLikeUObject(femCls)) {
          cands.push({ tag: 'fem', cls: femCls });
        }
      } catch (eF3) {}
      if (li['/Game/SurvAnimator/New_Character/SurviveLocomotion'] >= 0 && li['SurviveLocomotion_C'] >= 0) {
        const bb = Memory.alloc(32);
        for (let i2 = 0; i2 < 32; i2++) bb.add(i2).writeU8(0);
        bb.writeU32(li['/Game/SurvAnimator/New_Character/SurviveLocomotion'] >>> 0);
        bb.add(8).writeU32(li['SurviveLocomotion_C'] >>> 0);
        const mc = loadTryNative(bb);
        if (mc && !mc.isNull()) cands.push({ tag: 'masc', cls: mc });
      }
      log('REBIRTH chkFn=' + (chkFn ? 'ok' : 'NULL') + ' candidatos=' + cands.length);
      if (chkFn) {
        for (let ci3 = 0; ci3 < cands.length; ci3++) {
          try {
            const b2 = Memory.alloc(16);
            for (let i3 = 0; i3 < 16; i3++) b2.add(i3).writeU8(0);
            b2.writePointer(cands[ci3].cls);
            processEventFn(probeInst, chkFn, b2);
            const linked = b2.add(8).readPointer();
            log('REBIRTH ' + cands[ci3].tag + ' linked=' +
              (linked && !linked.isNull() ? linked + ' nome=' + objectName(linked) : 'NULL'));
            if (linked && !linked.isNull()) probeLinkedInst = linked;
          } catch (eC3) {
            log('REBIRTH chk ' + cands[ci3].tag + ' exc ' + eC3);
          }
        }
      }
    } catch (eRB) {
      log('REBIRTH exc ' + eRB);
    }
  }
  function execPlaySetup() {
    try {
      if (!loadTryNative) {
        loadTryNative = new NativeFunction(main.base.add(0x242f7f0), 'pointer', ['pointer']);
      }
      if (!playPathBuf) { log('PLAYTRY setup sem path'); return; }
      const ret = loadTryNative(playPathBuf);
      if (!ret || ret.isNull()) { log('PLAYTRY load Surv_Jog_F ret=NULL'); return; }
      playSeq = ret;
      let cls = '?';
      try { cls = objectName(ret.add(0x10).readPointer()); } catch (eC) {}
      log('PLAYTRY seq=' + ret + ' nome=' + objectName(ret) + ' cls=' + cls);
      playFn = findUFnWide(probeInst, 'PlaySlotAnimationAsDynamicMontage');
      playStopFn = findUFnWide(probeInst, 'StopSlotAnimation');
      playRateFn = findUFnWide(probeInst, 'Montage_SetPlayRate');
      playActiveFn = findUFnWide(probeInst, 'Montage_IsActive');
      log('PLAYTRY fns play=' + (playFn ? 'ok' : 'NULL') +
        ' stop=' + (playStopFn ? 'ok' : 'NULL') + ' rate=' + (playRateFn ? 'ok' : 'NULL') +
        ' active=' + (playActiveFn ? 'ok' : 'NULL') + ' slotIdx=' + playSlotIdx);
      if (playFn) dumpAnimFnParms(playFn, 'PlaySlotAnimationAsDynamicMontage');
      if (playStopFn) dumpAnimFnParms(playStopFn, 'StopSlotAnimation');
    } catch (ePS) {
      log('PLAYTRY setup exc ' + ePS);
    }
  }
  function execPlayCmd(cmd) {
    try {
      if (cmd === 'play') {
        if (!playFn || !playSeq) { log('PLAYTRY play sem fn/seq'); return; }
        const slot = playSlotList[playSlotPos];
        if (!slot) { log('PLAYTRY play sem slot pos=' + playSlotPos); return; }
        playSlotAtual = slot;
        const buf = Memory.alloc(64);
        for (let i = 0; i < 64; i++) buf.add(i).writeU8(0);
        buf.writePointer(playSeq);
        buf.add(8).writeU32(slot.idx >>> 0);
        buf.add(16).writeFloat(0.15);
        buf.add(20).writeFloat(0.2);
        buf.add(24).writeFloat(playRateNow);
        buf.add(28).writeS32(1000);
        buf.add(32).writeFloat(-1);
        processEventFn(probeInst, playFn, buf);
        const mont = buf.add(40).readPointer();
        playMontage = mont;
        playTryPlaying = true;
        log('PLAYTRY play slot=' + slot.nome + ' rate=' + playRateNow.toFixed(2) + ' montage=' + mont +
          ' nome=' + (mont && !mont.isNull() ? objectName(mont) : 'NULL'));
      } else if (cmd === 'stop') {
        if (!playStopFn) { log('PLAYTRY stop sem fn'); playTryPlaying = false; return; }
        const buf = Memory.alloc(32);
        for (let i = 0; i < 32; i++) buf.add(i).writeU8(0);
        buf.writeFloat(0.25);
        buf.add(8).writeU32((playSlotAtual ? playSlotAtual.idx : playSlotIdx) >>> 0);
        processEventFn(probeInst, playStopFn, buf);
        playTryPlaying = false;
        playMontage = null;
        log('PLAYTRY stop slot=' + (playSlotAtual ? playSlotAtual.nome : '?'));
      } else if (cmd === 'check') {
        if (!playActiveFn || !playMontage) { log('PLAYTRY check sem fn/montage'); return; }
        const buf = Memory.alloc(32);
        for (let i = 0; i < 32; i++) buf.add(i).writeU8(0);
        buf.writePointer(playMontage);
        processEventFn(probeInst, playActiveFn, buf);
        log('PLAYTRY check IsActive=' + buf.add(8).readU8() +
          ' slot=' + (playSlotAtual ? playSlotAtual.nome : '?'));
      }
    } catch (ePC) {
      log('PLAYTRY cmd ' + cmd + ' exc ' + ePC);
      if (cmd === 'play') playTryPlaying = false;
    }
  }
  // NODEWATCH: estruturas dos nos do grafo (offsets ja provados no dump
  // de membros da instancia) â€” a pose e montada aqui.
  var NODE_REGS = [
    { tag: 'LBB', off: 0x770, len: 224 },
    { tag: 'SEQ', off: 0x850, len: 64 },
    { tag: 'CACHE', off: 0x890, len: 40 },
    { tag: 'SMMAIN', off: 0x9930, len: 192 },
    // A2: varredura ampla â€” regioes inteiras onde vivem nos e maquinas,
    // pra mapear o que esta vivo/morto ao redor do ramo de locomocao.
    { tag: 'R1', off: 0x6b0, len: 0x1950 },
    { tag: 'R2', off: 0x9800, len: 0x600 },
    { tag: 'R3', off: 0x14d00, len: 0x500 },
  ];
  var probeNodes = null, probeNodeDone1 = false, probeNodeDone2 = false, probeNodeTick1 = -1;
  function dumpNodeDiff(tag) {
    try {
      for (let nr = 0; nr < NODE_REGS.length; nr++) {
        const reg = NODE_REGS[nr];
        let n = 0;
        for (let nb = 0; nb < reg.len; nb += 4) {
          const cur = probeInst.add(reg.off + nb).readU32();
          if (cur !== probeNodes[nr][nb / 4]) {
            n++;
            if (n <= 40) {
              log(
                tag + ' ' + reg.tag + '+0x' + nb.toString(16) +
                ' idle=' + probeNodes[nr][nb / 4] + ' now=' + cur +
                ' f=' + probeInst.add(reg.off + nb).readFloat().toFixed(3)
              );
            }
          }
        }
        log(tag + ' ' + reg.tag + ' totalAlteradas=' + n + '/' + reg.len / 4);
      }
    } catch (eND) {
      log(tag + ' exc ' + eND);
    }
  }
  // A: diff detalhado dos mutaveis vs idle (mesmo formato do ANIMMUT) â€”
  // mostra QUAIS lanes mudaram e com que valores. So leitura.
  function dumpMutDiffDet(tag) {
    try {
      let n = 0;
      for (let bi = 0; bi < probeMutIdle.length; bi++) {
        const now32 = probeInst.add(probeMutOff + bi * 4).readU32();
        if (now32 !== probeMutIdle[bi]) {
          n++;
          if (n <= 40) {
            let dblStr = '';
            if (bi % 2 === 0) {
              try {
                dblStr = ' dbl=' + probeInst.add(probeMutOff + bi * 4).readDouble().toFixed(3);
              } catch (eD) {}
            }
            log(
              tag + ' lane+0x' + (bi * 4).toString(16) +
              ' idleU32=' + probeMutIdle[bi] + ' nowU32=' + now32 + dblStr
            );
          }
        }
      }
      log(tag + ' totalLanesAlteradas=' + n);
    } catch (eMD) {
      log(tag + ' exc ' + eMD);
    }
  }
  // X17b: retorno do getSpeed capturado no onLeave do hook de PE (chamadas do jogo)
  var gsLastF0 = -1, gsLastT = 0, gsLogN = 0, gsLastLogged = -999;
  function animProbeSetup() {
    probeSetupDone = true;
    try {
      const comps = findMeshComps();
      let mesh0 = null;
      for (let i = 0; i < comps.length; i++) {
        if (objectName(comps[i]) === 'CharacterMesh0') mesh0 = comps[i];
      }
      if (!mesh0) { log('ANIMPROBE sem CharacterMesh0'); probeDone = true; return; }
      const hit = findPropOffset(mesh0, 'AnimScriptInstance');
      if (!hit || hit.off < 0) { log('ANIMPROBE sem AnimScriptInstance'); probeDone = true; return; }
      probeInst = mesh0.add(hit.off).readPointer();
      if (!probeInst || probeInst.isNull()) { log('ANIMPROBE inst null'); probeDone = true; return; }
      // findUFnDet nao achou getSpeed nesta classe BP; enumera p/ inventario
      // e o retorno vem do onLeave (X17b), sem precisar resolver a UFunction.
      let instCls = null;
      try {
        instCls = probeInst.add(0x10).readPointer();
      } catch (eC) {}
      log('ANIMPROBE inst=' + objectName(probeInst) + ' cls=' + (instCls ? objectName(instCls) : '?'));
      if (instCls && !instCls.isNull()) {
        enumAnimFns(instCls, 'ANIMINST', /Speed|MainState|Locom|State|UpdateAnim/i, 40);
      }
      dumpPropsFor(probeInst, 'ANIMVARS', /Speed|Direc|Vel|Mov|Ground|Fall|Accel|State|Locom|Input|Walk|Run|Jog|Sprint/);
      // A(otimizacao): controles de ritmo/atualizacao do mesh â€” um modo
      // economico aqui prenderia justamente a locomocao.
      try {
        dumpPropsFor(mesh0, 'MESHCTRL', /Anim|Tick|Update|Optimi|Visib|Pause|Rate|LOD|Refresh|Bone/i);
      } catch (eMC) {}
      // OPTANIM: o OptimizeAnimator e chamado pelo grafo todo frame e
      // nunca foi investigado. Resolver p/ o antes/depois no tick.
      try {
        optAnimFn = findUFnWide(probeInst, 'OptimizeAnimator');
        if (optAnimFn) {
          try { dumpAnimFnParms(optAnimFn, 'OptimizeAnimator'); } catch (eOA) {}
        } else {
          log('OPTANIM nao achou OptimizeAnimator');
        }
      } catch (eOA2) {
        log('OPTANIM exc setup ' + eOA2);
      }
      // X17c: CharacterMovement do pawn p/ ler Velocity da memoria (sem PE)
      probeMov = null;
      probeVelOff = -1;
      for (let off = 0x100; off <= 0xb00; off += 8) {
        let pc = null;
        try {
          pc = survPawnObj.add(off).readPointer();
        } catch (eM) {
          continue;
        }
        if (!pc || pc.isNull() || !looksLikeUObject(pc)) continue;
        let cn = '';
        try {
          cn = objectName(pc.add(0x10).readPointer());
        } catch (eN) {}
        if (/CharacterMovement/i.test(cn)) {
          probeMov = pc;
          const hv = findPropOffset(pc, 'Velocity');
          if (hv && hv.off >= 0) probeVelOff = hv.off;
          log('ANIMPROBE movComp=' + objectName(pc) + ' cls=' + cn + ' velOff=' + probeVelOff);
          break;
        }
      }
      probeGsFn = findUFnWide(probeInst, 'getSpeed');
      log('ANIMPROBE getSpeedFn=' + (probeGsFn ? probeGsFn.toString() : 'NAO ACHOU'));
      if (probeGsFn) dumpAnimFnParms(probeGsFn, 'getSpeed');
      // X19 (so leitura): condicoes de transicao da MainState â€” funcoes puras
      // bool sem entradas. Chamar andando mostra qual condicao bloqueia.
      probeTrans = [];
      const transNames = [
        'MainState_Loot_to_Loco',
        'MainState_Land_to_Loco',
        'MainState_Land_to_Loco_Right',
        'MainState_Land_to_Loco_NotRight',
        'IdleTransition',
      ];
      for (let ti = 0; ti < transNames.length; ti++) {
        const tf = findUFnWide(probeInst, transNames[ti]);
        if (tf) {
          probeTrans.push({ name: transNames[ti], fn: tf });
          dumpAnimFnParms(tf, transNames[ti]);
        } else {
          log('ANIMTRANS nao achou ' + transNames[ti]);
        }
      }
      // X20 (so leitura): estado atual de cada maquina (indice) via
      // GetCurrentStateName(int) -> FName. Desempata: preso no estado X vs
      // entrou em Loco mas o conteudo nao toca.
      probeStateFn = findUFnWide(probeInst, 'GetCurrentStateName');
      log('ANIMSTATE fn=' + (probeStateFn ? probeStateFn.toString() : 'NAO ACHOU'));
      // GetCurrentStateName da AV 0x18 neste build; usar pesos por indice.
      probeWeightFn = findUFnWide(probeInst, 'GetInstanceStateWeight');
      log('ANIMW fn=' + (probeWeightFn ? probeWeightFn.toString() : 'NAO ACHOU'));
      // X26: peso total da maquina no grafo + tempo no estado (mapeia mi)
      probeMachWF = findUFnWide(probeInst, 'GetInstanceMachineWeight');
      probeElapsedF = findUFnWide(probeInst, 'GetInstanceCurrentStateElapsedTime');
      log(
        'ANIMMW fns=' + (probeMachWF ? 'W' : '-') + (probeElapsedF ? 'E' : '-')
      );
      // X21 (so leitura): scan da instancia atras de FAnimNode_StateMachine.
      // Layout provado no Ghidra (FUN_143de3600): maquina+0x24 = indice do
      // estado atual; maquina+0x30 = baked; baked+0x10 = estados (stride
      // 0x58, FName no +0); baked+0x18 = numEstados.
      probeMachines = [];
      try {
        for (let off = 0x100; off < 0x20000 && probeMachines.length < 12; off += 8) {
          let baked = null;
          let cur = -1;
          try {
            cur = probeInst.add(off + 0x24).readS32();
            if (cur < 0 || cur > 63) continue;
            baked = probeInst.add(off + 0x30).readPointer();
          } catch (eS1) {
            continue;
          }
          if (!baked || baked.isNull()) continue;
          let num = -1;
          let states = null;
          try {
            num = baked.add(0x18).readS32();
            if (num < 2 || num > 64) continue;
            states = baked.add(0x10).readPointer();
          } catch (eS2) {
            continue;
          }
          if (!states || states.isNull()) continue;
          if (cur >= num) continue;
          const names = [];
          let okNames = true;
          for (let si = 0; si < num; si++) {
            let nm = null;
            try {
              const fidx = states.add(si * 0x58).readS32() >>> 0;
              nm = fidx > 0 ? readFNameEntry(fidx) : 'None';
            } catch (eS3) {
              okNames = false;
              break;
            }
            if (!nm || !/^[A-Za-z0-9_ .\-]{1,48}$/.test(nm)) {
              okNames = false;
              break;
            }
            names.push(nm);
          }
          if (!okNames) continue;
          probeMachines.push({ off: off, names: names });
          log(
            'ANIMSM off=0x' + off.toString(16) + ' atual=' + names[cur] +
            ' estados=[' + names.join(', ') + ']'
          );
        }
        log('ANIMSM total=' + probeMachines.length);
      } catch (eSM) {
        log('ANIMSM exc ' + eSM);
      }
      // A': instancia pos-processo do mesmo mesh (candidata a chamadora)
      probePostInst = null;
      try {
        const hp = findPropOffset(mesh0, 'PostProcessAnimInstance');
        if (hp && hp.off >= 0) {
          const pp = mesh0.add(hp.off).readPointer();
          if (pp && !pp.isNull()) {
            probePostInst = pp;
            log('ANIMPOST inst=' + objectName(pp));
          }
        }
      } catch (ePP) {
        log('ANIMPOST exc ' + ePP);
      }
      // A: cadeia ALS completa â€” CollectVariables (busca dados do pawn)
      // primeiro, depois os Calculate*. Sem a coleta, os Calculate* leem
      // variaveis zeradas e nao escrevem nada (veredito do experimento B).
      calcFns = [];
      const calcNames = [
        'CollectVariables',
        'CalculateSpeed',
        'CalculateMovementDirection',
        'CalculateVelocityBlend',
        'CalculateMovePlayRate',
      ];
      for (let ci = 0; ci < calcNames.length; ci++) {
        const cf = findUFnWide(probeInst, calcNames[ci]);
        if (cf) {
          calcFns.push({ name: calcNames[ci], fn: cf });
          // A1 (so leitura): forma de cada elo da cadeia â€” parametros de
          // entrada/saida mostram se eles trocam dados via buffer (que a
          // nossa chamada descarta) ou via variaveis-membro.
          try { dumpAnimFnParms(cf, calcNames[ci]); } catch (eCV) {}
        } else {
          log('CALC nao achou ' + calcNames[ci]);
        }
      }
      log('CALC fns resolvidas=' + calcFns.length + '/5');
      // C: inits nunca chamados â€” a maquina de itens esta presa em
      // FirstStart desde o READY. Resolver agora, chamar 1x andando.
      init2Fns = [];
      const init2Names = ['FirstStartUpdate', 'On Init Loco'];
      for (let ii = 0; ii < init2Names.length; ii++) {
        const inf = findUFnWide(probeInst, init2Names[ii]);
        if (inf) {
          init2Fns.push({ name: init2Names[ii], fn: inf });
          try { dumpAnimFnParms(inf, init2Names[ii]); } catch (eI2) {}
        } else {
          log('INIT2 nao achou ' + init2Names[ii]);
        }
      }
      log('INIT2 fns resolvidas=' + init2Fns.length + '/2');
      // INITANIM: evento de nascimento da instancia de animacao. Ela
      // nasceu cedo demais (tela de personagem); resolver aqui e o tick
      // chama 1x com o pawn pronto â€” hipotese dos sub-grafos congelados.
      try {
        initAnimFn = findUFnWide(probeInst, 'BlueprintInitializeAnimation');
        if (initAnimFn) {
          try { dumpAnimFnParms(initAnimFn, 'BlueprintInitializeAnimation'); } catch (eIA) {}
        } else {
          log('INITANIM nao achou BlueprintInitializeAnimation');
        }
      } catch (eIA2) {
        log('INITANIM exc setup ' + eIA2);
      }
      // RITUAL: resolver as funcoes do evento de locomocao (a sequencia
      // que o ExecuteUbergraph chamaria: CollectVariables em 321277,
      // UpdateLayerValues em 321267, e os Calculate* que o grafo
      // alimentaria). Buffers proprios de 512B (o frame de parametros
      // de CalculateVelocityBlend passa de 384B).
      try {
        const rNames = ['CollectVariables', 'UpdateLayerValues',
          'CalculateSpeed', 'CalculateMovementDirection',
          'CalculateVelocityBlend', 'CalculateMovePlayRate',
          'GetClampedMoveDir'];
        ritualFns = []; ritualBufs = [];
        for (let ri = 0; ri < rNames.length; ri++) {
          const rf = findUFnWide(probeInst, rNames[ri]);
          if (rf) {
            const rb = Memory.alloc(512);
            for (let rj = 0; rj < 512; rj++) rb.add(rj).writeU8(0);
            ritualFns.push(rf); ritualBufs.push(rb);
          } else {
            log('RITUAL nao achou ' + rNames[ri]);
          }
        }
        ritualOn = ritualFns.length > 0;
        log('RITUAL fns=' + ritualFns.length + '/7 on=' + ritualOn);
      } catch (eRT2) {
        log('RITUAL setup exc ' + eRT2);
      }
      // LINKCHK (so leitura): a instancia ligada de locomocao existe?
      // A classe dela esta referenciada em inst+0x9888 (achado NODEPTR).
      try {
        const locoCls = probeInst.add(0x9888).readPointer();
        const glFn = findUFnWide(probeInst, 'GetLinkedAnimLayerInstanceByClass');
        linkChkFn = glFn;
        if (glFn && locoCls && !locoCls.isNull()) {
          const gbuf = Memory.alloc(32);
          for (let gi = 0; gi < 32; gi++) gbuf.add(gi).writeU8(0);
          gbuf.writePointer(locoCls);
          processEventFn(probeInst, glFn, gbuf);
          const linked = gbuf.add(8).readPointer();
          log(
            'LINKCHK ByClass(' + objectName(locoCls) + ') = ' +
            (linked.isNull() ? 'NULL' : objectName(linked) + '@' + linked)
          );
          if (!linked.isNull()) probeLinkedInst = linked;
        } else {
          log('LINKCHK fn/cls indisponivel');
        }
      } catch (eLK) {
        log('LINKCHK exc ' + eLK);
      }
      // LINKTRY: resolver a funcao de ligacao (a chamada vai no tick)
      try {
        linkFn = findUFnWide(probeInst, 'LinkAnimClassLayers');
        log(linkFn ? 'LINKTRY fn LinkAnimClassLayers ok' : 'LINKTRY nao achou LinkAnimClassLayers');
      } catch (eLF) {}
      // MASC (so leitura): caÃ§ar a classe de locomocao masculina nas
      // propriedades do pawn, da instancia e do mesh â€” o leitor ja
      // resolve ClassProperty em nome@endereco.
      try {
        dumpPropsFor(survPawnObj, 'PAWNLOCO', /Locom|Anim|Sex|Gender|Male|Fem|Masc|Class|Body/);
      } catch (eML1) {}
      try {
        dumpPropsFor(probeInst, 'INSTLOCO', /Locom|Sex|Gender|Male|Fem|Masc|Class/);
      } catch (eML2) {}
      try {
        dumpPropsFor(mesh0, 'MESHLOCO', /Locom|Sex|Gender|Male|Fem|Masc/);
      } catch (eML3) {}
      // TAGSCAN (so leitura): a etiqueta do no de grafo ligado esta
      // gravada na estrutura dele (perto da classe, inst+0x9888). Ler os
      // FNames da regiao e testar os candidatos na consulta por tag â€”
      // copiando os 8 bytes crus do nome, sem precisar monta-lo.
      try {
        const tagCands = [];
        for (let to = 0x9750; to < 0x9d00; to += 4) {
          let tn = null, tnum = -1;
          try {
            tn = fnameAt(probeInst.add(to));
            tnum = probeInst.add(to + 4).readS32();
          } catch (eT) { continue; }
          if (!tn || tnum !== 0) continue;
          if (!/^[A-Za-z_][A-Za-z0-9_ ]{1,48}$/.test(tn)) continue;
          if (tn === 'None') continue;
          tagCands.push({ off: to, name: tn });
          log('TAGSCAN +0x' + to.toString(16) + ' = "' + tn + '"');
        }
        log('TAGSCAN candidatos=' + tagCands.length);
        const gtagFn = findUFnWide(probeInst, 'GetLinkedAnimGraphInstanceByTag');
        if (gtagFn && tagCands.length > 0) {
          const prio = tagCands.filter((c) => /Locom|Anim|Graph|Main|Body/i.test(c.name));
          const rest = tagCands
            .filter((c) => !/Locom|Anim|Graph|Main|Body/i.test(c.name))
            .sort((a, b) => Math.abs(a.off - 0x9888) - Math.abs(b.off - 0x9888));
          const tryList = prio.concat(rest).slice(0, 6);
          for (let tc = 0; tc < tryList.length; tc++) {
            const cand = tryList[tc];
            try {
              const tbuf = Memory.alloc(32);
              for (let ti = 0; ti < 32; ti++) tbuf.add(ti).writeU8(0);
              tbuf.writeU32(probeInst.add(cand.off).readU32());
              tbuf.add(4).writeU32(probeInst.add(cand.off + 4).readU32());
              processEventFn(probeInst, gtagFn, tbuf);
              const linst = tbuf.add(8).readPointer();
              log(
                'TAGCHK tag="' + cand.name + '" (+0x' + cand.off.toString(16) + ') = ' +
                (linst.isNull() ? 'NULL' : objectName(linst) + '@' + linst)
              );
              if (!linst.isNull() && !probeLinkedInst) probeLinkedInst = linst;
            } catch (eTC) {
              log('TAGCHK exc "' + cand.name + '" ' + eTC);
            }
          }
        } else {
          log('TAGCHK fn indisponivel ou sem candidatos');
        }
      } catch (eTS) {
        log('TAGSCAN exc ' + eTS);
      }
      // TAGLINK (experimento unico): achar o FName da etiqueta gravado na
      // instancia, LIGAR o grafo de locomocao com ele (classe Fem, a que
      // o no ja referencia em inst+0x9888) e re-consultar na hora.
      try {
        const linkTagFn = findUFnWide(probeInst, 'LinkAnimGraphByTag');
        const getTagFn2 = findUFnWide(probeInst, 'GetLinkedAnimGraphInstanceByTag');
        const locoCls3 = probeInst.add(0x9888).readPointer();
        log(
          'TAGLINK fns=' + (linkTagFn ? 1 : 0) + '/' + (getTagFn2 ? 1 : 0) +
          ' cls=' + (locoCls3 && !locoCls3.isNull() ? objectName(locoCls3) : 'NULL')
        );
        if (linkTagFn && locoCls3 && !locoCls3.isNull()) {
          const hitsL = [];
          for (let fo2 = 0x300; fo2 < 0x16000 && hitsL.length < 8; fo2 += 4) {
            let fn3 = null, fnum3 = -1;
            try {
              fn3 = fnameAt(probeInst.add(fo2));
              if (fn3 !== 'Locomotion' && fn3 !== 'LocoMotion') continue;
              fnum3 = probeInst.add(fo2 + 4).readS32();
            } catch (eF3) { continue; }
            if (fnum3 !== 0) continue;
            hitsL.push({ off: fo2, name: fn3 });
          }
          hitsL.sort((a, b) => (a.name === b.name ? a.off - b.off : a.name === 'Locomotion' ? -1 : 1));
          log('TAGLINK ocorrencias=' + hitsL.length);
          let linkedOk = false;
          for (let hi = 0; hi < hitsL.length && hi < 6 && !linkedOk; hi++) {
            const h = hitsL[hi];
            try {
              if (getTagFn2) {
                const qb = Memory.alloc(32);
                for (let qi = 0; qi < 32; qi++) qb.add(qi).writeU8(0);
                qb.writeU32(probeInst.add(h.off).readU32());
                qb.add(4).writeU32(probeInst.add(h.off + 4).readU32());
                processEventFn(probeInst, getTagFn2, qb);
                const pre = qb.add(8).readPointer();
                log(
                  'TAGLINK pre tag="' + h.name + '" +0x' + h.off.toString(16) + ' = ' +
                  (pre.isNull() ? 'NULL' : objectName(pre) + '@' + pre)
                );
                if (!pre.isNull()) { probeLinkedInst = pre; linkedOk = true; break; }
              }
              const lb = Memory.alloc(32);
              for (let li2 = 0; li2 < 32; li2++) lb.add(li2).writeU8(0);
              lb.writeU32(probeInst.add(h.off).readU32());
              lb.add(4).writeU32(probeInst.add(h.off + 4).readU32());
              lb.add(8).writePointer(locoCls3);
              processEventFn(probeInst, linkTagFn, lb);
              log('TAGLINK ligou tag="' + h.name + '" +0x' + h.off.toString(16) + ' cls=' + objectName(locoCls3));
              if (getTagFn2) {
                const qb2 = Memory.alloc(32);
                for (let qj = 0; qj < 32; qj++) qb2.add(qj).writeU8(0);
                qb2.writeU32(probeInst.add(h.off).readU32());
                qb2.add(4).writeU32(probeInst.add(h.off + 4).readU32());
                processEventFn(probeInst, getTagFn2, qb2);
                const post = qb2.add(8).readPointer();
                log('TAGLINK pos = ' + (post.isNull() ? 'NULL' : objectName(post) + '@' + post));
                if (!post.isNull()) { probeLinkedInst = post; linkedOk = true; }
              }
            } catch (eHL) {
              log('TAGLINK exc cand "' + h.name + '" ' + eHL);
            }
          }
          log('TAGLINK resultado=' + (linkedOk ? 'INSTANCIA VIVA' : 'sem instancia'));
        }
      } catch (eTL) {
        log('TAGLINK exc ' + eTL);
      }
      // TAGALL (so leitura): listar TODOS os nomes distintos gravados na
      // instancia â€” a etiqueta do no ligado esta entre eles; eu escolho
      // a olho no log. '*' = faixa da maquina principal (0x9000-0xa200).
      try {
        const seenNames = {};
        let nDistinct = 0;
        for (let ao = 0x300; ao < 0x16000; ao += 4) {
          let an = null, anum = -1;
          try {
            an = fnameAt(probeInst.add(ao));
            if (!an) continue;
            anum = probeInst.add(ao + 4).readS32();
          } catch (eA) { continue; }
          if (anum !== 0) continue;
          if (!/^[A-Za-z_][A-Za-z0-9_ ]{2,40}$/.test(an)) continue;
          if (seenNames[an] !== undefined) continue;
          seenNames[an] = ao;
          nDistinct++;
          if (nDistinct <= 500) {
            const star = ao >= 0x9000 && ao < 0xa200 ? ' *' : '';
            log('TAGALL "' + an + '" +0x' + ao.toString(16) + star);
          }
        }
        log('TAGALL distintos=' + nDistinct);
      // TAGNONE (experimento): a etiqueta do no ligado pode ser vazia
      // (None = 8 bytes zero). Consultar por ela; se vazio, LIGAR com
      // LinkAnimGraphByTag(None, Fem) e re-consultar. Tambem chama a
      // GetLinkedAnimInstance, que o proprio grafo usa.
      try {
        const gtFn3 = findUFnWide(probeInst, 'GetLinkedAnimGraphInstanceByTag');
        const ltFn3 = findUFnWide(probeInst, 'LinkAnimGraphByTag');
        const cls3 = probeInst.add(0x9888).readPointer();
        const descInst = (p) => {
          if (!p || p.isNull()) return 'NULL';
          let cn = '?';
          try { cn = objectName(p.add(0x10).readPointer()); } catch (eD) {}
          return objectName(p) + '@' + p + ' cls=' + cn;
        };
        const queryTagNone = () => {
          const b = Memory.alloc(32);
          for (let i = 0; i < 32; i++) b.add(i).writeU8(0);
          processEventFn(probeInst, gtFn3, b);
          return b.add(8).readPointer();
        };
        if (gtFn3) {
          const preN = queryTagNone();
          log('TAGNONE pre = ' + descInst(preN));
          if (!preN.isNull()) probeLinkedInst = preN;
          if (preN.isNull() && ltFn3 && cls3 && !cls3.isNull()) {
            const lb3 = Memory.alloc(32);
            for (let i3 = 0; i3 < 32; i3++) lb3.add(i3).writeU8(0);
            lb3.add(8).writePointer(cls3);
            processEventFn(probeInst, ltFn3, lb3);
            log('TAGNONE ligou LinkAnimGraphByTag(None, ' + objectName(cls3) + ')');
            const postN = queryTagNone();
            log('TAGNONE pos = ' + descInst(postN));
            if (!postN.isNull()) probeLinkedInst = postN;
          }
        } else {
          log('TAGNONE sem fn de consulta');
        }
        try {
          const gliFn = findUFnWide(probeInst, 'GetLinkedAnimInstance');
          if (gliFn) {
            try { dumpAnimFnParms(gliFn, 'GetLinkedAnimInstance'); } catch (eG1) {}
            const gb3 = Memory.alloc(64);
            for (let g3 = 0; g3 < 64; g3++) gb3.add(g3).writeU8(0);
            processEventFn(probeInst, gliFn, gb3);
            log('TAGNONE GetLinkedAnimInstance buf=' + hexBytes(gb3, 32));
          } else {
            log('TAGNONE GetLinkedAnimInstance nao achou');
          }
        } catch (eG2) {
          log('TAGNONE GetLinkedAnimInstance exc ' + eG2);
        }
        log('TAGNONE linked=' + (probeLinkedInst ? descInst(probeLinkedInst) : 'NULL'));
      } catch (eTN) {
        log('TAGNONE exc ' + eTN);
      }
      // TAGTRYALL (so leitura): testar TODOS os nomes distintos como
      // etiqueta na consulta por tag. Um acerto = etiqueta + instancia.
      try {
        const gtFn4 = findUFnWide(probeInst, 'GetLinkedAnimGraphInstanceByTag');
        if (gtFn4) {
          const names = Object.keys(seenNames);
          let hitsT = 0;
          for (let ni = 0; ni < names.length; ni++) {
            const nm = names[ni];
            const noff = seenNames[nm];
            try {
              const tb4 = Memory.alloc(32);
              for (let ti4 = 0; ti4 < 32; ti4++) tb4.add(ti4).writeU8(0);
              tb4.writeU32(probeInst.add(noff).readU32());
              tb4.add(4).writeU32(probeInst.add(noff + 4).readU32());
              processEventFn(probeInst, gtFn4, tb4);
              const ri = tb4.add(8).readPointer();
              if (!ri.isNull()) {
                hitsT++;
                let rcn = '?';
                try { rcn = objectName(ri.add(0x10).readPointer()); } catch (eR) {}
                log('TAGHIT "' + nm + '" +0x' + noff.toString(16) + ' = ' + objectName(ri) + '@' + ri + ' cls=' + rcn);
                if (!probeLinkedInst) probeLinkedInst = ri;
              }
            } catch (eNT) {}
          }
          log('TAGTRYALL testados=' + names.length + ' acertos=' + hitsT);
        } else {
          log('TAGTRYALL sem fn');
        }
      } catch (eTT) {
        log('TAGTRYALL exc ' + eTT);
      }
      // TAGLINKALL (experimento): LIGAR com cada nome candidato e
      // re-consultar. Etiqueta errada = o motor ignora (nenhum no casa).
      // Acerto util = instancia cuja classe seja SurviveLocomotion*.
      try {
        const ltFn5 = findUFnWide(probeInst, 'LinkAnimGraphByTag');
        const gtFn5 = findUFnWide(probeInst, 'GetLinkedAnimGraphInstanceByTag');
        const cls5 = probeInst.add(0x9888).readPointer();
        if (ltFn5 && gtFn5 && cls5 && !cls5.isNull()) {
          const names5 = Object.keys(seenNames);
          let hitsL5 = 0;
          for (let n5 = 0; n5 < names5.length; n5++) {
            const nm5 = names5[n5];
            const noff5 = seenNames[nm5];
            try {
              const lb5 = Memory.alloc(32);
              for (let i5b = 0; i5b < 32; i5b++) lb5.add(i5b).writeU8(0);
              lb5.writeU32(probeInst.add(noff5).readU32());
              lb5.add(4).writeU32(probeInst.add(noff5 + 4).readU32());
              lb5.add(8).writePointer(cls5);
              processEventFn(probeInst, ltFn5, lb5);
              const qb5 = Memory.alloc(32);
              for (let q5 = 0; q5 < 32; q5++) qb5.add(q5).writeU8(0);
              qb5.writeU32(probeInst.add(noff5).readU32());
              qb5.add(4).writeU32(probeInst.add(noff5 + 4).readU32());
              processEventFn(probeInst, gtFn5, qb5);
              const ri5 = qb5.add(8).readPointer();
              if (!ri5.isNull()) {
                hitsL5++;
                let rcn5 = '?';
                try { rcn5 = objectName(ri5.add(0x10).readPointer()); } catch (eR5) {}
                log('TAGLINKHIT "' + nm5 + '" +0x' + noff5.toString(16) + ' = ' + objectName(ri5) + '@' + ri5 + ' cls=' + rcn5);
                if (/SurviveLocomotion/.test(rcn5)) {
                  probeLinkedInst = ri5;
                  log('TAGLINKALVO instancia de LOCOMOCAO ligada com tag="' + nm5 + '"');
                  break;
                }
              }
            } catch (eN5) {}
          }
          log('TAGLINKALL testados=' + names5.length + ' acertos=' + hitsL5 + ' alvo=' + (probeLinkedInst ? 'SIM' : 'NAO'));
        } else {
          log('TAGLINKALL fns/cls indisponivel');
        }
      } catch (eTL5) {
        log('TAGLINKALL exc ' + eTL5);
      }
      } catch (eTA) {
        log('TAGALL exc ' + eTA);
      }
      // X24a (so leitura): TryGetPawnOwner nesta instancia â€” se vier nulo ou
      // placeholder, o BlueprintUpdateAnimation aborta antes dos Calculate*.
      try {
        const tpoFn = findUFnWide(probeInst, 'TryGetPawnOwner');
        if (tpoFn) {
          const tbuf2 = Memory.alloc(16);
          for (let i = 0; i < 16; i++) tbuf2.add(i).writeU8(0);
          processEventFn(probeInst, tpoFn, tbuf2);
          const owner = tbuf2.readPointer();
          log(
            'ANIMOWNER TryGetPawnOwner=' +
              (owner.isNull() ? 'NULL' : objectName(owner) + '@' + owner)
          );
        } else {
          log('ANIMOWNER fn nao achou');
        }
      } catch (eOw) {
        log('ANIMOWNER exc ' + eOw);
      }
      // X24b (so leitura): setters da instancia (quem liga o modo de locomocao)
      try {
        let sc0 = probeInst.add(0x10).readPointer();
        if (sc0 && !sc0.isNull()) {
          enumAnimFns(sc0, 'ANIMFN3_C1', /^Set|MovementState|Overlay|Gait|Stance|RotationMode|ViewMode/i, 60);
          let sc1 = sc0.add(0x40).readPointer();
          if (
            sc1 &&
            !sc1.isNull() &&
            /Class/.test(objectName(sc1.add(0x10).readPointer()))
          ) {
            enumAnimFns(sc1, 'ANIMFN3_C2', /^Set|MovementState|Overlay|Gait|Stance|RotationMode|ViewMode/i, 60);
          }
        }
      } catch (eS3) {}
      // X22a (so leitura): inventario amplo de funcoes das classes BP da
      // instancia (fontes de Speed/Direction p/ o blend de locomocao).
      try {
        let cc0 = probeInst.add(0x10).readPointer();
        if (cc0 && !cc0.isNull()) {
          enumAnimFns(cc0, 'ANIMFN2_C1', /Speed|Dir|Vel|Angle|Move|Ground|Owner|Pawn|Char|Update/i, 80);
          let cc1 = cc0.add(0x40).readPointer();
          if (
            cc1 &&
            !cc1.isNull() &&
            /Class/.test(objectName(cc1.add(0x10).readPointer()))
          ) {
            enumAnimFns(cc1, 'ANIMFN2_C2', /Speed|Dir|Vel|Angle|Move|Ground|Owner|Pawn|Char|Update/i, 80);
          }
        }
      } catch (eF2) {}
      // X22b: snapshot idle do bloco mutavel do grafo (diff andando depois)
      probeMutIdle = null;
      probeMutDone = false;
      try {
        // Offset provado pelo ANIMALL (__AnimBlueprintMutables off=0x358 elem=856);
        // findPropOffset nao localizou por nome, usar o offset direto.
        probeMutOff = 0x358;
        probeMutIdle = [];
        for (let bi = 0; bi < 856; bi += 4) {
          probeMutIdle.push(probeInst.add(probeMutOff + bi).readU32());
        }
        log('ANIMMUT snapshot idle off=0x358 lanes=' + probeMutIdle.length);
        // NODEWATCH: retrato dos nos no mesmo instante (parado)
        probeNodes = [];
        for (let nr = 0; nr < NODE_REGS.length; nr++) {
          const arr = [];
          for (let nb = 0; nb < NODE_REGS[nr].len; nb += 4) {
            arr.push(probeInst.add(NODE_REGS[nr].off + nb).readU32());
          }
          probeNodes.push(arr);
        }
        log('NODEWATCH snapshot idle regs=' + probeNodes.length);
      } catch (eMu) {
        log('ANIMMUT exc ' + eMu);
      }
      // A1 (so leitura): inventario COMPLETO de funcoes (sem filtro) das
      // classes BP da instancia â€” achar a funcao-elo da locomocao pelo nome.
      try {
        let ac0 = probeInst.add(0x10).readPointer();
        if (ac0 && !ac0.isNull()) {
          let aCls = ac0;
          for (let ad = 0; ad < 3 && aCls && !aCls.isNull(); ad++) {
            const aClsName = objectName(aCls);
            let aNode = null;
            try {
              aNode = aCls.add(0x48).readPointer();
            } catch (eA1) {}
            let aCnt = 0;
            for (let ai = 0; ai < 2000 && aNode && !aNode.isNull(); ai++) {
              let aNm = null;
              try {
                aNm = objectName(aNode);
              } catch (eA2) {
                break;
              }
              let aIsFn = false;
              try {
                const anc = aNode.add(0x10).readPointer();
                if (anc && !anc.isNull()) aIsFn = objectName(anc) === 'Function';
              } catch (eA3) {}
              if (aIsFn && aNm) {
                aCnt++;
                log('ANIMALLFN fn=' + aNm + ' owner=' + aClsName);
              }
              let aNext = null;
              try {
                aNext = aNode.add(0x28).readPointer();
              } catch (eA4) {
                break;
              }
              if (aNext && aNext.equals(aNode)) break;
              aNode = aNext;
            }
            log('ANIMALLFN cls=' + aClsName + ' fns=' + aCnt);
            let aUp = null;
            try {
              const candA = aCls.add(0x40).readPointer();
              if (
                candA &&
                !candA.isNull() &&
                !candA.equals(aCls) &&
                /Class/.test(objectName(candA.add(0x10).readPointer()))
              ) {
                aUp = candA;
              }
            } catch (eA5) {}
            aCls = aUp;
          }
        }
      } catch (eA) {
        log('ANIMALLFN exc ' + eA);
      }
      // A2: trace dos primeiros 4s (funcoes de init: FirstStartUpdate etc.)
      trace0On = true;
      traceSet0 = {};
      trace0Until = Date.now() + 4000;
      log('ANIMTRACE0 armado (4s)');
      // X18 (so leitura): TODAS as variaveis da instancia (nome+valor) p/ achar
      // a trava de estado (getSpeed ja provou = velMag; a transicao nao entra).
      dumpPropsFor(probeInst, 'ANIMALL', null);
      try {
        let c0 = probeInst.add(0x10).readPointer();
        if (c0 && !c0.isNull()) {
          enumAnimFns(c0, 'ANIMFN_C1', /State|Main|Locom|Trans/i, 60);
          let c1 = c0.add(0x40).readPointer();
          if (
            c1 &&
            !c1.isNull() &&
            /Class/.test(objectName(c1.add(0x10).readPointer()))
          ) {
            enumAnimFns(c1, 'ANIMFN_C2', /State|Main|Locom|Trans/i, 60);
          }
        }
      } catch (eF) {}
      probeNextAt = Date.now() + 500;
    } catch (e) {
      log('ANIMPROBE setup exc ' + e);
      probeDone = true;
    }
  }
  function ritualTick() {
    if (!ritualOn || !probeInst || ritualMode === 0) return;
    const nFns = ritualMode === 1
      ? Math.min(2, ritualFns.length)
      : ritualFns.length;
    for (let i = 0; i < nFns; i++) {
      const b = ritualBufs[i];
      for (let j = 0; j < 512; j += 8) b.add(j).writeU64(0);
      processEventFn(probeInst, ritualFns[i], b);
    }
    ritualN++;
    if (ritualN % 600 === 1) log('RITUAL rodando n=' + ritualN + ' modo=' + ritualMode);
  }
  function animProbeTick() {
    if (!probeSetupDone) { animProbeSetup(); return; }
    if (probeDone || !probeInst) return;
    const now = Date.now();
    if (now < probeNextAt) return;
    probeNextAt = now + 500;
    probeTickN++;
    if (probeLines >= 140 || probeTickN > 20000) { probeDone = true; log('ANIMPROBE fim'); return; }
    try {
      const p = readPawnZQuick();
      if (!p) return;
      let speed = 0;
      if (probeLastLoc && probeLastT > 0) {
        const dt = (now - probeLastT) / 1000;
        if (dt > 0.05) {
          speed = Math.round(
            Math.hypot(p.x - probeLastLoc.x, p.y - probeLastLoc.y, p.z - probeLastLoc.z) / dt
          );
        }
      }
      probeLastLoc = p;
      probeLastT = now;
      let velMag = -1;
      let velStr = '?';
      if (probeMov && probeVelOff >= 0) {
        try {
          const vx = probeMov.add(probeVelOff).readDouble();
          const vy = probeMov.add(probeVelOff + 8).readDouble();
          const vz = probeMov.add(probeVelOff + 16).readDouble();
          velMag = Math.round(Math.hypot(vx, vy, vz));
          velStr = Math.round(vx) + ',' + Math.round(vy) + ',' + Math.round(vz);
        } catch (eV) {}
      }
      // INITANIM (experimento, 1x): repetir o nascimento da instancia
      // agora que o pawn esta pronto e controlado â€” os relogios das
      // maquinas secundarias devem destravar se a hipotese estiver certa.
      if (!initAnimDone && initAnimFn) {
        initAnimDone = true;
        try {
          const abuf = Memory.alloc(192);
          for (let ia = 0; ia < 192; ia++) abuf.add(ia).writeU8(0);
          processEventFn(probeInst, initAnimFn, abuf);
          log('INITANIM chamou BlueprintInitializeAnimation');
        } catch (eIA3) {
          log('INITANIM exc ' + eIA3);
        }
      }
      // OPTDIFF (1x, parado): o OptimizeAnimator grava algum sinalizador
      // interno? Retrato das lanes, UMA chamada, diff imediato.
      if (!optDiffDone && optAnimFn && probeMutIdle && velMag >= 0 && velMag < 50) {
        optDiffDone = true;
        try {
          const pre = [];
          for (let pb = 0; pb < probeMutIdle.length; pb++) {
            pre.push(probeInst.add(probeMutOff + pb * 4).readU32());
          }
          const obuf = Memory.alloc(192);
          for (let oi = 0; oi < 192; oi++) obuf.add(oi).writeU8(0);
          processEventFn(probeInst, optAnimFn, obuf);
          let nOpt = 0;
          for (let pa = 0; pa < pre.length; pa++) {
            const cur = probeInst.add(probeMutOff + pa * 4).readU32();
            if (cur !== pre[pa]) {
              nOpt++;
              if (nOpt <= 24) {
                log('OPTDIFF lane+0x' + (pa * 4).toString(16) + ' antes=' + pre[pa] + ' depois=' + cur);
              }
            }
          }
          log('OPTDIFF totalLanes=' + nOpt + ' bufRet=' + hexBytes(obuf, 32));
        } catch (eOD) {
          log('OPTDIFF exc ' + eOD);
        }
      }
      // LINKTRY (experimento, 1x): ligar a instancia de locomocao com a
      // classe que o no referencia (Fem, em inst+0x9888). Depois
      // re-consulta: LINKPOS != NULL = a instancia nasceu.
      if (!linkDone && linkFn && linkChkFn) {
        linkDone = true;
        try {
          const locoCls2 = probeInst.add(0x9888).readPointer();
          if (locoCls2 && !locoCls2.isNull()) {
            const lbuf = Memory.alloc(32);
            for (let li = 0; li < 32; li++) lbuf.add(li).writeU8(0);
            lbuf.writePointer(locoCls2);
            processEventFn(probeInst, linkFn, lbuf);
            log('LINKTRY chamou LinkAnimClassLayers(' + objectName(locoCls2) + ')');
            const gbuf2 = Memory.alloc(32);
            for (let gj = 0; gj < 32; gj++) gbuf2.add(gj).writeU8(0);
            gbuf2.writePointer(locoCls2);
            processEventFn(probeInst, linkChkFn, gbuf2);
            const linked2 = gbuf2.add(8).readPointer();
            log('LINKPOS = ' + (linked2.isNull() ? 'NULL' : objectName(linked2) + '@' + linked2));
            if (!linked2.isNull()) probeLinkedInst = linked2;
          } else {
            log('LINKTRY classe invalida em inst+0x9888');
          }
        } catch (eLT) {
          log('LINKTRY exc ' + eLT);
        }
      }
      // PAWNID (1x, so leitura): a porta de identidade â€” o boneco se
      // considera do jogador/local? Um false aqui trancaria a logica de
      // locomocao (os Calculate* desviam em guardas de validade).
      if (!pawnIdDone) {
        pawnIdDone = true;
        try {
          const idNames = ['IsPlayerControlled', 'IsLocallyControlled', 'GetController'];
          for (let idn = 0; idn < idNames.length; idn++) {
            try {
              const idFn = findUFnWide(survPawnObj, idNames[idn]);
              if (!idFn) { log('PAWNID ' + idNames[idn] + ' fn nao achou'); continue; }
              const ib = Memory.alloc(32);
              for (let ii2 = 0; ii2 < 32; ii2++) ib.add(ii2).writeU8(0);
              processEventFn(survPawnObj, idFn, ib);
              let extra = '';
              if (idNames[idn] === 'GetController') {
                try {
                  const c0 = ib.readPointer();
                  const c8 = ib.add(8).readPointer();
                  const pick = c0 && !c0.isNull() && looksLikeUObject(c0) ? c0 : c8;
                  if (pick && !pick.isNull()) {
                    let pcn = '?';
                    try { pcn = objectName(pick.add(0x10).readPointer()); } catch (eP9) {}
                    extra = ' ctrl=' + objectName(pick) + '@' + pick + ' cls=' + pcn;
                  } else {
                    extra = ' ctrl=NULL';
                  }
                } catch (eC8) { extra = ' ctrl=?'; }
              }
              log('PAWNID ' + idNames[idn] + ' byte0=' + ib.readU8() + extra + ' buf=' + hexBytes(ib, 16));
            } catch (eID) {
              log('PAWNID ' + idNames[idn] + ' exc ' + eID);
            }
          }
          for (let co = 0x280; co <= 0x2e0; co += 8) {
            try {
              const cp = survPawnObj.add(co).readPointer();
              if (cp && !cp.isNull() && looksLikeUObject(cp)) {
                const cnm = objectName(cp);
                if (/Controller/i.test(cnm)) {
                  log('PAWNID Controller@0x' + co.toString(16) + ' = ' + cnm + '@' + cp);
                }
              }
            } catch (eC9) {}
          }
        } catch (eID2) {
          log('PAWNID exc ' + eID2);
        }
      }
      // LOADTRY (1x): acha os FNames do asset de locomocao Fem na pool,
      // monta o FSoftObjectPath (32B) e arma o carregamento sincrono no
      // Tick (game thread) via pendingLoadTry. So prova o carregador.
      if (!loadTryDone) {
        loadTryDone = true;
        try {
          log('LOADTRY4 flag=' + main.base.add(0x7ccd46c).readU8());
          loadTryQueue = [];
          const li = findFNameIndices([
            '/Game/SurvAnimator/New_Character/SurviveLocomotion_Fem',
            'SurviveLocomotion_Fem',
            '/Game/SurvAnimator/Anims/Surv_Loco_F',
            'Surv_Loco_F',
            '/Game/SurvAnimator/TrailerAnims/Surv_Trailer_Walk',
            'Surv_Trailer_Walk',
          ]);
          const pkgIdx = li['/Game/SurvAnimator/New_Character/SurviveLocomotion_Fem'];
          const assetIdx = li['SurviveLocomotion_Fem'];
          log('LOADTRY4 fnames pkg=' + pkgIdx + ' asset=' + assetIdx +
            ' locoPkg=' + li['/Game/SurvAnimator/Anims/Surv_Loco_F'] +
            ' trailerPkg=' + li['/Game/SurvAnimator/TrailerAnims/Surv_Trailer_Walk']);
          const mkBuf = function (pIdx, aIdx) {
            const bb = Memory.alloc(32);
            for (let lx = 0; lx < 32; lx++) bb.add(lx).writeU8(0);
            bb.writeU32(pIdx >>> 0);
            bb.add(8).writeU32(aIdx >>> 0);
            return bb;
          };
          if (pkgIdx >= 0 && assetIdx >= 0) {
            loadTryQueue.push({ tag: 'fem', buf: mkBuf(pkgIdx, assetIdx), expect: null });
          } else {
            log('LOADTRY4 FName fem ausente');
          }
          // Cobaias de CARGA: assets validos que nao deveriam estar em
          // memoria (locomocao antiga / cinematica de trailer). Se algum
          // voltar nao-nulo, a funcao CARREGA â€” nao so procura.
          if (li['/Game/SurvAnimator/Anims/Surv_Loco_F'] >= 0 && li['Surv_Loco_F'] >= 0) {
            loadTryQueue.push({ tag: 'loco', buf: mkBuf(li['/Game/SurvAnimator/Anims/Surv_Loco_F'], li['Surv_Loco_F']), expect: null });
          } else {
            log('LOADTRY4 FName loco ausente');
          }
          if (li['/Game/SurvAnimator/TrailerAnims/Surv_Trailer_Walk'] >= 0 && li['Surv_Trailer_Walk'] >= 0) {
            loadTryQueue.push({ tag: 'trailer', buf: mkBuf(li['/Game/SurvAnimator/TrailerAnims/Surv_Trailer_Walk'], li['Surv_Trailer_Walk']), expect: null });
          } else {
            log('LOADTRY4 FName trailer ausente');
          }
          // Controles positivos: caminhos derivados de objetos vivos.
          // (a) a classe da propria instancia (pacote = Outer da classe);
          // (b) a classe Fem referenciada em inst+0x9888, pelo caminho
          // derivado dela mesma â€” separa "funcao nao acha nada" de
          // "pacote Fem nao carregado" e revela o caminho real dele.
          try {
            const clsP = probeInst.add(0x10).readPointer();
            const clsPkg = clsP.add(0x20).readPointer();
            const clsName = objectName(clsP);
            const clsPkgName = clsPkg && !clsPkg.isNull() ? objectName(clsPkg) : 'NULL';
            log('LOADTRY4 ctrlCls nome=' + clsName + ' pkg=' + clsPkgName + ' cls=' + clsP);
            const ci = findFNameIndices([clsPkgName, clsName]);
            if (ci[clsPkgName] >= 0 && ci[clsName] >= 0) {
              const b2 = Memory.alloc(32);
              for (let lb2 = 0; lb2 < 32; lb2++) b2.add(lb2).writeU8(0);
              b2.writeU32(ci[clsPkgName] >>> 0);
              b2.add(8).writeU32(ci[clsName] >>> 0);
              loadTryQueue.push({ tag: 'ctrl-cls', buf: b2, expect: clsP });
            } else {
              log('LOADTRY4 ctrl-cls fname ausente');
            }
          } catch (eCT) {
            log('LOADTRY4 ctrl-cls exc ' + eCT);
          }
          try {
            const femCls = probeInst.add(0x9888).readPointer();
            if (femCls && !femCls.isNull() && looksLikeUObject(femCls)) {
              const femClsName = objectName(femCls);
              const femPkg = femCls.add(0x20).readPointer();
              const femPkgName = femPkg && !femPkg.isNull() ? objectName(femPkg) : 'NULL';
              log('LOADTRY4 femCls nome=' + femClsName + ' pkg=' + femPkgName + ' cls=' + femCls);
              const fi = findFNameIndices([femPkgName, femClsName]);
              if (fi[femPkgName] >= 0 && fi[femClsName] >= 0) {
                const b3 = Memory.alloc(32);
                for (let lb3 = 0; lb3 < 32; lb3++) b3.add(lb3).writeU8(0);
                b3.writeU32(fi[femPkgName] >>> 0);
                b3.add(8).writeU32(fi[femClsName] >>> 0);
                loadTryQueue.push({ tag: 'fem-cls', buf: b3, expect: femCls });
              } else {
                log('LOADTRY4 fem-cls fname ausente');
              }
            } else {
              log('LOADTRY4 femCls@0x9888 invalido');
            }
          } catch (eCF) {
            log('LOADTRY4 fem-cls exc ' + eCF);
          }
          if (loadTryQueue.length) {
            pendingLoadTry = true;
            log('LOADTRY4 armado n=' + loadTryQueue.length + ' (Tick executa)');
          }
        } catch (eLD) {
          log('LOADTRY4 exc ' + eLD);
        }
      }
      // PLAYTRY setup (1x): caminho do Surv_Jog_F + slot DefaultSlot;
      // o Tick carrega o asset e resolve as funcoes de montage.
      if (!playTryDone) {
        playTryDone = true;
        try {
          // Candidatos a slot: FNames varridos da instancia (os nos Slot
          // guardam o nome) + padroes UE. DefaultSlot ja testado (montage
          // tocou e nada mexeu) â€” fica fora da rotacao.
          const slotNames = [];
          const seenSlot = {};
          try {
            for (let so = 0x300; so < 0x16000; so += 4) {
              try {
                const sIdx = probeInst.add(so).readU32();
                if (!sIdx || sIdx > 6000000) continue;
                const sName = readFNameEntry(sIdx);
                if (!sName) continue;
                if (/slot/i.test(sName) ||
                    /^(UpperBody|LowerBody|FullBody|Upper_Body|Lower_Body|Full_Body)$/i.test(sName)) {
                  if (!seenSlot[sName] && sName !== 'DefaultSlot') {
                    seenSlot[sName] = 1;
                    slotNames.push(sName);
                  }
                }
              } catch (eS2) {}
            }
          } catch (eSV) {}
          const fallbacks = ['UpperBody', 'FullBody', 'LowerBody'];
          for (let fb = 0; fb < fallbacks.length; fb++) {
            if (!seenSlot[fallbacks[fb]]) { seenSlot[fallbacks[fb]] = 1; slotNames.push(fallbacks[fb]); }
          }
          const pi = findFNameIndices([
            '/Game/SurvAnimator/New_Character/Unarmed/Jogs/Surv_Jog_F',
            'Surv_Jog_F',
            'DefaultSlot',
          ].concat(slotNames));
          playSlotIdx = pi['DefaultSlot'];
          playSlotList = [];
          for (let sn = 0; sn < slotNames.length; sn++) {
            if (pi[slotNames[sn]] >= 0) playSlotList.push({ nome: slotNames[sn], idx: pi[slotNames[sn]] });
          }
          playSlotPos = 0;
          const pIdx = pi['/Game/SurvAnimator/New_Character/Unarmed/Jogs/Surv_Jog_F'];
          const aIdx = pi['Surv_Jog_F'];
          log('PLAYTRY fnames pkg=' + pIdx + ' asset=' + aIdx + ' slot=' + playSlotIdx +
            ' rotacao=' + playSlotList.map(function (s) { return s.nome; }).join(','));
          if (pIdx >= 0 && aIdx >= 0 && playSlotList.length) {
            playPathBuf = Memory.alloc(32);
            for (let pb = 0; pb < 32; pb++) playPathBuf.add(pb).writeU8(0);
            playPathBuf.writeU32(pIdx >>> 0);
            playPathBuf.add(8).writeU32(aIdx >>> 0);
            pendingPlaySetup = true;
            log('PLAYTRY armado (Tick executa setup)');
          } else {
            log('PLAYTRY FName/slot ausente â€” nao testa');
          }
        } catch (ePT) {
          log('PLAYTRY exc ' + ePT);
        }
      }
      // LINK2 (1x): arma o teste do grafo (Tick executa). Paliativo
      // desligado neste run â€” se mexer, e o grafo puro.
      if (!link2Done) {
        link2Done = true;
        pendingLink2 = true;
        log('LINK2 armado (Tick executa)');
      }
      // REBIRTH (1x): arma o renascimento da instancia (Tick executa).
      if (!rebirthDone) {
        rebirthDone = true;
        pendingRebirth = true;
        log('REBIRTH armado (Tick executa)');
      }
      // NODESCAN (1x, pos-renascimento): a camada de locomocao existe
      // escondida em algum campo da instancia nova?
      if (!nodeScanDone && rebirthApplied) {
        nodeScanDone = true;
        execNodeScan();
      }
      // SUBPROBE setup (1x, pos-renascimento): captura as possiveis
      // sub-instancias (offsets da varredura) e interroga dono/funcoes.
      if (!subProbeSetupDone && rebirthApplied) {
        subProbeSetupDone = true;
        try {
          const offs = [[0x9788, 'masc'], [0x9840, 'fem']];
          for (let oi = 0; oi < offs.length; oi++) {
            const o = probeInst.add(offs[oi][0]).readPointer();
            if (!o || o.isNull() || !looksLikeUObject(o)) {
              log('SUBPROBE ' + offs[oi][1] + ' invalido em 0x' + offs[oi][0].toString(16));
              continue;
            }
            let outerNm = '?';
            try { outerNm = objectName(o.add(0x20).readPointer()); } catch (eO) {}
            log('SUBPROBE ' + offs[oi][1] + ' obj=' + o + ' nome=' + objectName(o) + ' outer=' + outerNm);
            let gs = null;
            try { gs = findUFnWide(o, 'getSpeed'); } catch (eG) {}
            let dono = 'semfn';
            try {
              const tpo = findUFnWide(o, 'TryGetPawnOwner');
              if (tpo) {
                const tb = Memory.alloc(16);
                for (let ti = 0; ti < 16; ti++) tb.add(ti).writeU8(0);
                processEventFn(o, tpo, tb);
                const dp = tb.readPointer();
                dono = dp && !dp.isNull() ? objectName(dp) : 'NULL';
              }
            } catch (eD) { dono = 'exc'; }
            log('SUBPROBE ' + offs[oi][1] + ' getSpeedFn=' + (gs ? 'ok' : 'NULL') + ' dono=' + dono);
            if (offs[oi][1] === 'fem') { subFem = o; subFemGsFn = gs; }
            else { subMasc = o; subMascGsFn = gs; }
          }
        } catch (eSP) {
          log('SUBPROBE setup exc ' + eSP);
        }
      }
      // PLAYTRY controle por movimento: andar toca o ciclo no slot
      // atual; a cada 8s de movimento troca para o proximo slot da
      // rotacao (o usuario anda sem parar e avisa quando mexer).
      if (playControlEnabled && playSeq && playFn && velMag >= 0 && playSlotPos < playSlotList.length) {
        if (!playTryPlaying && velMag > 60) {
          playRateNow = Math.max(0.6, Math.min(1.6, velMag / 280));
          playSlotMoveTime = 0;
          playCheckAt = probeTickN + 2;
          pendingPlayCmd = 'play';
        } else if (playTryPlaying && velMag < 25) {
          pendingPlayCmd = 'stop';
        } else if (playTryPlaying && velMag > 60) {
          playSlotMoveTime += 0.5;
          if (playCheckAt > 0 && probeTickN >= playCheckAt) {
            playCheckAt = -1;
            pendingPlayCmd = 'check';
          } else if (playSlotMoveTime >= 8) {
            pendingPlayCmd = 'stop';
            playSlotPos++;
            playSlotMoveTime = 0;
            if (playSlotPos >= playSlotList.length) {
              log('PLAYTRY slots esgotados sem mexer');
            }
          }
        }
      }
      let gsStr = '-';
      if (probeGsFn) {
        try {
          const gbuf = Memory.alloc(32);
          for (let i = 0; i < 32; i++) gbuf.add(i).writeU8(0);
          processEventFn(probeInst, probeGsFn, gbuf);
          // ReturnValue e DoubleProperty (off=0, elem=8) â€” ler double, nao float
          gsStr = gbuf.readDouble().toFixed(2);
        } catch (eGs) {
          gsStr = 'exc';
        }
      }
      if (speed > 15 || velMag > 15 || probeTickN % 16 === 0) {
        probeLines++;
        log(
          'ANIMPROBE n=' + probeTickN + ' pawnSpeed=' + speed + ' velMag=' + velMag + ' vel=' + velStr +
          ' getSpeed=' + gsStr
        );
        // SUBPROBE: as sub-instancias de locomocao enxergam o movimento?
        if (subFem && subFemGsFn) {
          try {
            const sb = Memory.alloc(32);
            for (let si = 0; si < 32; si++) sb.add(si).writeU8(0);
            processEventFn(subFem, subFemGsFn, sb);
            log('SUBPROBE fem getSpeed=' + sb.readDouble().toFixed(2) + ' velMag=' + velMag);
          } catch (eSB) {}
        }
        if (subMasc && subMascGsFn) {
          try {
            const sb2 = Memory.alloc(32);
            for (let si2 = 0; si2 < 32; si2++) sb2.add(si2).writeU8(0);
            processEventFn(subMasc, subMascGsFn, sb2);
            log('SUBPROBE masc getSpeed=' + sb2.readDouble().toFixed(2) + ' velMag=' + velMag);
          } catch (eSB2) {}
        }
        // X20b: pesos dos estados (mi 0..3 x si 0..15); ativo tem peso ~1
        if (probeWeightFn) {
          let wline = '';
          let wdead = false;
          for (let mi = 0; mi < 4 && !wdead; mi++) {
            for (let si = 0; si < 16; si++) {
              try {
                const wbuf = Memory.alloc(16);
                for (let i = 0; i < 16; i++) wbuf.add(i).writeU8(0);
                wbuf.writeS32(mi);
                wbuf.add(4).writeS32(si);
                processEventFn(probeInst, probeWeightFn, wbuf);
                const w = wbuf.add(8).readFloat();
                if (w > 0.01) wline += ' mi' + mi + 'si' + si + '=' + w.toFixed(2);
              } catch (eW) {
                log('ANIMW exc (desligando) ' + eW);
                probeWeightFn = null;
                wdead = true;
                break;
              }
            }
          }
          if (wline) log('ANIMW velMag=' + velMag + wline);
        }
        // X21: estado atual de cada maquina (leitura direta de memoria)
        for (let mj = 0; mj < probeMachines.length; mj++) {
          try {
            const m = probeMachines[mj];
            const curI = probeInst.add(m.off + 0x24).readS32();
            const el = probeInst.add(m.off + 0x28).readFloat();
            log(
              'ANIMSM velMag=' + velMag + ' off=0x' + m.off.toString(16) +
              ' estado=' + (m.names[curI] || ('#' + curI)) + ' t=' + el.toFixed(1)
            );
          } catch (eM2) {}
        }
        // X26: peso da maquina no grafo por indice nativo (mi)
        if (probeMachWF && probeElapsedF) {
          try {
            let mw = '';
            for (let mi2 = 0; mi2 < 12; mi2++) {
              const wb = Memory.alloc(8);
              for (let i2 = 0; i2 < 8; i2++) wb.add(i2).writeU8(0);
              wb.writeS32(mi2);
              processEventFn(probeInst, probeMachWF, wb);
              const wv = wb.add(4).readFloat();
              if (wv > 0.01) {
                const eb = Memory.alloc(8);
                for (let i3 = 0; i3 < 8; i3++) eb.add(i3).writeU8(0);
                eb.writeS32(mi2);
                processEventFn(probeInst, probeElapsedF, eb);
                mw += ' mi' + mi2 + ':w=' + wv.toFixed(2) + ',t=' + eb.add(4).readFloat().toFixed(1);
              }
            }
            log('ANIMMW velMag=' + velMag + (mw || ' TODAS ZERO'));
          } catch (eMW) {
            log('ANIMMW exc ' + eMW);
            probeMachWF = null;
          }
        }
        // X23: arma o rastreador ao andar; despeja ao fim da janela
        if (!traceDone && velMag > 50 && !traceOn) {
          traceOn = true;
          traceSet = {};
          traceSetPawn = {};
          traceSetPost = {};
          traceUntil = now + 3000;
          log('ANIMTRACE armado (3s andando)');
        }
        if (traceOn && now > traceUntil) {
          traceOn = false;
          traceDone = true;
          try {
            const names = Object.keys(traceSet || {});
            names.sort();
            log('ANIMTRACE total fns distintas=' + names.length);
            for (let ni = 0; ni < names.length; ni++) {
              log('ANIMTRACE fn=' + names[ni] + ' x' + traceSet[names[ni]]);
            }
            const namesP = Object.keys(traceSetPawn || {});
            namesP.sort();
            log('ANIMTRACE PAWN total fns distintas=' + namesP.length);
            for (let nj = 0; nj < namesP.length; nj++) {
              log('ANIMTRACE PAWN fn=' + namesP[nj] + ' x' + traceSetPawn[namesP[nj]]);
            }
            const namesPP = Object.keys(traceSetPost || {});
            namesPP.sort();
            log('ANIMTRACE POST total fns distintas=' + namesPP.length);
            for (let nk = 0; nk < namesPP.length; nk++) {
              log('ANIMTRACE POST fn=' + namesPP[nk] + ' x' + traceSetPost[namesPP[nk]]);
            }
          } catch (eTr2) {
            log('ANIMTRACE exc ' + eTr2);
          }
        }
        // A2: despejo do trace inicial
        if (trace0On && now > trace0Until) {
          trace0On = false;
          trace0Done = true;
          try {
            const names0 = Object.keys(traceSet0 || {});
            names0.sort();
            log('ANIMTRACE0 total fns distintas=' + names0.length);
            for (let n0 = 0; n0 < names0.length; n0++) {
              log('ANIMTRACE0 fn=' + names0[n0] + ' x' + traceSet0[names0[n0]]);
            }
          } catch (eT0) {
            log('ANIMTRACE0 exc ' + eT0);
          }
        }
        // C/trace2: apos o InitLocalPlayer, o jogo chama Calculate* sozinho?
        if (!trace2Done && !trace2On && initLocalRecheckDone && velMag > 50) {
          trace2On = true;
          traceSet = {};
          trace2Until = now + 3000;
          log('ANIMTRACE2 armado (3s andando)');
        }
        if (trace2On && now > trace2Until) {
          trace2On = false;
          trace2Done = true;
          try {
            const names2 = Object.keys(traceSet || {});
            names2.sort();
            log('ANIMTRACE2 total fns distintas=' + names2.length);
            for (let n2 = 0; n2 < names2.length; n2++) {
              log('ANIMTRACE2 fn=' + names2[n2] + ' x' + traceSet[names2[n2]]);
            }
          } catch (eT22) {
            log('ANIMTRACE2 exc ' + eT22);
          }
        }
        // NODEWATCH (so leitura): os nos do grafo mudam andando? Dois
        // retratos â€” o 2o, ~10s depois, mostra tempos/pesos avancando.
        if (probeNodes && !probeNodeDone1 && velMag > 100) {
          probeNodeDone1 = true;
          probeNodeTick1 = probeTickN;
          dumpNodeDiff('NODEW1');
        }
        if (probeNodes && probeNodeDone1 && !probeNodeDone2 && velMag > 100 && probeTickN > probeNodeTick1 + 20) {
          probeNodeDone2 = true;
          dumpNodeDiff('NODEW2');
        }
        // NODEPTR (1x, andando): resolver os ponteiros da regiao da
        // maquina principal â€” o no de locomocao guarda a referencia do
        // seu asset (BlendSpace/sequencia); os campos de eixo moram ao
        // lado dessa referencia na mesma estrutura.
        if (!nodePtrDone && velMag > 100) {
          nodePtrDone = true;
          try {
            let nPtr = 0;
            for (let po = 0x9800; po < 0xa200 && nPtr < 160; po += 8) {
              let pv = null;
              try { pv = probeInst.add(po).readPointer(); } catch (eP) { continue; }
              if (!pv || pv.isNull() || !looksLikeUObject(pv)) continue;
              let onm = '?', ocn = '?';
              try { onm = objectName(pv); } catch (eP2) {}
              try { ocn = objectName(pv.add(0x10).readPointer()); } catch (eP3) {}
              if (!onm || onm === 'None') continue;
              nPtr++;
              const hot = /Blend|Anim|Sequence|Locom|Run|Jog|Walk|State|Graph|Pose/i.test(onm + ' ' + ocn) ? ' *' : '';
              log('NODEPTR +0x' + po.toString(16) + ' -> ' + onm + ' cls=' + ocn + hot);
            }
            log('NODEPTR total=' + nPtr);
          } catch (eNP) {
            log('NODEPTR exc ' + eNP);
          }
        }
        // X22b/c: diff do bloco mutavel andando + cabecalho da maquina main
        if (!probeMutDone && probeMutIdle && velMag > 100) {
          probeMutDone = true;
          try {
            let nchg = 0;
            for (let bi = 0; bi < probeMutIdle.length && nchg < 28; bi++) {
              const now32 = probeInst.add(probeMutOff + bi * 4).readU32();
              if (now32 !== probeMutIdle[bi]) {
                nchg++;
                let dblStr = '';
                if (bi % 2 === 0) {
                  try {
                    dblStr = ' walkDbl=' + probeInst.add(probeMutOff + bi * 4).readDouble().toFixed(3);
                  } catch (eD) {}
                }
                log(
                  'ANIMMUT lane+0x' + (bi * 4).toString(16) +
                  ' idleU32=' + probeMutIdle[bi] + ' walkU32=' + now32 + dblStr
                );
              }
            }
            log('ANIMMUT lanesAlteradas=' + nchg);
            for (let mj2 = 0; mj2 < probeMachines.length; mj2++) {
              const mm = probeMachines[mj2];
              if (mm.names.length > 3) {
                log(
                  'ANIMSMHDR velMag=' + velMag + ' off=0x' + mm.off.toString(16) +
                  ' hdr=' + hexBytes(probeInst.add(mm.off), 96)
                );
              }
            }
          } catch (eMu2) {
            log('ANIMMUT tick exc ' + eMu2);
          }
        }
        // X19: avaliar as condicoes de transicao neste mesmo instante
        for (let tj = 0; tj < probeTrans.length; tj++) {
          try {
            const tbuf = Memory.alloc(32);
            for (let i = 0; i < 32; i++) tbuf.add(i).writeU8(0);
            processEventFn(probeInst, probeTrans[tj].fn, tbuf);
            log(
              'ANIMTRANS velMag=' + velMag + ' ' + probeTrans[tj].name +
              ' ret=' + tbuf.readU8() + ' buf=' + hexBytes(tbuf, 32)
            );
          } catch (eT) {
            log('ANIMTRANS exc ' + probeTrans[tj].name + ' ' + eT);
          }
        }
      }
      // B v2 (experimento): cadeia Calculate* auto-temporizada â€” so chama
      // enquanto velMag>50, arma depois do trace2. Sucesso: pernas mexem.
      if (!calcDone && trace2Done && calcFns.length > 0 && !calcOn) {
        calcOn = true;
        calcUntil = now + 480000;
        calcRounds = 0;
        // A: buffers PERSISTENTES por funcao â€” o VelocityBlend e in/out
        // (entra o anterior, sai o novo). Antes, buffer zerado descartado
        // a cada chamada fazia o blend nunca sair do zero.
        calcBufs = [];
        for (let cb = 0; cb < calcFns.length; cb++) {
          const nb = Memory.alloc(256);
          for (let i6 = 0; i6 < 256; i6++) nb.add(i6).writeU8(0);
          calcBufs.push(nb);
        }
        log('CALC auto armado â€” anda quando quiser');
      }
      if (calcOn && !calcDone) {
        // VBPROBE (sondagem 1x): o corpo do CalculateVelocityBlend executa
        // ou desvia num portao inicial? Escrevo uma assinatura no buffer
        // (0.11/0.22/0.33/0.44), chamo 1x andando e leio de volta.
        if (!vbProbeDone && velMag > 100) {
          vbProbeDone = true;
          for (let vp = 0; vp < calcFns.length; vp++) {
            if (calcFns[vp].name === 'CalculateVelocityBlend' && calcBufs[vp]) {
              try {
                calcBufs[vp].writeFloat(0.11);
                calcBufs[vp].add(4).writeFloat(0.22);
                calcBufs[vp].add(8).writeFloat(0.33);
                calcBufs[vp].add(12).writeFloat(0.44);
                processEventFn(probeInst, calcFns[vp].fn, calcBufs[vp]);
                log(
                  'VBPROBE depois=' +
                  calcBufs[vp].readFloat().toFixed(3) + ',' +
                  calcBufs[vp].add(4).readFloat().toFixed(3) + ',' +
                  calcBufs[vp].add(8).readFloat().toFixed(3) + ',' +
                  calcBufs[vp].add(12).readFloat().toFixed(3) +
                  ' velMag=' + velMag
                );
              } catch (eVP) {
                log('VBPROBE exc ' + eVP);
              }
            }
          }
        }
        if (now > calcUntil || calcRounds >= 240) {
          calcOn = false;
          calcDone = true;
          log('CALC fim rodadas=' + calcRounds);
        } else if (velMag > 50) {
          calcRounds++;
          let okC = 0;
          for (let cj = 0; cj < calcFns.length; cj++) {
            try {
              let cbuf = calcBufs[cj];
              if (!cbuf) {
                cbuf = Memory.alloc(256);
                for (let i4 = 0; i4 < 256; i4++) cbuf.add(i4).writeU8(0);
                calcBufs[cj] = cbuf;
              }
              processEventFn(probeInst, calcFns[cj].fn, cbuf);
              okC++;
            } catch (eC2) {
              log('CALC exc ' + calcFns[cj].name + ' ' + eC2);
            }
          }
          // A2: UMA rodada sob o rastreador sincronizado (1x) â€” as nossas
          // 5 chamadas aparecem como controle; qualquer OUTRA funcao na
          // lista foi disparada por dentro da cadeia.
          if (!traceCalcDone && velMag > 100) {
            traceCalcDone = true;
            try {
              traceCalcSet = {};
              traceCalcOn = true;
              for (let ct = 0; ct < calcFns.length; ct++) {
                try {
                  processEventFn(probeInst, calcFns[ct].fn, calcBufs[ct]);
                } catch (eCT) {}
              }
              traceCalcOn = false;
              const cn = Object.keys(traceCalcSet || {});
              cn.sort();
              log('ANIMTRACECALC total fns distintas=' + cn.length);
              for (let ci2 = 0; ci2 < cn.length; ci2++) {
                log('ANIMTRACECALC fn=' + cn[ci2] + ' x' + traceCalcSet[cn[ci2]]);
              }
            } catch (eTC) {
              traceCalcOn = false;
              log('ANIMTRACECALC exc ' + eTC);
            }
          }
          if (calcRounds % 20 === 0) {
            // A: o blend persistiu? Andando pra frente, um dos 4 valores
            // (F/B/L/R, ordem incerta) deve subir de 0 para perto de 1.
            let vbStr = '';
            for (let cv = 0; cv < calcFns.length; cv++) {
              if (calcFns[cv].name === 'CalculateVelocityBlend' && calcBufs[cv]) {
                try {
                  vbStr =
                    ' VB[0]=' + calcBufs[cv].readFloat().toFixed(2) +
                    ' [1]=' + calcBufs[cv].add(4).readFloat().toFixed(2) +
                    ' [2]=' + calcBufs[cv].add(8).readFloat().toFixed(2) +
                    ' [3]=' + calcBufs[cv].add(12).readFloat().toFixed(2);
                } catch (eVB) {}
              }
            }
            log('CALC rodada=' + calcRounds + ' ok=' + okC + '/' + calcFns.length + ' velMag=' + velMag + vbStr);
          }
          // A: baseline detalhado â€” QUAIS lanes a cadeia altera e com que
          // valores (procurar ~334). So leitura, 1x andando.
          if (!calcMutLogged && probeMutIdle && velMag > 100) {
            calcMutLogged = true;
            dumpMutDiffDet('CALCMUT');
          }
          // C (variavel unica nova): inits nunca chamados, 1x andando e
          // DEPOIS do baseline, pra atribuicao ficar limpa.
          if (calcMutLogged && !init2Done && velMag > 50) {
            init2Done = true;
            init2AtRound = calcRounds;
            if (init2Fns.length === 0) log('INIT2 sem fns resolvidas');
            for (let ij = 0; ij < init2Fns.length; ij++) {
              try {
                const ibuf = Memory.alloc(192);
                for (let i5 = 0; i5 < 192; i5++) ibuf.add(i5).writeU8(0);
                processEventFn(probeInst, init2Fns[ij].fn, ibuf);
                log('INIT2 chamou ' + init2Fns[ij].name);
              } catch (eI3) {
                log('INIT2 exc ' + init2Fns[ij].name + ' ' + eI3);
              }
            }
          }
          // A2: diff pos-C, depois de +4 rodadas da cadeia (mede C+CALC)
          if (init2Done && !calcMut2Logged && calcRounds >= init2AtRound + 4 && velMag > 100) {
            calcMut2Logged = true;
            dumpMutDiffDet('CALCMUT2');
          }
        }
      }
    } catch (e) {
      log('ANIMPROBE tick exc ' + e);
      probeDone = true;
    }
  }
  // --- X25: FullyLoad() experiment (user-suggested init chain) ---
  // Pawn BP fn with no parms; the real login flow's load-complete step we
  // skipped. Runs once, after SLOTVIS, so body/collision stay as fallback.
  var fullyLoadDone = false, fullyLoadAt = 0, fullyLoadRecheckDone = false;
  var initLocalDone = false, initLocalAt = 0, initLocalRecheckDone = false;
  function applyFullyLoad() {
    if (fullyLoadDone) return;
    fullyLoadDone = true;
    fullyLoadAt = Date.now();
    try {
      log('FULLYLOAD start');
      diagSlots('PREFULL');
      var ok = peBoolSafe(survPawnObj, 'FullyLoad', 1);
      log('FULLYLOAD peBoolSafe(FullyLoad,1)=' + ok);
    } catch (e) {
      log('FULLYLOAD exc ' + e);
    }
  }
  // --- X26: InitLocalPlayer() experiment (option C) ---
  // Other pawn init fn (no parms). Runs after FullyLoad recheck; trace2 then
  // checks whether the game starts calling the Calculate chain by itself.
  function applyInitLocal() {
    if (initLocalDone) return;
    initLocalDone = true;
    initLocalAt = Date.now();
    try {
      var okI = peBoolSafe(survPawnObj, 'InitLocalPlayer', 1);
      log('INITLOCAL peBoolSafe(InitLocalPlayer,1)=' + okI);
    } catch (e) {
      log('INITLOCAL exc ' + e);
    }
  }
  function diagPawnApi() {
    if (!survPawnObj) {
      log('PAWNAPI sem pawn');
      return;
    }
    let pawnCls = null;
    try {
      pawnCls = survPawnObj.add(0x10).readPointer();
    } catch (e) {}
    if (!pawnCls || pawnCls.isNull()) {
      log('PAWNAPI sem classe');
      return;
    }
    log('PAWNAPI pawnClass=' + objectName(pawnCls));
    enumAnimFns(
      pawnCls,
      'PAWNAPI',
      /VisToggle|Shadow|Collision|LoadMesh|SaveMesh|SkelMesh|FullyLoad|InitLocal|Equip|GPS/i,
      30
    );
  }
  function diagDiffSnap(kind) {
    diffSnapCount++;
    log('DIFF inicio ' + kind + ' (#' + diffSnapCount + ')');
    try {
      diagSlots(kind);
    } catch (eS) {}
    try {
      const comp = findAtpcCameraComp();
      if (comp && processEventFn) {
        callTagGetter(comp, 'GetCurrentCameraModeTag');
        callCamLoc(comp, kind);
        callMeshLoc(kind);
      }
    } catch (eG) {}
    try {
      if (survPawnObj)
        dumpPropsFor(
          survPawnObj,
          'PAWN-' + kind,
          /Mesh|Camera|FirstPerson|FP|View|Visib|Hidden|OwnerNoSee/i
        );
    } catch (eP) {}
    try {
      const comps = findMeshComps();
      log('DIFF ' + kind + ' meshComps=' + comps.length);
      for (let i = 0; i < comps.length; i++) {
        dumpPropsFor(
          comps[i],
          'MESH-' + kind,
          /SkeletalMesh|OwnerNoSee|OnlyOwnerSee|Visib|Hidden|CastShadow|FirstPerson|FP/i
        );
      }
    } catch (eM) {}
    log('DIFF fim ' + kind);
  }
  // Spawn XY costuma estar certo; o pawn CAI sob o chao porque Landscape/WP
  // ainda nao tem colisao. Nao dependemos de tp_safe: soft-lift Z pos-stream.
  // -75400 = pivot spawner (enterrado). -75075 ainda pode ficar sob mesh.
  // Z dinamico: NAO usar CITY_GROUND_Z como destino final.
  // Drop from sky no XY â†’ gravidade/colisao â†’ Z estavel = chao.
  const CITY_GROUND_Z = -72000; // so fallback legado / hint
  // Chao tipico ~-69700; DROP perto (~800â€“1200uu acima), nao do ceu -64000
  const DROP_START_Z = -68500;
  const DROP_MIN_FALL = 150; // queda curta ainda conta landed
  const CITY_WALK_MIN = -75000;
  const CITY_Z_MIN = -76000; // abaixo = void
  const CITY_Z_MAX = -62000; // acima = ainda no ceu do drop
  // Patio so se XY estiver fora da cidade / void profundo
  const CITY_SAFE_XY = [186175, -208257];
  // PlayerStart / BP_PlayerSpawn vistos no PE (coords do mapa, nao chute)
  const spawnActorsSeen = {};
  // Ancoras do mapa jogavel (ZombieSpawner etc) â€” PlayerStart default cai no void
  const mapAnchorActors = {};
  let pendingDumpLoc = false;
  let lastPawnLocLog = 0;
  // GROUND: drop-settle dinamico
  let groundZSamples = [];
  let groundOkSince = 0;
  let groundBlindSince = 0; // R1: desde quando o GROUND esta sem loc valido
  let groundBlindRedrops = 0; // R1: re-DROPs por cegueira (max 2)
  let lastSoftLiftAt = 0;
  let dropState = 0; // 0=need drop, 1=waiting settle, 2=landed
  let dropFromZ = 0;
  let dropAt = 0;
  let dropTx = 0;
  let dropTy = 0;
  let dropSkyRetries = 0; // re-DROP "ainda no ceu" â€” max 2 senao loop infinito
  const DROP_SKY_RETRY_MAX = 2;
  let lastRescueLogAt = 0;
  const WP_SHOWN_BEFORE_HIDE = 25;
  const LANDSCAPE_BEFORE_HIDE = 2;
  // HideLoading so apos Survival+Landscape+WP â€” senao tela escura sem ESC
  // offline-spawn/postFix continuam OFF (causaram AV fatal)
  // F5 FakeLogin = AV fatal â€” nunca auto; Jump no Script basta
  const AUTO_HIDE_LOADING = true;
  const AUTO_OFFLINE_SPAWN = false;
  const AUTO_POST_SURV_FIX = false;
  const AUTO_BODY_AFTER_GROUND = true;
  // Stream: L muitas vezes trava em 3 neste mapa â€” WP alto = bypass
  const STREAM_WP_MIN = 12;
  const STREAM_LANDSCAPE_MIN = 3; // minimo real observado
  const STREAM_SETTLE_MS = 4000;
  const GROUND_LANDSCAPE_MIN = 3;
  const WP_COLLISION_BYPASS = 50; // WP>=50 substitui L>=8 (contador L stuck)
  const GROUND_STABLE_MS = 2000;
  const GROUND_Z_EPS = 150;
  const DROP_SETTLE_MS = 2800;
  const HIDE_AFTER_LANDSCAPE = 1;
  const skipFirst = neverInvoke;
  const uiOnlyRe =
    /^(ShowMouseCursor|SetShowMouseCursor|bShowMouseCursor|SetInputMode|SetInputModeUIOnly|SetInputModeGameOnly|SetInputModeGameAndUI|Focus|SetFocus|SetKeyboardFocus|SetUserFocus|RemoveFromParent|RemoveFromViewport|SetVisibility)$/i;

  const HOST_CACHE_RE =
    /StartLevel|CreateSession|RestartPlayer|RestartPlayerAtPlayerStart|ServerRestartPlayer|OpenLevel|HostGame|ServerTravel|SpawnDefaultPawn|PrepareServerList|Server_Continue|OnChangedServerSelected|BndEvt.*Server|ServerCategory|WBP_Server/i;

  // Teste hub_instance: NewCity_persistent_WP (hub_instance e sublevel aqui; gatilho -97737,-3599,-72350).
  // Suburban_new_Lighting nao contem hub_instance (loja/loot), entao foi descartado.
  // hub_instance como travel direto deixou a tela preta (sem nivel carregado). Voltando ao NewCity.
  const MAP_LISTEN =
    '/Game/A_TestMap/LandscapeParts/NewCity_WC/NewCity_persistent_WP?Listen?game=/Game/ThirdPersonBP/Blueprints/TDB_GameMode.TDB_GameMode_C';
  const fstringAssign = new NativeFunction(
    main.base.add(0x2134630),
    'pointer',
    ['pointer', 'pointer']
  );

  const found = {}; // name -> { obj, fn }
  let processEventAddr = null;
  let processEventFn = null;
  let logging = true;
  let logBudget = 600;
  let pendingInvoke = false;
  let pendingBrowser = false;
  let peHooked = false;
  let peLoggerListener = null;   // 06/11: para o HOST_LEVE soltar so este hook
  let browserMode = false; // Space opened server browser â€” keep PE cache hot
  let browserBoostUntil = 0;
  let autoPrepDone = false;

  function readFNameEntry(comparisonIndex) {
    try {
      const block = (comparisonIndex >>> 16) & 0xffff;
      const offset = comparisonIndex & 0xffff;
      const blockPtr = fnamePool.add(0x10).add(block * 8).readPointer();
      if (blockPtr.isNull()) return null;
      const entry = blockPtr.add(offset * 2);
      const header = entry.readU16();
      const isWide = (header & 1) !== 0;
      const len = header >>> 6;
      if (len <= 0 || len > 1024) return null;
      if (isWide) return entry.add(2).readUtf16String(len);
      return entry.add(2).readUtf8String(len);
    } catch (e) {
      return null;
    }
  }

  function objectName(obj) {
    try {
      if (!obj || obj.isNull()) return '?';
      const idx = obj.add(0x18).readS32();
      const n = readFNameEntry(idx >>> 0);
      return n || 'idx:' + (idx >>> 0);
    } catch (e) {
      return '?';
    }
  }

  function functionName(ufn) {
    return objectName(ufn);
  }

  function getEngine() {
    try {
      const ge = gEngineSlot.readPointer();
      return ge.isNull() ? null : ge;
    } catch (e) {
      return null;
    }
  }

  function getWorldContext(eng) {
    try {
      const listData = eng.add(0xec0).readPointer();
      const listNum = eng.add(0xec8).readS32();
      if (listNum < 1 || listData.isNull()) return null;
      const ctx = listData.readPointer();
      return ctx.isNull() ? null : ctx;
    } catch (e) {
      return null;
    }
  }

  function looksLikeUObject(p) {
    try {
      if (!p || p.isNull()) return false;
      const vt = p.readPointer();
      if (vt.compare(main.base) < 0 || vt.compare(main.base.add(main.size)) >= 0)
        return false;
      const n = objectName(p);
      return !!(n && n !== '?' && n.indexOf('idx:') !== 0 && /^[A-Za-z_]/.test(n));
    } catch (e) {
      return false;
    }
  }

  function isLikelyUClass(p) {
    try {
      if (!p || p.isNull()) return false;
      const meta = p.add(0x10).readPointer();
      const mn = objectName(meta);
      return /^(Class|BlueprintGeneratedClass)$/i.test(mn);
    } catch (e) {
      return false;
    }
  }

  function cacheSurvivalPawnClass(p, why) {
    if (!p || p.isNull() || !isLikelyUClass(p)) return;
    const n = objectName(p);
    if (!/^SurvivalPlayer(_V2|_Test)?_C$/i.test(n)) return;
    const rank = /_V2_C$/i.test(n) ? 3 : /_Test_C$/i.test(n) ? 1 : 2;
    const cur = survivalPawnClass ? objectName(survivalPawnClass) : '';
    const curRank = /_V2_C$/i.test(cur)
      ? 3
      : /_Test_C$/i.test(cur)
        ? 1
        : cur
          ? 2
          : 0;
    if (rank >= curRank) {
      survivalPawnClass = p;
      log('cache SurvivalPawnClass=' + n + ' (' + why + ')');
    }
  }

  function remember(obj, ufn, name) {
    if (!name || name === '?' || name.indexOf('idx:') === 0) return;
    if (/^SurvivalPlayer(_V2|_Test)?_C$/i.test(name)) {
      cacheSurvivalPawnClass(ufn, 'remember/' + name);
    }
    const keep =
      INTEREST.test(name) ||
      HOST_CACHE_RE.test(name) ||
      /SetSpawnRegion|JoinToServer|InitClient|BndEvt_|Fake|Login|LoadFrom|InitPlayer|PickPlayer|SurvivalPlayer/i.test(
        name
      );
    if (!keep) return;
    if (!found[name]) {
      found[name] = { obj: obj, fn: ufn };
      const psz = readParmsSize(ufn);
      log(
        'FOUND UFunction ' +
          name +
          ' on ' +
          objectName(obj) +
          ' ParmsSize=' +
          psz
      );
      if (
        HOST_CACHE_RE.test(name) &&
        /StartLevel|CreateSession|Restart|Host|Listen|Travel/i.test(name)
      ) {
        log('HOST-CANDIDATE ' + name + ' ParmsSize=' + psz);
      }
    } else {
      const on = objectName(obj);
      if (
        /GI_|GameMode|Survival|TDB_|PC_|PlayerController|WBP_Server|PlayerPlaceholder/i.test(
          on
        ) &&
        !/Viewport/i.test(on)
      )
        found[name] = { obj: obj, fn: ufn };
    }
  }

  function findGameInstance(eng) {
    // Prefer owner of a cached GI UFunction
    const kn = Object.keys(found);
    for (let i = 0; i < kn.length; i++) {
      try {
        const o = found[kn[i]].obj;
        const n = objectName(o);
        if (/GI_Survival/i.test(n)) {
          log('GameInstance from cache name=' + n);
          return o;
        }
      } catch (e) {}
    }
    const ctx = getWorldContext(eng);
    if (!ctx) return null;
    const tryOffs = [];
    for (let o = 0x20; o <= 0x220; o += 8) tryOffs.push(o);
    for (let i = 0; i < tryOffs.length; i++) {
      try {
        const p = ctx.add(tryOffs[i]).readPointer();
        if (!looksLikeUObject(p)) continue;
        const n = objectName(p);
        if (/Viewport|PlayerController|LocalPlayer|GameEngine|WorldSettings/i.test(n))
          continue;
        if (/GI_Survival|GI_.*_C$/i.test(n) || /^.*GameInstance.*_C$/i.test(n)) {
          log('GameInstance @ ctx+0x' + tryOffs[i].toString(16) + ' name=' + n);
          return p;
        }
      } catch (e) {}
    }
    return null;
  }

  function harvestFuncsFromObject(obj) {
    if (!obj || obj.isNull()) return 0;
    let added = 0;
    const before = Object.keys(found).length;
    let cls = null;
    try {
      cls = obj.add(0x10).readPointer();
    } catch (e) {
      return 0;
    }
    for (let depth = 0; depth < 14 && cls && !cls.isNull(); depth++) {
      for (let o = 0x28; o < 0x2a0; o += 8) {
        try {
          const p = cls.add(o).readPointer();
          if (p.isNull()) continue;
          if (looksLikeUObject(p)) {
            const n = objectName(p);
            if (INTEREST.test(n) || HOST_CACHE_RE.test(n)) {
              remember(obj, p, n);
            }
          }
          // Heuristic: pointer may be TMap/TArray data â€” sweep nearby UFunction*s
          for (let i = 0; i < 128; i++) {
            try {
              const q = p.add(i * 8).readPointer();
              if (!looksLikeUObject(q)) continue;
              const n = objectName(q);
              if (INTEREST.test(n) || HOST_CACHE_RE.test(n)) {
                remember(obj, q, n);
              }
            } catch (e2) {
              break;
            }
          }
        } catch (e) {}
      }
      // UStruct::SuperStruct â€” try common offsets
      let next = null;
      const supers = [0x40, 0x48, 0x30, 0x38, 0x50];
      for (let s = 0; s < supers.length; s++) {
        try {
          const cand = cls.add(supers[s]).readPointer();
          if (cand.isNull() || cand.equals(cls)) continue;
          if (!looksLikeUObject(cand)) continue;
          const cn = objectName(cand);
          if (/Class|Struct|Object|Interface|GI_|GameInstance|GameMode|Actor/i.test(cn)) {
            next = cand;
            break;
          }
        } catch (e) {}
      }
      cls = next;
    }
    added = Object.keys(found).length - before;
    if (added > 0) log('harvest +' + added + ' UFunctions from ' + objectName(obj));
    return added;
  }

  function attachPeLogger(addr) {
    if (peHooked) return;
    peHooked = true;
    peLoggerListener = Interceptor.attach(addr, {
      onEnter: function (args) {
        this._peObj = args[0];
        this._peFn = args[1];
        this._peParms = args[2];
        this._peName = '';
        try {
          if (this._peFn && !this._peFn.isNull()) {
            this._peName = functionName(this._peFn) || '';
          }
        } catch (e) {}

        if (pelogOn && pelogLeft > 0 && this._peName) {
          pelogLeft--;
          try { log('PELOG ' + pelogTag + ' ' + objectName(args[0]) + ' :: ' + this._peName); } catch (ePl) {}
        }

        // TRACE v6.8: registra a ORDEM real de chamadas do fluxo teleport/cutscene/missao/casa.
        try {
          const tn = this._peName;
          if (tn && TRACE_RE.test(tn) && !TRACE_SKIP.test(tn) && traceBudget > 0) {
            const tobj = objectName(args[0]);
            if (!/Default__|Widget_|Anim|Sound|Listener/i.test(tobj) || /Quest|Cutscene|Gate|Door|Teleport/i.test(tobj)) {
              traceBudget--;
              let extra = '';
              if (/^(CT_|LoadingScreen|Cutscene|TeleportToSpawnPoint|Serv_TeleportAt|MC_TeleportAt|TeleportAt|EnteredWorld|ShowLocation)/.test(tn)) {
                try {
                  const pz = readParmsSize(this._peFn);
                  if (pz > 0 && pz <= 96) {
                    extra = ' parms=' + hexdumpShort(args[2], pz);
                    // resolve ponteiros de objeto nos primeiros 3 slots de 8 bytes
                    for (let po = 0; po + 8 <= Math.min(pz, 24); po += 8) {
                      try {
                        const pp = args[2].add(po).readPointer();
                        if (looksLikeUObject(pp)) extra += ' obj@' + po + '=' + objectName(pp);
                      } catch (eP) {}
                    }
                  }
                } catch (eX) {}
              }
              log('TRACE ' + new Date().toISOString().substr(11, 12) + ' ' + tobj + '@' + args[0] + ' :: ' + tn + extra);
            }
          }
        } catch (eTR) {}

        try {
          if (v62Budget.pe > 0 && this._peName &&
              /^(ClientSetViewTarget|SetViewTarget|SetViewTargetWithBlend|LoadStreamLevel|LoadLevelInstance|OnStartEndLoadingScreen|OnLoadingScreenInited|OnLoadingCompleted|StartInitial|StopInitial|OnOpened|OnClosed|OnBlackScreenSee)$/.test(this._peName)) {
            v62Budget.pe--;
            log('V62_PE ' + new Date().toISOString() + ' ' + objectName(args[0]) + ' :: ' + this._peName);
          }
        } catch (eV62p) {}
        // NUNCA drenar HideLoading/rescue aqui â€” PE reentrante = freeze (Responding=False)
        // Cache SurvPC/pawn SEMPRE (antes do logBudget) â€” senao rescueVoidZ nunca acha ClientSetLocation
        try {
          const on0 = objectName(args[0]);
          // Cache PlayerStart/spawn actors do mapa (coords reais via K2_GetActorLocation no Tick)
          if (
            /PlayerStart|BP_PlayerSpawn|PlayerSpawn|SpawnPoint|PlayerSpawnPoint/i.test(
              on0
            ) &&
            !/Default__|Listener|Component|Widget|Anim|Sound/i.test(on0)
          ) {
            spawnActorsSeen[args[0].toString()] = { name: on0, obj: args[0] };
          }
          // Ancoras: ZombieSpawner / AI spawn no mapa real (nao no plano cinza)
          if (
            /ZombieSpawner|AISpawn|BP_.*Spawner|PlayerStartPIE/i.test(on0) &&
            !/Default__/i.test(on0) &&
            Object.keys(mapAnchorActors).length < 60
          ) {
            const key = args[0].toString();
            // So cachear pointer â€” ler loc no Tick (dumpLoc), nunca no PE onEnter
            if (!mapAnchorActors[key]) {
              mapAnchorActors[key] = { name: on0, obj: args[0], loc: null };
              if (Object.keys(mapAnchorActors).length === 1) {
                pendingDumpLoc = true;
              } else if (
                Object.keys(mapAnchorActors).length === 8 ||
                Object.keys(mapAnchorActors).length === 20
              ) {
                pendingDumpLoc = true;
              }
            }
          }
          // Capturar ChoosePlayerStart/FindPlayerStart no onLeave (ReturnValue)
          if (
            /^(ChoosePlayerStart|FindPlayerStart|K2_FindPlayerStart|PickSpawnPoint|ServerPickSpawnPoint|PickSpawnPoint_Player)$/i.test(
              this._peName
            )
          ) {
            this._captureStart = true;
          }
          // FIRSTSTART: captura o GameInstance e loga chamadas de IsFirstStart via ProcessEvent
          if (this._peName === 'IsFirstStart') {
            try {
              const onFS = objectName(args[0]);
              if (/GI_Survival/.test(onFS) && !/Default__/.test(onFS)) {
                globalThis.__giObj = args[0];
                this._fsCap = true;
                globalThis.__fsCalls = (globalThis.__fsCalls || 0) + 1;
                if (globalThis.__fsCalls <= 5) log('FIRSTSTART call GI=' + onFS + ' ptr=' + args[0]);
              }
            } catch (eFS) {}
          }
          // X17b: marcar getSpeed p/ capturar o ReturnValue no onLeave
          if (this._peName === 'getSpeed' && phase >= PH.READY) {
            this._gsCap = true;
          }
          // X23: rastreador de funcoes executadas NA instancia (janela andando)
          if ((traceOn || trace2On) && probeInst && args[0].equals(probeInst) && this._peName) {
            try {
              traceSet[this._peName] = (traceSet[this._peName] || 0) + 1;
            } catch (eTr) {}
          }
          // A2: rastreador SINCRONIZADO com a rodada da cadeia CALC â€”
          // ligado so durante as nossas chamadas, captura sub-chamadas BP
          if (traceCalcOn && probeInst && args[0].equals(probeInst) && this._peName) {
            try {
              traceCalcSet[this._peName] = (traceCalcSet[this._peName] || 0) + 1;
            } catch (eTrC) {}
          }
          // A: trace inicial (primeiros 4s apos o setup da sonda)
          if (trace0On && probeInst && args[0].equals(probeInst) && this._peName) {
            try {
              traceSet0[this._peName] = (traceSet0[this._peName] || 0) + 1;
            } catch (eTr0) {}
          }
          // X24: idem no pawn (quem empurra os calculos pode ser ele)
          if (traceOn && survPawnObj && args[0].equals(survPawnObj) && this._peName) {
            try {
              traceSetPawn[this._peName] = (traceSetPawn[this._peName] || 0) + 1;
            } catch (eTrP) {}
          }
          // A': idem na instancia pos-processo
          if (traceOn && probePostInst && args[0].equals(probePostInst) && this._peName) {
            try {
              traceSetPost[this._peName] = (traceSetPost[this._peName] || 0) + 1;
            } catch (eTrPP) {}
          }
          // X20c: notifies que denunciam entrada em locomocao / loot
          if (
            this._peName === 'AnimNotify_OnStartLocomotion' ||
            this._peName === 'AnimNotify_LootStateEntered'
          ) {
            try {
              log('NOTIFY ' + this._peName + ' obj=' + objectName(args[0]));
            } catch (eNt) {}
          }
          if (/SurvPC/i.test(on0)) {
            const first = !survPcObj;
            survPcObj = args[0];
            if (first) {
              try {
                harvestFuncsFromObject(args[0]);
              } catch (eH) {}
            }
            if (/ClientSetLocation|ClientRestart|ReceivePossess/i.test(this._peName)) {
              remember(args[0], args[1], this._peName);
            }
            // Rescue Z so na fase GROUND (cedo = DEFER spam / loc 0,0,0)
            if (
              phase >= PH.GROUND &&
              phase < PH.BODY &&
              sawSurvivalPlayer &&
              /ClientRestart|ReceivePossess/i.test(this._peName)
            ) {
              pendingRescueZ = true;
            }
          }
          if (
            /SurvivalPlayer/i.test(on0) &&
            !/Listener|Default__/i.test(on0)
          ) {
            if (!survPawnObj || !survPawnObj.equals(args[0])) camYawCache = null;
            survPawnObj = args[0];
            try { lsPawnSeen(args[0], this._peName); } catch (eLP1) {}
            if (/K2_GetActorLocation|ReceivePossessed/i.test(this._peName)) {
              remember(args[0], args[1], this._peName);
            }
            // So avanca para WAIT_PAWN; NUNCA rebaixa fase (evita ping-pong)
            if (
              !travelBusy &&
              phase === PH.STREAM &&
              survPcObj &&
              (landscapeShown >= 1 || wpShownCount >= STREAM_WP_MIN)
            ) {
              setPhase(PH.WAIT_PAWN, 'SurvivalPlayer tick');
            }
            // Cache AddMovementInput se aparecer no PE
            if (/^AddMovementInput$/i.test(this._peName)) {
              found.AddMovementInput = { obj: args[0], fn: args[1] };
            }
            // Bridge: WASD + mouse look (Turn/LookUp tambem chegam sem efeito)
            if (
              moveBridgeOn &&
              processEventFn &&
              /InpAxisEvt_Move(Forward|Right)_/i.test(this._peName)
            ) {
              try {
                applyMoveBridgeAxis(
                  /MoveForward/i.test(this._peName) ? 'fwd' : 'right',
                  args[2]
                );
              } catch (eBr) {}
            }
            if (
              lookBridgeOn &&
              processEventFn &&
              /InpAxisEvt_(Turn|LookUp)_/i.test(this._peName)
            ) {
              try {
                applyLookBridgeAxis(
                  /Turn/i.test(this._peName) ? 'yaw' : 'pitch',
                  args[2]
                );
              } catch (eLk) {}
            }
          }
          // Cache Basic_* SkeletalMesh se aparecer no PE (sem chamar SetSkeletalMesh)
          if (
            on0 &&
            /Basic_Mesh|Basic_Body_V3|Basic_Head_V3|Basic_Legs_V3|Female_Basic/i.test(
              on0
            ) &&
            !/Component|Function|Class/i.test(on0)
          ) {
            meshAssetsSeen[on0] = args[0];
          }
        } catch (e0) {}

        // DIAG_UI v2 (M/Tab): troca de modo de camera + parms. Exclui spam
        // por-frame (BlueprintModifyCamera/AnyKey drenaram a v1). So logging.
        if (
          DIAG_UI_MODE &&
          phase >= PH.READY &&
          peUiBudget > 0 &&
          this._peName &&
          !/BlueprintModifyCamera|ModifyCamera|AnyKey|CameraShake|AnimNotify|ToggleGrenade|PlayerFire|PlayerAim|AimGrenade|ZoomOut|MouseScroll/i.test(
            this._peName
          ) &&
          /CameraMode|SetCamera|CanSetCamera|EquipGPS|GPSView|Inventor|Backpack|OpenMap|InpActEvt_(Equip|Open|Inventory|Map)/i.test(
            this._peName
          )
        ) {
          try {
            const keyD = args[0].toString() + '::' + this._peName;
            const nowD = Date.now();
            const isModeFn = /SetCameraMode|CanSetCameraMode/i.test(
              this._peName
            );
            if (
              isModeFn ||
              !peUiLast[keyD] ||
              nowD - peUiLast[keyD] > 800
            ) {
              peUiLast[keyD] = nowD;
              peUiBudget--;
              // Dump parms: ptr@0 (asset?), int@0/4 (FName/tag index), nome do ptr
              let parms = '';
              try {
                const pb = args[2];
                if (pb && !pb.isNull()) {
                  let p0name = '';
                  try {
                    const p0 = pb.readPointer();
                    if (p0 && !p0.isNull()) p0name = objectName(p0) || '';
                  } catch (eP0) {}
                  parms =
                    ' i0=' +
                    pb.readS32() +
                    ' i1=' +
                    pb.add(4).readS32() +
                    (p0name ? ' ptr0=' + p0name : '');
                }
              } catch (ePm) {}
              log(
                'DIAG_UI PE ' +
                  objectName(args[0]) +
                  ' :: ' +
                  this._peName +
                  parms +
                  ' (budget=' +
                  peUiBudget +
                  ')'
              );
            }
          } catch (eD) {}
        }

        // GPS_SPAWN: orcamento proprio (gpsUiBudget), independente do peUiBudget
        // que zera cedo (inventario/Tab). Loga EquipGpsServer/SpawnGPSMulticast/
        // DestroyGPSMulticast, o M (InpActEvt_EquipGPS) e os modos GPSViewScript/
        // InterpSpeedsReset/FadingObject com GPSRef_FP no momento da chamada.
        if (
          phase >= PH.READY &&
          gpsUiBudget > 0 &&
          this._peName &&
          (/^(EquipGpsServer|SpawnGPSMulticast|DestroyGPSMulticast|EquipGPS|InpActEvt_EquipGPS.*)$/.test(this._peName) ||
            (/^(K2_OnEnterCameraMode|K2_OnExitCameraMode)$/.test(this._peName) &&
              /GPSViewScript|InterpSpeedsReset|ATPCCameraFadingObject/i.test(objectName(args[0]) || '')))
        ) {
          try {
            let gpsRefNow = 'pawn?';
            if (survPawnObj && !survPawnObj.isNull()) {
              const gr = survPawnObj.add(0x3158).readPointer();
              gpsRefNow = gr.isNull() ? 'null' : (objectName(gr) || gr.toString());
            }
            gpsUiBudget--;
            log(
              'GPS_SPAWN ' + new Date().toISOString() + ' ' + this._peName +
                ' owner=' + objectName(args[0]) + ' GPSRef_FP=' + gpsRefNow +
                ' (gpsBudget=' + gpsUiBudget + ')'
            );
          } catch (eGs) {}
        }

        // LSWIDE (SOMENTE LOG): na janela de 25s apos a chamada, loga todo PE exceto spam
        // por-frame, para ver quem reabre a tela de carregamento (orcamento proprio, dedupe 150ms).
        if (
          Date.now() < lsWideUntil &&
          lsWideBudget > 0 &&
          this._peName &&
          !/Tick|Anim|Camera|Update|Notify|Input|Mouse|Stamina|Hunger|Thirst|Timeline|Blueprint|Footstep|Sound|Audio|Overlap|Hit|Physics|Move|Velocity|Elevator|DoorTeleport|HouseGate|GetActor|IsValid|Lerp|Interp|Look|Turn|Sprint|Breath|Weapon|Aim|Fire|FOV|Shake|Bar|Stat/i.test(
            this._peName
          )
        ) {
          try {
            const keyW = args[0].toString() + '::' + this._peName;
            const nowW = Date.now();
            // Lista de objetos relevantes (evita ruido de luzes/alarmes/zumbis/agua/helicoptero).
            const onW = objectName(args[0]) || '';
            if (
              (!lsWideLast[keyW] || nowW - lsWideLast[keyW] > 150) &&
              /SurvPC|GameHUD|^W_|^WBP_|^UIW_|GI_Survival|GameMode|GS_TDB|PlayerPlaceholder|LevelStreamer|BlackScreen|SurvivalPlayer_V2_C|PlayerController|PlayerState|GameState|PlayerCameraManager|Cutscene|LevelSequence|SequencePlayer|TipsInfo|Spectator|DefaultPawn|NewCity_persistent_WP|WorldPartition|LevelStreaming/i.test(onW) &&
              !/WBP_TutorialQuest3DTracker_C :: EnableLoadingCheck/.test(onW + ' :: ' + this._peName)
            ) {
              lsWideLast[keyW] = nowW;
              lsWideBudget--;
              log(
                'LSWIDE ' + new Date().toISOString() + ' ' +
                  objectName(args[0]) + ' :: ' + this._peName +
                  ' (b=' + lsWideBudget + ')'
              );
            }
          } catch (eLw2) {}
        }

        // LSTRACE (SOMENTE LOG): qual funcao reabre LoadingScreen/BlackScreen apos
        // EndLoadingScreen. Sem gate de phase, orcamento proprio, dedupe 250ms.
        if (
          lsTraceBudget > 0 &&
          this._peName &&
          /LoadingScreen|BlackScreen|Teleport|Death|Respawn|Kill|FellOut|OutOfWorld|StartInitial|StopInitial|^Open$|OpenWithText|^Close$|Restart|Possess|SetPawn|ServerLocationLoaded|EndLoading|OnStartEnd|InitPlayer|DestrSelf|DelayNePashet|ONLevelsLoaded|ClientLevel|OnLevelLoaded|ConfirmPlayerJoined|NotifyPlayerJoined|OnIncreaseLoadingPercent|OnSetMaxLoadingPercent|HideLoadingScreen|RemoveLoadingScreen|OnLoadingCompleted|AfterLoading/i.test(
            this._peName
          )
        ) {
          try {
            const keyL = args[0].toString() + '::' + this._peName;
            const nowL = Date.now();
            if (
              (!lsTraceLast[keyL] || nowL - lsTraceLast[keyL] > 250) &&
              !/Elevator|DoorTeleport|HouseGate/i.test(objectName(args[0]) || '')
            ) {
              lsTraceLast[keyL] = nowL;
              lsTraceBudget--;
              log(
                'LSTRACE ' + new Date().toISOString() + ' ' +
                  objectName(args[0]) + ' :: ' + this._peName +
                  ' (b=' + lsTraceBudget + ')'
              );
            }
          } catch (eLs) {}
        }

        // X15: vigia total pos-modo (log de todo PE na janela, exceto spam/frame)
        if (
          phase >= PH.READY &&
          peWatchLeft > 0 &&
          Date.now() < peWatchUntil &&
          this._peName &&
          !/BlueprintUpdateAnimation|BlueprintModifyCamera|ModifyCamera|AnyKey|AnimNotify|ReceiveTick|BlueprintPostEvaluateAnimation/i.test(
            this._peName
          )
        ) {
          try {
            peWatchLeft--;
            var phex = '';
            try {
              var pbw = args[2];
              if (pbw && !pbw.isNull()) phex = ' parms=' + hexBytes(pbw, 16);
            } catch (ePw) {}
            log(
              'PEWATCH ' + objectName(args[0]) + ' :: ' + this._peName + phex
            );
          } catch (eW) {}
        }

        // D9: detectar entrada/saida do modo GPS p/ snapshot diferencial
        if (
          DIAG_DIFF &&
          phase >= PH.READY &&
          this._peName &&
          /K2_On(Enter|Exit)CameraMode/i.test(this._peName)
        ) {
          try {
            const onm9 = objectName(args[0]);
            if (/GPSViewScript/i.test(onm9)) {
              peWatchUntil = Date.now() + 2500;
              peWatchLeft = 250;
              if (/Enter/i.test(this._peName)) scheduleDiffSnap('GPS');
              else scheduleDiffSnap('NORMAL');
            }
          } catch (eD9) {}
        }

        const boosted = browserMode || Date.now() < browserBoostUntil;
        // Sempre observar DefaultPawn / possess mesmo com logBudget esgotado
        const always =
          /GetDefaultPawnClassForController|SpawnDefaultPawn|K2_PostLogin|ReceivePossess|ClientRestart|ServerLogined|LoadFromPlaceholder|FakeLogin|ClientSetLocation|K2_GetActorLocation/i.test(
            this._peName
          );
        // v6.5: contador de OnLevelShown (usado pelo seq99 modo camera).
        try {
          if (this._peName === 'OnLevelShown') {
            globalThis.__lvlShown = (globalThis.__lvlShown || 0) + 1;
            globalThis.__lvlShownAt = Date.now();
            const lsn = globalThis.__lvlShownNames || (globalThis.__lvlShownNames = []);
            if (lsn.length < 40) lsn.push(objectName(args[0]));
          }
        } catch (eLS5) {}
        // DOORPE: qualquer chamada de funcao na instancia da porta (achada pelo findactor).
        try {
          const dcs = globalThis.__doorCands;
          if (dcs && dcs.length && args[0].equals(dcs[0])) {
            log('DOORPE ' + this._peName);
          }
        } catch (eDP) {}
        if (!logging || ((logBudget <= 0 && !boosted) && !always)) return;
        try {
          const ufn = args[1];
          if (ufn.isNull()) return;
          const name = this._peName;
          if (!name || name === '?' || name.indexOf('idx:') === 0) return;
          const interesting =
            always ||
            INTEREST.test(name) ||
            HOST_CACHE_RE.test(name) ||
            /Host|Session|Travel|Spawn|Listen|Server|Level|Pawn|Possess|Join|StartLevel|CreateSession|Continue|OnClick|Restart|NewChar|Logined|Placeholder|SurvivalPlayer|FakeLogin|LoadFrom|InpActEvt_(Jump|Sprint|Run|Crouch|Aim)/i.test(
              name
            );
          if (!interesting) return;
          if (logBudget > 0) logBudget--;
          remember(args[0], ufn, name);
          log('PE ' + objectName(args[0]) + ' :: ' + name);
          try {
            const on = objectName(args[0]);
            if (/WBP_Server|ServerScreen/i.test(on)) {
              harvestFuncsFromObject(args[0]);
            }
            if (/PlayerPlaceholder/i.test(on)) {
              sawPlaceholder = true;
              placeholderObj = args[0];
              harvestFuncsFromObject(args[0]);
              // Guardar Script; Jump so apos Landscape (Jump cedo = ceu vazio)
              if (/ExecuteUbergraph_PlayerPlaceholder/i.test(name)) {
                try {
                  const data = args[1].add(0x60).readPointer();
                  const num = args[1].add(0x68).readS32();
                  if (!data.isNull() && num > ENTRY_SL + 5) {
                    placeholderScript = data;
                    placeholderScriptNum = num;
                    tryPatchJump('ubergraph');
                  }
                } catch (eJ2) {
                  log('JUMP script fail: ' + eJ2);
                }
              }
            }
            if (/SurvPC/i.test(on)) {
              survPcObj = args[0];
            }
            // So possess real apos travel â€” Unpossessed do menu dispara cinza
            if (
              travelArmed &&
              /SurvivalPlayer/i.test(on) &&
              !/Default__/i.test(on) &&
              !/Listener/i.test(on) &&
              /ReceivePossessed|UserConstructionScript|ReceiveBeginPlay/i.test(name)
            ) {
              if (!sawSurvivalPlayer) {
                log(
                  'F8 SurvivalPlayer vivo: ' +
                    on +
                    ' :: ' +
                    name +
                    ' L=' +
                    landscapeShown +
                    ' â€” corpo/input so apos STREAM+GROUND'
                );
                // Soft-lift depois; corpo/release via advancePhases (nao Possess agora)
                rescueVoidZAttempts = 0;
                softLiftZAttempts = 0;
                if (phase < PH.WAIT_PAWN && !travelBusy) {
                  setPhase(PH.WAIT_PAWN, 'possess ' + name);
                }
                scheduleDumpLocs('possess');
              }
              sawSurvivalPlayer = true;
              survPawnObj = args[0];
              try { lsPawnSeen(args[0], name); } catch (eLP2) {}
              try {
                cacheSurvivalPawnClass(
                  args[0].add(0x10).readPointer(),
                  'instance/' + on
                );
              } catch (e4) {}
            }
            // LVL_LOG: captura eventos de carregamento de nivel (diagnostico lobby)
            if (
              (lvlLogBudget > 0 || (wpLogBudget > 0 && /NewCity_persistent_WP/.test(on))) &&
              /OnLevel|LevelAdded|LevelRemoved|LevelShown|LevelLoaded|Streaming|LoadStream|LoadMap|OpenLevel|Browse|PostLoad|ServerInfoError|PrepareServerList|PickPlayer|ServerLogined|LoadPlayerPos|OnServerLogin/i.test(name) &&
              !/Default__/i.test(on)
            ) {
              if (lvlLogBudget > 0) lvlLogBudget--; else wpLogBudget--;
              log('LVL ' + name + ' on=' + on);
            }
            // WP stream counters
            if (
              travelArmed &&
              /NewCity_persistent|First_Launch_Tutorial|Suburban_new_Lighting/i.test(on) &&
              /OnLevelShown/i.test(name)
            ) {
              wpShownCount++;
              travelDone = true;
              if (/Landscape/i.test(on)) {
                landscapeShown++;
                log('F8 Landscape #' + landscapeShown + ' (' + on + ')');
                if (travelBusy && landscapeShown >= 1) {
                  travelBusy = false;
                  log('F8 travelBusy OFF (Landscape)');
                  scheduleDumpLocs('F8-post-Landscape');
                }
                if (phase === PH.TRAVEL && landscapeShown >= 1) {
                  setPhase(PH.STREAM, 'Landscape #' + landscapeShown);
                }
                tryPatchJump('Landscape');
                // Soft-lift so na fase GROUND (advancePhases) â€” nao spam aqui
                if (
                  AUTO_POST_SURV_FIX &&
                  sawSurvivalPlayer &&
                  !postSurvFixDone &&
                  landscapeShown >= HIDE_AFTER_LANDSCAPE
                ) {
                  pendingPostSurvFix = true;
                  log('F8 Landscape â†’ postFix (pawn ja possessed)');
                }
              }
              if (wpShownCount === 1 || wpShownCount === 8 || wpShownCount === 25) {
                log(
                  'F8 WP #' +
                    wpShownCount +
                    ' L=' +
                    landscapeShown +
                    ' placeholder=' +
                    sawPlaceholder
                );
              }
              if (wpShownCount === 3 && !jumpPatched) {
                tryPatchJump('WP3');
              }
              // HideLoading so na fase RELEASE (advancePhases) â€” cedo = tela sem pawn
              if (
                AUTO_OFFLINE_SPAWN &&
                landscapeShown >= LANDSCAPE_BEFORE_HIDE &&
                wpShownCount >= WP_SHOWN_BEFORE_HIDE &&
                !offlineSpawnDone
              ) {
                pendingOfflineSpawn = true;
                log('F8 Landscape+WP â†’ queue NewCharCreated (sair Placeholder)');
              }
            }
            // Placeholder logou sem SurvivalPlayer = void vermelho tipico offline
            if (
              travelArmed &&
              /ServerLogined/i.test(name) &&
              /PlayerPlaceholder/i.test(on)
            ) {
              log(
                'F8 PlayerPlaceholder::ServerLogined â€” sem SurvivalPlayer = ecran vermelho'
              );
              if (AUTO_OFFLINE_SPAWN && !offlineSpawnDone)
                pendingOfflineSpawn = true;
            }
          } catch (e3) {}
        } catch (e) {}
      },
      onLeave: function () {
        // FIRSTSTART: forca ReturnValue=true do IsFirstStart (so se globalThis.__forceFS)
        if (this._fsCap && this._peParms && !this._peParms.isNull()) {
          try {
            const fo = globalThis.__fsRetOff || 0;
            const before = this._peParms.add(fo).readU8();
            if (globalThis.__forceFS) {
              this._peParms.add(fo).writeU8(1);
            }
            if ((globalThis.__fsLogN = (globalThis.__fsLogN || 0) + 1) <= 5) {
              log('FIRSTSTART ret off=' + fo + ' antes=' + before + ' depois=' + this._peParms.add(fo).readU8() + ' force=' + !!globalThis.__forceFS);
            }
          } catch (eFSR) {}
        }
        // X17b: ReturnValue do getSpeed (buffer de parms apos a chamada do jogo)
        if (this._gsCap && this._peParms && !this._peParms.isNull()) {
          try {
            const f0 = this._peParms.readFloat();
            gsLastF0 = f0;
            gsLastT = Date.now();
            if (gsLogN < 60 && Math.abs(f0 - gsLastLogged) > 0.5) {
              gsLastLogged = f0;
              gsLogN++;
              let on2 = '?';
              try {
                on2 = objectName(this._peObj);
              } catch (eO) {}
              log('GSRET obj=' + on2 + ' getSpeed=' + f0.toFixed(2) + ' raw=' + hexBytes(this._peParms, 16));
            }
          } catch (eG) {}
        }
        // Captura AActor* retornado por Choose/FindPlayerStart (parms ReturnValue @+8)
        if (this._captureStart && this._peParms && !this._peParms.isNull()) {
          try {
            const offs = [8, 0, 16, 24];
            for (let i = 0; i < offs.length; i++) {
              const p = this._peParms.add(offs[i]).readPointer();
              if (!looksLikeUObject(p)) continue;
              const n = objectName(p);
              if (
                /PlayerStart|SpawnPoint|PlayerSpawn/i.test(n) &&
                !/Default__|Component/i.test(n)
              ) {
                spawnActorsSeen[p.toString()] = { name: n, obj: p };
                log(
                  'F8 capture ' +
                    this._peName +
                    ' â†’ ' +
                    n +
                    ' (parms+0x' +
                    offs[i].toString(16) +
                    ')'
                );
                pendingDumpLoc = true;
                break;
              }
            }
          } catch (eC) {}
        }
        if (!FORCE_SURVIVAL_PAWN) return;
        if (this._peName !== 'GetDefaultPawnClassForController') return;
        if (!this._peParms || this._peParms.isNull()) return;
        try {
          // Preferir class ja cached; senao tentar found.*
          if (!survivalPawnClass) {
            const keys = [
              'SurvivalPlayer_V2_C',
              'SurvivalPlayer_C',
              'SurvivalPlayer_Test_C',
            ];
            for (let i = 0; i < keys.length; i++) {
              const hit = found[keys[i]];
              if (hit && hit.fn) cacheSurvivalPawnClass(hit.fn, 'found/' + keys[i]);
            }
          }
          if (!survivalPawnClass) return;
          // Parms: AController* (0) + UClass* ReturnValue (8)
          const old = this._peParms.add(8).readPointer();
          const oldN = objectName(old);
          if (/SurvivalPlayer/i.test(oldN)) return;
          this._peParms.add(8).writePointer(survivalPawnClass);
          defaultPawnForced++;
          log(
            'FORCE DefaultPawn ' +
              oldN +
              ' â†’ ' +
              objectName(survivalPawnClass) +
              ' #' +
              defaultPawnForced
          );
        } catch (e) {
          log('FORCE DefaultPawn fail: ' + e);
        }
      },
    });
  }

  function bindProcessEvent(addr, label) {
    processEventAddr = addr;
    processEventFn = new NativeFunction(addr, 'void', [
      'pointer',
      'pointer',
      'pointer',
    ]);
    log('ProcessEvent ' + label + ' @ ' + addr);
    attachPeLogger(addr);
  }

  function discoverProcessEvent(eng) {
    // Fast path: known RVA (validated earlier as vtable[77]/78])
    try {
      if (peKnown && !peKnown.isNull()) {
        bindProcessEvent(peKnown, 'known-RVA');
        return;
      }
    } catch (e) {}

    const vt = eng.readPointer();
    const counts = {};
    const hooks = [];
    const lo = 60;
    const hi = 100;
    for (let i = lo; i <= hi; i++) {
      counts[i] = 0;
      try {
        const addr = vt.add(i * 8).readPointer();
        if (addr.isNull()) continue;
        if (addr.compare(main.base) < 0 || addr.compare(main.base.add(main.size)) >= 0)
          continue;
        hooks.push(
          Interceptor.attach(addr, {
            onEnter: function () {
              counts[i]++;
            },
          })
        );
      } catch (e) {}
    }
    log('probe ProcessEvent vtable[' + lo + '..' + hi + '] 2.5s...');
    setTimeout(function () {
      let best = -1;
      let bestC = 0;
      for (let i = lo; i <= hi; i++) {
        if (counts[i] > bestC) {
          bestC = counts[i];
          best = i;
        }
      }
      hooks.forEach(function (h) {
        try {
          h.detach();
        } catch (e) {}
      });
      if (best < 0 || bestC < 5) {
        log('falha probe PE â€” retry F11');
        return;
      }
      bindProcessEvent(vt.add(best * 8).readPointer(), 'vtable[' + best + ']');
    }, 2500);
  }

  function readParmsSize(ufn) {
    // UE5 UFunction::ParmsSize â€” prefer known offsets only.
    // NUNCA tratar 0 em offset aleatorio (0x30 etc.) como ParmsSize==0 â€” isso
    // fazia SetSpawnRegion parecer 0-arg e crashar com PE(null).
    const preferred = [0x5e, 0x5c, 0x60, 0x62, 0x5a];
    for (let i = 0; i < preferred.length; i++) {
      try {
        const v = ufn.add(preferred[i]).readU16();
        if (v >= 0 && v <= 0x200) return v;
      } catch (e) {}
    }
    return -1;
  }

  function dumpGiFunctions(obj) {
    if (!obj || obj.isNull()) {
      log('F9 dump: sem objeto');
      return;
    }
    log('F9 dump UFunctions em ' + objectName(obj) + ' (heuristica class*)');
    const seen = {};
    let cls = null;
    try {
      cls = obj.add(0x10).readPointer();
    } catch (e) {
      return;
    }
    let nLog = 0;
    for (let depth = 0; depth < 16 && cls && !cls.isNull(); depth++) {
      for (let o = 0x28; o < 0x300; o += 8) {
        try {
          const p = cls.add(o).readPointer();
          if (p.isNull()) continue;
          for (let i = 0; i < 256; i++) {
            try {
              const q = i === 0 && looksLikeUObject(p) ? p : p.add(i * 8).readPointer();
              if (!looksLikeUObject(q)) continue;
              const n = objectName(q);
              if (!n || seen[n] || n.indexOf('idx:') === 0) continue;
              // UFunction names are typically CamelCase identifiers
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !/^BndEvt_/.test(n)) continue;
              if (n.length < 4 || n.length > 180) continue;
              seen[n] = true;
              const psz = readParmsSize(q);
              if (
                /Server|Host|Listen|Travel|Session|Spawn|Level|Join|Play|Match|Lobby|Continue|Restart|Create|Open|Fake|Login|Char|LoadChar|SaveChar|Possess|Pawn|Placeholder|Survival/i.test(
                  n
                )
              ) {
                log('F9 HIT ' + n + ' ParmsSize=' + psz);
                remember(obj, q, n);
                nLog++;
              }
            } catch (e2) {
              break;
            }
          }
        } catch (e) {}
      }
      let next = null;
      const supers = [0x40, 0x48, 0x30, 0x38, 0x50];
      for (let s = 0; s < supers.length; s++) {
        try {
          const cand = cls.add(supers[s]).readPointer();
          if (cand.isNull() || cand.equals(cls)) continue;
          if (!looksLikeUObject(cand)) continue;
          next = cand;
          break;
        } catch (e) {}
      }
      cls = next;
    }
    log('F9 dump done hits=' + nLog + ' totalCached=' + Object.keys(found).length);
  }

  // SERVIDOR (06/11): remendo DESLIGADO. Ele grava EX_Jump em 0x2399 do ubergraph do PlayerPlaceholder (bytecode da CLASSE,
  // compartilhado por todas as instancias). Com o Firestore funcionando, o OnServerLogin do SurvPC de um CLIENTE chama
  // ServerLogined -> salta para PickPlayer@0x12AA -> o host spawna e possui o SurvivalPlayer cedo demais, pulando
  // LoginCompleted/ServerLogin/ONLevelsLoaded/InitPlayer. No cliente, OnRep_LoginCompleted so chama ServerLogin se
  // IsLocallyControlled (o placeholder ja nao e o pawn) -> a tela de carregamento nunca fecha.
  // Alem disso o remendo (5 bytes em 0x2399) sobrescreve o inicio do ClientLevelLoaded (0x239A).
  // Original em 0x2399: 4d 19 01 80 bb (os 2 ultimos bytes sao o ponteiro de FField do LevelStreamer; ver restaurar_servidor_logined.js).
  let jumpSkipLogged = false;
  function tryPatchJump(reason) {
    if (!jumpSkipLogged) { jumpSkipLogged = true; log('JUMP desligado no modo servidor (host_flow_servidor.js), motivo: ' + reason); }
    return false;
  }
  function tryPatchJump_original(reason) {
    if (jumpPatched || !placeholderScript) return false;
    if (landscapeShown < 1 && wpShownCount < 3) {
      log(
        'JUMP defer (' +
          reason +
          ') L=' +
          landscapeShown +
          ' WP=' +
          wpShownCount
      );
      return false;
    }
    try {
      try {
        Memory.protect(placeholderScript.add(ENTRY_SL), 8, 'rwx');
      } catch (eJ) {}
      placeholderScript.add(ENTRY_SL).writeU8(0x06);
      placeholderScript.add(ENTRY_SL + 1).writeU32(ENTRY_PICK);
      jumpPatched = true;
      log(
        'JUMP ServerLogined@0x2399 -> PickPlayer@0x12AA (' +
          reason +
          ' Num=' +
          placeholderScriptNum +
          ')'
      );
      if (!sawSurvivalPlayer && placeholderObj) {
        pendingPickAfterJump = true;
      }
      return true;
    } catch (e) {
      log('JUMP fail: ' + e);
      return false;
    }
  }

  // Achar UFunction por nome no class hierarchy (sem depender de INTEREST/logBudget)
  function findUFn(obj, wantRe) {
    if (!obj) return null;
    let cls;
    try {
      cls = obj.add(0x10).readPointer();
    } catch (e) {
      return null;
    }
    for (let d = 0; d < 14 && cls && !cls.isNull(); d++) {
      for (let o = 0x28; o < 0x2c0; o += 8) {
        try {
          const p = cls.add(o).readPointer();
          if (p.isNull()) continue;
          for (let i = 0; i < 220; i++) {
            try {
              const q = i === 0 && looksLikeUObject(p) ? p : p.add(i * 8).readPointer();
              if (!looksLikeUObject(q)) continue;
              const nm = objectName(q);
              if (wantRe.test(nm)) return q;
            } catch (e2) {
              break;
            }
          }
        } catch (e) {}
      }
      let next = null;
      [0x40, 0x48, 0x30, 0x38, 0x50].forEach(function (s) {
        if (next) return;
        try {
          const c = cls.add(s).readPointer();
          if (!c.isNull() && looksLikeUObject(c) && !c.equals(cls)) next = c;
        } catch (e) {}
      });
      cls = next;
    }
    return null;
  }

  // T1: lookup DETERMINISTICO de UFunction â€” sobe SuperStruct (+0x40) e
  // percorre a lista UField Children (+0x48, Next +0x28) por nome exacto.
  // (O findUFn heuristico por varrimento falhava runs inteiras: K2_double=0.)
  function findUFnDet(obj, exactName) {
    if (!obj || obj.isNull()) return null;
    let cls = null;
    try {
      cls = obj.add(0x10).readPointer();
    } catch (e) {
      return null;
    }
    for (let depth = 0; depth < 24 && cls && !cls.isNull(); depth++) {
      try {
        let node = cls.add(0x48).readPointer();
        for (let i = 0; i < 500 && node && !node.isNull(); i++) {
          let nm = null;
          try {
            nm = objectName(node);
          } catch (e2) {
            break;
          }
          if (nm === exactName) {
            log(
              'findUFnDet ' +
                exactName +
                ' em ' +
                objectName(cls) +
                ' depth=' +
                depth
            );
            return node;
          }
          let next = null;
          try {
            next = node.add(0x28).readPointer();
          } catch (e3) {
            break;
          }
          if (next && next.equals(node)) break;
          node = next;
        }
      } catch (e4) {}
      let nextCls = null;
      const supers = [0x40, 0x48, 0x30, 0x38, 0x50];
      for (let s = 0; s < supers.length; s++) {
        try {
          const cand = cls.add(supers[s]).readPointer();
          if (!cand || cand.isNull() || cand.equals(cls)) continue;
          if (!isLikelyUClass(cand)) continue;
          nextCls = cand;
          break;
        } catch (e5) {}
      }
      cls = nextCls;
    }
    return null;
  }

  // X17d: findUFnDet com teto largo + contagem (AnimBP tem centenas de fns;
  // o teto de 500 cortava antes do getSpeed). So leitura.
  function findUFnWide(obj, exactName) {
    if (!obj || obj.isNull()) return null;
    let cls = null;
    try {
      cls = obj.add(0x10).readPointer();
    } catch (e) {
      return null;
    }
    for (let depth = 0; depth < 24 && cls && !cls.isNull(); depth++) {
      let count = 0;
      try {
        let node = cls.add(0x48).readPointer();
        for (let i = 0; i < 4000 && node && !node.isNull(); i++) {
          count++;
          let nm = null;
          try {
            nm = objectName(node);
          } catch (e2) {
            break;
          }
          if (nm === exactName) {
            log('findUFnWide ' + exactName + ' em ' + objectName(cls) + ' depth=' + depth + ' idx=' + i);
            return node;
          }
          let next = null;
          try {
            next = node.add(0x28).readPointer();
          } catch (e3) {
            break;
          }
          if (next && next.equals(node)) break;
          node = next;
        }
      } catch (e4) {}
      log('findUFnWide cls=' + objectName(cls) + ' filhosVisitados=' + count);
      // Subida: SuperStruct +0x40 validado pela metaclasse ('Class').
      // isLikelyUClass rejeitava a BP pai; classe de um UClass e sempre 'Class'.
      let nextCls = null;
      const supersW = [0x40, 0x48, 0x30, 0x38, 0x50];
      for (let s = 0; s < supersW.length && !nextCls; s++) {
        try {
          const cand = cls.add(supersW[s]).readPointer();
          if (!cand || cand.isNull() || cand.equals(cls)) continue;
          const mc = objectName(cand.add(0x10).readPointer());
          // UClass nativa -> 'Class'; classe gerada por BP -> 'BlueprintGeneratedClass'
          if (/Class/.test(mc)) nextCls = cand;
        } catch (e5) {}
      }
      cls = nextCls;
    }
    return null;
  }

  // Tentar resolver SurvPC a partir do pawn (APawn::Controller)
  function resolveSurvPcFromPawn() {
    if (!survPawnObj) return null;
    const offs = [0x2a8, 0x2b0, 0x2b8, 0x2c0, 0x2c8, 0x2d0, 0x298, 0x2e0];
    for (let i = 0; i < offs.length; i++) {
      try {
        const p = survPawnObj.add(offs[i]).readPointer();
        if (!looksLikeUObject(p)) continue;
        const n = objectName(p);
        if (/SurvPC|PlayerController|Controller/i.test(n)) {
          survPcObj = p;
          log('rescueVoidZ Controller @+0x' + offs[i].toString(16) + '=' + n);
          return p;
        }
      } catch (e) {}
    }
    return null;
  }


  function scheduleDumpLocs(reason) {
    pendingDumpLoc = true;
    log('dumpLoc scheduled (' + reason + ')');
    [2000, 5000, 10000, 18000].forEach(function (ms) {
      setTimeout(function () {
        pendingDumpLoc = true;
        log('dumpLoc re-queue t+' + ms + 'ms (' + reason + ')');
      }, ms);
    });
  }

  // Valida FVector LWC razoavel (mapa NewCity ~1e4..2e5)
  function locLooksOk(x, y, z) {
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return false;
    if (Math.abs(x) > 5e6 || Math.abs(y) > 5e6 || Math.abs(z) > 5e5) return false;
    // rejeita zero puro / NaN junk
    if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01 && Math.abs(z) < 0.01) return false;
    return true;
  }

  // Sonda RootComponent + qualquer *Component* no actor; le doubles/floats candidatos
  function readRootComponentLoc(actor) {
    if (!actor) return null;
    const comps = [];
    // varrer pointers do actor a procura de Capsule/Root/Scene Component
    // (nao exigir looksLikeUObject â€” vtable check falha em alguns UObject)
    for (let off = 0x50; off < 0x500; off += 8) {
      try {
        const p = actor.add(off).readPointer();
        if (!p || p.isNull()) continue;
        let n = null;
        try {
          n = objectName(p);
        } catch (eN) {
          continue;
        }
        if (!n || n === '?' || n.indexOf('idx:') === 0) continue;
        // So componentes reais â€” NAO UFunction BndEvt_*Component*Signature
        if (
          !/^(CapsuleComponent|SphereComponent|BoxComponent|SceneComponent|StaticMeshComponent|SkeletalMeshComponent|BillboardComponent|ArrowComponent|ChildActorComponent|ProjectileMovementComponent|CharacterMovementComponent|FloatingPawnMovement)/i.test(
            n
          ) &&
          !/RootComponent|DefaultSceneRoot|CollisionCylinder|CollisionComponent/i.test(
            n
          )
        )
          continue;
        if (
          /BndEvt|Signature|Delegate|Widget|Audio|Particle|Niagara|Light|Timeline|Default__/i.test(
            n
          )
        )
          continue;
        comps.push({ off: off, obj: p, name: n });
      } catch (e) {}
    }
    const hits = [];
    function consider(x, y, z, meta) {
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
      if (Math.abs(x) > 5e6 || Math.abs(y) > 5e6 || Math.abs(z) > 1e6) return;
      // aceita ate quase-zero se Z parecer altura
      const mag = Math.hypot(x, y);
      if (mag < 1 && Math.abs(z) < 1) return;
      hits.push({ loc: [x, y, z], mag: mag, z: z, meta: meta });
    }
    for (let ci = 0; ci < comps.length; ci++) {
      const c = comps[ci];
      for (let vo = 0x100; vo < 0x2c0; vo += 8) {
        try {
          const xd = c.obj.add(vo).readDouble();
          const yd = c.obj.add(vo + 8).readDouble();
          const zd = c.obj.add(vo + 16).readDouble();
          consider(xd, yd, zd, c.name + '@actor+0x' + c.off.toString(16) + '/d+0x' + vo.toString(16));
        } catch (eD) {}
        try {
          const xf = c.obj.add(vo).readFloat();
          const yf = c.obj.add(vo + 4).readFloat();
          const zf = c.obj.add(vo + 8).readFloat();
          consider(xf, yf, zf, c.name + '@actor+0x' + c.off.toString(16) + '/f+0x' + vo.toString(16));
        } catch (eF) {}
      }
    }
    if (!hits.length) {
      log(
        'dumpLoc rootProbe comps=' +
          comps.length +
          ' names=' +
          comps
            .slice(0, 8)
            .map(function (c) {
              return c.name + '+0x' + c.off.toString(16);
            })
            .join(',')
      );
      return null;
    }
    // Preferir mag XY grande (mundo NewCity) e Z tipico de chao/camera
    hits.sort(function (a, b) {
      const aZok = Math.abs(a.z) > 20 && Math.abs(a.z) < 50000 ? 1 : 0;
      const bZok = Math.abs(b.z) > 20 && Math.abs(b.z) < 50000 ? 1 : 0;
      if (bZok !== aZok) return bZok - aZok;
      return b.mag - a.mag;
    });
    log(
      'dumpLoc rootProbe top=' +
        hits[0].loc.join(',') +
        ' via=' +
        hits[0].meta +
        ' candidates=' +
        hits.length
    );
    return {
      loc: hits[0].loc,
      root: hits[0].meta,
      rootOff: 0,
      vecOff: 0,
    };
  }

  // Le loc: K2_GetActorLocation (double/float) + fallback RootComponent
  function readActorLoc(actor) {
    if (!actor) return null;
    // 1) UFunction no proprio actor (nao reusar found de outra classe)
    if (processEventFn) {
      const fn = findUFn(actor, /^K2_GetActorLocation$/);
      if (fn) {
        found.K2_GetActorLocation = { fn: fn, obj: actor };
        const buf = Memory.alloc(64);
        for (let i = 0; i < 64; i++) buf.add(i).writeU8(0);
        try {
          processEventFn(actor, fn, buf);
          let x = buf.readDouble();
          let y = buf.add(8).readDouble();
          let z = buf.add(16).readDouble();
          if (locLooksOk(x, y, z)) return { loc: [x, y, z], via: 'K2_double' };
          // fallback float32
          x = buf.readFloat();
          y = buf.add(4).readFloat();
          z = buf.add(8).readFloat();
          if (locLooksOk(x, y, z)) return { loc: [x, y, z], via: 'K2_float' };
        } catch (e) {}
      }
    }
    const root = readRootComponentLoc(actor);
    if (root) return { loc: root.loc, via: 'Root@+0x' + root.rootOff.toString(16) + '/+0x' + root.vecOff.toString(16) + '/' + root.root };
    return null;
  }

  function dumpLiveLocations(reason) {
    if (survPawnObj) harvestFuncsFromObject(survPawnObj);
    if (survPcObj) harvestFuncsFromObject(survPcObj);
    const pawnHit = readActorLoc(survPawnObj);
    const pawnLoc = pawnHit ? pawnHit.loc : null;
    log(
      'dumpLoc pawn=' +
        (survPawnObj ? objectName(survPawnObj) : 'null') +
        ' loc=' +
        (pawnLoc ? pawnLoc.join(',') : 'null') +
        (pawnHit ? ' via=' + pawnHit.via : ' via=fail') +
        ' (' +
        reason +
        ') spawnsSeen=' +
        Object.keys(spawnActorsSeen).length
    );
    const keys = Object.keys(spawnActorsSeen);
    const safe = [];
    const spawnRows = [];
    for (let i = 0; i < keys.length; i++) {
      const s = spawnActorsSeen[keys[i]];
      const hit = readActorLoc(s.obj);
      const loc = hit ? hit.loc : null;
      log(
        'dumpLoc SPAWN ' +
          s.name +
          ' â†’ ' +
          (loc ? loc.join(',') : 'null') +
          (hit ? ' via=' + hit.via : ' via=fail')
      );
      spawnRows.push({ name: s.name, loc: loc, via: hit ? hit.via : null });
      // PlayerStart relativo muitas vezes Y=0 â€” so aceitar se XY parece cidade
      if (
        loc &&
        loc[0] > 50000 &&
        loc[0] < 300000 &&
        loc[1] < -50000 &&
        loc[1] > -400000
      ) {
        const gz =
          loc[2] < CITY_Z_MAX && loc[2] > CITY_Z_MIN
            ? loc[2] + 200
            : CITY_GROUND_Z;
        safe.push([loc[0], loc[1], gz]);
      }
    }
    // Ancoras do mundo (ZombieSpawner) â€” estes ESTÃƒO no mapa jogavel
    const anchorKeys = Object.keys(mapAnchorActors);
    const anchors = [];
    for (let i = 0; i < anchorKeys.length; i++) {
      const a = mapAnchorActors[anchorKeys[i]];
      const hit = readActorLoc(a.obj);
      const loc = hit ? hit.loc : null;
      if (!loc) continue;
      log(
        'dumpLoc ANCHOR ' +
          a.name +
          ' â†’ ' +
          loc.join(',') +
          (hit ? ' via=' + hit.via : '')
      );
      anchors.push({ name: a.name, loc: loc, via: hit ? hit.via : null });
      // Cidade real (Buildings): X 50k..300k, Y -400k..-50k
      // Chao live ~Z=-75475 (spawner). Nao usar Z=3000 (= ceu, queda longa).
      const cityXY =
        loc[0] > 50000 &&
        loc[0] < 300000 &&
        loc[1] < -50000 &&
        loc[1] > -400000;
      if (cityXY) {
        const gz =
          loc[2] < -65000 && loc[2] > -90000
            ? loc[2] + 200
            : CITY_GROUND_Z;
        safe.push([loc[0], loc[1], gz]);
      }
    }
    if (safe.length) {
      rescueVoidZ._mapSpawns = safe;
      log('dumpLoc SAFE from map n=' + safe.length + ' first=' + safe[0].join(','));
    } else if (pawnLoc) {
      log(
        'dumpLoc SEM safe spawn â€” pawn em ' +
          pawnLoc.join(',') +
          ' (spawn default do jogo / ChoosePlayerStart)'
      );
    }
    try {
      send({
        tdb: 'dumpLocJSON',
        reason: reason,
        pawn: survPawnObj ? objectName(survPawnObj) : null,
        pawnLoc: pawnLoc,
        pawnVia: pawnHit ? pawnHit.via : null,
        spawns: spawnRows,
        anchors: anchors,
        safe: safe,
      });
    } catch (eJ) {}
    return { pawnLoc: pawnLoc, spawnCount: keys.length, anchors: anchors.length, safe: safe };
  }

  // Z dinamico: drop from sky no XY â†’ esperar colisao/gravidade â†’ Z estavel.
  // FORCE: NUNCA usar Z de ZombieSpawner (~-75k = sob a mesh). Runs bons ~-69700.
  // -68200 = ~1500uu acima do chao tipico â€” margem se colisao atrasar (antes -69000 caia no void).
  const FORCE_LAND_Z = -68200;
  const UNDER_MESH_Z = -72000; // abaixo = sob a mesh / caindo no void
  const PLAYABLE_Z_LO = -71500;
  const PLAYABLE_Z_HI = -67000;
  let postLandLifts = 0;
  // EXPERIMENTO C (diagnostico): FORCE pos-land DESLIGADO â€” so observar.
  // Sucesso/aborto: log DIAG_Z decide H1 (sem chao) / H3 (LANDED precoce) / H4 (pawn!=PC).
  const POST_LAND_LIFT_MAX = 60;
  const POST_LAND_WATCHDOG = false;
  const POST_LAND_INTERVAL_MS = 4000;
  const POST_LAND_DEEP_Z = -73000;
  const DIAG_Z_MODE = true;
  let diagZLast = null; // {t,x,y,z} ultima amostra logada (velocidade entre amostras)
  let diagZStartAt = 0;
  function diagZReset() {
    diagZLast = null;
    diagZStartAt = 0;
  }
  function readPcLocDiag() {
    if (!survPcObj || !processEventFn) return null;
    const getHit = found.K2_GetActorLocation;
    if (!getHit) return null;
    try {
      const buf = Memory.alloc(64);
      for (let i = 0; i < 64; i++) buf.add(i).writeU8(0);
      processEventFn(survPcObj, getHit.fn, buf);
      const x = buf.readDouble();
      const y = buf.add(8).readDouble();
      const z = buf.add(16).readDouble();
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
      if (Math.abs(z) > 5e6) return null;
      return { x: x, y: y, z: z };
    } catch (e) {
      return null;
    }
  }
  // Amostra 0.8s: pawn (K2) vs PC (mesma UFunction no controller) + vZ/dXY.
  function diagZTick() {
    if (!DIAG_Z_MODE) return;
    if (phase < PH.GROUND || !survPawnObj) return;
    const now = Date.now();
    if (diagZLast && now - diagZLast.t < 800) return;
    const p = readPawnZQuick();
    if (!p || !isFinite(p.z) || p.z === -999999) return;
    const pc = readPcLocDiag();
    let vz = 0;
    let dxy = 0;
    if (diagZLast) {
      const dt = (now - diagZLast.t) / 1000;
      if (dt > 0) {
        vz = (p.z - diagZLast.z) / dt;
        dxy = Math.hypot(p.x - diagZLast.x, p.y - diagZLast.y);
      }
    }
    if (!diagZStartAt) {
      diagZStartAt = now;
      log('DIAG_Z inicio (C: sem FORCE pos-land; watchdog=' + POST_LAND_WATCHDOG + ')');
    }
    log(
      'DIAG_Z +' +
        ((now - diagZStartAt) / 1000).toFixed(1) +
        's phase=' +
        phase +
        ' drop=' +
        dropState +
        ' pawn=' +
        Math.round(p.x) +
        ',' +
        Math.round(p.y) +
        ',' +
        Math.round(p.z) +
        ' pc=' +
        (pc
          ? Math.round(pc.x) + ',' + Math.round(pc.y) + ',' + Math.round(pc.z)
          : '?') +
        ' vZ=' +
        Math.round(vz) +
        '/s dXY=' +
        Math.round(dxy)
    );
    diagZLast = { t: now, x: p.x, y: p.y, z: p.z };
  }
  function forceLandedRescue(setHit, why) {
    const tx = dropTx || CITY_SAFE_XY[0];
    const ty = dropTy || CITY_SAFE_XY[1];
    let gz = FORCE_LAND_Z;
    try {
      const h = nearestAnchorHint(tx, ty);
      // so aceitar ancoras no band de chao jogavel (nao pivot enterrado)
      if (
        h &&
        isFinite(h[2]) &&
        h[2] > -73000 &&
        h[2] < -65000
      ) {
        gz = h[2] + 180;
      }
    } catch (e) {}
    if (!(gz > UNDER_MESH_Z && gz < -65000)) gz = FORCE_LAND_Z;
    try {
      clientSetLocXYZ(setHit, tx, ty, gz);
    } catch (e2) {}
    dropState = 2;
    dropFromZ = gz;
    groundOkSince = Date.now();
    lastSoftLiftAt = Date.now();
    groundZSamples = [];
    pendingRescueZ = false;
    log(
      'rescueVoidZ FORCE LANDED Z=' +
        Math.round(gz) +
        ' XY=' +
        Math.round(tx) +
        ',' +
        Math.round(ty) +
        ' (' +
        why +
        ')'
    );
    return false;
  }
  function zInPlayableBand(z) {
    return isFinite(z) && z > PLAYABLE_Z_LO && z < PLAYABLE_Z_HI;
  }

  function rescueVoidZ(reason) {
    try {
      if (!survPcObj) resolveSurvPcFromPawn();
      if (survPcObj) harvestFuncsFromObject(survPcObj);
      if (survPawnObj) harvestFuncsFromObject(survPawnObj);
      let getHit = found.K2_GetActorLocation;
      if (!getHit && survPawnObj) {
        const fnD = findUFnDet(survPawnObj, 'K2_GetActorLocation');
        if (fnD) {
          getHit = { fn: fnD, obj: survPawnObj };
          found.K2_GetActorLocation = getHit;
        }
      }
      let setHit = found.ClientSetLocation;
      if (!setHit && survPcObj) {
        const fn = findUFn(survPcObj, /^ClientSetLocation$/);
        if (fn) {
          setHit = { fn: fn, obj: survPcObj };
          found.ClientSetLocation = setHit;
          log('rescueVoidZ found ClientSetLocation via scan');
        }
      }
      if (!getHit && survPawnObj) {
        const fn = findUFn(survPawnObj, /^K2_GetActorLocation$/);
        if (fn) {
          getHit = { fn: fn, obj: survPawnObj };
          found.K2_GetActorLocation = getHit;
        }
      }
      if (!processEventFn || !survPcObj || !setHit) {
        log(
          'rescueVoidZ SKIP sem ClientSetLocation (' +
            reason +
            ') pc=' +
            !!survPcObj +
            ' set=' +
            !!setHit
        );
        if (phase >= PH.GROUND) pendingRescueZ = true;
        return false;
      }
      if (softLiftZAttempts >= SOFT_LIFT_Z_MAX) {
        log('rescueVoidZ STOP max soft');
        return false;
      }
      if (!collisionStreamReady()) {
        log(
          'rescueVoidZ DEFER L=' +
            landscapeShown +
            ' WP=' +
            wpShownCount +
            '/' +
            WP_COLLISION_BYPASS +
            ' (' +
            reason +
            ')'
        );
        if (phase >= PH.GROUND) pendingRescueZ = true;
        return false;
      }

      let x = 0;
      let y = 0;
      let z = -999999;
      let locSrc = 'sem-getHit'; // R1: diagnosticar qual leitura falhou
      if (getHit && survPawnObj) {
        const buf = Memory.alloc(64);
        for (let i = 0; i < 64; i++) buf.add(i).writeU8(0);
        try {
          processEventFn(survPawnObj, getHit.fn, buf);
          x = buf.readDouble();
          y = buf.add(8).readDouble();
          z = buf.add(16).readDouble();
          locSrc =
            z === -999999 || (Math.abs(x) < 1 && Math.abs(y) < 1)
              ? 'PE-zeros'
              : 'PE';
        } catch (e) {
          locSrc = 'PE-throw';
          log('rescueVoidZ getLoc fail: ' + e);
        }
      }
      // Fallback se PE K2_Get falhar (causava 0,0,-999999 â†’ re-DROP freeze)
      if (
        (!isFinite(z) || z === -999999 || (Math.abs(x) < 1 && Math.abs(y) < 1)) &&
        survPawnObj
      ) {
        const q = readPawnZQuick();
        if (q) {
          x = q.x;
          y = q.y;
          z = q.z;
          locSrc += '+FB-ok';
        } else {
          locSrc += '+FB-null';
        }
      }
      if (Date.now() - lastRescueLogAt > 2000) {
        lastRescueLogAt = Date.now();
        log(
          'rescueVoidZ loc before=' +
            Math.round(x) +
            ',' +
            Math.round(y) +
            ',' +
            Math.round(z) +
            ' dropState=' +
            dropState +
            ' skyRetry=' +
            dropSkyRetries +
            ' src=' +
            locSrc +
            ' (' +
            reason +
            ')'
        );
      }

      const bogusLoc =
        !isFinite(x) ||
        !isFinite(y) ||
        !isFinite(z) ||
        (Math.abs(x) < 1 && Math.abs(y) < 1);
      const outsideCity =
        bogusLoc ||
        (isFinite(x) &&
        isFinite(y) &&
          (x < 0 || x > 294400 || y < -345600 || y > 12800));
      const inCityXY =
        !bogusLoc &&
        isFinite(x) &&
        isFinite(y) &&
        x > 50000 &&
        x < 300000 &&
        y < -50000 &&
        y > -400000;

      // Loc invalida (getLoc falhou) â€” NUNCA tratar como void (isso re-DROP em loop = freeze)
      const locBad =
        bogusLoc ||
        !isFinite(z) ||
        z === -999999 ||
        Math.abs(z) > 5e6;

      // --- Fase 1 do drop: observa queda REAL â€” NUNCA "LANDED grace" sem Z valido
      if (dropState === 1) {
        const elapsedDrop = Date.now() - dropAt;
        if (locBad) {
          // Tentar de novo ler loc (root / K2) sem marcar chao
          const q2 = readPawnZQuick();
          if (q2 && isFinite(q2.z) && !(Math.abs(q2.x) < 1 && Math.abs(q2.y) < 1)) {
            x = q2.x;
            y = q2.y;
            z = q2.z;
          } else if (survPawnObj) {
            try {
              const hit = readActorLoc(survPawnObj);
              if (hit && hit.loc && isFinite(hit.loc[2])) {
                x = hit.loc[0];
                y = hit.loc[1];
                z = hit.loc[2];
              }
            } catch (eR) {}
          }
          const stillBad =
            !isFinite(z) ||
            z === -999999 ||
            Math.abs(z) > 5e6 ||
            (Math.abs(x) < 1 && Math.abs(y) < 1);
          if (stillBad) {
            // Esperar getLoc â€” NAO teletransportar (reseta fisica). FORCE so apos 12s.
            if (elapsedDrop > 12000) {
              return forceLandedRescue(
                setHit,
                'getLoc bad ' + Math.round(elapsedDrop) + 'ms'
              );
            }
        return false;
      }
          // loc recuperada â€” continua fluxo normal abaixo
        }
        // OPCAO A: pouso por ESTABILIDADE em qualquer Z (cidade multinivel:
        // -75401 e chao valido â€” faixa absoluta causava o loop de pin).
        const fell = dropFromZ - z;
        groundZSamples.push(z);
        if (groundZSamples.length > 6) groundZSamples.shift();
        let zSpan = 9999;
        if (groundZSamples.length >= 3) {
          let mn = groundZSamples[0];
          let mx = groundZSamples[0];
          for (let i = 1; i < groundZSamples.length; i++) {
            if (groundZSamples[i] < mn) mn = groundZSamples[i];
            if (groundZSamples[i] > mx) mx = groundZSamples[i];
          }
          zSpan = mx - mn;
        }
        const settled =
          elapsedDrop >= DROP_SETTLE_MS &&
          fell >= DROP_MIN_FALL &&
          zSpan <= GROUND_Z_EPS;
        if (settled) {
          dropState = 2;
          lastSoftLiftAt = Date.now();
          groundOkSince = Date.now();
          log(
            'rescueVoidZ LANDED Z=' +
              Math.round(z) +
              ' fell=' +
              Math.round(fell) +
              ' span=' +
              Math.round(zSpan) +
              ' XY=' +
              Math.round(x) +
              ',' +
              Math.round(y) +
              ' (dinamico estavel)'
          );
          return false;
        }
        // Void real: abaixo do minimo E ainda em queda (nao estavel) â€” so aqui FORCE.
        if (z < CITY_Z_MIN) {
          return forceLandedRescue(setHit, 'void em queda Z=' + Math.round(z));
        }
        // Sem re-DROP higher: ClientSetLocation cancela a queda.
        // Se apos 12s nao caiu = fisica/colisao falhou â†’ FORCE.
        if (elapsedDrop >= 12000 && fell < DROP_MIN_FALL) {
          return forceLandedRescue(setHit, 'dinamico timeout sem queda');
        }
        return false;
      }

      // Pos-land pin lento: so void profundo. Intervalo longo = jogavel sem spam.
      if (dropState === 2) {
        if (!POST_LAND_WATCHDOG) return false;
        if (postLandLifts >= POST_LAND_LIFT_MAX) return false;
        if (Date.now() - lastSoftLiftAt < POST_LAND_INTERVAL_MS) return false;
        if (
          locBad ||
          !isFinite(z) ||
          z === -999999 ||
          Math.abs(z) > 5e6
        ) {
          return false;
        }
        if (z < POST_LAND_DEEP_Z || z > CITY_Z_MAX) {
          postLandLifts++;
          lastSoftLiftAt = Date.now();
          return forceLandedRescue(
            setHit,
            'z-pin#' + postLandLifts + ' Z=' + Math.round(z)
          );
        }
        return false;
      }

      // --- Fase 0: UM drop from sky (nunca spam) ---
      let tx;
      let ty;
      let how;
      if (dropTx && dropTy) {
        tx = dropTx;
        ty = dropTy;
        how = 'DROP_RETRY_XY';
      } else if (inCityXY && !outsideCity && !locBad) {
        tx = x;
        ty = y;
        how = 'DROP_KEEP_XY';
      } else {
        const hint = nearestAnchorHint(
          !locBad && isFinite(x) ? x : CITY_SAFE_XY[0],
          !locBad && isFinite(y) ? y : CITY_SAFE_XY[1]
        );
        if (hint) {
          tx = hint[0];
          ty = hint[1];
          how = 'DROP_NEAR_ANCHOR';
        } else {
        tx = CITY_SAFE_XY[0];
        ty = CITY_SAFE_XY[1];
          how = 'DROP_PATIO_XY';
        }
      }

      let tz = DROP_START_Z;
      const hint2 = nearestAnchorHint(tx, ty);
      // So ancoras no band jogavel; +800uu (nao +2500 = catapulta)
      if (
        hint2 &&
        isFinite(hint2[2]) &&
        hint2[2] > -73000 &&
        hint2[2] < -65000
      ) {
        tz = hint2[2] + 800;
      }
      if (!(tz > -70000 && tz < -67000)) tz = DROP_START_Z;

      groundZSamples = [];
      groundOkSince = 0;
      dropTx = tx;
      dropTy = ty;
      dropFromZ = tz;
      dropAt = Date.now();
      dropState = 1;
      dropSkyRetries = 0;
      lastSoftLiftAt = Date.now();
      softLiftZAttempts++;

      clientSetLocXYZ(setHit, tx, ty, tz);
      log(
        'rescueVoidZ DROP â†’ ' +
          Math.round(tx) +
          ',' +
          Math.round(ty) +
          ',' +
          Math.round(tz) +
          ' (' +
          reason +
          '/' +
          how +
          ') was ' +
          Math.round(x) +
          ',' +
          Math.round(y) +
          ',' +
          Math.round(z)
      );
      return true;
    } catch (e) {
      log('rescueVoidZ throw: ' + e);
      return false;
    }
  }

  function peBoolSafe(obj, name, v) {
    if (!obj || !processEventFn) return false;
    // U1: resolver deterministicamente na hierarquia do proprio alvo.
    // (found[] global chamava funcoes de OUTRA classe no alvo = AV intermitente)
    const fn = findUFnDet(obj, name);
    if (!fn) return false;
    const buf = Memory.alloc(16);
    for (let i = 0; i < 16; i++) buf.add(i).writeU8(0);
    buf.writeU8(v ? 1 : 0);
    try {
      processEventFn(obj, fn, buf);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Bool PE no objeto certo â€” U1: nome literal da regex ancorada +
  // resolucao deterministica (findUFnDet) na hierarquia do alvo.
  function peBoolOn(obj, nameRe, v) {
    if (!obj || !processEventFn) return false;
    const m = /^\^([A-Za-z0-9_]+)\$$/.exec(nameRe.source || '');
    if (!m) return false;
    const fn = findUFnDet(obj, m[1]);
    if (!fn) return false;
    const buf = Memory.alloc(16);
    for (let i = 0; i < 16; i++) buf.add(i).writeU8(0);
    buf.writeU8(v ? 1 : 0);
    try {
      processEventFn(obj, fn, buf);
      return true;
    } catch (e) {
      return false;
    }
  }

  function pe0On(obj, nameRe) {
    if (!obj || !processEventFn) return false;
    const fn = findUFn(obj, nameRe);
    if (!fn) return false;
    try {
      processEventFn(obj, fn, ptr(0));
      return true;
    } catch (e) {
      try {
        const buf = Memory.alloc(16);
        buf.writeU8(1);
        processEventFn(obj, fn, buf);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function setMeshOnComp(comp, meshAsset, setMeshFn) {
    if (!comp || !meshAsset || !setMeshFn) return false;
        const buf = Memory.alloc(32);
    for (let bi = 0; bi < 32; bi++) buf.add(bi).writeU8(0);
    buf.writePointer(meshAsset);
    buf.add(8).writeU8(1);
        try {
      processEventFn(comp, setMeshFn, buf);
          return true;
        } catch (e) {
          return false;
        }
      }

// Yaw do PlayerController (camera look) â€” movimento deve seguir isto
function getControlYawDeg() {
    const r = readControlRotationPE();
    return r ? r.yaw : null;
  }

  // EXPERIMENTO A (look): rotacao AUTORITATIVA via GetControlRotation PE (doubles).
  let ctrlRotFnCache = null;
  let ctrlRotDblOff = -1; // offset double Pitch@off Yaw@off+8 Roll@off+16 no SurvPC
  let ctrlRotLastCalibAt = 0;
  function readControlRotationPE() {
    if (!survPcObj || !processEventFn) return null;
    if (!ctrlRotFnCache) {
      ctrlRotFnCache = findUFn(survPcObj, /^GetControlRotation$/i);
      if (!ctrlRotFnCache) return null;
    }
    const buf = Memory.alloc(64);
    for (let i = 0; i < 64; i++) buf.add(i).writeU8(0);
    try {
      processEventFn(survPcObj, ctrlRotFnCache, buf);
      const pitch = buf.readDouble();
      const yaw = buf.add(8).readDouble();
      const roll = buf.add(16).readDouble();
      if (!isFinite(pitch) || !isFinite(yaw) || !isFinite(roll)) return null;
      if (Math.abs(pitch) > 1e5 || Math.abs(yaw) > 1e5) return null;
      return { pitch: pitch, yaw: yaw, roll: roll };
    } catch (e) {
      return null;
    }
  }
  // Procura na memoria do PC o trio double == rotacao PE atual â†’ offset verdadeiro.
  function calibrateCtrlRotOff() {
    if (!survPcObj) return -1;
    const now = Date.now();
    if (ctrlRotDblOff >= 0 && now - ctrlRotLastCalibAt < 1500)
      return ctrlRotDblOff;
    ctrlRotLastCalibAt = now;
    const pe = readControlRotationPE();
    if (!pe) return ctrlRotDblOff;
    for (let off = 0x80; off < 0x800; off += 8) {
      try {
        const p = survPcObj.add(off).readDouble();
        const y = survPcObj.add(off + 8).readDouble();
        const r = survPcObj.add(off + 16).readDouble();
        if (
          Math.abs(p - pe.pitch) < 0.05 &&
          Math.abs(y - pe.yaw) < 0.05 &&
          Math.abs(r - pe.roll) < 0.05
        ) {
          if (ctrlRotDblOff !== off) {
            log(
              'lookCalib off=0x' +
                off.toString(16) +
                ' PE=' +
                Math.round(pe.pitch) +
                ',' +
                Math.round(pe.yaw) +
                ',' +
                Math.round(pe.roll) +
                ' (trio double ==)'
            );
          }
          ctrlRotDblOff = off;
          return off;
        }
      } catch (e) {}
    }
    if (ctrlRotDblOff < 0) log('lookCalib FALHOU trio nao encontrado (PE yaw=' + Math.round(pe.yaw) + ')');
    return ctrlRotDblOff;
  }
  function readCtrlYawMemDbl() {
    if (ctrlRotDblOff < 0 || !survPcObj) return null;
    try {
      const y = survPcObj.add(ctrlRotDblOff + 8).readDouble();
      return isFinite(y) && Math.abs(y) < 1e5 ? y : null;
    } catch (e) {
      return null;
    }
  }

  function getPawnFwdRight() {
    const out = { fwd: null, right: null };
    if (!survPawnObj || !processEventFn) return out;
    function readVec(nameRe) {
      const fn = findUFn(survPawnObj, nameRe);
      if (!fn) return null;
      const buf = Memory.alloc(64);
      for (let i = 0; i < 64; i++) buf.add(i).writeU8(0);
      try {
        processEventFn(survPawnObj, fn, buf);
        const x = buf.readDouble();
        const y = buf.add(8).readDouble();
        const z = buf.add(16).readDouble();
        if (!isFinite(x) || !isFinite(y)) return null;
        return [x, y, isFinite(z) ? z : 0];
      } catch (e) {
        return null;
      }
    }
    out.fwd = readVec(/^GetActorForwardVector$/i);
    out.right = readVec(/^GetActorRightVector$/i);
    return out;
  }

  function yawToFwdRight(yawDeg) {
    const rad = (yawDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return {
      fwd: [c, s, 0],
      right: [-s, c, 0],
    };
  }

  // Resolve offset de ControlRotation no SurvPC (mesmo scan do camYaw mem).
  function ensurePcControlRotOff() {
    if (pcControlRotOff >= 0 && survPcObj) return pcControlRotOff;
    if (!survPcObj) return -1;
    if (
      camYawCache &&
      camYawCache.kind === 'pc' &&
      typeof camYawCache.rotOff === 'number' &&
      camYawCache.rotOff >= 0
    ) {
      pcControlRotOff = camYawCache.rotOff;
      return pcControlRotOff;
    }
    let bestOff = -1;
    let bestScore = -1;
    for (let off = 0x280; off < 0x520; off += 4) {
      try {
        const pitch = survPcObj.add(off).readFloat();
        const yaw = survPcObj.add(off + 4).readFloat();
        const roll = survPcObj.add(off + 8).readFloat();
        let sc = scoreRotator(pitch, yaw, roll);
        if (sc >= 0) sc += 20;
        if (sc > bestScore) {
          bestScore = sc;
          bestOff = off;
        }
      } catch (e) {}
    }
    if (bestOff >= 0) {
      pcControlRotOff = bestOff;
      camYawCache = {
        kind: 'pc',
        rotOff: bestOff,
        name: 'SurvPC',
        lastYaw: survPcObj.add(bestOff + 4).readFloat(),
        stableHits: 0,
      };
      log('lookMem ControlRotation off=0x' + bestOff.toString(16) + ' sc=' + bestScore);
    }
    return pcControlRotOff;
  }

  function seedLookFromMem() {
    if (lookRotSeeded) return;
    lookRotSeeded = true;
    // Seed autoritativo (PE) â€” nao do slot float provavel.
    const pe = readControlRotationPE();
    if (pe) {
      if (isFinite(pe.yaw) && Math.abs(pe.yaw) < 1e5) lookYawAccum = pe.yaw;
      if (isFinite(pe.pitch) && Math.abs(pe.pitch) < 90.5)
        lookPitchAccum = pe.pitch;
      calibrateCtrlRotOff();
      return;
    }
    const off = ensurePcControlRotOff();
    if (off < 0 || !survPcObj) return;
    try {
      const pitch = survPcObj.add(off).readFloat();
      const yaw = survPcObj.add(off + 4).readFloat();
      if (isFinite(yaw) && Math.abs(yaw) < 1e5) lookYawAccum = yaw;
      if (isFinite(pitch) && Math.abs(pitch) < 90.5) lookPitchAccum = pitch;
    } catch (e) {}
  }

  // Escreve ControlRotation â€” A: double no offset calibrado pelo trio PE.
  // Fallback float (legado) so se a calibracao falhar. Sem AddController* PE.
  function writeControlRotationMem(pitch, yaw) {
    if (!LOOK_MEM_WRITE || !survPcObj) return false;
    let p = pitch;
    let y = yaw;
    if (!isFinite(p)) p = 0;
    if (!isFinite(y)) y = 0;
    if (p > 89) p = 89;
    if (p < -89) p = -89;
    while (y > 180) y -= 360;
    while (y < -180) y += 360;
    const doff = calibrateCtrlRotOff();
    if (doff >= 0) {
      try {
        survPcObj.add(doff).writeDouble(p);
        survPcObj.add(doff + 8).writeDouble(y);
        lookMemWriteOk++;
          return true;
        } catch (e) {
        lookMemWriteFail++;
          return false;
        }
      }
    const off = ensurePcControlRotOff();
    if (off < 0) {
      lookMemWriteFail++;
      return false;
    }
    try {
      const roll = survPcObj.add(off + 8).readFloat();
      survPcObj.add(off).writeFloat(p);
      survPcObj.add(off + 4).writeFloat(y);
      if (!(isFinite(roll) && Math.abs(roll) < 45)) {
        survPcObj.add(off + 8).writeFloat(0);
      }
      if (camYawCache && camYawCache.kind === 'pc') {
        camYawCache.lastYaw = y;
        camYawCache.stableHits = 0;
      }
      lookMemWriteOk++;
          return true;
        } catch (e) {
      lookMemWriteFail++;
          return false;
        }
      }

  // Acumula yaw/pitch + write ControlRotation (camera). Sem AddController* PE.
  function applyLookBridgeAxis(which, axisPtr) {
    let axis = axisPtr.readFloat();
    if (!isFinite(axis) || Math.abs(axis) < 0.0005) axis = axisPtr.readDouble();
    if (!isFinite(axis) || Math.abs(axis) < 0.0005) return;
    seedLookFromMem();
    const sens = 2.5;
    if (which === 'yaw') {
      lookYawAccum += axis * sens;
      while (lookYawAccum > 180) lookYawAccum -= 360;
      while (lookYawAccum < -180) lookYawAccum += 360;
    } else if (which === 'pitch') {
      // Sinal invertido (provado em run): eixo LookUp do BP e oposto ao
      // ControlRotation â€” mouse p/ baixo somava pitch "para cima".
      lookPitchAccum -= axis * sens;
      if (lookPitchAccum > 89) lookPitchAccum = 89;
      if (lookPitchAccum < -89) lookPitchAccum = -89;
    }
    const wrote = writeControlRotationMem(lookPitchAccum, lookYawAccum);
    lookBridgeCount++;
    if (lookBridgeCount === 1 || lookBridgeCount % 300 === 0) {
      let peYaw = '?';
      try {
        const pe = readControlRotationPE();
        if (pe) peYaw = String(Math.round(pe.yaw));
      } catch (ePe) {}
      log(
        'lookBridge n=' +
          lookBridgeCount +
          ' ' +
          which +
          ' yawAcc=' +
          Math.round(lookYawAccum) +
          ' pitchAcc=' +
          Math.round(lookPitchAccum) +
          ' memW=' +
          wrote +
          ' ok=' +
          lookMemWriteOk +
          ' dblOff=' +
          (ctrlRotDblOff >= 0 ? '0x' + ctrlRotDblOff.toString(16) : '?') +
          ' peYaw=' +
          peYaw +
          ' (noPE)'
      );
    }
  }

  function applyMoveBridgeAxis(which, axisPtr) {
    if (MOVE_BRIDGE_OFF) return;
    if (!survPawnObj || !processEventFn) return;
    if (!found.AddMovementInput) {
      const u = findUFn(survPawnObj, /^AddMovementInput$/i);
      if (u) found.AddMovementInput = { obj: survPawnObj, fn: u };
    }
    if (!found.AddMovementInput) return;
    let axis = axisPtr.readFloat();
    if (!isFinite(axis) || Math.abs(axis) < 0.01) axis = axisPtr.readDouble();
    if (!isFinite(axis) || Math.abs(axis) < 0.05) return;

    // Direcao = yaw do mouse. A: ler do slot double calibrado (= ControlRotation
    // real, deve == accum apos write); float legado so como fallback.
    // NAO deixar slot preso em 1 clobber do accum (era "anda reto").
    let yaw = lookYawAccum;
    const dblYaw = readCtrlYawMemDbl();
    const memYaw = dblYaw !== null ? dblYaw : readCameraYawMem();
    if (
      memYaw !== null &&
      isFinite(memYaw) &&
      Math.abs(memYaw - lookYawAccum) > 2 &&
      lookBridgeCount > 0
    ) {
      // So sincroniza se houve look real e a leitura e do slot calibrado/PE â€”
      // accum continua a fonte enquanto o write nao pegou.
      if (dblYaw !== null) {
        lookYawAccum = memYaw;
        yaw = memYaw;
      }
    }
    let dir;
    if (yaw !== null && isFinite(yaw)) {
      const d = yawToFwdRight(yaw);
      dir = which === 'fwd' ? d.fwd : d.right;
    } else {
      dir = which === 'fwd' ? [1, 0, 0] : [0, 1, 0];
    }

    const buf = Memory.alloc(64);
    for (let bi = 0; bi < 64; bi++) buf.add(bi).writeU8(0);
    buf.writeDouble(dir[0]);
    buf.add(8).writeDouble(dir[1]);
    buf.add(16).writeDouble(dir[2] || 0);
    buf.add(24).writeFloat(axis);
    buf.add(28).writeU8(0);
    processEventFn(survPawnObj, found.AddMovementInput.fn, buf);
    moveBridgeCount++;
    if (moveBridgeCount === 1 || moveBridgeCount % 200 === 0) {
      log(
        'moveBridge n=' +
          moveBridgeCount +
          ' ' +
          which +
          ' yaw=' +
          (yaw !== null ? Math.round(yaw) : 'world')
      );
    }
  }

  // Liga camera ao pawn â€” SO chamadas 0/1-arg seguras (Blend/Absolute/Ack = Fatal)
  function linkCameraToPawn() {
    const r = { view: false, useYaw: false, atpc: false, spring: false };
    if (!survPcObj || !survPawnObj || !processEventFn) return r;
    try {
      // Preferir SetViewTarget simples (WithBlend tem args â†’ AV)
      const vt = findUFn(survPcObj, /^SetViewTarget$/i);
      if (vt) {
        const buf = Memory.alloc(32);
        for (let i = 0; i < 32; i++) buf.add(i).writeU8(0);
        buf.writePointer(survPawnObj);
        processEventFn(survPcObj, vt, buf);
        r.view = true;
      }
    } catch (e) {
      log('linkCam SetViewTarget skip: ' + e);
    }
    try {
      r.useYaw = peBoolOn(survPawnObj, /^SetUseControllerRotationYaw$/i, true);
    } catch (e) {}
    for (let off = 0x200; off < 0xe00; off += 8) {
      try {
        const p = survPawnObj.add(off).readPointer();
        if (!p || p.isNull()) continue;
        const n = objectName(p);
        if (/ATPCCamera|ATPC_/i.test(n)) {
          // so UsePawnControlRotation bool â€” sem SetAbsolute / Switch* arriscados
          if (peBoolOn(p, /^SetUsePawnControlRotation$/i, true)) r.atpc = true;
        }
        if (/SpringArm|CameraBoom/i.test(n)) {
          if (peBoolOn(p, /^SetUsePawnControlRotation$/i, true)) r.spring = true;
        }
      } catch (e) {}
    }
    try {
      pe0On(survPcObj, /^SetInputModeGameOnly$/i);
      peBoolOn(survPcObj, /^SetShowMouseCursor$/i, false);
      peBoolOn(survPcObj, /^SetIgnoreLookInput$/i, false);
    } catch (e) {}
    return r;
  }

  // BODY: PE SetSkeletalMesh OFF (Fatal). Poke ptr de SkeletalMesh OFF â€”
  // DXGI_ERROR_DEVICE_HUNG (GPU) quando offset/comp errado. Hide FP so via peBoolOn.
  const APPLY_MESH_PE = false;
  const APPLY_MESH_MEM = false;
  // Offsets tipicos UE5 USkinnedMeshComponent::SkeletalMesh / SkinnedAsset (probe)
  const SKINNED_MESH_OFFS = [
    0x4e0, 0x4e8, 0x4f0, 0x500, 0x508, 0x510, 0x520, 0x528, 0x530, 0x540, 0x548,
    0x550, 0x560, 0x568, 0x570, 0x580, 0x588, 0x590, 0x5a0, 0x5b0, 0x5c0,
  ];
  // USceneComponent RelativeRotation / ComponentToWorld (probe yaw)
  const REL_ROT_OFFS = [
    0x128, 0x130, 0x138, 0x140, 0x148, 0x150, 0x158, 0x160, 0x168, 0x170, 0x180,
    0x188, 0x190, 0x1a0, 0x1b0, 0x1c0, 0x1d0, 0x1e0, 0x1f0, 0x200, 0x210,
  ];

  function looksLikeYaw(v) {
    return isFinite(v) && Math.abs(v) <= 720;
  }

  function quatToYawDeg(x, y, z, w) {
    // Z-up yaw from quat
    const siny = 2 * (w * z + x * y);
    const cosy = 1 - 2 * (y * y + z * z);
    return (Math.atan2(siny, cosy) * 180) / Math.PI;
  }

  function readYawFromComp(comp) {
    if (!comp || comp.isNull()) return null;
    // 1) FRotator float Pitch,Yaw,Roll
    for (let i = 0; i < REL_ROT_OFFS.length; i++) {
      const off = REL_ROT_OFFS[i];
      try {
        const pitch = comp.add(off).readFloat();
        const yaw = comp.add(off + 4).readFloat();
        const roll = comp.add(off + 8).readFloat();
        if (
          looksLikeYaw(yaw) &&
          looksLikeYaw(pitch) &&
          looksLikeYaw(roll) &&
          Math.abs(pitch) < 90.5
        ) {
          return yaw;
        }
      } catch (e) {}
      try {
        const pitch = comp.add(off).readDouble();
        const yaw = comp.add(off + 8).readDouble();
        const roll = comp.add(off + 16).readDouble();
        if (
          looksLikeYaw(yaw) &&
          looksLikeYaw(pitch) &&
          looksLikeYaw(roll) &&
          Math.abs(pitch) < 90.5
        ) {
          return yaw;
        }
      } catch (e2) {}
    }
    // 2) FTransform ComponentToWorld: FQuat (4 floats/doubles) + translation
    for (let i = 0; i < REL_ROT_OFFS.length; i++) {
      const off = REL_ROT_OFFS[i];
      try {
        const x = comp.add(off).readFloat();
        const y = comp.add(off + 4).readFloat();
        const z = comp.add(off + 8).readFloat();
        const w = comp.add(off + 12).readFloat();
        const n = x * x + y * y + z * z + w * w;
        if (n > 0.85 && n < 1.15) {
          const yaw = quatToYawDeg(x, y, z, w);
          if (looksLikeYaw(yaw)) return yaw;
        }
      } catch (e) {}
      try {
        const x = comp.add(off).readDouble();
        const y = comp.add(off + 8).readDouble();
        const z = comp.add(off + 16).readDouble();
        const w = comp.add(off + 24).readDouble();
        const n = x * x + y * y + z * z + w * w;
        if (n > 0.85 && n < 1.15) {
          const yaw = quatToYawDeg(x, y, z, w);
          if (looksLikeYaw(yaw)) return yaw;
        }
      } catch (e2) {}
    }
    return null;
  }

  // Cache do yaw: { kind:'comp'|'pc', ptr, rotOff, name, lastYaw, stableHits }
  let camYawCache = null;
  let camYawLastLog = 0;
  const meshAssetsSeen = {}; // name -> ptr (Basic_* vistos no PE)

  function scoreRotator(pitch, yaw, roll) {
    if (!looksLikeYaw(yaw) || !looksLikeYaw(pitch) || !looksLikeYaw(roll)) return -1;
    if (Math.abs(pitch) > 89.5 || Math.abs(roll) > 45) return -1;
    // Prefer rotators "vivos" (nao tudo ~0)
    let s = 10;
    if (Math.abs(yaw) > 0.5) s += 5;
    if (Math.abs(pitch) > 0.5) s += 3;
    if (Math.abs(roll) < 1) s += 2;
    return s;
  }

  function readCameraYawMem() {
    if (!survPawnObj) return null;

    // Fast path: cache hit â€” mas invalidar se yaw nunca muda (slot errado)
    if (camYawCache) {
      try {
        let yaw = null;
        if (camYawCache.kind === 'comp' && camYawCache.ptr) {
          yaw = camYawCache.ptr.add(camYawCache.rotOff + 4).readFloat();
        } else if (camYawCache.kind === 'pc' && survPcObj) {
          yaw = survPcObj.add(camYawCache.rotOff + 4).readFloat();
        }
        if (yaw !== null && looksLikeYaw(yaw)) {
          if (
            camYawCache.lastYaw !== undefined &&
            Math.abs(yaw - camYawCache.lastYaw) < 0.05
          ) {
            camYawCache.stableHits = (camYawCache.stableHits || 0) + 1;
            // apos muitos moves sem mudanca, re-probe (mouse look deveria alterar)
            if (camYawCache.stableHits > 40) {
              camYawCache = null;
            } else {
              return yaw;
            }
          } else {
            camYawCache.lastYaw = yaw;
            camYawCache.stableHits = 0;
            return yaw;
          }
        } else {
          camYawCache = null;
        }
      } catch (e) {
        camYawCache = null;
      }
    }

    let best = null;
    let bestScore = -1;
    let bestMeta = null;

    // Prefer SurvPC ControlRotation (segue o mouse) â€” ATPC RelativeRotation fica preso em ~3
    if (survPcObj) {
      for (let off = 0x280; off < 0x520; off += 4) {
        try {
          const pitch = survPcObj.add(off).readFloat();
          const yaw = survPcObj.add(off + 4).readFloat();
          const roll = survPcObj.add(off + 8).readFloat();
          let sc = scoreRotator(pitch, yaw, roll);
          if (sc >= 0) sc += 20; // PC sempre ganha de RelativeRotation da camera
          if (sc > bestScore) {
            bestScore = sc;
            best = yaw;
            bestMeta = { kind: 'pc', rotOff: off, name: 'SurvPC' };
          }
        } catch (e) {}
      }
    }

    // ATPC / Camera â€” so se PC nao achou (RelativeRotation costuma ser estatico)
    if (bestScore < 0) {
      for (let off = 0x200; off < 0xe00; off += 8) {
        try {
          const p = survPawnObj.add(off).readPointer();
          if (!p || p.isNull()) continue;
          const n = objectName(p);
          if (!/ATPCCamera|SurvivalATPC|CameraComponent|^Camera$/i.test(n))
            continue;
          if (/Shake|Modifier|Manager|Listener/i.test(n)) continue;
          for (let ri = 0; ri < REL_ROT_OFFS.length; ri++) {
            const ro = REL_ROT_OFFS[ri];
            try {
              const pitch = p.add(ro).readFloat();
              const yaw = p.add(ro + 4).readFloat();
              const roll = p.add(ro + 8).readFloat();
              const sc = scoreRotator(pitch, yaw, roll);
              if (sc > bestScore) {
                bestScore = sc;
                best = yaw;
                bestMeta = {
                  kind: 'comp',
                  ptr: p,
                  rotOff: ro,
                  name: n,
                };
              }
            } catch (eR) {}
          }
        } catch (e) {}
      }
    }

    if (bestMeta && best !== null) {
      camYawCache = bestMeta;
      camYawCache.lastYaw = best;
      camYawCache.stableHits = 0;
    }
    if (best !== null && moveBridgeCount - camYawLastLog > 80) {
      camYawLastLog = moveBridgeCount;
      log(
        'camYaw mem=' +
          Math.round(best) +
          ' src=' +
          (bestMeta && bestMeta.name ? bestMeta.name : '?') +
          ' sc=' +
          bestScore
      );
    }
    return best;
  }

  function pokeSkinnedMeshPtr(comp, meshPtr) {
    if (!comp || !meshPtr || meshPtr.isNull()) return 0;
    // 1) achar offset real do SkeletalMesh neste tipo (onde CharacterMesh0 ja aponta pro Basic)
    let slotOff = -1;
    for (let i = 0; i < SKINNED_MESH_OFFS.length; i++) {
      const off = SKINNED_MESH_OFFS[i];
      try {
        const cur = comp.add(off).readPointer();
        if (!cur || cur.isNull()) continue;
        if (cur.equals(meshPtr)) {
          slotOff = off;
          break;
        }
        const cn = objectName(cur);
        if (
          cn &&
          /Basic_Mesh|Basic_Body_V3|Basic_Head_V3|Basic_Legs_V3|SkeletalMesh/i.test(
            cn
          ) &&
          !/Component|Function|Class/i.test(cn)
        ) {
          slotOff = off;
          break;
        }
      } catch (e) {}
    }
    // 2) se nao achou asset, preferir slot NULL no range tipico
    if (slotOff < 0) {
      for (let i = 0; i < SKINNED_MESH_OFFS.length; i++) {
        const off = SKINNED_MESH_OFFS[i];
        try {
          const cur = comp.add(off).readPointer();
          if (cur.isNull()) {
            slotOff = off;
            break;
          }
        } catch (e) {}
      }
    }
    if (slotOff < 0) return 0;
    try {
      const before = comp.add(slotOff).readPointer();
      if (!before.isNull() && before.equals(meshPtr)) return 0;
      comp.add(slotOff).writePointer(meshPtr);
      return 1;
    } catch (e) {
      return 0;
    }
  }

  // bHiddenInGame / bVisible bitfield heuristico em USceneComponent (sem PE)
  function pokeHiddenInGame(comp, hidden) {
    if (!comp || comp.isNull()) return false;
    // Offsets comuns UE5: bHiddenInGame em packed bools perto de 0x150-0x1c0
    const offs = [0x148, 0x149, 0x14a, 0x14b, 0x150, 0x158, 0x160, 0x168, 0x170, 0x178, 0x180, 0x188, 0x190];
    let any = false;
    for (let i = 0; i < offs.length; i++) {
      try {
        const b = comp.add(offs[i]).readU8();
        // so tocar bytes que ja parecem flag 0/1
        if (b > 1) continue;
        const want = hidden ? 1 : 0;
        if (b !== want) {
          comp.add(offs[i]).writeU8(want);
          any = true;
        }
        } catch (e) {}
      }
    return any;
  }

  function findMeshAssetOnComp(comp) {
    if (!comp || comp.isNull()) return null;
    for (let mo = 0x400; mo < 0x780; mo += 8) {
      try {
        const mp = comp.add(mo).readPointer();
        if (!mp || mp.isNull()) continue;
        const mn = objectName(mp);
        if (
          mn &&
          /Basic_Mesh|Basic_Body_V3|Basic_Head_V3|Basic_Legs_V3|Female_Basic|SkeletalMesh/i.test(
            mn
          ) &&
          !/Component|Function|Class|Default__/i.test(mn)
        ) {
          return mp;
        }
      } catch (eM) {}
    }
    return null;
  }

  function applyBodyMeshes(reason) {
    if (!survPawnObj || !processEventFn) {
      log('applyBody SKIP sem pawn (' + reason + ')');
      return false;
    }
    log(
      'applyBody (' +
        reason +
        ') APPLY_MESH_PE=' +
        APPLY_MESH_PE +
        ' MEM=' +
        APPLY_MESH_MEM
    );
    try {
      harvestFuncsFromObject(survPawnObj);
      let mesh0 = null;
      let basicMesh = null;
      const fpComps = [];
      const woundComps = [];
      // Soft/hard mesh asset ptrs no proprio pawn + vistos no PE
      const seenNames = Object.keys(meshAssetsSeen);
      for (let si = 0; si < seenNames.length; si++) {
        const sn = seenNames[si];
        if (/Basic_Mesh/i.test(sn)) basicMesh = meshAssetsSeen[sn];
        else if (!basicMesh) basicMesh = meshAssetsSeen[sn];
      }
      for (let off = 0x200; off < 0x1400; off += 8) {
        try {
          const p = survPawnObj.add(off).readPointer();
          if (!p || p.isNull()) continue;
          const n = objectName(p);
          if (
            n &&
            /Basic_Mesh|Basic_Body_V3|Basic_Head_V3|Basic_Legs_V3|Female_Basic/i.test(n) &&
            !/Component|Function|Class/i.test(n)
          ) {
            if (!basicMesh || /Basic_Mesh/i.test(n)) basicMesh = p;
            meshAssetsSeen[n] = p;
          }
        } catch (eS) {}
      }
      for (let off = 0x180; off < 0xd00; off += 8) {
        let p;
        try {
          p = survPawnObj.add(off).readPointer();
        } catch (e) {
          continue;
        }
        if (!p || p.isNull()) continue;
        const n = objectName(p);
        if (!n || n === '?' || n.indexOf('idx:') === 0) continue;
        if (/FPMeshNew|FlashlightArm|WeaponLerp/i.test(n)) {
          fpComps.push(p);
            harvestFuncsFromObject(p);
          }
        if (/^CharacterMesh0$/i.test(n)) {
          mesh0 = p;
            harvestFuncsFromObject(p);
          const m = findMeshAssetOnComp(p);
          if (m) basicMesh = m;
        }
        if (/WoundComponent|ArmorSlot/i.test(n)) woundComps.push(p);
      }

      // BODY minimo: hide FP / show mesh0. Sem OwnerNoSee / LeaderPose (Fatal).
      // TESTE opcao 1 (GPS): FP mesh deixa de ser ocultado aqui. Reverter = APPLY_FP_HIDE=true.
      const APPLY_FP_HIDE = true;
      let fpHid = 0;
      for (let i = 0; APPLY_FP_HIDE && i < fpComps.length; i++) {
        if (peBoolOn(fpComps[i], /^SetHiddenInGame$/i, true)) fpHid++;
        peBoolOn(fpComps[i], /^SetVisibility$/i, false);
      }
      if (mesh0) {
        peBoolOn(mesh0, /^SetHiddenInGame$/i, false);
        peBoolOn(mesh0, /^SetVisibility$/i, true);
      }
      peBoolOn(survPawnObj, /^SetActorHiddenInGame$/i, false);

      let woundFilled = 0;
      let memPokes = 0;
      // APPLY_MESH_PE / APPLY_MESH_MEM permanecem OFF (Fatal / DEVICE_HUNG)

      bodyApplyDone = true;
      log(
        'applyBody done body=' +
          !!basicMesh +
          ' wounds=' +
          woundFilled +
          '/' +
          woundComps.length +
          ' memPoke=' +
          memPokes +
          ' mesh0=' +
          !!mesh0 +
          ' fpHid=' +
          fpHid +
          '/' +
          fpComps.length +
          ' meshPE=' +
          APPLY_MESH_PE +
          ' meshMEM=' +
          APPLY_MESH_MEM
      );
      return true;
    } catch (e) {
      log('applyBody throw: ' + e);
      bodyApplyDone = true;
      return false;
    }
  }

  // RELEASE ULTRA: HideLoading cache + bridges. Zero findUFn novo (Fatal).
  function releasePlayable(reason) {
    if (releaseDone) return true;
    log('releasePlayable (' + reason + ') ULTRA');
    try {
      if (survPcObj) {
        peBoolSafe(survPcObj, 'SetIgnoreMoveInput', false);
        peBoolSafe(survPcObj, 'SetIgnoreLookInput', false);
        peBoolSafe(survPcObj, 'SetShowMouseCursor', false);
      }
      let hide = false;
      if (!hideLoadingDone && found.HideLoadingScreenAfterLoadLevel) {
        try {
          const eng = getEngine();
          const gi = eng ? findGameInstance(eng) : null;
          processEventFn(
            gi || found.HideLoadingScreenAfterLoadLevel.obj,
            found.HideLoadingScreenAfterLoadLevel.fn,
            ptr(0)
          );
          hideLoadingDone = true;
          hide = true;
        } catch (eH) {}
      }
      moveBridgeOn = true;
      lookBridgeOn = true; // yawAccum + LOOK_MEM_WRITE ControlRotation (sem PE look)
      // Liga yaw do pawn/camera ao ControlRotation que vamos escrever (bool PE seguro)
      try {
        if (survPawnObj) {
          peBoolSafe(survPawnObj, 'SetUseControllerRotationYaw', true);
          peBoolSafe(survPawnObj, 'SetUseControllerRotationPitch', false);
        }
      } catch (eYaw) {}
      releaseDone = true;
      makePlayableDone = true;
      log(
        'release done ULTRA hide=' +
          hide +
          ' moveBr=' +
          moveBridgeOn +
          ' lookMem=' +
          LOOK_MEM_WRITE +
          ' addMove=' +
          !!found.AddMovementInput
      );
      return true;
    } catch (e) {
      log('release throw: ' + e);
      moveBridgeOn = true;
      lookBridgeOn = true;
      releaseDone = true;
      return false;
    }
  }

  // F6 manual: corpo depois release (ainda sem Possess)
  function makePlayable(reason) {
    if (!survPcObj || !survPawnObj || !processEventFn) {
      log('makePlayable SKIP sem pc/pawn (' + reason + ')');
      return false;
    }
    applyBodyMeshes(reason + '/body');
    return releasePlayable(reason + '/release');
  }

  function readPawnZQuick() {
    if (!survPawnObj || !processEventFn) return null;
    try {
      let getHit = found.K2_GetActorLocation;
      if (!getHit) {
        const fn = findUFnDet(survPawnObj, 'K2_GetActorLocation');
        if (fn) {
          getHit = { fn: fn, obj: survPawnObj };
          found.K2_GetActorLocation = getHit;
        }
      }
      if (!getHit) return null;
      const buf = Memory.alloc(64);
      for (let i = 0; i < 64; i++) buf.add(i).writeU8(0);
      processEventFn(survPawnObj, getHit.fn, buf);
      const x = buf.readDouble();
      const y = buf.add(8).readDouble();
      const z = buf.add(16).readDouble();
      if (!isFinite(z)) return null;
      return { x: x, y: y, z: z };
    } catch (e) {
      return null;
    }
  }

  function collisionStreamReady() {
    if (travelBusy) return false;
    if (wpShownCount < STREAM_WP_MIN) return false;
    // L trava em ~3 neste mapa; WP alto = stream de celulas ja ocorreu
    if (wpShownCount >= WP_COLLISION_BYPASS) return true;
    return landscapeShown >= GROUND_LANDSCAPE_MIN;
  }

  function streamSettledEnough(elapsed) {
    if (travelBusy) return false;
    if (elapsed < STREAM_SETTLE_MS) return false;
    if (wpShownCount < STREAM_WP_MIN) return false;
    if (wpShownCount >= WP_COLLISION_BYPASS) return true;
    return landscapeShown >= STREAM_LANDSCAPE_MIN;
  }

  function groundZIsStable(loc) {
    if (!loc || dropState < 2) {
      groundOkSince = 0;
      groundZSamples = [];
      return false;
    }
    // Ainda no ceu do drop = nao aterrizou
    if (loc.z > dropFromZ - DROP_MIN_FALL) {
      groundOkSince = 0;
      groundZSamples = [];
      return false;
    }
    if (loc.z < CITY_Z_MIN || loc.z > CITY_Z_MAX) {
      groundOkSince = 0;
      groundZSamples = [];
      return false;
    }
    groundZSamples.push(loc.z);
    if (groundZSamples.length > 8) groundZSamples.shift();
    if (groundZSamples.length < 3) return false;
    let min = groundZSamples[0];
    let max = groundZSamples[0];
    for (let i = 1; i < groundZSamples.length; i++) {
      if (groundZSamples[i] < min) min = groundZSamples[i];
      if (groundZSamples[i] > max) max = groundZSamples[i];
    }
    if (max - min > GROUND_Z_EPS) {
      groundOkSince = 0;
      return false;
    }
    if (!groundOkSince) groundOkSince = Date.now();
    return Date.now() - groundOkSince >= GROUND_STABLE_MS;
  }

  function clientSetLocXYZ(setHit, x, y, z) {
    const buf2 = Memory.alloc(96);
    for (let i = 0; i < 96; i++) buf2.add(i).writeU8(0);
    buf2.writeDouble(x);
    buf2.add(8).writeDouble(y);
    buf2.add(16).writeDouble(z);
    processEventFn(survPcObj, setHit.fn, buf2);
  }

  // Z hint de ancora proxima (ZombieSpawner) â€” so referencia; destino final = drop
  function nearestAnchorHint(x, y) {
    let best = null;
    let bestD = 1e18;
    const keys = Object.keys(mapAnchorActors);
    for (let i = 0; i < keys.length; i++) {
      const a = mapAnchorActors[keys[i]];
      let loc = a.loc;
      if (!loc) {
        const hit = readActorLoc(a.obj);
        if (hit && hit.loc) {
          loc = hit.loc;
          a.loc = loc;
        }
      }
      if (!loc) continue;
      if (
        !(
          loc[0] > 50000 &&
          loc[0] < 300000 &&
          loc[1] < -50000 &&
          loc[1] > -400000
        )
      )
        continue;
      if (!(loc[2] > CITY_Z_MIN && loc[2] < CITY_Z_MAX)) continue;
      const d = Math.hypot(loc[0] - x, loc[1] - y);
      if (d < bestD) {
        bestD = d;
        best = loc;
      }
    }
    if (rescueVoidZ._mapSpawns && rescueVoidZ._mapSpawns.length) {
      for (let i = 0; i < rescueVoidZ._mapSpawns.length; i++) {
        const s = rescueVoidZ._mapSpawns[i];
        const d = Math.hypot(s[0] - x, s[1] - y);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
    }
    return best;
  }

  // Avanca fases no Tick â€” mapa â†’ stream â†’ pawn â†’ chao estavel â†’ corpo â†’ soltar
  function advancePhases() {
    if (phase === PH.IDLE || phase === PH.READY) return;
    if (travelBusy && phase === PH.TRAVEL) return;
    const elapsed = Date.now() - phaseSince;

    if (phase === PH.TRAVEL) {
      if (landscapeShown >= 1) setPhase(PH.STREAM, 'tick Landscape');
      return;
    }
    if (phase === PH.STREAM) {
      if (streamSettledEnough(elapsed)) {
        tryPatchJump('STREAM');
        if (sawSurvivalPlayer && survPawnObj) {
          groundZSamples = [];
          groundOkSince = 0;
          setPhase(
            PH.GROUND,
            'stream L=' + landscapeShown + ' WP=' + wpShownCount
          );
        } else {
          setPhase(PH.WAIT_PAWN, 'stream settled, aguarda SurvivalPlayer');
        }
      } else if (elapsed > 8000 && elapsed % 4000 < 50) {
        log(
          'PHASE STREAM wait L=' +
            landscapeShown +
            ' WP=' +
            wpShownCount +
            ' (bypass WP>=' +
            WP_COLLISION_BYPASS +
            ')'
        );
      }
      return;
    }
    if (phase === PH.WAIT_PAWN) {
      // NUNCA rebaixar para STREAM (ping-pong = soft-lift nunca corre)
      if (sawSurvivalPlayer && survPawnObj) {
        if (!streamSettledEnough(elapsed) && wpShownCount < WP_COLLISION_BYPASS) {
          if (elapsed > 5000 && elapsed % 5000 < 50) {
            log(
              'PHASE WAIT_PAWN hold pawn L=' +
                landscapeShown +
                ' WP=' +
                wpShownCount
            );
          }
          return;
        }
        // R1/S1: so segura se o loc for ILEGIVEL. Origem (0,0) e legivel â€”
        // o DROP no GROUND resgata via ancora (segurar aqui = pawn cai sem rescue).
        const locW = readPawnZQuick();
        const locWOk =
          locW &&
          isFinite(locW.z) &&
          locW.z !== -999999 &&
          Math.abs(locW.z) < 5e6;
        if (!locWOk && elapsed < 20000) {
          if (elapsed > 5000 && elapsed % 5000 < 50) {
            log('PHASE WAIT_PAWN hold loc ilegivel (pawn cego)');
          }
          return;
        }
        if (!locWOk)
          log(
            'PHASE WAIT_PAWN escape 20s loc ilegivel â€” avanca p/ GROUND (rescue decide)'
          );
        groundZSamples = [];
        groundOkSince = 0;
        groundBlindSince = 0;
        groundBlindRedrops = 0;
        setPhase(
          PH.GROUND,
          'pawn ready L=' + landscapeShown + ' WP=' + wpShownCount
        );
      } else if (elapsed > 45000) {
        log(
          'PHASE WAIT_PAWN timeout 45s Jump=' +
            jumpPatched +
            ' placeholder=' +
            sawPlaceholder +
            ' (NAO F5)'
        );
        phaseSince = Date.now();
      }
      return;
    }
    if (phase === PH.GROUND) {
      if (!collisionStreamReady()) {
        if (elapsed > 5000 && elapsed % 5000 < 50) {
          log(
            'PHASE GROUND wait WP=' +
              wpShownCount +
              '/' +
              WP_COLLISION_BYPASS +
              ' L=' +
              landscapeShown
          );
        }
        return;
      }
      // drop 0: um DROP; drop 1: amostrar settle (sem re-teleport); drop 2: corpo
      if (dropState === 0) {
        pendingRescueZ = true;
      } else if (dropState === 1 && Date.now() - lastSoftLiftAt > 700) {
        lastSoftLiftAt = Date.now();
        pendingRescueZ = true;
      }
      const loc = readPawnZQuick();
      if (loc && Date.now() - lastPawnLocLog > 1500) {
        lastPawnLocLog = Date.now();
        log(
          'GROUND loc=' +
            Math.round(loc.x) +
            ',' +
            Math.round(loc.y) +
            ',' +
            Math.round(loc.z) +
            ' drop=' +
            dropState +
            ' L=' +
            landscapeShown
        );
      }
      if (dropState === 2) {
        // R1: dropState=2 so avanca com loc VALIDO. Avancar cego (Z=?) foi
        // o que pos o pawn debaixo da terra â€” agora segura e re-DROP (max 2).
        const zOk =
          loc &&
          isFinite(loc.z) &&
          loc.z !== -999999 &&
          Math.abs(loc.z) < 5e6 &&
          !(Math.abs(loc.x) < 1 && Math.abs(loc.y) < 1);
        if (!zOk) {
          if (!groundBlindSince) groundBlindSince = Date.now();
          const blindFor = Date.now() - groundBlindSince;
          if (Date.now() - lastSoftLiftAt > 1200) {
            lastSoftLiftAt = Date.now();
            pendingRescueZ = true;
          }
          if (Date.now() - lastPawnLocLog > 2000) {
            lastPawnLocLog = Date.now();
            log(
              'GROUND hold cego Z=' +
                (loc ? Math.round(loc.z) : '?') +
                ' t=' +
                Math.round(blindFor / 1000) +
                's redrops=' +
                groundBlindRedrops +
                ' (sem BODY ate loc valido)'
            );
          }
          if (blindFor > 12000 && groundBlindRedrops < 2) {
            groundBlindRedrops++;
            groundBlindSince = 0;
            dropState = 0;
            log(
              'GROUND loc invalido 12s â€” re-DROP #' +
                groundBlindRedrops +
                ' (pawn cego)'
            );
          }
          return;
        }
        groundBlindSince = 0;
        const zLabel = Math.round(loc.z);
        if (AUTO_BODY_AFTER_GROUND)
          setPhase(PH.BODY, 'Z estavel OK Z=' + zLabel);
        else setPhase(PH.RELEASE, 'ground ok');
      }
      return;
    }
    if (phase === PH.BODY) {
      try {
        applyBodyMeshes('phase');
      } catch (eB) {
        log('BODY apply throw: ' + eB);
      }
      // Nao chamar RELEASE no mesmo tick â€” deixa 1 frame (PE mesh adiado)
      setPhase(PH.RELEASE, 'body applied');
      return;
    }
    if (phase === PH.RELEASE) {
      // Delay curto apos BODY p/ nao run PE no mesmo frame do Fatal adiado
      if (Date.now() - phaseSince < 500) return;
      try {
        releasePlayable('phase');
      } catch (eR) {
        log('RELEASE throw: ' + eR);
        moveBridgeOn = true;
        releaseDone = true;
      }
      setPhase(PH.READY, 'playable');
      autoHubAt = Date.now() + 6000;
      return;
    }
  }

  function tryPostSurvivalFix(reason) {
    if (postSurvFixDone && !/force|retry/i.test(reason)) return false;
    if (landscapeShown < HIDE_AFTER_LANDSCAPE) {
      log(
        'postSurvFix SKIP (' +
          reason +
          ') L=' +
          landscapeShown +
          ' â€” sem Landscape = cinza'
      );
      return false;
    }
    log(
      'postSurvFix (' +
        reason +
        ') L=' +
        landscapeShown +
        ' WP=' +
        wpShownCount +
        ' jump=' +
        jumpPatched
    );
    try {
      const eng = getEngine();
      const gi = eng ? findGameInstance(eng) : null;
      if (gi) harvestFuncsFromObject(gi);
      if (survPcObj) harvestFuncsFromObject(survPcObj);
      if (survPawnObj) harvestFuncsFromObject(survPawnObj);
      if (placeholderObj) harvestFuncsFromObject(placeholderObj);

      // 1) corrigir Z void ANTES de HideLoading
      rescueVoidZ(reason + '/void');

      if (placeholderObj) {
        tryCallOnObj(placeholderObj, 'PickSpawnPoint', reason + '/ph');
        tryCallOnObj(placeholderObj, 'ServerPickSpawnPoint', reason + '/ph');
      }
      if (survPawnObj) {
        tryCallOnObj(survPawnObj, 'LoadPlayerPos', reason + '/pawn');
      }
      tryCallNamed('LoadPlayerPos', reason);

      // 2) HideLoading 1x so depois de WP minimo
      if (wpShownCount >= 8 && !hideLoadingDone) {
        tryHideLoadingScreen(reason + '/hide');
      } else {
        log('postSurvFix: HideLoading adiado WP=' + wpShownCount);
        hideLoadingQueued = true;
        pendingHideLoading = true;
      }

      postSurvFixDone = true;
      // re-checar Z apos 2s (pode continuar caindo)
      setTimeout(function () {
        rescueVoidZ('t+2s');
      }, 2000);
      setTimeout(function () {
        rescueVoidZ('t+5s');
      }, 5000);
      return true;
    } catch (e) {
      log('postSurvFix throw: ' + e);
      return false;
    }
  }

  function tryHideLoadingScreen(reason) {
    if (!processEventFn) {
      log('HideLoading: ProcessEvent ainda nao pronto');
      return false;
    }
    try {
      const eng = getEngine();
      const gi = eng ? findGameInstance(eng) : null;
      if (gi) harvestFuncsFromObject(gi);
      let hit = found.HideLoadingScreenAfterLoadLevel;
      if (!hit && gi) {
        dumpGiFunctions(gi);
        hit = found.HideLoadingScreenAfterLoadLevel;
      }
      if (!hit) {
        log('HideLoading: UFunction nao no cache â€” F9 no menu/GI primeiro');
        return false;
      }
      const target = gi || hit.obj;
      processEventFn(target, hit.fn, ptr(0));
      hideLoadingDone = true;
      pendingHideLoading = false;
      log('HideLoadingScreenAfterLoadLevel OK (' + reason + ') on ' + objectName(target));
      // tambem HideLoadingScreen simples (WBP loading)
      const hit2 = found.HideLoadingScreen;
      if (hit2) {
        try {
          processEventFn(gi || hit2.obj, hit2.fn, ptr(0));
          log('HideLoadingScreen OK (' + reason + ')');
        } catch (e2) {}
      }
      tryRestoreCursor();
      return true;
    } catch (e) {
      log('HideLoading throw: ' + e);
      return false;
    }
  }

  function tryCallNamed(name, reason) {
    const hit = found[name];
    if (!hit || !processEventFn) return false;
    if (neverInvoke[name]) {
      log('SKIP ' + name + ' blacklist');
      return false;
    }
    if (!safeZeroArg[name]) {
      log('SKIP ' + name + ' not safeZeroArg');
      return false;
    }
    const psz = readParmsSize(hit.fn);
    if (psz !== 0) {
      log('SKIP ' + name + ' ParmsSize=' + psz + ' (' + reason + ')');
      return false;
    }
    try {
      const eng = getEngine();
      const gi = eng ? findGameInstance(eng) : null;
      const target = gi || hit.obj;
      processEventFn(target, hit.fn, ptr(0));
      log('OK ' + name + ' (' + reason + ') on ' + objectName(target));
      return true;
    } catch (e) {
      log('throw ' + name + ': ' + e);
      return false;
    }
  }

  function tryCallOnObj(obj, name, reason) {
    if (!obj || !processEventFn) return false;
    const hit = found[name];
    if (!hit) return false;
    if (neverInvoke[name]) return false;
    const psz = readParmsSize(hit.fn);
    if (psz !== 0) {
      log('SKIP ' + name + ' on obj ParmsSize=' + psz);
      return false;
    }
    try {
      processEventFn(obj, hit.fn, ptr(0));
      log('OK ' + name + ' (' + reason + ') on ' + objectName(obj));
      return true;
    } catch (e) {
      log('throw ' + name + ' on obj: ' + e);
      return false;
    }
  }

  function tryOfflineCharacterSpawn(reason) {
    if (offlineSpawnDone && !/force|F5/i.test(reason)) return false;
    log(
      'F8 offline-spawn (' +
        reason +
        ') placeholder=' +
        sawPlaceholder +
        ' survival=' +
        sawSurvivalPlayer +
        ' L=' +
        landscapeShown
    );
    try {
      const eng = getEngine();
      const gi = eng ? findGameInstance(eng) : null;
      if (gi) {
        harvestFuncsFromObject(gi);
        dumpGiFunctions(gi);
      }
      if (placeholderObj) {
        harvestFuncsFromObject(placeholderObj);
        dumpGiFunctions(placeholderObj);
      }
      harvestKnownControllers(eng);

      let ok = false;
      // 1) GI: load/save char local
      const giChain = [
        'FakeLogin',
        'Login',
        'LoadCharInit',
        'LoadCharacter',
        'LoadCharacterInfo',
        'GetSaveCharsFromServer',
        'NewCharCreated',
        'NewCharacterCreated',
        'CharactedCreated',
        'OnCharacterLoaded',
        'SaveCharacter',
        'SaveCharacterInfo',
      ];
      for (let i = 0; i < giChain.length; i++) {
        if (tryCallNamed(giChain[i], reason)) ok = true;
      }
      // 2) Placeholder BP: FakeLogin â†’ LoadFromPlaceholder â†’ InitPlayer (pak)
      //    ServerLogined/RestartPlayer AV offline â€” skip
      const phChain = [
        'FakeLogin',
        'Login',
        'LoginCompleted',
        'ServerLogin',
        'OnServerLogin',
        'LoadFromPlaceholder',
        'InitPlayer',
        'PickPlayer',
      ];
      if (placeholderObj) {
        for (let i = 0; i < phChain.length; i++) {
          if (tryCallOnObj(placeholderObj, phChain[i], reason + '/ph')) ok = true;
        }
      }

      offlineSpawnDone = true;
      if (sawSurvivalPlayer) {
        log('F8 offline-spawn: SurvivalPlayer JA vivo');
      } else if (ok) {
        log(
          'F8 offline-spawn cadeia OK (forcedDefaultPawn=' +
            defaultPawnForced +
            ') â€” se vermelho: Shift+F8 cedo p/ FORCE DefaultPawn'
        );
      } else {
        log('F8 offline-spawn: sem UFunctions Placeholder/GI â€” F9');
      }
      return ok;
    } catch (e) {
      log('offline-spawn throw: ' + e);
      return false;
    }
  }

  function clearTravelUrl(ctx) {
    try {
      const empty = Memory.allocUtf16String('');
      fstringAssign(ctx.add(0xa8), empty);
    } catch (e) {}
  }

  function forceTravelListen(reason) {
    try {
      if (travelBusy) {
        log('F8 SKIP: travelBusy (Browse em curso) â€” evita Fatal world leaks');
        return false;
      }
      if (travelDone && !/force|retry/i.test(reason)) {
        log(
          'F8 SKIP: travel ja feito â€” F7=HideLoading | NAO re-F8 (world leak)'
        );
        return false;
      }
      // Re-travel mid-session = UE Fatal world leaks â€” so 1x por processo
      if (travelDone && /force|retry/i.test(reason)) {
        log(
          'F8 SKIP retry: re-TravelURL com mundo vivo = leak/crash. Reinicie o jogo.'
        );
        return false;
      }
      const eng = getEngine();
      if (!eng) {
        log('F8 TravelURL: sem GEngine');
        return false;
      }
      const ctx = getWorldContext(eng);
      if (!ctx) {
        log('F8 TravelURL: sem WorldContext');
        return false;
      }
      hideLoadingDone = false;
      hideLoadingQueued = false;
      pendingOfflineSpawn = false;
      offlineSpawnDone = false;
      sawPlaceholder = false;
      sawSurvivalPlayer = false;
      placeholderObj = null;
      survPawnObj = null;
      survPcObj = null;
      camYawCache = null;
      for (const k in meshAssetsSeen) delete meshAssetsSeen[k];
      moveBridgeOn = false;
      moveBridgeCount = 0;
      lookBridgeOn = false;
      lookBridgeCount = 0;
      lookYawAccum = 0;
      lookPitchAccum = 0;
      lookRotSeeded = false;
      lookMemWriteOk = 0;
      lookMemWriteFail = 0;
      pcControlRotOff = -1;
      ctrlRotFnCache = null;
      ctrlRotDblOff = -1;
      ctrlRotLastCalibAt = 0;
      lookYawAccum = 0;
      wpShownCount = 0;
      landscapeShown = 0;
      defaultPawnForced = 0;
      jumpPatched = false;
      placeholderScript = null;
      placeholderScriptNum = 0;
      pendingPostSurvFix = false;
      postSurvFixDone = false;
      pendingPickAfterJump = false;
      pendingRescueZ = false;
      rescueVoidZAttempts = 0;
      softLiftZAttempts = 0;
      pendingMakePlayable = false;
      makePlayableDone = false;
      bodyApplyDone = false;
      releaseDone = false;
      groundZSamples = [];
      groundOkSince = 0;
      groundBlindSince = 0;
      groundBlindRedrops = 0;
      lastSoftLiftAt = 0;
      dropState = 0;
      dropFromZ = 0;
      dropAt = 0;
      dropTx = 0;
      dropTy = 0;
      dropSkyRetries = 0;
      postLandLifts = 0;
      diagZReset();
      atpcApiDone = false;
      atpcParmsDone = false;
      atpcGetDone = false;
      atpcPropsDone = false;
      atpcObjPropsDone = false;
      atpcSetDone = false;
      diffSnapPending = null;
      diffSnapAt = 0;
      diffSnapCount = 0;
      camLocDone = false;
      animApiDone = false;
      animFixDone = false;
      animFixRecheckDone = false;
      animFixAt = 0;
      vtDone = false;
      animInitDone = false;
      animInitRecheckDone = false;
      animInitAt = 0;
      boneSnap1Done = false;
      boneSnap2Done = false;
      boneSnap1Hex = '';
      guardDone = false;
      treeDone = false;
      instVarsDone = false;
      slotsPreDone = false;
      pawnApiDone = false;
      visFixDone = false;
      visFixAt = 0;
      visFixRecheckDone = false;
      visTglDone = false;
      visTglAt = 0;
      visTglRecheckDone = false;
      fullyLoadDone = false;
      fullyLoadAt = 0;
      fullyLoadRecheckDone = false;
      initLocalDone = false;
      initLocalAt = 0;
      initLocalRecheckDone = false;
      slotVisDone = false;
      slotVisAt = 0;
      slotVisRecheckDone = false;
      probeSetupDone = false;
      probeDone = false;
      probeInst = null;
      probeGsFn = null;
      probeLastLoc = null;
      probeLastT = 0;
      probeNextAt = 0;
      probeLines = 0;
      probeTickN = 0;
      probeMov = null;
      probeVelOff = -1;
      probeTrans = [];
      probeStateFn = null;
      probeWeightFn = null;
      probeMachines = [];
      probeMachWF = null;
      probeElapsedF = null;
      probeMutIdle = null;
      probeMutDone = false;
      probeMutOff = -1;
      probeNodes = null;
      probeNodeDone1 = false;
      probeNodeDone2 = false;
      probeNodeTick1 = -1;
      nodePtrDone = false;
      probeLinkedInst = null;
      linkFn = null;
      linkChkFn = null;
      linkDone = false;
      pawnIdDone = false;
      loadTryDone = false;
      pendingLoadTry = false;
      loadTryBuf = null;
      loadTryQueue = [];
      playTryDone = false;
      pendingPlaySetup = false;
      pendingPlayCmd = '';
      playSeq = null;
      playFn = null;
      playStopFn = null;
      playTryPlaying = false;
      playMontage = null;
      playPathBuf = null;
      playSlotList = [];
      playSlotPos = 0;
      playSlotAtual = null;
      playSlotMoveTime = 0;
      playCheckAt = -1;
      link2Done = false;
      pendingLink2 = false;
      rebirthDone = false;
      pendingRebirth = false;
      rebirthApplied = false;
      nodeScanDone = false;
      subMasc = null;
      subFem = null;
      subMascGsFn = null;
      subFemGsFn = null;
      subProbeSetupDone = false;
      traceOn = false;
      traceUntil = 0;
      traceSet = null;
      traceDone = false;
      traceSetPawn = null;
      probePostInst = null;
      traceSetPost = null;
      trace2On = false;
      trace2Done = false;
      trace2Until = 0;
      calcMutLogged = false;
      trace0On = false;
      trace0Done = false;
      trace0Until = 0;
      traceSet0 = null;
      calcFns = [];
      calcOn = false;
      calcUntil = 0;
      calcDone = false;
      calcRounds = 0;
      init2Fns = [];
      init2Done = false;
      init2AtRound = -1;
      calcMut2Logged = false;
      calcBufs = [];
      vbProbeDone = false;
      traceCalcSet = null;
      traceCalcOn = false;
      traceCalcDone = false;
      initAnimFn = null;
      initAnimDone = false;
      optAnimFn = null;
      optDiffDone = false;
      ritualFns = [];
      ritualBufs = [];
      ritualOn = false;
      ritualN = 0;
      ritualMode = 1;
      pendingDumpLoc = false;
      if (rescueVoidZ._idx) rescueVoidZ._idx = 0;
      travelArmed = true;
      travelBusy = true;
      setPhase(PH.TRAVEL, reason);
      // Limpar spawns antigos; dumpLoc SO depois do stream (senao PE no mundo morrendo)
      for (const k in spawnActorsSeen) delete spawnActorsSeen[k];
      for (const k in mapAnchorActors) delete mapAnchorActors[k];
      if (rescueVoidZ._mapSpawns) rescueVoidZ._mapSpawns = null;
      // Pre-cache SurvivalPlayer*_C antes do GameMode escolher DefaultPawn
      try {
        const gi0 = findGameInstance(eng);
        if (gi0) {
          harvestFuncsFromObject(gi0);
          dumpGiFunctions(gi0);
        }
      } catch (e0) {}
      const urlBuf = Memory.allocUtf16String(MAP_LISTEN);
      fstringAssign(ctx.add(0xa8), urlBuf);
      ctx.add(0xb8).writeU8(0);
      log(
        'F8 TravelURL="' +
          MAP_LISTEN +
          '" (' +
          reason +
          ') FORCE_SURVIVAL_PAWN=' +
          FORCE_SURVIVAL_PAWN +
          ' class=' +
          (survivalPawnClass ? objectName(survivalPawnClass) : 'null') +
          ' | F5=Placeholder FakeLogin/LoadFrom'
      );
      setTimeout(function () {
        if (!travelDone && !wpShownCount) return;
        try {
          const eng2 = getEngine();
          const ctx2 = eng2 ? getWorldContext(eng2) : null;
          if (ctx2) {
            clearTravelUrl(ctx2);
            log('F8 TravelURL cleared (pos-stream, anti-loop)');
          }
        } catch (e) {}
      }, 8000);
      // Failsafe: liberar travelBusy mesmo sem Landscape
      setTimeout(function () {
        if (travelBusy) {
          travelBusy = false;
          log('F8 travelBusy OFF (timeout 20s)');
        }
      }, 20000);
      setTimeout(function () {
        log(
          'F8 status 12s: WP=' +
            wpShownCount +
            ' L=' +
            landscapeShown +
            ' placeholder=' +
            sawPlaceholder +
            ' survival=' +
            sawSurvivalPlayer
        );
        if (
          AUTO_OFFLINE_SPAWN &&
          travelArmed &&
          !offlineSpawnDone &&
          !sawSurvivalPlayer &&
          landscapeShown >= LANDSCAPE_BEFORE_HIDE
        ) {
          pendingOfflineSpawn = true;
        }
      }, 12000);
      setTimeout(function () {
        log(
          'F8 status 25s: phase=' +
            phase +
            ' survival=' +
            sawSurvivalPlayer +
            ' jump=' +
            jumpPatched +
            (sawSurvivalPlayer
              ? ' â€” pawn OK, espere BODY/RELEASE'
              : ' â€” espere Jump/PickPlayer (NAO F5)')
        );
      }, 25000);
      return true;
    } catch (e) {
      log('F8 TravelURL erro: ' + e);
      return false;
    }
  }

  // neverInvoke always skipped. ParmsSize==0 so e seguro se safeZeroArg[name].
  function callPE(obj, ufn, force) {
    if (!processEventFn || !obj || !ufn) return false;
    const fname = functionName(ufn);
    if (
      neverInvoke[fname] ||
      /^(SetSpawnRegion|JoinToServer|InitClient|DebugCreatePlayer|DebugRemovePlayer|AuthToServer)$/i.test(
        fname
      )
    ) {
      log('SKIP forever ' + fname + ' (blacklist: AV/BE/join/args)');
      return false;
    }
    const psz = readParmsSize(ufn);
    if (!force) {
      if (psz < 0) {
        log('SKIP ' + fname + ' ParmsSize=unknown');
        return false;
      }
      if (psz === 0 && !safeZeroArg[fname] && !force) {
        log(
          'SKIP ' +
            fname +
            ' ParmsSize=0 nao-whitelist (F9 mentia; PE null â†’ AV)'
        );
        return false;
      }
      if (psz > 0) {
        log('SKIP ' + fname + ' ParmsSize=' + psz + ' (precisa args)');
        return false;
      }
    }
    try {
      processEventFn(obj, ufn, ptr(0));
      return true;
    } catch (e) {
      log('ProcessEvent throw: ' + e);
      return false;
    }
  }

  function invokeSetServerAddress(gi, ufn) {
    // Tentativa: 1x FString em parms (16 bytes) = "127.0.0.1:7777"
    if (!processEventFn || !gi || !ufn) return false;
    try {
      const buf = Memory.alloc(0x40);
      for (let i = 0; i < 0x40; i++) buf.add(i).writeU8(0);
      const url = Memory.allocUtf16String('127.0.0.1:7777');
      fstringAssign(buf, url);
      log('F10 SetServerAddress parms FString=127.0.0.1:7777');
      processEventFn(gi, ufn, buf);
      return true;
    } catch (e) {
      log('SetServerAddress throw: ' + e);
      return false;
    }
  }

  function pickHostHits() {
    const out = [];
    for (let i = 0; i < invokeOrder.length; i++) {
      const name = invokeOrder[i];
      if (neverInvoke[name]) continue;
      if (found[name]) out.push({ name: name, hit: found[name] });
    }
    // Also pick any Restart* / StartLevel* / CreateSession* variants seen in PE while browser open
    const kn = Object.keys(found);
    for (let i = 0; i < kn.length; i++) {
      const name = kn[i];
      if (neverInvoke[name] || uiOnlyRe.test(name)) continue;
      let already = false;
      for (let j = 0; j < out.length; j++) {
        if (out[j].name === name) {
          already = true;
          break;
        }
      }
      if (already) continue;
      if (
        /^(StartLevel|CreateSession|Restart|HostGame|HostSession|Listen)/i.test(
          name
        ) ||
        (/BndEvt_.*Server/i.test(name) &&
          /Continue|Select|Play|Host|Join|Confirm/i.test(name))
      ) {
        out.push({ name: name, hit: found[name] });
      }
    }
    return out;
  }

  function pickUiContinue() {
    const names = Object.keys(found);
    const out = [];
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      if (uiOnlyRe.test(n)) continue;
      if (neverInvoke[n]) continue;
      if (/Server_Continue|Continue.*OnClick|OnChangedServerSelected/i.test(n)) {
        out.push({ name: n, hit: found[n] });
      }
    }
    return out;
  }

  function isWorldHostName(name) {
    return /^(StartLevel|CreateSession|RestartPlayer|RestartPlayerAtPlayerStart|ServerRestartPlayer|HostGame|ServerTravel|OpenLevel)$/i.test(
      name
    );
  }

  let ShowCursorFn = null;
  try {
    const sc =
      (Module.findGlobalExportByName &&
        Module.findGlobalExportByName('ShowCursor')) ||
      Process.getModuleByName('user32.dll').getExportByName('ShowCursor');
    ShowCursorFn = new NativeFunction(sc, 'int', ['int']);
  } catch (e) {}

  function tryRestoreCursor() {
    // OS-level: make cursor visible again if a 0-arg stub hid it.
    try {
      if (ShowCursorFn) {
        for (let i = 0; i < 8; i++) ShowCursorFn(1);
        log('F10 restore: user32 ShowCursor(TRUE) x8');
      }
    } catch (e) {
      log('F10 restore ShowCursor fail: ' + e);
    }
    // UE: only call ShowMouseCursor / SetShowMouseCursor with bool true (ParmsSize 1..8)
    const cursorNames = ['ShowMouseCursor', 'SetShowMouseCursor'];
    for (let i = 0; i < cursorNames.length; i++) {
      const hit = found[cursorNames[i]];
      if (!hit || !processEventFn) continue;
      const psz = readParmsSize(hit.fn);
      if (psz < 1 || psz > 8) {
        log('F10 restore skip ' + cursorNames[i] + ' ParmsSize=' + psz);
        continue;
      }
      try {
        const buf = Memory.alloc(psz);
        for (let b = 0; b < psz; b++) buf.add(b).writeU8(0);
        buf.writeU8(1); // bShow = true
        processEventFn(hit.obj, hit.fn, buf);
        log('F10 restore OK ' + cursorNames[i] + ' on ' + objectName(hit.obj));
        return;
      } catch (e) {
        log('F10 restore ' + cursorNames[i] + ' throw: ' + e);
      }
    }
  }

  function harvestKnownControllers(eng) {
    // Pull RestartPlayer / StartLevel off PC / GM if PE already saw them.
    const kn = Object.keys(found);
    for (let i = 0; i < kn.length; i++) {
      try {
        const o = found[kn[i]].obj;
        const n = objectName(o);
        if (/PC_|PlayerController|GM_|GameMode|GI_/i.test(n)) harvestFuncsFromObject(o);
      } catch (e) {}
    }
  }

  function boostBrowserCache(reason) {
    browserMode = true;
    browserBoostUntil = Date.now() + 90000; // keep PE logging hot ~90s
    if (logBudget < 400) logBudget = 400;
    log(
      'browser-mode ON (' +
        reason +
        '): PE cache hot p/ StartLevel/CreateSession/Restart* | refresh lista no UI, depois F10'
    );
    const eng = getEngine();
    if (eng) {
      try {
        const gi = findGameInstance(eng);
        if (gi) harvestFuncsFromObject(gi);
        harvestKnownControllers(eng);
      } catch (e) {}
    }
  }

  function invokeHostFlow() {
    const eng = getEngine();
    if (!eng) {
      log('F10 ERRO: sem GEngine');
      return;
    }
    if (!processEventFn) {
      log('F10 ERRO: ProcessEvent ainda nao pronto â€” espere 1s ou F11');
      discoverProcessEvent(eng);
      return;
    }

    const gi = findGameInstance(eng);
    if (gi) harvestFuncsFromObject(gi);
    harvestKnownControllers(eng);

    const names = Object.keys(found);
    log('F10 cache=[' + names.join(',') + ']');

    // 0) SetServerAddress com FString local (caminho real do GI â€” nao ha StartLevel)
    let invokedAny = false;
    if (found.SetServerAddress && gi) {
      log('F10 try SetServerAddress(127.0.0.1:7777) â€” caminho lista/join local');
      invokedAny = true;
      if (invokeSetServerAddress(gi, found.SetServerAddress.fn)) {
        log('F10 OK SetServerAddress â€” se UI pedir join, NAO uses JoinToServer (BE); usa F8 listen');
      } else {
        log('F10 FALHOU SetServerAddress');
      }
    } else {
      log(
        'F10: SetServerAddress ainda nao no cache â€” F9 de novo apos SPACE/Refresh (F9 HIT SetServerAddress)'
      );
    }

    // 1) Host UFunctions safe 0-arg only
    const hosts = pickHostHits();
    let skipped = [];
    let deferredRisky = [];
    for (let i = 0; i < hosts.length; i++) {
      const name = hosts[i].name;
      const hit = hosts[i].hit;
      if (name === 'SetServerAddress') continue; // ja tratado
      if (uiOnlyRe.test(name)) {
        log('F10 skip UI-only ' + name);
        continue;
      }
      if (neverInvoke[name]) {
        deferredRisky.push({ name: name, hit: hit });
        log('F10 blacklist ' + name);
        continue;
      }
      const psz = readParmsSize(hit.fn);
      const target =
        gi && /GI_Survival/i.test(objectName(gi)) && !/Restart|SpawnDefault/i.test(name)
          ? gi
          : hit.obj;
      if (psz !== 0 || !safeZeroArg[name]) {
        if (psz !== 0) skipped.push(name + ':' + psz);
        else skipped.push(name + ':0-not-whitelisted');
        continue;
      }
      log('F10 invoke ' + name + ' on ' + objectName(target) + ' ParmsSize=0 safe');
      invokedAny = true;
      if (callPE(target, hit.fn)) {
        log('F10 OK ' + name);
        if (isWorldHostName(name) || /^Restart/i.test(name)) return;
        continue;
      }
      log('F10 FALHOU ' + name);
    }

    // 2) UI Continue after real host attempts (never cursor/input-only)
    const ui = pickUiContinue();
    for (let i = 0; i < ui.length; i++) {
      const psz = readParmsSize(ui[i].hit.fn);
      if (psz !== 0) {
        log('F10 skip UI ' + ui[i].name + ' ParmsSize=' + psz);
        continue;
      }
      log('F10 invoke UI ' + ui[i].name + ' on ' + objectName(ui[i].hit.obj));
      invokedAny = true;
      if (callPE(ui[i].hit.obj, ui[i].hit.fn)) {
        log('F10 OK UI ' + ui[i].name);
        return;
      }
    }

    // 3) No last-resort for blacklisted (SetSpawnRegion / JoinToServer / InitClient).
    for (let i = 0; i < deferredRisky.length; i++) {
      const d = deferredRisky[i];
      log(
        'F10 skip forever ' +
          d.name +
          (/InitClient/i.test(d.name)
            ? ' (BattlEye InitClient / online AC)'
            : /JoinToServer/i.test(d.name)
              ? ' (client-join / AC path)'
              : /SetSpawnRegion/i.test(d.name)
                ? ' (PE null â†’ AV 0x0)'
                : ' (offline unsafe)')
      );
    }

    if (skipped.length) {
      log(
        'F10: candidatas com args (nao chamadas, evitam crash): ' +
          skipped.join(',')
      );
    }
    const hasWorld =
      found.StartLevel ||
      found.CreateSession ||
      Object.keys(found).some(function (k) {
        return /^Restart/i.test(k);
      });
    if (!invokedAny || !hasWorld) {
      tryRestoreCursor();
      log(
        'F10: sem host 0-arg. SPACE=browser | F12=PrepareServerList | F9=dump GI funcs | F8=TravelURL?listen (pode void). cache=' +
          names.join(',')
      );
    } else {
      tryRestoreCursor();
      log('F10: tentativas feitas sem world host â€” cursor restaurado se possivel');
    }
  }

  function invokeBrowserRefresh(auto) {
    if (!processEventFn) {
      log('F12: ProcessEvent nao pronto');
      return;
    }
    const hit = found.PrepareServerList;
    if (!hit) {
      log(
        (auto ? 'auto' : 'F12') +
          ': PrepareServerList ainda nao visto â€” SPACE abre Server Browser, Refresh no UI alimenta PE'
      );
      return;
    }
    const psz = readParmsSize(hit.fn);
    log(
      (auto ? 'auto' : 'F12') +
        ' PrepareServerList on ' +
        objectName(hit.obj) +
        ' ParmsSize=' +
        psz +
        ' (refresh lista; pode falhar offline)'
    );
    if (psz !== 0) {
      log((auto ? 'auto' : 'F12') + ' SKIP â€” ParmsSize!=0 (risco de crash)');
      return;
    }
    if (callPE(hit.obj, hit.fn)) log((auto ? 'auto' : 'F12') + ' OK');
    else log((auto ? 'auto' : 'F12') + ' FALHOU');
  }

  const gaksAddr = Module.findGlobalExportByName
    ? Module.findGlobalExportByName('GetAsyncKeyState')
    : null;
  let GetAsyncKeyState = null;
  try {
    const a =
      gaksAddr ||
      Process.getModuleByName('user32.dll').getExportByName('GetAsyncKeyState');
    GetAsyncKeyState = new NativeFunction(a, 'int16', ['int']);
  } catch (e) {
    log('GetAsyncKeyState fail: ' + e);
  }

  // AUTO_F8 (06/11): host sem janela (-nullrhi). O servidor_host.py --sem-interface coloca `var AUTO_F8_MS = 15000;` no
  // inicio deste script. Com o mundo no menu (Mainmenu*) ha AUTO_F8_MS, o poller abaixo ve F8 "apertado" em 1 leitura
  // (nova tentativa a cada 30 s enquanto continuar no menu, ate 5). Feito aqui dentro porque um hook externo em
  // GetAsyncKeyState nao ve as chamadas que este script faz de dentro do proprio Interceptor (medido: 0 leituras vistas).
  let autoF8Desde = 0, autoF8Feito = false, autoF8Ultimo = 0, autoF8Tent = 0, autoF8Leu = 0;
  function autoF8Tick() {
    if (typeof AUTO_F8_MS === 'undefined' || autoF8Feito) return false;
    if (travelDone) { autoF8Feito = true; log('AUTO_F8 encerrado: travel feito'); return false; }
    if (travelBusy) return false;
    const agora = Date.now();
    if (agora - autoF8Leu < 500) return false;
    autoF8Leu = agora;
    let n = '';
    try {
      const eng = main.base.add(0x7e20ea8).readPointer();
      if (!eng.isNull() && eng.add(0xec8).readS32() > 0) {
        const w = eng.add(0xec0).readPointer().readPointer().add(0x2c0).readPointer();
        if (!w.isNull()) n = objectName(w);
      }
    } catch (e) {}
    if (!/mainmenu/i.test(n)) { autoF8Desde = 0; return false; }
    if (!autoF8Desde) { autoF8Desde = agora; log('AUTO_F8 menu detectado (' + n + '); F8 em ' + AUTO_F8_MS + ' ms'); return false; }
    if (agora - autoF8Desde < AUTO_F8_MS) return false;
    if (autoF8Ultimo && agora - autoF8Ultimo < 30000) return false;
    if (autoF8Tent >= 5) { autoF8Feito = true; log('AUTO_F8 DESISTIU: 5 tentativas no menu'); return false; }
    autoF8Tent++; autoF8Ultimo = agora;
    log('AUTO_F8 F8 automatico (tentativa ' + autoF8Tent + ')');
    return true;
  }

  let f5Was = false;
  let f6Was = false;
  let f7Was = false;
  let f8Was = false;
  let f9Was = false;
  let f10Was = false;
  let f11Was = false;
  let f12Was = false;
  let spaceWas = false;
  let pendingDump = false;
  let pendingTravel = false;

  // HOST_LEVE (06/11): host sem interface/dedicado. O servidor_host.py --sem-interface coloca `var HOST_LEVE = true;` no inicio.
  // Depois que o travel assenta (fase >= WAIT_PAWN por 20 s; o listen ja abriu), este script SOLTA TODOS os seus hooks
  // (Interceptor.detachAll e por script): o logger de ProcessEvent (TRACE), os de spawn, LoadStreamLevel, Tick etc. so serviam
  // para o personagem do proprio host e para diagnostico, e custavam tempo em cada chamada do jogo. So o Browse 2->1 volta.
  // v2 (06/11 11:57): detachAll derrubou o host 12 s depois (processo terminou sem WER). Agora solta SO o logger de ProcessEvent
  // (o hook pesado, chamado em toda UFunction do jogo) e o tick deste script so passa a retornar cedo; os outros hooks ficam.
  let leveDesde = 0, leveFeito = false;
  let tickListenerPrincipal = null, tickListenerArmado = null;   // 12/11: soltos junto com o logger (cada hook JS custa uma chamada por quadro)
  function hostLeveTick() {
    if (leveFeito || typeof HOST_LEVE === 'undefined' || !HOST_LEVE) return;
    if (phase < PH.WAIT_PAWN) { leveDesde = 0; return; }
    if (!leveDesde) { leveDesde = Date.now(); log('HOST_LEVE: travel feito; hooks do host_flow serao soltos em 20 s'); return; }
    if (Date.now() - leveDesde < 20000) return;
    leveFeito = true;
    setTimeout(function () {
      try { if (peLoggerListener) { peLoggerListener.detach(); peLoggerListener = null; }
        if (tickListenerPrincipal) { tickListenerPrincipal.detach(); tickListenerPrincipal = null; }
        if (tickListenerArmado) { tickListenerArmado.detach(); tickListenerArmado = null; }
        log('HOST_LEVE: logger de ProcessEvent e ganchos do Tick soltos (o tick do host_flow nao roda mais JS)'); }
      catch (e) { log('HOST_LEVE erro ao soltar hooks: ' + e); }
    }, 0);
  }

  tickListenerPrincipal = Interceptor.attach(tickAddress, {
    onEnter: function () {
      try { hostLeveTick(); } catch (eHL) {}
      if (leveFeito) return;
      if (pendingOfflineSpawn) {
        pendingOfflineSpawn = false;
        try {
          tryOfflineCharacterSpawn('auto/pending');
        } catch (e) {
          log('offline-spawn pending erro: ' + e);
        }
      }
      // PickPlayer/InitPlayer forÃ§ados via PE = AV 0xffffffff / freeze â€” so Jump no Script
      if (pendingPickAfterJump) {
        pendingPickAfterJump = false;
        log('PickAfterJump SKIP (Jump no ubergraph basta; PE forÃ§ado crasha)');
      }
      if (pendingPostSurvFix) {
        pendingPostSurvFix = false;
        try {
          tryPostSurvivalFix('auto/surv');
        } catch (e) {
          log('postSurvFix pending erro: ' + e);
        }
      }
      if (pendingHideLoading) {
        pendingHideLoading = false;
        try {
          tryHideLoadingScreen('auto/pending');
        } catch (e) {
          log('HideLoading pending erro: ' + e);
        }
      }
      if (pendingLoadTry) {
        pendingLoadTry = false;
        try {
          execLoadTry('tick');
        } catch (e) {
          log('LOADTRY tick erro: ' + e);
        }
      }
      if (pendingPlaySetup) {
        pendingPlaySetup = false;
        try {
          execPlaySetup();
        } catch (e) {
          log('PLAYTRY tick setup erro: ' + e);
        }
      }
      if (pendingPlayCmd) {
        const pc = pendingPlayCmd;
        pendingPlayCmd = '';
        try {
          execPlayCmd(pc);
        } catch (e) {
          log('PLAYTRY tick cmd erro: ' + e);
        }
      }
      if (pendingLink2) {
        pendingLink2 = false;
        try {
          execLink2();
        } catch (e) {
          log('LINK2 tick erro: ' + e);
        }
      }
      if (pendingRebirth) {
        pendingRebirth = false;
        try {
          execRebirth();
        } catch (e) {
          log('REBIRTH tick erro: ' + e);
        }
      }
      if (!jumpHooked && jumpTries < 20 && phase >= PH.WAIT_PAWN && survPawnObj) {
        jumpTries++;
        installJumpHook('auto');
      }
      if (Date.now() - cmdPollAt > 1000) {
        cmdPollAt = Date.now();
        pollCmdFile();
      }
      if (monitorOn && Date.now() - monitorAt > 1000) {
        monitorAt = Date.now();
        try { monitorTick(); } catch (eMon) { log('MONITOR exc ' + eMon); }
      }
      if (phase >= PH.READY && ritualOn && probeInst) {
        try {
          ritualTick();
        } catch (eRT) {
          log('RITUAL tick exc ' + eRT);
          ritualOn = false;
        }
      }
      if (pendingRescueZ) {
        pendingRescueZ = false;
        if (travelBusy) {
          log('rescueZ defer (travelBusy)');
        } else {
          try {
            rescueVoidZ('tick');
          } catch (e) {
            log('rescueZ pending erro: ' + e);
          }
        }
      }
      if (pendingMakePlayable) {
        pendingMakePlayable = false;
        if (travelBusy || phase < PH.GROUND) {
          log('makePlayable defer (travelBusy/phase=' + phase + ')');
          pendingMakePlayable = true;
        } else {
          try {
            makePlayable('tick/F6');
            if (phase < PH.READY) setPhase(PH.READY, 'F6 manual');
          } catch (e) {
            log('makePlayable pending erro: ' + e);
          }
        }
      }
      try {
        advancePhases();
      } catch (ePh) {
        log('advancePhases erro: ' + ePh);
      }
      try {
        diagZTick();
      } catch (eDiag) {}
      if (DIAG_ATPC_API && phase >= PH.READY && !atpcApiDone) {
        try {
          diagAtpcApi();
        } catch (eApi) {}
      }
      if (DIAG_ATPC_PARMS && phase >= PH.READY && !atpcParmsDone) {
        try {
          diagAtpcParms();
        } catch (eParms) {}
      }
      if (DIAG_ATPC_GET && phase >= PH.READY && !atpcGetDone) {
        try {
          diagAtpcGet();
        } catch (eGet) {}
      }
      if (DIAG_ATPC_PROPS && phase >= PH.READY && !atpcPropsDone) {
        try {
          diagAtpcProps();
        } catch (eProps) {}
      }
      if (DIAG_OBJ_PROPS && phase >= PH.READY && !atpcObjPropsDone) {
        try {
          diagObjProps();
        } catch (eObjProps) {}
      }
      if (
        DIAG_ATPC_SET &&
        phase >= PH.READY &&
        !atpcSetDone &&
        Date.now() - phaseSince > 3000
      ) {
        try {
          diagAtpcSet();
        } catch (eSet) {}
      }
      if (phase >= PH.READY && survPawnObj && !survPawnObj.isNull()) {
        try {
          const gpR = survPawnObj.add(0x3158).readPointer();
          const gpS = gpR.toString();
          if (gpS !== lastGpsRef) {
            const gpN = gpR.isNull() ? 'null' : objectName(gpR);
            log('GPSREF ' + new Date().toISOString() + ' ' + lastGpsRef + ' -> ' + gpS + ' nome=' + gpN);
            lastGpsRef = gpS;
          }
        } catch (eGr) {}
      }
      if (phase >= PH.READY && !cutsceneFixDone && Date.now() - phaseSince > 5000) {
        cutsceneFixDone = true;
        try {
          const blk = survPawnObj && !survPawnObj.isNull() ? survPawnObj.add(0x16e0).add(8).readS32() : 0;
          log('CUTSCENE_FIX blockers num=' + blk);
          if (blk > 0) {
            const cc = cmdTarget('cutcomp');
            const cfn = cc ? findUFnWide(cc, 'CutsceneFinish') : null;
            if (cfn) {
              const cbuf = Memory.alloc(256);
              for (let i = 0; i < 256; i++) cbuf.add(i).writeU8(0);
              processEventFn(cc, cfn, cbuf);
              log('CUTSCENE_FIX CutsceneFinish chamado');
            } else {
              log('CUTSCENE_FIX CutsceneFinish nao encontrado');
            }
          }
        } catch (eCf) {
          log('CUTSCENE_FIX erro ' + eCf);
        }
      }
      if (phase >= PH.READY && !camLocDone && Date.now() - phaseSince > 4000) {
        camLocDone = true;
        try {
          callCamLoc(findAtpcCameraComp(), 'READY');
          callMeshLoc('READY');
          diagAnim();
        } catch (eCam) {}
      }
      if (phase >= PH.READY && !animApiDone && Date.now() - phaseSince > 6000) {
        animApiDone = true;
        try {
          diagAnimApi();
        } catch (eAA) {}
      }
      if (phase >= PH.READY && !vtDone && Date.now() - phaseSince > 7000) {
        vtDone = true;
        try {
          diagVtable();
        } catch (eVT) {}
      }
      if (
        phase >= PH.READY &&
        !animInitDone &&
        Date.now() - phaseSince > 9000
      ) {
        animInitDone = true;
        try {
          applyAnimInit();
        } catch (eAI) {}
      }
      if (phase >= PH.READY && !guardDone && Date.now() - phaseSince > 5000) {
        guardDone = true;
        try {
          diagGuard();
        } catch (eG7) {}
      }
      if (phase >= PH.READY && !slotsPreDone && Date.now() - phaseSince > 5000) {
        slotsPreDone = true;
        try {
          diagSlots('PRE');
        } catch (eSP) {}
      }
      if (phase >= PH.READY && !pawnApiDone && Date.now() - phaseSince > 7000) {
        pawnApiDone = true;
        try {
          diagPawnApi();
        } catch (ePA) {}
      }
      if (phase >= PH.READY && !visFixDone && Date.now() - phaseSince > 8000) {
        try {
          applyVisFix();
        } catch (eVF) {
          log('VISFIX tick exc ' + eVF);
        }
      }
      if (
        phase >= PH.READY &&
        visFixDone &&
        !visFixRecheckDone &&
        visFixAt > 0 &&
        Date.now() - visFixAt > 2000
      ) {
        visFixRecheckDone = true;
        try {
          diagSlots('POSVIS');
        } catch (ePV) {}
      }
      if (
        phase >= PH.READY &&
        visFixRecheckDone &&
        !visTglDone &&
        visFixAt > 0 &&
        Date.now() - visFixAt > 4500
      ) {
        try {
          applyVisToggle();
        } catch (eVT2) {
          log('VISTGL tick exc ' + eVT2);
        }
      }
      if (
        phase >= PH.READY &&
        visTglDone &&
        !visTglRecheckDone &&
        visTglAt > 0 &&
        Date.now() - visTglAt > 2000
      ) {
        visTglRecheckDone = true;
        try {
          diagSlots('POSTGL');
        } catch (ePT) {}
      }
      if (
        phase >= PH.READY &&
        visTglRecheckDone &&
        !slotVisDone &&
        visTglAt > 0 &&
        Date.now() - visTglAt > 4500
      ) {
        try {
          applySlotVis();
        } catch (eSV) {
          log('SLOTVIS tick exc ' + eSV);
        }
      }
      if (
        phase >= PH.READY &&
        slotVisDone &&
        !slotVisRecheckDone &&
        slotVisAt > 0 &&
        Date.now() - slotVisAt > 2000
      ) {
        slotVisRecheckDone = true;
        try {
          diagSlots('POSSV');
        } catch (ePSV) {}
      }
      if (phase >= PH.READY && !probeDone && Date.now() - phaseSince > 6000) {
        try {
          animProbeTick();
        } catch (eAP) {
          log('ANIMPROBE outer exc ' + eAP);
          probeDone = true;
        }
      }
      if (
        phase >= PH.READY &&
        slotVisRecheckDone &&
        !fullyLoadDone &&
        slotVisAt > 0 &&
        Date.now() - slotVisAt > 20000
      ) {
        try {
          applyFullyLoad();
        } catch (eFL) {
          log('FULLYLOAD tick exc ' + eFL);
        }
      }
      if (
        phase >= PH.READY &&
        fullyLoadDone &&
        !fullyLoadRecheckDone &&
        fullyLoadAt > 0 &&
        Date.now() - fullyLoadAt > 3000
      ) {
        fullyLoadRecheckDone = true;
        try {
          diagSlots('POSFULL');
        } catch (ePF) {}
        // C: InitLocalPlayer 15s depois do FullyLoad
        // (bloco irmao executado no tick â€” ver applyInitLocal)
        // A': o FullyLoad trocou o AnimClass do mesh?
        try {
          const compsF = findMeshComps();
          for (let fi = 0; fi < compsF.length; fi++) {
            if (objectName(compsF[fi]) === 'CharacterMesh0') {
              const hac = findPropOffset(compsF[fi], 'AnimClass');
              if (hac && hac.off >= 0) {
                const acp = compsF[fi].add(hac.off).readPointer();
                log('FULLYLOAD AnimClass=' + (acp.isNull() ? 'NULL' : objectName(acp)));
              }
            }
          }
        } catch (eAC) {
          log('FULLYLOAD AnimClass exc ' + eAC);
        }
      }
      if (
        phase >= PH.READY &&
        fullyLoadRecheckDone &&
        !initLocalDone &&
        fullyLoadAt > 0 &&
        Date.now() - fullyLoadAt > 15000
      ) {
        try {
          applyInitLocal();
        } catch (eIL2) {
          log('INITLOCAL tick exc ' + eIL2);
        }
      }
      if (
        phase >= PH.READY &&
        initLocalDone &&
        !initLocalRecheckDone &&
        initLocalAt > 0 &&
        Date.now() - initLocalAt > 3000
      ) {
        initLocalRecheckDone = true;
        try {
          diagSlots('POSINIT');
        } catch (ePI) {}
      }
      if (phase >= PH.READY && !treeDone && Date.now() - phaseSince > 6000) {
        treeDone = true;
        try {
          diagTreeInv();
        } catch (eT) {}
      }
      if (phase >= PH.READY && !boneSnap1Done && Date.now() - phaseSince > 11000) {
        boneSnap1Done = true;
        try {
          diagBoneWide(1);
        } catch (eB1) {}
      }
      if (phase >= PH.READY && !instVarsDone && Date.now() - phaseSince > 12000) {
        instVarsDone = true;
        try {
          diagInstVars();
        } catch (eIV) {}
      }
      if (phase >= PH.READY && !boneSnap2Done && Date.now() - phaseSince > 13500) {
        boneSnap2Done = true;
        try {
          diagBoneWide(2);
        } catch (eB2) {}
      }
      if (
        animInitDone &&
        !animInitRecheckDone &&
        animInitAt > 0 &&
        Date.now() - animInitAt > 1500
      ) {
        animInitRecheckDone = true;
        log('ANIM_INIT depois:');
        try {
          diagAnim();
        } catch (eAR2) {}
      }
      if (
        ANIM_FIX_ON &&
        phase >= PH.READY &&
        !animFixDone &&
        Date.now() - phaseSince > 8000
      ) {
        animFixDone = true;
        try {
          applyAnimFix();
        } catch (eAF) {}
      }
      if (
        animFixDone &&
        !animFixRecheckDone &&
        animFixAt > 0 &&
        Date.now() - animFixAt > 1500
      ) {
        animFixRecheckDone = true;
        log('ANIM_FIX depois:');
        try {
          diagAnim();
        } catch (eAR) {}
      }
      if (DIAG_DIFF && diffSnapPending && Date.now() >= diffSnapAt) {
        const kindD = diffSnapPending;
        diffSnapPending = null;
        diffSnapAt = 0;
        try {
          diagDiffSnap(kindD);
        } catch (eDiff) {}
      }
      // READY: pin pos-land (DESLIGADO no experimento C â€” ver DIAG_Z)
      if (
        POST_LAND_WATCHDOG &&
        phase >= PH.READY &&
        dropState >= 2 &&
        !pendingRescueZ &&
        postLandLifts < POST_LAND_LIFT_MAX &&
        Date.now() - lastSoftLiftAt > POST_LAND_INTERVAL_MS
      ) {
        try {
          const locR = readPawnZQuick();
          if (
            locR &&
            isFinite(locR.z) &&
            locR.z !== -999999 &&
            Math.abs(locR.z) < 5e6 &&
            (locR.z < POST_LAND_DEEP_Z || locR.z > CITY_Z_MAX)
          ) {
            pendingRescueZ = true;
          }
        } catch (eUnd) {}
      }
      if (pendingDumpLoc) {
        pendingDumpLoc = false;
        if (travelBusy) {
          log('dumpLoc defer (travelBusy)');
        } else {
          try {
            dumpLiveLocations('rpc');
          } catch (e) {
            log('dumpLoc erro: ' + e);
          }
        }
      }
      if (!GetAsyncKeyState) return;
      try {
        const f5 = (GetAsyncKeyState(0x74) & 0x8000) !== 0;
        const f6 = (GetAsyncKeyState(0x75) & 0x8000) !== 0;
        const f7 = (GetAsyncKeyState(0x76) & 0x8000) !== 0;
        const f8 = ((GetAsyncKeyState(0x77) & 0x8000) !== 0) || autoF8Tick();
        const f9 = (GetAsyncKeyState(0x78) & 0x8000) !== 0;
        const f10 = (GetAsyncKeyState(0x79) & 0x8000) !== 0;
        const f11 = (GetAsyncKeyState(0x7a) & 0x8000) !== 0;
        const f12 = (GetAsyncKeyState(0x7b) & 0x8000) !== 0;
        // SPACE desativado (removido do init): nao dispara browser/PrepareServerList. F12 faz o refresh manual.
        const space = false;
        if (space && !spaceWas) {
          log(
            '[KEY] SPACE down â€” Server Browser (ESC=so Continue/Settings/Quit; sem Server no pause)'
          );
          boostBrowserCache('SPACE');
          if (!autoPrepDone && found.PrepareServerList) {
            autoPrepDone = true;
            pendingBrowser = true;
            log('[KEY] SPACE â†’ auto PrepareServerList (se ParmsSize==0)');
          }
        }
        if (!space && spaceWas) {
          autoPrepDone = false;
        }
        if (f5 && !f5Was) {
          log(
            '[KEY] F5 IGNORADO â€” FakeLogin/LoadFrom = Fatal AV. Espere Jump pos-Landscape (fase WAIT_PAWN).'
          );
        }
        if (f6 && !f6Was) {
          if (!survPcObj || !survPawnObj) {
            log(
              '[KEY] F6 SKIP â€” sem SurvivalPlayer. F8 â†’ espere PHASE READY (corpo automatico).'
            );
          } else if (phase < PH.GROUND) {
            log('[KEY] F6 adiado â€” ainda fase ' + phase + ' (espera chao)');
          } else {
            log('[KEY] F6 â€” applyBody + release (manual)');
            bodyApplyDone = false;
            releaseDone = false;
            makePlayableDone = false;
            pendingMakePlayable = true;
          }
        }
        if (f7 && !f7Was) {
          log(
            '[KEY] F7 HideLoading (nao resolve Placeholder vermelho; usa F5)'
          );
          pendingHideLoading = true;
        }
        if (f8 && !f8Was) {
          if (travelBusy) {
            log('[KEY] F8 ignorado â€” travelBusy (anti world-leak)');
          } else if (travelDone) {
            log(
              '[KEY] F8 ignorado (ja em NewCity) â€” re-travel = Fatal world leaks. Reinicie o exe p/ novo F8.'
            );
          } else {
            log('[KEY] F8 down â€” TravelURL NewCity?listen (1x)');
            pendingTravel = true;
          }
        }
        if (f9 && !f9Was) {
          log('[KEY] F9 down â€” dump UFunctions GI_Survival (achar Host/StartLevel)');
          pendingDump = true;
        }
        if (f10 && !f10Was) {
          log(
            '[KEY] F10 down â€” host/spawn 0-arg (blacklist SetSpawnRegion/Join/InitClient)'
          );
          pendingInvoke = true;
        }
        if (f11 && !f11Was) {
          log('[KEY] F11 down â€” rebind ProcessEvent');
          peHooked = false;
          const eng = getEngine();
          if (eng) discoverProcessEvent(eng);
        }
        if (f12 && !f12Was) {
          log('[KEY] F12 down â€” PrepareServerList (browser refresh)');
          pendingBrowser = true;
        }
        f5Was = f5;
        f6Was = f6;
        f7Was = f7;
        f8Was = f8;
        f9Was = f9;
        f10Was = f10;
        f11Was = f11;
        f12Was = f12;
        spaceWas = space;
      } catch (e) {}

      if (pendingTravel) {
        pendingTravel = false;
        try {
          forceTravelListen('F8');
        } catch (e) {
          log('F8 ERRO JS: ' + e);
        }
      }
      if (pendingDump) {
        pendingDump = false;
        try {
          const eng = getEngine();
          const gi = eng ? findGameInstance(eng) : null;
          dumpGiFunctions(gi);
        } catch (e) {
          log('F9 ERRO JS: ' + e);
        }
      }
      if (pendingInvoke) {
        pendingInvoke = false;
        try {
          invokeHostFlow();
        } catch (e) {
          log('F10 ERRO JS: ' + e);
        }
      }
      if (pendingBrowser) {
        pendingBrowser = false;
        try {
          invokeBrowserRefresh(autoPrepDone);
        } catch (e) {
          log('F12 ERRO JS: ' + e);
        }
      }

      // Expire browser boost
      if (browserMode && Date.now() > browserBoostUntil) {
        browserMode = false;
        log('browser-mode OFF (timer)');
      }
    },
  });

  const eng0 = getEngine();
  if (eng0) {
    log('ready base=' + main.base + ' GEngine=' + eng0 + ' name=' + objectName(eng0));
    discoverProcessEvent(eng0);
    try {
      const gi0 = findGameInstance(eng0);
      if (gi0) harvestFuncsFromObject(gi0);
    } catch (e) {}
  } else {
    log('GEngine null â€” esperando Tick...');
    let armed = true;
    tickListenerArmado = Interceptor.attach(tickAddress, {
      onEnter: function () {
        if (!armed) return;
        const e = getEngine();
        if (!e) return;
        armed = false;
        log('GEngine apareceu ' + e);
        discoverProcessEvent(e);
      },
    });
  }

  log(
    'Fases auto: F8 -> TRAVEL -> STREAM -> WAIT_PAWN -> GROUND -> BODY -> RELEASE -> READY'
  );
  log(
    'Teclas: F8=listen | F6=forcar corpo/input | F7 HideLoading | F12 PrepareServerList | F10 | F9 | F11 | F5=BLOQUEADO'
  );
  log('Nao attach scripts com jogo aberto. Nao JoinToServer/FakeLogin.');

  rpc.exports = {
    // HideLoading: so via Tick (PE da thread Frida = freeze)
    hideLoading: function () {
      hideLoadingDone = false;
      hideLoadingQueued = false;
      pendingHideLoading = true;
      return 'queued';
    },
    // So via Tick â€” PE direto da thread Frida pode freeze
    rescueZ: function () {
      if (rescueVoidZAttempts < RESCUE_Z_MAX) pendingRescueZ = true;
      return 'queued attempts=' + rescueVoidZAttempts;
    },
    unstick: function () {
      hideLoadingDone = false;
      pendingHideLoading = true;
      if (rescueVoidZAttempts < RESCUE_Z_MAX) pendingRescueZ = true;
      return 'queued hide+rescueZ';
    },
    makePlayable: function () {
      makePlayableDone = false;
      pendingMakePlayable = true;
      return 'queued';
    },
    status: function () {
      return {
        phase: phase,
        travelArmed: travelArmed,
        travelDone: travelDone,
        travelBusy: travelBusy,
        landscapeShown: landscapeShown,
        wpShownCount: wpShownCount,
        sawSurvivalPlayer: sawSurvivalPlayer,
        sawPlaceholder: sawPlaceholder,
        jumpPatched: jumpPatched,
        hideLoadingDone: hideLoadingDone,
        pendingHideLoading: pendingHideLoading,
        pendingRescueZ: pendingRescueZ,
        bodyApplyDone: bodyApplyDone,
        releaseDone: releaseDone,
        makePlayableDone: makePlayableDone,
        moveBridgeOn: moveBridgeOn,
        moveBridgeCount: moveBridgeCount,
        survPc: !!survPcObj,
        survPawn: !!survPawnObj,
        spawnActorsSeen: Object.keys(spawnActorsSeen).length,
        mapAnchors: Object.keys(mapAnchorActors).length,
        mapSpawns: rescueVoidZ._mapSpawns ? rescueVoidZ._mapSpawns.length : 0,
      };
    },
    // Queue dump no Tick (PE da thread Frida = freeze)
    dumpLoc: function () {
      pendingDumpLoc = true;
      return (
        'queued spawnsSeen=' +
        Object.keys(spawnActorsSeen).length +
        ' anchors=' +
        Object.keys(mapAnchorActors).length
      );
    },
  };
}



