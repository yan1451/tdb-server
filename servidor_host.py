"""Servidor proprio com host nativo (The Day Before): runner unico. Ver README.md na raiz do repositorio.
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

JOGO = os.environ.get("TDB_JOGO", r"C:\Games\THE DAY BEFORE")
WD = os.path.join(JOGO, r"Survival\Binaries\Win64")
EXE = os.path.join(WD, "TheDayBefore.exe")
AQUI = os.path.dirname(os.path.abspath(__file__))
FRIDA = os.path.join(AQUI, "scripts")                         # scripts Frida do host
SERVICOS = os.path.join(AQUI, "servicos")
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
SCRIPTS = ["appdata_separado.js", "ssl_unpin.js", "tdb_connectex_test.js", "fake_server_join.js", "host_flow_servidor.js",
           "modo_dedicado.js", "listen_nativo.js", "replicacao.js", "replicacao_donos.js", "replicacao_distancia.js", "disparar_onserverload.js"]
# Sempre isola o host por porta: o cliente conserva o LocalAppData original, sem disputar o LOCK do Firestore.
# --appdata-separado continua aceito por compatibilidade, mas agora este e o padrao.
APPDATA_DIR = os.path.join(os.environ["LOCALAPPDATA"], "TDB_instancia_%d" % PORTA)
if "--diag-excecao" in sys.argv:   # 06/11: registra excecoes C++ (tipo, what, backtrace) - investigacao da 2a instancia
    SCRIPTS.insert(0, "captura_excecao.js")
# F8 automatico (--sem-interface): feito DENTRO do host_flow_servidor.js (autoF8Tick, ativado por `var AUTO_F8_MS`).
# O auto_f8.js (hook externo em GetAsyncKeyState) NAO funciona carregado por este runner: 0 leituras vistas, mesmo numa
# 2a sessao; so funcionou carregado por outro processo Python (06/11 11:00 e 11:08). Ficou como ferramenta manual.
EMU = os.path.join(SERVICOS, "firestore_emu")
EXPORT_A_CADA = 60   # segundos
MARCOS = ("LISTEN OK", "ABORTADO", "ERRO", "DESLIGADO", "NetMode", "canal aberto: Pawn", "chamando OnServerLoad",
          "LoginCompleted", "PHASE", "placeholder de cliente visto", "SurvivalPlayer_V2_C", "InitPlayer", "OnError", "erro",
          "SteamId", "Firestore", "ConnectEx IPv")

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

def ps(cmd):
    return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], capture_output=True, text=True).stdout.strip()

def escutando_tcp(porta, endereco):
    return bool(ps("Get-NetTCPConnection -State Listen -LocalPort %d -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq '%s'" % (porta, endereco)))

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

LISTA_URL = ("http://127.0.0.1:8081/v1/projects/the-day-before-8f438/databases/(default)/documents/"
             "server-list/us-central/versions/3/servers/127.0.0.1:%d" % PORTA)

def criar_servidor_na_lista():
    """Cria/atualiza o documento que o Server Browser do jogo le (server-list/us-central/versions/3/servers)."""
    campos = {"Players": {"integerValue": "10"}, "Adress": {"stringValue": "127.0.0.1"}, "Port": {"integerValue": str(PORTA)},
              "Region": {"stringValue": "us-central"}, "ServerName": {"stringValue": "SERVIDOR-LOCAL"},
              "Name": {"stringValue": "SERVIDOR-LOCAL"}, "DisplayName": {"stringValue": "SERVIDOR-LOCAL"}}
    req = urllib.request.Request(LISTA_URL, data=json.dumps({"fields": campos}).encode(), method="PATCH",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resposta:
        resposta.read()

# ---- 0. pre-requisitos ----
if not os.path.exists(EXE):
    log("ABORTADO: jogo nao encontrado em " + EXE + " (defina a variavel TDB_JOGO com a pasta do jogo)"); sys.exit(1)
if ps("Get-Process | Where-Object ProcessName -match proxifier"):
    log("ABORTADO: Proxifier aberto (interfere no Firestore)"); sys.exit(1)
TLS = os.path.join(SERVICOS, "tls")
if not os.path.exists(os.path.join(TLS, "firestore.pem")):
    log("certificados locais ausentes: gerando (servicos\\tls\\make_local_ca.py)")
    subprocess.run([PY, "-I", os.path.join(TLS, "make_local_ca.py")], cwd=TLS, check=True)
if ps("Get-Process -Name TheDayBefore -ErrorAction SilentlyContinue"):
    log("aviso: ja existe TheDayBefore aberto (cliente ou host antigo). O host novo sera outro processo.")

# ---- 1. servicos da lista ----
if not escutando_tcp(8081, "127.0.0.1"):
    importar = "--import ./emu_data " if os.path.isdir(os.path.join(EMU, "emu_data")) else ""
    iniciar(["cmd.exe", "/c", "firebase emulators:start --only firestore --project the-day-before-8f438 " + importar + "--export-on-exit ./emu_data"], EMU, "firestore_emu")
    if not esperar(lambda: escutando_tcp(8081, "127.0.0.1"), 90, "Firestore em 127.0.0.1:8081"): sys.exit(1)
else:
    log("ok: Firestore ja em 127.0.0.1:8081")
if not escutando_tcp(8081, "::1"):
    iniciar([PY, "-I", os.path.join(SERVICOS, "ipv6_bridge.py")], SERVICOS, "ipv6_bridge")
    if not esperar(lambda: escutando_tcp(8081, "::1"), 15, "ponte IPv6 [::1]:8081"): sys.exit(1)
else:
    log("ok: ponte IPv6 ja em [::1]:8081")
if not escutando_tcp(443, "127.0.0.1"):
    iniciar([PY, os.path.join(TLS, "tls_front.py")], TLS, "tls_front")
    if not esperar(lambda: escutando_tcp(443, "127.0.0.1"), 15, "terminador TLS 127.0.0.1:443"): sys.exit(1)
else:
    log("ok: terminador TLS ja em 443")
if not esperar(lambda: escutando_tcp(443, "::1"), 15, "terminador TLS [::1]:443"): sys.exit(1)
try:
    criar_servidor_na_lista(); log("ok: SERVIDOR-LOCAL (127.0.0.1:%d) na lista de servidores" % PORTA)
except OSError as e:
    log("ABORTADO: nao consegui gravar o servidor na lista (%s)" % e); sys.exit(1)

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
    if nome == "listen_nativo.js" and PORTA != 7777:
        if "const PORTA = 7777;" not in src: log("ABORTADO: listen_nativo.js sem 'const PORTA = 7777;'"); sys.exit(1)
        src = src.replace("const PORTA = 7777;", "const PORTA = %d;" % PORTA)
    fontes.append((nome, src))
definir_identidade(HOST_STEAM_ID, HOST_NOME)
dev = frida.get_local_device()
janela = ["-nullrhi", "-nosound"] if SEM_INTERFACE else ["-windowed", "-ResX=1280", "-ResY=720"]
log("modo: %s, %s, porta %d, log %s" % ("SEM INTERFACE (-nullrhi -nosound, F8 automatico)" if SEM_INTERFACE else "com janela (apertar F8)",
                                        "LEVE" if LEVE else "DIAGNOSTICO (--diag)", PORTA, OUT))
env_jogo = dict(os.environ); env_jogo["LOCALAPPDATA"] = APPDATA_DIR
log("LocalAppData desta instancia: " + APPDATA_DIR)
pid = dev.spawn([EXE] + janela + ["-Port=%d" % PORTA, "-FullStdOutLogOutput"], cwd=WD, env=env_jogo)
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
EXPORTA = (PORTA == 7777)   # porta de teste: outro runner (o host da 7777) ja exporta; dois exports juntos brigam pelo emu_data
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
            definir_identidade(CLIENTE_STEAM_ID, CLIENTE_NOME); restaurado = True
        d = ps("Get-NetUDPEndpoint -LocalPort %d -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess" % PORTA)
        if d != ultimo:
            log("porta UDP %d: " % PORTA + (d or "ninguem") + (" (host)" if d.strip() == str(pid) else "")); ultimo = d
except KeyboardInterrupt:
    log("interrompido (Ctrl+C)")
finally:
    if not restaurado:
        try: definir_identidade(CLIENTE_STEAM_ID, CLIENTE_NOME)
        except Exception as e: log("falha ao devolver a identidade do cliente: %s" % e)
try: sess.detach()
except Exception: pass
vivo["v"] = False
if EXPORTA and escutando_tcp(8081, "127.0.0.1"):
    exportar("final", bloquear=True)
log("fim")
