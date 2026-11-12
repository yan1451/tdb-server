"""Servidor proprio com host nativo (The Day Before): runner unico - VERSAO OTIMIZADA (host_otimizado/, ver host_otimizado/LEIA.md).
Uso:  python -I servidor_host.py                 (padrao: sem janela, F8 automatico, modo leve)
      python -I servidor_host.py --com-janela    (com janela: apertar F8 no host depois do menu; continua leve)
      python -I servidor_host.py --diag          (sem o modo leve: monitores e diagnosticos ligados, mais lento)
  1. Sobe os servicos que estiverem parados: emulador do Firestore (8081), ponte IPv6 ([::1]:8081), terminador TLS (443);
     cria os certificados locais e o servidor "SERVIDOR-LOCAL" na lista, se faltarem.
  2. Confere a porta UDP do listen (7777).
  3. Sobe o host (TheDayBefore.exe) com os scripts Frida de scripts\ numa unica sessao.
  4. Exporta o Firestore (servicos\firestore_emu\emu_data) a cada 60 s e ao sair (o emulador so guarda em memoria).
Pasta do jogo: variavel de ambiente TDB_JOGO (padrao C:\\Games\\THE DAY BEFORE).
Roda ate o host fechar (ou Ctrl+C). Log: %TEMP%\\servidor_host[_headless].out"""
import os, sys, time, json, subprocess, socket, shutil, threading, urllib.request
import frida

def _pasta_jogo():
    """08/11: TDB_JOGO > pasta escolhida no launcher (launcher\config.json) > padrao."""
    if os.environ.get("TDB_JOGO"):
        return os.environ["TDB_JOGO"]
    try:
        cfg = json.loads(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "launcher", "config.json"), encoding="utf-8").read())
        if cfg.get("pasta_jogo"):
            return cfg["pasta_jogo"]
    except Exception:
        pass
    return r"C:\Games\THE DAY BEFORE"


JOGO = _pasta_jogo()
WD = os.path.join(JOGO, r"Survival\Binaries\Win64")
EXE = os.path.join(WD, "TheDayBefore.exe")
AQUI = os.path.dirname(os.path.abspath(__file__))           # ...\host
FRIDA = os.path.join(AQUI, "scripts")                         # scripts Frida do host
SERVICOS = os.path.join(os.path.dirname(AQUI), "servicos")    # ...\servicos
PY = sys.executable
TMP = os.environ["TEMP"]
# 06/11: opcoes
#   --sem-interface : host sem janela/placa de video (-nullrhi -nosound) e F8 automatico (auto_f8.js)
#   --porta N       : porta UDP do listen (padrao 7777). Outra porta serve para testar sem derrubar o host atual
#                     (a lista de servidores aponta para 7777, entao o cliente so entra pela 7777).
# Padrao: SEM INTERFACE e MODO LEVE (o recomendado). --com-janela abre o jogo com janela (apertar F8 depois do menu);
# --diag desliga o modo leve (mantem monitores/diagnosticos dos scripts, mais lento). --sem-interface fica aceito (era o antigo).
SEM_INTERFACE = "--com-janela" not in sys.argv
LEVE = "--diag" not in sys.argv
PORTA = int(sys.argv[sys.argv.index("--porta") + 1]) if "--porta" in sys.argv else 7777
OUT = os.path.join(TMP, "servidor_host%s%s.out" % ("_headless" if SEM_INTERFACE else "", "" if PORTA == 7777 else "_%d" % PORTA))
# tdb_connectex_test.js (copia do cliente) vem DEPOIS do ssl_unpin.js: o ssl_unpin desvia antes os IPs de autenticacao
# para 127.0.0.1:8080; o resto do Google:443 (Firestore gRPC) vai para o terminador TLS -> emulador, desde a abertura.
SCRIPTS = ["ssl_unpin.js", "tdb_connectex_test.js", "fake_server_join.js", "host_flow_servidor.js",
           "modo_dedicado.js", "listen_nativo.js", "replicacao_otimizada.js", "disparar_onserverload.js",
           "reaplicar_aparencia.js",
           "quest_fix.js",
           "id_unico.js",
           "carregar_dados.js",
           "timeout_conexao.js"]   # 10/11: ConnectionTimeout 300 s (queda ao ir para o terreno)   # 10/11: chama SurvPC.LoadUserInfo (sem isso o jogador nasce na sala do doutor)
#   # 10/11: so leitura - registra tutorial/posicao salva (bug de nascer na sala do doutor)
#   # 10/11: contador de ID dos itens nao recomeca de 0 (itens sumindo do bau por ID repetido)
#   # 07/11: itens de quest (QuestList dos baus preenchido quando o mapa estabiliza)   # 07/11: rosto/cabelo/barba de quem chega depois (multicast perdido)
# host_otimizado (07/11): replicacao_otimizada.js substitui replicacao.js + replicacao_donos.js + replicacao_distancia.js
# (laco em C/CModule + NetUpdateFrequency). --sem-frequencia: mesmo laco em C sem o ritmo por ator (para comparar).
# --freq-min N: piso de atualizacoes por segundo (padrao 4).
# monitor_bugs.js (06/11): vigia itens sumindo e tiro em zumbi fantasma; filtro em C (CModule), barato. --sem-monitores desliga.
if "--sem-monitores" not in sys.argv:
    SCRIPTS.append("monitor_bugs.js")
    SCRIPTS.append("monitor_ping.js")   # ping de cada jogador a cada 15 s (APlayerState.CompressedPing x4)
    SCRIPTS.append("monitor_posicao.js")   # posicao do pawn de cada jogador no servidor (teleporte, queda, troca de pawn)
# resgate_queda.js (06/11): unstuck automatico (6 s caindo ou abaixo do mapa) e manual (linux/unstuck.sh). --sem-resgate desliga.
if "--sem-resgate" not in sys.argv:
    SCRIPTS.append("resgate_queda.js")
# 10/11: diagnostico de desempenho: TDB_SEM_SCRIPTS=a.js,b.js tira scripts da lista (bisseccao do atraso do host).
for _x in [t for t in os.environ.get("TDB_SEM_SCRIPTS", "").split(",") if t]:
    if _x in SCRIPTS: SCRIPTS.remove(_x)
# LocalAppData proprio (06/11): na porta de teste (ou com --appdata-separado) a instancia usa outra pasta LocalAppData, porque o banco
# local do Firestore (LevelDB com LOCK) em %LOCALAPPDATA%\firestore so abre em um processo por usuario (a 2a instancia caia).
APPDATA_SEPARADO = ("--appdata-separado" in sys.argv) or PORTA != 7777
# 10/11 18:3x: carregar_dados.js so no Offline (host e cliente no mesmo PC). Na VPS o jogo ja carregava os dados sozinho e a
# chamada extra chegou DEPOIS do spawn -> teleporte para a posicao salva -> jogador no limbo (visto 18:29-18:34).
# 10/11 19:3x: volta a rodar tambem na VPS (agora pede de novo quando a 1a leitura falha por conexao velha com o banco).
# 10/11 13:1x: a pasta do host SAIU de %LOCALAPPDATA%. O app do Claude (MSIX) virtualiza AppData\Local para os processos que ele
# abre: as gravacoes iam para AppData\Local\Packages\Claude_*\LocalCache, mas a exclusao de arquivos antigos atingia a pasta real ->
# o banco local do Firestore REAL ficou com CURRENT apontando para um MANIFEST apagado ("Corruption: CURRENT points to a non-existent
# file") e o Offline pelo launcher caia ~4 s depois do menu. Na pasta do projeto (servicos\) todo mundo enxerga os mesmos arquivos.
APPDATA_DIR = os.path.join(SERVICOS, "appdata_host_%d" % PORTA)
def _banco_corrompido_de_lado(pasta):
    """Se o CURRENT do banco local do Firestore aponta para um MANIFEST que nao existe, move o banco de lado (o jogo cria outro;
    os saves ficam no emulador, nao nesse cache)."""
    main = os.path.join(pasta, "firestore", "__FIRAPP_DEFAULT", "the-day-before-8f438", "main")
    try:
        cur = open(os.path.join(main, "CURRENT"), encoding="ascii", errors="replace").read().strip()
    except OSError:
        return
    if cur and os.path.exists(os.path.join(main, cur)):
        return
    destino = main + "_corrompido_" + time.strftime("%Y%m%d_%H%M%S")
    try:
        os.rename(main, destino)
        print(time.strftime("%H:%M:%S ") + "[lock] banco local CORROMPIDO (CURRENT -> %s, que nao existe): movido para %s" % (cur, destino), flush=True)
    except OSError as e:
        print(time.strftime("%H:%M:%S ") + "[lock] banco local corrompido e nao consegui mover: %s" % e, flush=True)

def _lock_firestore_livre(pasta):
    """True se o LOCK do banco local do Firestore (LevelDB) desta pasta pode ser aberto sem compartilhamento (ninguem segura)."""
    import ctypes
    from ctypes import wintypes
    lock = os.path.join(pasta, "firestore", "__FIRAPP_DEFAULT", "the-day-before-8f438", "main", "LOCK")
    if not os.path.exists(lock):
        return True
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateFileW.restype = wintypes.HANDLE
    h = k.CreateFileW(lock, 0x80000000, 0, None, 3, 0, None)
    if h == wintypes.HANDLE(-1).value:
        return False
    k.CloseHandle(h)
    return True
def _quem_segura(pasta):
    """Processos que estao com os arquivos do banco local do Firestore abertos (API Restart Manager do Windows)."""
    try:
        import ctypes
        from ctypes import wintypes
        main = os.path.join(pasta, "firestore", "__FIRAPP_DEFAULT", "the-day-before-8f438", "main")
        if not os.path.isdir(main):
            return "pasta do banco ainda nao existe"
        arqs = [os.path.join(main, n) for n in os.listdir(main)]
        rm = ctypes.WinDLL("rstrtmgr")
        class UNIQ(ctypes.Structure): _fields_ = [("pid", wintypes.DWORD), ("t", wintypes.FILETIME)]
        class INFO(ctypes.Structure):
            _fields_ = [("p", UNIQ), ("app", ctypes.c_wchar * 256), ("svc", ctypes.c_wchar * 64), ("tipo", ctypes.c_int),
                        ("st", wintypes.DWORD), ("sess", wintypes.DWORD), ("rest", wintypes.BOOL)]
        h = wintypes.DWORD(); chave = ctypes.create_unicode_buffer(64)
        if rm.RmStartSession(ctypes.byref(h), 0, chave):
            return "RmStartSession falhou"
        try:
            lst = (ctypes.c_wchar_p * len(arqs))(*arqs)
            rm.RmRegisterResources(h, len(arqs), lst, 0, None, 0, None)
            prec, n, mot = wintypes.UINT(0), wintypes.UINT(0), wintypes.DWORD()
            rm.RmGetList(h, ctypes.byref(prec), ctypes.byref(n), None, ctypes.byref(mot))
            if prec.value == 0:
                return "ninguem"
            n.value = prec.value; buf = (INFO * prec.value)()
            rm.RmGetList(h, ctypes.byref(prec), ctypes.byref(n), buf, ctypes.byref(mot))
            return ", ".join("%s (PID %d)" % (buf[i].app, buf[i].p.pid) for i in range(n.value))
        finally:
            rm.RmEndSession(h)
    except Exception as e:
        return "? (%s)" % e
def _jogos_abertos():
    try:
        r = subprocess.run(["tasklist", "/FO", "CSV", "/NH", "/FI", "IMAGENAME eq TheDayBefore.exe"], capture_output=True, text=True, encoding="oem", errors="replace",   # 10/11: Windows em russo (cp866)
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.strip()
        return ", ".join("PID " + l.split('","')[1] for l in r.splitlines() if l.startswith('"')) or "nenhum"
    except Exception as e:
        return "? (%s)" % e
# 10/11: o Offline pelo launcher caia ~4 s depois do menu com "FIRESTORE INTERNAL ASSERTION FAILED ... FirestoreClient::Initialize"
# (0xe06d7363): o banco local do Firestore desta pasta ainda estava aberto por um processo do jogo da subida anterior (o launcher
# encerra o host com taskkill /T /F; uma queda fica presa no WER). Reproduzido segurando o LOCK (12:45). Espera ate 30 s o LOCK ficar
# livre; se nao ficar, usa uma pasta nova so nesta subida (o cache local do host nao e a fonte dos saves: eles ficam no emulador).
if APPDATA_SEPARADO and os.name == "nt":
    _banco_corrompido_de_lado(APPDATA_DIR)
    print(time.strftime("%H:%M:%S ") + "[lock] jogos abertos antes de subir: " + _jogos_abertos(), flush=True)
    print(time.strftime("%H:%M:%S ") + "[lock] arquivos do banco abertos por: " + _quem_segura(APPDATA_DIR), flush=True)
    def _vigia_lock(t0=time.time()):   # 10/11: a queda vem ~9 s depois de abrir o jogo: quem segura o banco nessa janela
        for _s in (14, 17, 20, 23, 26):
            time.sleep(max(0, t0 + _s - time.time()))
            print(time.strftime("%H:%M:%S ") + "[lock] +%d s: banco aberto por: %s | jogos: %s" % (_s, _quem_segura(APPDATA_DIR), _jogos_abertos()), flush=True)
    threading.Thread(target=_vigia_lock, daemon=True).start()
    for _i in range(30):
        if _lock_firestore_livre(APPDATA_DIR):
            if _i:
                print(time.strftime("%H:%M:%S ") + "[lock] liberado depois de %d s" % _i, flush=True)
            break
        if _i == 0:
            print(time.strftime("%H:%M:%S ") + "[lock] banco local do Firestore EM USO em " + APPDATA_DIR + "; esperando liberar (ate 30 s)", flush=True)
        time.sleep(1)
    else:
        APPDATA_DIR = APPDATA_DIR + "_" + time.strftime("%Y%m%d_%H%M%S")
        print(time.strftime("%H:%M:%S ") + "[lock] continuou em uso (jogos: " + _jogos_abertos() + "): esta subida usa a pasta nova " + APPDATA_DIR, flush=True)
if APPDATA_SEPARADO:
    SCRIPTS.insert(0, "appdata_separado.js")
if "--sem-diag-excecao" not in sys.argv:   # 10/11: LIGADO SEMPRE (so leitura) - Offline caia com 0xe06d7363 no menu so pelo launcher. 06/11: registra excecoes C++ (tipo, what, backtrace) - investigacao da 2a instancia
    SCRIPTS.insert(0, "captura_excecao.js")
# F8 automatico (--sem-interface): feito DENTRO do host_flow_servidor.js (autoF8Tick, ativado por `var AUTO_F8_MS`).
# O auto_f8.js (hook externo em GetAsyncKeyState) NAO funciona carregado por este runner: 0 leituras vistas, mesmo numa
# 2a sessao; so funcionou carregado por outro processo Python (06/11 11:00 e 11:08). Ficou como ferramenta manual.
EMU = os.path.join(SERVICOS, "firestore_emu")
EXPORT_A_CADA = 60   # segundos
MARCOS = ("LISTEN OK", "reenviada a aparencia", "[qfix]", "ABORTADO", "ERRO", "DESLIGADO", "NetMode", "canal aberto: Pawn", "chamando OnServerLoad",
          "LoginCompleted", "PHASE", "placeholder de cliente visto", "SurvivalPlayer_V2_C", "InitPlayer", "OnError", "erro",
          "SteamId", "Firestore", "ConnectEx IPv", "ITEM SUMIU", "TIRO EM ZUMBI LONGE", "[ping]", "alvos vigiados", "canal FECHADO",
          "TELEPORTE", "TROCOU PAWN", "SEM PAWN", "classe preservada", "RESGATE", "pedido manual", "[otim]")

# Identidade Steam (emulador Goldberg): host e cliente usam a mesma instalacao, e o emulador le o ID ao abrir o processo
# (force_steamid.txt da pasta do Engine, onde esta o steam_api64.dll carregado; configs.user.ini gravado junto).
# O host abre com o ID dele; 30 s depois, os arquivos voltam para o ID do cliente (o cliente_conecta.py tambem grava o dele).
HOST_STEAM_ID, HOST_NOME = "76561197960271872", "HostTDB"
CLIENTE_STEAM_ID, CLIENTE_NOME = "76561197960287930", "Jogador1"
STEAM_ENGINE = os.path.join(JOGO, r"Engine\Binaries\ThirdParty\Steamworks\Steamv153\Win64\steam_settings")
STEAM_CFG = os.path.join(WD, r"steam_settings\configs.user.ini")

fh = open(OUT, "w", encoding="utf-8")
def log(s, tela=True):
    line = time.strftime("%H:%M:%S ") + s
    fh.write(line + "\n"); fh.flush()
    if tela: print(line, flush=True)

# --sem-servicos (Linux/Wine): os servicos (Firestore, TLS, ponte) rodam nativos no Linux (linux/iniciar_servicos.sh) e exportam o
# Firestore por conta propria; aqui so se abre o jogo com os scripts. No Wine nao ha PowerShell: ps() devolve vazio.
SEM_SERVICOS = "--sem-servicos" in sys.argv

def ps(cmd):
    if SEM_SERVICOS:
        return ""
    try:
        return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], capture_output=True, text=True).stdout.strip()
    except Exception:
        return ""

def escutando_tcp(porta, endereco):
    """Ve se ha algo escutando conectando na porta (funciona no Windows, no Wine e no Linux)."""
    fam = socket.AF_INET6 if ":" in endereco else socket.AF_INET
    s = socket.socket(fam, socket.SOCK_STREAM)
    s.settimeout(1.5)
    try:
        s.connect((endereco, porta)); return True
    except Exception:
        return False
    finally:
        s.close()

def iniciar(args, cwd, nome):
    err = open(os.path.join(TMP, nome + ".err"), "w")
    subprocess.Popen(args, cwd=cwd, stdout=err, stderr=err, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)
    log("iniciado: " + nome)

def definir_identidade(steam_id, nome):
    with open(os.path.join(STEAM_ENGINE, "force_steamid.txt"), "wb") as f: f.write(steam_id.encode("ascii"))
    with open(os.path.join(STEAM_ENGINE, "force_account_name.txt"), "wb") as f: f.write(nome.encode("ascii"))
    linhas = open(STEAM_CFG, encoding="ascii").read().splitlines()
    linhas = [("steam_id = " + steam_id) if l.strip().startswith("steam_id") else
              ("account_name = " + nome) if l.strip().startswith("account_name") else l for l in linhas]
    with open(STEAM_CFG, "w", encoding="ascii", newline="\n") as f: f.write("\n".join(linhas) + "\n")
    log("identidade Steam nos arquivos: %s (%s)" % (steam_id, nome))

def devolver_identidade():
    """10/11: so devolve o ID do cliente se os arquivos AINDA tem o ID do host. Antes gravava sempre, 30 s depois de abrir: no
    Offline do launcher o cliente abre logo apos o LISTEN OK (as vezes antes desses 30 s) e grava o proprio ID (ex.: ...287931);
    o host sobrescrevia com ...287930 um segundo depois e o jogo abria com o ID errado = outro save (visto 10/11 08:58:53/54)."""
    try:
        with open(os.path.join(STEAM_ENGINE, "force_steamid.txt"), "rb") as f:
            atual = f.read().decode("ascii", "replace").strip()
    except OSError:
        atual = HOST_STEAM_ID
    if atual != HOST_STEAM_ID:
        log("identidade Steam: arquivos ja tem %s (gravado pelo cliente); nao devolvo o ID padrao" % atual)
        return
    definir_identidade(CLIENTE_STEAM_ID, CLIENTE_NOME)

_export_lock = threading.Lock()

def exportar(motivo, bloquear=False):
    """Exporta o Firestore para emu_data de forma segura: exporta para emu_data_novo e so troca no fim, para um
    desligamento no meio do export nao corromper o emu_data. Guarda a versao anterior em emu_data_anterior."""
    if not _export_lock.acquire(blocking=bloquear):
        return
    try:
        atual = os.path.join(EMU, "emu_data"); novo = os.path.join(EMU, "emu_data_novo"); ant = os.path.join(EMU, "emu_data_anterior")
        shutil.rmtree(novo, ignore_errors=True)
        t0 = time.time()
        r = subprocess.run(["cmd", "/c", "firebase emulators:export ./emu_data_novo --force --project the-day-before-8f438 --only firestore"],
                           cwd=EMU, capture_output=True, text=True, timeout=180)
        if r.returncode != 0 or not os.path.exists(os.path.join(novo, "firebase-export-metadata.json")):
            log("EXPORT Firestore FALHOU (%s): %s" % (motivo, (r.stdout + r.stderr).strip()[-200:])); return
        shutil.rmtree(ant, ignore_errors=True)
        if os.path.isdir(atual): os.rename(atual, ant)
        os.rename(novo, atual)
        log("export Firestore ok (%s, %.0f s)" % (motivo, time.time() - t0), tela=(motivo != "periodico"))
    except Exception as e:
        log("EXPORT Firestore erro (%s): %s" % (motivo, e))
    finally:
        _export_lock.release()

def esperar(cond, seg, nome):
    fim = time.time() + seg
    while time.time() < fim:
        if cond(): log("ok: " + nome); return True
        time.sleep(1)
    log("FALHOU: " + nome); return False

# IP que os clientes usam para entrar (Linux/VPS: o IP publico). Variavel TDB_IP_PUBLICO; padrao 127.0.0.1 (mesmo PC).
IP_PUBLICO = os.environ.get("TDB_IP_PUBLICO", "127.0.0.1")
LISTA_URL = ("http://127.0.0.1:8081/v1/projects/the-day-before-8f438/databases/(default)/documents/"
             "server-list/us-central/versions/3/servers/%s:%d" % (IP_PUBLICO, PORTA))
# O jogo usa o NOME do documento (ip:porta) como endereco do join (medido 06/11 18:04: com o doc '127.0.0.1:7777' o cliente
# mandava o join para o proprio PC mesmo com o host na VPS). Nome exibido: TDB_NOME_SERVIDOR (padrao SERVIDOR-LOCAL).
NOME_SERVIDOR = os.environ.get("TDB_NOME_SERVIDOR", "SERVIDOR-LOCAL")

def criar_servidor_na_lista():
    """Cria/atualiza o documento que o Server Browser do jogo le (server-list/us-central/versions/3/servers)."""
    campos = {"Players": {"integerValue": "10"}, "Adress": {"stringValue": IP_PUBLICO}, "Port": {"integerValue": str(PORTA)},
              "Region": {"stringValue": "us-central"}, "ServerName": {"stringValue": NOME_SERVIDOR},
              "Name": {"stringValue": NOME_SERVIDOR}, "DisplayName": {"stringValue": NOME_SERVIDOR}}
    req = urllib.request.Request(LISTA_URL, data=json.dumps({"fields": campos}).encode(), method="PATCH",
                                 headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10).read()
    if IP_PUBLICO != "127.0.0.1":   # tira o servidor local antigo da lista (senao aparecem dois e o local leva o join ao PC)
        try:
            urllib.request.urlopen(urllib.request.Request(LISTA_URL.rsplit("/", 1)[0] + "/127.0.0.1:%d" % PORTA, method="DELETE"), timeout=10).read()
        except Exception:
            pass


def limpar_temp_frida(horas=1):
    """06/11: o Frida extrai o agente (~61 MB) em %TEMP%\frida-<codigo> a cada conexao e so apaga quando o Python termina de forma
    limpa; com processos encerrados a forca juntou 1460 pastas (60 GB). Apaga as com mais de `horas`; as em uso (DLL carregada) falham e ficam."""
    import tempfile
    base, n = tempfile.gettempdir(), 0
    for nome in os.listdir(base):
        if not nome.startswith("frida-"):
            continue
        p = os.path.join(base, nome)
        try:
            if time.time() - os.path.getmtime(p) < horas * 3600:
                continue
            shutil.rmtree(p)
            n += 1
        except Exception:
            pass
    return n
# ---- 0. pre-requisitos ----
_n = limpar_temp_frida()
if _n: log("limpeza: %d pastas antigas do Frida apagadas do TEMP" % _n)
if not os.path.exists(EXE):
    log("ABORTADO: jogo nao encontrado em " + EXE + " (defina a variavel TDB_JOGO com a pasta do jogo)"); sys.exit(1)
if ps("Get-Process | Where-Object ProcessName -match proxifier"):
    log("ABORTADO: Proxifier aberto (interfere no Firestore)"); sys.exit(1)
TLS = os.path.join(SERVICOS, "tls")
if not SEM_SERVICOS and not os.path.exists(os.path.join(TLS, "firestore.pem")):
    log("certificados locais ausentes: gerando (servicos\\tls\\make_local_ca.py)")
    subprocess.run([PY, "-I", os.path.join(TLS, "make_local_ca.py")], cwd=TLS, check=True)
if ps("Get-Process -Name TheDayBefore -ErrorAction SilentlyContinue"):
    log("aviso: ja existe TheDayBefore aberto (cliente ou host antigo). O host novo sera outro processo.")

# ---- 1. servicos da lista ----
if SEM_SERVICOS:
    for porta, nome_s in ((8081, "Firestore 127.0.0.1:8081"), (443, "terminador TLS 127.0.0.1:443")):
        if not esperar(lambda porta=porta: escutando_tcp(porta, "127.0.0.1"), 60, nome_s + " (iniciado fora, pelo linux/iniciar_servicos.sh)"):
            log("ABORTADO: suba os servicos antes (linux/iniciar_servicos.sh)"); sys.exit(1)
elif not escutando_tcp(8081, "127.0.0.1"):
    importar = "--import ./emu_data " if os.path.isdir(os.path.join(EMU, "emu_data")) else ""
    iniciar(["cmd.exe", "/c", "firebase emulators:start --only firestore --project the-day-before-8f438 " + importar + "--export-on-exit ./emu_data"], EMU, "firestore_emu")
    if not esperar(lambda: escutando_tcp(8081, "127.0.0.1"), 90, "Firestore em 127.0.0.1:8081"): sys.exit(1)
else:
    log("ok: Firestore ja em 127.0.0.1:8081")
if SEM_SERVICOS:
    pass
elif not escutando_tcp(8081, "::1"):
    iniciar([PY, "-I", os.path.join(SERVICOS, "ipv6_bridge.py")], SERVICOS, "ipv6_bridge")
    esperar(lambda: escutando_tcp(8081, "::1"), 15, "ponte IPv6 [::1]:8081")
else:
    log("ok: ponte IPv6 ja em [::1]:8081")
if SEM_SERVICOS:
    pass
elif not escutando_tcp(443, "127.0.0.1"):
    iniciar([PY, os.path.join(TLS, "tls_front.py")], TLS, "tls_front")
    esperar(lambda: escutando_tcp(443, "127.0.0.1"), 15, "terminador TLS 127.0.0.1:443")
else:
    log("ok: terminador TLS ja em 443")
try:
    criar_servidor_na_lista(); log("ok: SERVIDOR-LOCAL (%s:%d) na lista de servidores" % (IP_PUBLICO, PORTA))
except Exception as e:
    log("AVISO: nao consegui gravar o servidor na lista (%s)" % e)

# ---- 2. porta 7777 ----
out = ps("Get-NetUDPEndpoint -LocalPort %d -ErrorAction SilentlyContinue | ForEach-Object { $p=$_.OwningProcess; $c=(Get-CimInstance Win32_Process -Filter \"ProcessId=$p\").CommandLine; \"$p|$c\" }" % PORTA)
for l in out.splitlines():
    if "|" not in l: continue
    pid7777, cmd = l.split("|", 1)
    if "servidor_v4" in cmd or "servidor_challenge" in cmd:
        log("porta 7777 com servidor Python (PID %s): encerrando" % pid7777); ps("Stop-Process -Id %s -Confirm:$false" % pid7777); time.sleep(1)
    else:
        log("ABORTADO: porta %d ocupada por PID %s: %s" % (PORTA, pid7777, cmd)); sys.exit(1)

# ---- 3. host ----
fontes = []
for nome in SCRIPTS:
    p = os.path.join(FRIDA, nome)
    if not os.path.exists(p): log("ABORTADO: script ausente " + p); sys.exit(1)
    src = open(p, encoding="utf-8").read()
    if nome == "host_flow_servidor.js" and SEM_INTERFACE:
        src = "var AUTO_F8_MS = 15000;  // injetado pelo servidor_host.py --sem-interface\n" + src
    # modo leve (06/11): no host sem interface desliga monitores/diagnosticos que custavam tempo em cada chamada do jogo
    # (host_flow solta os hooks depois do travel; modo_dedicado sem monitor de ProcessEvent; listen_nativo sem contador).
    if nome == "appdata_separado.js":
        os.makedirs(APPDATA_DIR, exist_ok=True)
        src = "var APPDATA_DIR = %s;\n" % json.dumps(APPDATA_DIR) + src
    if LEVE and nome in ("host_flow_servidor.js", "modo_dedicado.js", "listen_nativo.js"):   # padrao, com ou sem janela
        src = "var HOST_LEVE = true;  // injetado pelo servidor_host.py (modo leve; --diag desliga)\n" + src
    if nome == "replicacao_otimizada.js":
        if "--sem-frequencia" in sys.argv: src = "var OTIM_SEM_FREQUENCIA = true;\n" + src
        if "--freq-min" in sys.argv: src = "var OTIM_FREQ_MIN = %s;\n" % float(sys.argv[sys.argv.index("--freq-min") + 1]) + src
    if nome == "listen_nativo.js" and PORTA != 7777:
        if "const PORTA = 7777;" not in src: log("ABORTADO: listen_nativo.js sem 'const PORTA = 7777;'"); sys.exit(1)
        src = src.replace("const PORTA = 7777;", "const PORTA = %d;" % PORTA)
    fontes.append((nome, src))
definir_identidade(HOST_STEAM_ID, HOST_NOME)
dev = frida.get_local_device()
janela = ["-nullrhi", "-nosound"] if SEM_INTERFACE else ["-windowed", "-ResX=1280", "-ResY=720"]
log("modo: %s, %s, porta %d, log %s" % ("SEM INTERFACE (-nullrhi -nosound, F8 automatico)" if SEM_INTERFACE else "com janela (apertar F8)",
                                        "LEVE" if LEVE else "DIAGNOSTICO (--diag)", PORTA, OUT))
env_jogo = None
if APPDATA_SEPARADO:
    env_jogo = dict(os.environ); env_jogo["LOCALAPPDATA"] = APPDATA_DIR
    log("LocalAppData desta instancia: " + APPDATA_DIR)
pid = dev.spawn([EXE] + janela + ["-Port=%d" % PORTA, "-FullStdOutLogOutput"], cwd=WD, env=env_jogo) if env_jogo else \
      dev.spawn([EXE] + janela + ["-Port=%d" % PORTA, "-FullStdOutLogOutput"], cwd=WD)
sess = dev.attach(pid)
vivo = {"v": True}
def on_detached(reason, crash=None):
    vivo["v"] = False; log("HOST DESANEXADO: reason=%s crash=%s" % (reason, crash))
sess.on("detached", on_detached)
def on_msg(m, d):
    if m.get("type") == "send":
        t = (m.get("payload") or {}).get("tdb", "")
        if not t: return
        marco = any(k in t for k in MARCOS) and "[ded]" not in t
        posse = "[ded]" in t and ("ReceivePossessed" in t or "OnError" in t or "OnGot" in t or "InitPlayer" in t
                                  or "OnServerLoad" in t or "SteamId" in t or "SetLoginServer" in t or "ServerLocationLoaded" in t)
        log("MSG " + t, tela=marco or posse)
    else:
        log("ERRO-SCRIPT " + json.dumps(m)[:400])
for nome, src in fontes:
    sc = sess.create_script(src, name=nome); sc.on("message", on_msg); sc.load()
dev.resume(pid)
log("HOST PID %d. Aperte F8 no host, espere 'LISTEN OK', depois conecte o cliente." % pid)

def laco_export():
    while vivo["v"]:
        for _ in range(EXPORT_A_CADA):
            if not vivo["v"]: return
            time.sleep(1)
        exportar("periodico")
EXPORTA = (PORTA == 7777) and not SEM_SERVICOS   # no Linux quem exporta e o linux/iniciar_servicos.sh; porta de teste: outro runner (o host da 7777) ja exporta; dois exports juntos brigam pelo emu_data
if EXPORTA:
    threading.Thread(target=laco_export, daemon=True).start()
    log("export do Firestore a cada %d s e ao sair" % EXPORT_A_CADA)
else:
    log("porta de teste: export do Firestore DESLIGADO neste runner")

ultimo = None
inicio = time.time()
restaurado = False
try:
    while vivo["v"]:
        time.sleep(10)
        if not restaurado and time.time() - inicio >= 30:   # o emulador ja leu o ID do host
            devolver_identidade(); restaurado = True
        d = ps("Get-NetUDPEndpoint -LocalPort %d -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess" % PORTA)
        if d != ultimo:
            log("porta UDP %d: " % PORTA + (d or "ninguem") + (" (host)" if d.strip() == str(pid) else "")); ultimo = d
except KeyboardInterrupt:
    log("interrompido (Ctrl+C)")
finally:
    if not restaurado:
        try: devolver_identidade()
        except Exception as e: log("falha ao devolver a identidade do cliente: %s" % e)
try: sess.detach()
except Exception: pass
vivo["v"] = False
if EXPORTA and escutando_tcp(8081, "127.0.0.1"):
    exportar("final", bloquear=True)
log("fim")
